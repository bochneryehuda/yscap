'use strict';
/**
 * BACKWARDS repair for the MISMO 3.4 joint-report score mix-up (owner-reported 2026-08-21).
 *
 * THE BUG: Xactus is ordered at MISMO 3.4, and 3.4 keeps the borrower PARTIES and the
 * RELATIONSHIP arcs that bind a score to a person at DEAL level — OUTSIDE
 * <CREDIT_RESPONSE>. `parseCreditXml` scoped its borrower segmentation to the
 * CREDIT_RESPONSE subtree, so on a real joint 3.4 report it found ZERO borrowers, never
 * split the document, and fell back to a flat per-bureau de-dupe — "first score per
 * bureau wins" — ACROSS TWO PEOPLE. Both borrowers were then stored with the same
 * whole-document number, and that number was written into `borrowers.fico`, which is
 * what prices the deal.
 *
 * On the reported file the co-borrower's rows happened to come first, so the primary
 * (true middle 685) was stored and priced at the co-borrower's 719.
 *
 * The parser is fixed (src/lib/credit/parse.js — the content/identity two-scope split,
 * guarded by scripts/test-credit-merged-pure.js). This repairs reports ALREADY imported.
 *
 * SAFE BY DESIGN:
 *  - DRY-RUN by default: prints exactly what it WOULD change and writes nothing.
 *    Pass --apply to write.
 *  - It re-parses the report's OWN stored XML. A row with no stored XML, or whose
 *    re-parse errors, or whose re-parse yields no usable score, is REPORTED AND SKIPPED
 *    — never blanked.
 *  - A borrower is only re-scored from a segment that is PROVABLY theirs (SSN or full
 *    name, via the same matchSegments used at import). A positional guess is refused.
 *  - `borrowers.fico` is only corrected when it still holds the exact wrong value this
 *    bug wrote. A human (or a later import) having changed it since means hands off —
 *    it is reported instead.
 *  - The SSN-mismatch guard from the importer is re-applied: a segment whose SSN names
 *    a different person than the borrower on file never writes a fico.
 *  - IDEMPOTENT: a row already carrying the correct score is skipped, so re-running is
 *    harmless.
 *
 *   node scripts/credit-rescore-repair.js                    # dry run, whole database
 *   node scripts/credit-rescore-repair.js --apply            # write the corrections
 *   node scripts/credit-rescore-repair.js --file=YSCAP258134859   # one loan only
 *   node scripts/credit-rescore-repair.js --file=<app-uuid> --apply
 *
 * Requires DATABASE_URL and the storage config the documents were saved with.
 */
const db = require('../src/db');
const storage = require('../src/lib/storage');
const { parseCreditXml, sliceForSegment } = require('../src/lib/credit/parse');
const { matchSegments } = require('../src/lib/credit/match');
const { sanitizeFico } = require('../src/lib/fields');

const APPLY = process.argv.includes('--apply');
const FILE_ARG = (process.argv.find((a) => a.startsWith('--file=')) || '').slice('--file='.length).trim();

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s || '');
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

async function loadXml(row) {
  if (!row.xml_document_id) return null;
  const d = await db.query('SELECT storage_provider, storage_ref FROM documents WHERE id=$1', [row.xml_document_id]);
  const doc = d.rows[0];
  if (!doc || !doc.storage_ref) return null;
  const provider = storage.forRow ? storage.forRow(doc) : storage;
  const buf = await provider.read(doc.storage_ref);
  return buf ? buf.toString('utf8') : null;
}

