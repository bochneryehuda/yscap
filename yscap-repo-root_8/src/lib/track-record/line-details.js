'use strict';
/**
 * "SEE MORE INFORMATION" — one line's whole recorded story, and the fill that
 * imports what the records state (owner-directed 2026-08-19: "on each and every
 * thing of the track record, we should be able to click 'See more information'.
 * It should bring in more information about that line on the track record and
 * import more information").
 *
 * ═══ ONE READ, NEVER A SECOND ONE ══════════════════════════════════════════
 * The records come from `verify-run.runVerify` — the SAME pull (and the same
 * 90-day cache) the "Check the records" button uses — so the story this panel
 * tells, the pillar verdicts on the line, and the records stamp all come from
 * ONE read of the county records. A fresh click answers from the cache at zero
 * vendor cost; `refresh:true` forces a re-read (the same force the check
 * button has), and either way the pillar observations are refreshed as a side
 * effect, because runVerify writes them.
 *
 * ═══ THE FILL IS FILL-ONLY, STRUCTURALLY ═══════════════════════════════════
 * `applyFromRecords` writes through `COALESCE(col, $value)` — a column that
 * already holds anything is untouched by construction, never by a check
 * somebody could forget. The values come from the importer's OWN records→deal
 * mapping (`candidatesFrom` + the transfer/self-deal guards), never a second
 * reading of a deed — so a figure this door fills is byte-for-byte the figure
 * the import queue would have staged.
 *
 * A VERIFIED line is refused without `confirmReopen` — the same two-step the
 * importer's merge verb has (db/485 un-verifies on any material fill, and a
 * reviewer clicking "import more" must not lose a verification by surprise).
 *
 * STAFF-ONLY: the story carries raw recorded parties (grantors, lenders,
 * counterparties) — exactly the detail the borrower-confirm projection
 * deliberately withholds from borrowers.
 */

const CHECKS = require('./checks');

const str = (v) => String(v == null ? '' : v).trim();
const ymd = (v) => {
  const m = String(v == null ? '' : v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const names = (list) => (Array.isArray(list) ? list : (list == null ? [] : [list]))
  .map((p) => (typeof p === 'string' ? p : (p && (p.name || p.partyName))))
  .map((s) => str(s)).filter(Boolean);

/* The fields the records can supply, each with the column it fills and how the
   candidate carries it. `seller_name` / buyer ride the candidate's raw — the
   deed's other side (db/499). All except seller_name are MATERIAL (db/485). */
const FIELDS = [
  { field: 'purchase_price', kind: 'money', label: 'Purchase price' },
  { field: 'purchase_date', kind: 'date', label: 'Purchase date' },
  { field: 'sale_price', kind: 'money', label: 'Sale price' },
  { field: 'sale_date', kind: 'date', label: 'Sale date' },
  { field: 'rent_amount', kind: 'money', label: 'Monthly rent' },
  { field: 'rent_date', kind: 'date', label: 'Leased date' },
  { field: 'refi_amount', kind: 'money', label: 'Refinance amount' },
  { field: 'refi_date', kind: 'date', label: 'Refinance date' },
  { field: 'seller_name', kind: 'text', label: 'Bought from', raw: 'counterparty', material: false },
];

/** A value the COLUMN can actually hold — a vendor figure past numeric(14,2),
 *  or a date off the calendar, is reported as unstorable, never a 22003 that
 *  reads as "PILOT is broken". */
function storable(kind, v) {
  if (kind === 'money') { const n = num(v); return n != null && n >= 0 && n < 1e12 ? n : null; }
  if (kind === 'date') {
    const d = ymd(v); if (!d) return null;
    const y = Number(d.slice(0, 4)); return y >= 1900 && y <= 2100 ? d : null;
  }
  return str(v) ? str(v).slice(0, 160) : null;
}

async function loadLine(db, trackRecordId) {
  const t = (await db.query(
    `SELECT id, borrower_id, property_address, deal_type, is_verified,
            purchase_price, purchase_date, sale_price, sale_date,
            rent_amount, rent_date, refi_amount, refi_date, seller_name
       FROM track_records WHERE id=$1`, [trackRecordId])).rows[0];
  if (!t) { const e = new Error('not found'); e.status = 404; throw e; }
  return t;
}

/** The records→line diff, computed ONCE and used by both the panel and the
 *  apply — so what the screen offered is exactly what the apply fills. */
function suggestionsFor(line, candidate) {
  const out = [];
  for (const f of FIELDS) {
    const recordsRaw = f.raw ? (candidate && candidate.raw && candidate.raw[f.raw]) : (candidate && candidate[f.field]);
    const records = storable(f.kind, recordsRaw);
    if (records == null) continue;
    const current = line[f.field];
    const empty = current == null || String(current).trim() === '';
    if (empty) {
      out.push({ field: f.field, label: f.label, kind: f.kind, records, current: null, fillable: true, material: f.material !== false });
    } else if (f.kind === 'date' ? ymd(current) !== records : (f.kind === 'money' ? Number(current) !== records : str(current) !== records)) {
      /* A DIFFERENCE IS SHOWN, NEVER AUTO-APPLIED — the records never rewrite a
         figure somebody entered without a human choosing that change on the
         edit form (the owner's standing rule for every records import). */
      out.push({ field: f.field, label: f.label, kind: f.kind, records, current, fillable: false, material: f.material !== false });
    }
  }
  return out;
}

/**
 * The panel payload: the property's recorded story + what the records could
 * fill in. Never throws for vendor trouble — errors ride in `errors[]`.
 */
async function moreInfo(trackRecordId, { staffId, refresh } = {}, client) {
  const db = client || require('../../db');
  const t = await loadLine(db, trackRecordId);
  const run = await require('./verify-run').runVerify(trackRecordId, { staffId, force: refresh === true }, db);

  const { samePlace, normalizeRecords, forProperty } = CHECKS._internals;
  const recs = normalizeRecords(run.research || {});
  const address = (run.line && run.line.address) || '';

  /* THE STORY — this property's own recorded documents, oldest first. Every
     entry names its parties: who sold it to them, who they sold it to, who
     lent on it — the "more information about that line" the owner asked for. */
  const story = [];
  for (const d of forProperty(recs.deeds, address)) {
    story.push({
      kind: 'deed', date: ymd(d.date), amount: num(d.amount),
      grantors: names(d.grantors), grantees: names(d.grantees),
      docId: str(d.countyDocumentId || d.documentId || d.id) || null,
    });
  }
  for (const m of forProperty(recs.mortgages, address)) {
    story.push({
      kind: m.isRefinance === true ? 'refinance' : 'mortgage',
      date: ymd(m.date), amount: num(m.amount),
      lender: str(m.lenderName || m.lender) || null,
      borrowers: names(m.grantees && m.grantees.length ? m.grantees : m.borrowers),
      purpose: str(m.loanPurpose) || null,
      maturity: ymd(m.maturityDate),
      satisfied: ymd(m.satisfactionDate),
      docId: str(m.countyDocumentId || m.documentId || m.id) || null,
    });
  }
  for (const s of forProperty(recs.satisfactions, address)) {
    story.push({ kind: 'satisfaction', date: ymd(s.date), docId: str(s.countyDocumentId || s.documentId || s.id) || null });
  }
  story.sort((a, b) => String(a.date || '9999').localeCompare(String(b.date || '9999')));

  /* The records→line diff, through the importer's ONE mapping. */
  const allNames = run.line ? [...(run.line.borrowerNames || []), ...(run.line.entityNames || [])] : [];
  const { candidates } = require('./importer').candidatesFrom(run.research || {}, allNames);
  const candidate = candidates.find((c) => samePlace(c.property_address, address)) || null;
  const suggestions = suggestionsFor(t, candidate);

  return {
    ok: true,
    cached: run.cached === true,
    calls: run.calls || 0,
    searched: run.searched === true,
    errors: run.errors || [],
    address,
    entityName: (run.line && run.line.entityName) || null,
    story,
    currentOwner: recs.currentOwner || null,
    /* Context, not a claim: how many OTHER recorded properties the search under
       this entity surfaced — a reviewer reading one line should know the
       records hold more. */
    otherProperties: Math.max(0, (candidates || []).length - (candidate ? 1 : 0)),
    suggestions,
    isVerified: t.is_verified === true,
    pillars: run.pillars || [],
    signals: run.signals || null,
  };
}

/**
 * Fill the line from the records — the chosen fields only, blanks only.
 * Returns what was applied and what was skipped, each with its reason.
 */
async function applyFromRecords(trackRecordId, { staffId, fields, confirmReopen } = {}, client) {
  const db = client || require('../../db');
  const t = await loadLine(db, trackRecordId);
  const info = await moreInfo(trackRecordId, { staffId }, client);

  const want = new Set(Array.isArray(fields) && fields.length ? fields.map(String) : FIELDS.map((f) => f.field));
  const fillable = info.suggestions.filter((s) => s.fillable && want.has(s.field));
  if (!fillable.length) {
    return { ok: true, applied: [], skipped: info.suggestions.filter((s) => !s.fillable).map((s) => ({ field: s.field, reason: 'already_filled' })), reopened: false };
  }

  /* The importer's merge rule, verbatim: filling a MATERIAL blank un-verifies
     the line (db/485), so a verified line needs the second, explicit yes. */
  if (t.is_verified === true && fillable.some((s) => s.material) && confirmReopen !== true) {
    const e = new Error('This line is VERIFIED. Filling it from the records re-opens that verification — confirm to continue.');
    e.status = 409; e.code = 'would_reopen';
    e.fields = fillable.map((s) => s.field);
    throw e;
  }

  /* COALESCE = fill-only by construction. A concurrent edit that filled the
     column between the read and this write simply wins — nothing here can
     overwrite a value anybody typed. */
  const cols = []; const vals = [trackRecordId];
  for (const s of fillable) {
    vals.push(s.records);
    cols.push(`${s.field} = COALESCE(${s.field}, $${vals.length})`);
  }
  await db.query(
    `UPDATE track_records SET ${cols.join(', ')}, updated_at = now() WHERE id = $1`, vals);

  return {
    ok: true,
    applied: fillable.map((s) => ({ field: s.field, label: s.label, value: s.records })),
    skipped: info.suggestions.filter((s) => !s.fillable).map((s) => ({ field: s.field, reason: 'already_filled' })),
    reopened: t.is_verified === true && fillable.some((s) => s.material),
    borrowerId: t.borrower_id,
  };
}

module.exports = { moreInfo, applyFromRecords, FIELDS, _internals: { suggestionsFor, storable } };