(async function main() {
  const where = [];
  const args = [];
  if (FILE_ARG) {
    args.push(FILE_ARG);
    where.push(isUuid(FILE_ARG) ? `cr.application_id = $${args.length}::uuid` : `a.ys_loan_number = $${args.length}`);
  }
  const sql = `
    SELECT cr.id, cr.application_id, cr.borrower_id, cr.middle_score, cr.xml_document_id,
           cr.pulled_at, a.ys_loan_number,
           b.first_name, b.last_name, b.ssn_last4, b.fico AS borrower_fico
      FROM credit_reports cr
      JOIN applications a ON a.id = cr.application_id
      LEFT JOIN borrowers b ON b.id = cr.borrower_id
     WHERE cr.status = 'completed' AND cr.xml_document_id IS NOT NULL
       ${where.length ? 'AND ' + where.join(' AND ') : ''}
     ORDER BY cr.application_id, cr.pulled_at DESC`;
  const rows = (await db.query(sql, args)).rows;

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} completed credit report row(s) with stored XML${FILE_ARG ? ` for ${FILE_ARG}` : ''}\n`);

  // The roster of every file we touch (a segment is matched against ALL its borrowers).
  const rosterCache = new Map();
  async function rosterFor(appId) {
    if (rosterCache.has(appId)) return rosterCache.get(appId);
    const r = await db.query(
      `SELECT a.borrower_id, a.co_borrower_id,
              pb.first_name p_first, pb.last_name p_last, pb.ssn_last4 p_ssn,
              cb.first_name c_first, cb.last_name c_last, cb.ssn_last4 c_ssn
         FROM applications a
         LEFT JOIN borrowers pb ON pb.id=a.borrower_id
         LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
        WHERE a.id=$1`, [appId]);
    const x = r.rows[0] || {};
    const out = [];
    if (x.borrower_id) out.push({ borrowerId: x.borrower_id, role: 'primary', firstName: x.p_first, lastName: x.p_last, ssnLast4: x.p_ssn });
    if (x.co_borrower_id) out.push({ borrowerId: x.co_borrower_id, role: 'co', firstName: x.c_first, lastName: x.c_last, ssnLast4: x.c_ssn });
    rosterCache.set(appId, out);
    return out;
  }

  // The LATEST completed row per (application, borrower) is the one the credit section
  // and the fico write-back read; only that one may move a borrower's fico.
  const latest = new Set();
  const seenPair = new Set();
  for (const r of rows) {
    const k = `${r.application_id}|${r.borrower_id}`;
    if (!seenPair.has(k)) { seenPair.add(k); latest.add(r.id); }
  }

  const xmlCache = new Map();
  let checked = 0, wrong = 0, fixed = 0, ficoFixed = 0, skipped = 0;
  const notes = [];

  for (const r of rows) {
    const who = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.borrower_id || '(no borrower)';
    const tag = `${r.ys_loan_number || r.application_id} · ${who}`;
    let xml = xmlCache.get(r.xml_document_id);
    if (xml === undefined) {
      try { xml = await loadXml(r); } catch (e) { xml = null; notes.push(`${tag}: XML unreadable — ${(e && e.message) || e}`); }
      xmlCache.set(r.xml_document_id, xml);
    }
    if (!xml) { skipped++; continue; }

    const parsed = parseCreditXml(xml);
    if (parsed.parseError) { skipped++; notes.push(`${tag}: re-parse error — ${parsed.parseError} (left alone)`); continue; }
    checked++;

    let slice = null;
    let matchedBy = null;
    if (parsed.isMerged && r.borrower_id) {
      const roster = await rosterFor(r.application_id);
      const { pairs } = matchSegments(parsed.borrowers, roster);
      const pair = pairs.find((p) => String(p.borrower.borrowerId) === String(r.borrower_id));
      // Only a PROVEN match (SSN or full name) may re-score a stored report.
      if (!pair || !pair.verified) {
        skipped++;
        notes.push(`${tag}: the report's people could not be proven to include this borrower (${pair ? 'matched by ' + pair.matchedBy + ' only' : 'no match'}) — left alone`);
        continue;
      }
      slice = sliceForSegment(parsed, pair.segment);
      matchedBy = pair.matchedBy;
    } else {
      slice = parsed;
    }

    const next = sanitizeFico(slice.middleScore);
    if (next == null) { skipped++; notes.push(`${tag}: re-parse produced no usable score — left alone`); continue; }
    if (Number(next) === Number(r.middle_score)) continue;   // already correct

    wrong++;
    console.log(`${pad(tag, 52)} stored ${pad(r.middle_score, 5)} → correct ${pad(next, 5)}${matchedBy ? ` (matched by ${matchedBy})` : ''}`);

    // The importer's own SSN guard, re-applied: a report naming a DIFFERENT person
    // never prices this borrower's deal.
    const reported4 = slice.borrower && slice.borrower.ssnLast4;
    const onFile4 = r.ssn_last4 || null;
    const ssnMismatch = !!(reported4 && onFile4 && String(reported4) !== String(onFile4));

    const isLatest = latest.has(r.id);
    const ficoStale = r.borrower_fico != null && Number(r.borrower_fico) === Number(r.middle_score);
    let ficoPlan = 'no change';
    if (!isLatest) ficoPlan = 'not the newest report for this borrower — fico untouched';
    else if (ssnMismatch) ficoPlan = `report SSN *${reported4} ≠ file *${onFile4} — fico untouched (mismatch)`;
    else if (r.borrower_fico == null) ficoPlan = `fico is empty → set ${next}`;
    else if (ficoStale) ficoPlan = `fico ${r.borrower_fico} was written by the bad import → set ${next}`;
    else ficoPlan = `fico ${r.borrower_fico} was changed since the import — LEFT ALONE, check by hand`;
    console.log(`${' '.repeat(52)} ${ficoPlan}`);

    if (!APPLY) continue;

    await db.query(
      `UPDATE credit_reports
          SET middle_score=$1, scores=$2, summary=$3, parsed=$4
        WHERE id=$5`,
      [next, JSON.stringify(slice.scores || []), JSON.stringify(slice.summary || {}), JSON.stringify(slice), r.id]);
    fixed++;

    if (isLatest && !ssnMismatch && (r.borrower_fico == null || ficoStale)) {
      await db.query('UPDATE borrowers SET fico=$1, updated_at=now() WHERE id=$2', [next, r.borrower_id]);
      ficoFixed++;
    }
  }

  console.log('');
  if (notes.length) { console.log('Left alone:'); for (const n of notes) console.log('  · ' + n); console.log(''); }
  console.log(`re-parsed ${checked} · wrong ${wrong} · ${APPLY ? `report rows corrected ${fixed} · borrower fico corrected ${ficoFixed}` : 'nothing written (dry run — add --apply)'} · skipped ${skipped}`);
  if (APPLY && ficoFixed) {
    console.log('\nA corrected fico reopens Products & Pricing for that file (db/126 trigger), which is intended:');
    console.log('the deal must be re-priced on the borrower\'s real score.');
  }
  await db.end?.();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
