'use strict';
/**
 * NOTE-BUYER APPRAISAL CHECKS — deterministic, per-buyer requirements evaluated against the
 * IMPORTED appraisal, surfaced as `appraisal_findings` rows on the Appraisal tab, right beside
 * the general findings (owner-directed 2026-07-30: "anything being sold to EMCAP Financial —
 * review the appraisal findings together with the general appraisal findings, but there is a
 * few extra requirements … this is all stuff that you don't even need AI for — code it").
 *
 * EMCAP's "Valuations — Additional Appraisal Review Items" (the owner's list, also transcribed
 * in docs/SILVER-PROGRAM-EMCAP.md):
 *   1. At least ONE As-Is comp: settled within 12 months of the loan SUBMISSION date, under 15%
 *      net adjustment, and within 1 MILE of the subject (the "anchor" comp). Owner-directed
 *      2026-08-16 stated the distance rule in their own words ("it needs to be within 1 mile");
 *      the earlier transcription said "the same ZIP code", which is what this file could
 *      actually reach at the time. Both are honoured now — see compVerdict (c).
 *   2. The same for at least ONE ARV (after-repair) comp.
 *   3. A rental exit (Fix & Hold / DSCR / Rental) needs a rental analysis on the appraisal —
 *      a 1025 has it built in; a 1004 needs a 1007 rent schedule.
 *   4. Interior photos must be present.
 *   5. The appraisal must show OUR name as the submitting lender — checked only when the
 *      appraisal actually names a lender ("don't be stupid… it shouldn't be an always-on
 *      condition; when the appraisal comes in, look at the lender name — if it's not us, say
 *      a finding").
 *
 * DESIGN RULES (all owner-directed):
 *   • FINDINGS, NEVER CONDITIONS. Nothing here creates or edits a checklist condition — the
 *     rows land in `appraisal_findings` with source='note_buyer', so they ride the existing
 *     review/resolve/sign-off machinery (and the enforced appraisal-review gate) for free.
 *   • NEVER FABRICATE. A requirement whose data is genuinely missing (no comps readable, the
 *     grid split undetermined, no photo metadata in the file) surfaces as a WARNING asking a
 *     human to verify by hand — never as a fatal "requirement failed".
 *   • RE-RUNNABLE. `computeEmcapFindings` is PURE over data the import already STORES
 *     (appraisals + appraisal_comparables + the fields jsonb), so `syncNoteBuyerFindings` can
 *     re-evaluate whenever the note buyer changes after import — and retire the whole set when
 *     the buyer moves off EMCAP.
 *   • STAFF-ONLY. These findings name a note buyer, so the borrower's read-only appraisal view
 *     filters source='note_buyer' out entirely (src/routes/borrower.js).
 */

const registry = require('../conditions/field-registry');
// THE NUMBERS ARE NOT RESTATED HERE. They are stated once in
// investor-appraisal-requirements.js, which is also what the message posted to
// the appraisal order reads — so we can never tell an appraiser one rule and
// then refuse their report for another (owner-directed 2026-08-16).
const REQS = require('./investor-appraisal-requirements');
const { ANCHOR_MONTHS, ANCHOR_MAX_NET_ADJ_PCT, COMP_RADIUS_MILES } = REQS;
// The appraiser's own stated distance ("0.55 miles SW"), read by the ONE parser
// this repo already uses for it — which refuses anything it cannot read cleanly
// (a written fraction, an implausible distance) rather than interpreting it.
const { proximityMiles } = require('../research/trilaterate');

// The one source-tag for every finding this module writes. Retire/diff by THIS, never by code
// prefix, so a future buyer's checks can join the same channel.
const SOURCE = 'note_buyer';

// ---------- small helpers (mirror findings.js conventions; no new Date() anywhere) ----------
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function monthsBetween(a, b) { // b minus a, whole months; null when either isn't a calendar date
  const pa = /^(\d{4})-(\d{2})/.exec(String(a || '')), pb = /^(\d{4})-(\d{2})/.exec(String(b || ''));
  if (!pa || !pb) return null;
  return (+pb[1] - +pa[1]) * 12 + (+pb[2] - +pa[2]);
}
function normZip(z) { const m = /^(\d{5})/.exec(String(z == null ? '' : z).trim()); return m ? m[1] : null; }
const money = (n) => (n == null ? null : `$${Number(n).toLocaleString('en-US')}`);

function finding(f) {
  return Object.assign(
    { source: SOURCE, severity: 'fatal', status: 'open' },
    f,
    { blocksCtc: f.blocksCtc != null ? f.blocksCtc : (f.severity !== 'warning' && f.severity !== 'info') },
  );
}

// A rental exit for the owner's rule 3: Fix & Hold OR DSCR/Rental (normStrategy vocab).
function isRentalExit(strategy) { return strategy === 'fix_hold' || strategy === 'rental_dscr'; }

// ---------- the anchor-comp evaluation (rules 1 + 2) ----------
// One comp qualifies as an ANCHOR when all three requirements are PROVABLY true:
//   settled sale ≤ 12 months before the submission date · |net adj| < 15% · close enough
//   to the subject (see below).
// Verdict per comp: 'pass' | 'fail' (at least one requirement provably broken) | 'unknown'
// (a requirement's data is missing and nothing provably failed).
//
// HOW CLOSE IS CLOSE ENOUGH — the one rule that moved (owner-directed 2026-08-16).
// The requirement is "within 1 mile of the subject". Until now this file tested the
// subject's ZIP CODE, which was the only thing it could reach: a stand-in, and a
// wrong one at the edges — a comp 0.4 miles away across a ZIP boundary satisfies the
// real rule and was being failed by ours, on a finding that BLOCKS clear to close.
// So the appraiser's own stated distance is used WHEN THE REPORT GIVES ONE, and the
// ZIP stays as the fallback for a report that does not.
//
// THE DIRECTION IS THE SAFETY PROPERTY, and it is why this could ship against live
// files: a stated distance can only ever ADD a qualifying comp, never remove one.
// A comp inside the mile passes whatever its ZIP says; a comp outside the mile is
// NOT failed on distance, it simply falls back to the ZIP test it has always faced.
// So no file that qualifies today can stop qualifying. Making the mile a hard
// refusal would tighten a CTC-blocking gate, and that is the owner's call to make
// in their own words, not this file's to infer.
function compVerdict(c, { submittedDate, subjectZip }) {
  const reasons = [];
  let unknown = false;

  // Closed sale only — an active/pending listing is not a sale.
  const closed = c.saleStatus == null || c.saleStatus === 'closed';
  if (!closed) return { verdict: 'fail', reasons: ['not a settled sale (active/pending listing)'] };

  // (a) settled within 12 months of the loan submission date. A sale AFTER submission is even
  // more recent → qualifies. monthsBetween(sale, submitted) = how many months before submission.
  const mo = monthsBetween(c.saleDate, submittedDate);
  if (mo == null) unknown = true;
  else if (mo > ANCHOR_MONTHS) reasons.push(`sold ${mo} months before the loan was submitted (over ${ANCHOR_MONTHS})`);

  // (b) net adjustment under 15%. Prefer the reported %, else derive it from $/sale price.
  let adj = num(c.netAdjPct);
  if (adj == null) {
    const dollars = num(c.netAdjustment), sp = num(c.salePrice);
    if (dollars != null && sp != null && sp > 0) adj = (Math.abs(dollars) / sp) * 100;
  }
  if (adj == null) unknown = true;
  else if (Math.abs(adj) >= ANCHOR_MAX_NET_ADJ_PCT) {
    reasons.push(`${Math.abs(Math.round(adj * 10) / 10)}% net adjustment (needs under ${ANCHOR_MAX_NET_ADJ_PCT}%)`);
  }

  // (c) close enough to the subject: within the mile if the report says so, else the ZIP.
  const miles = proximityMiles(c.proximity);
  if (miles != null && miles <= COMP_RADIUS_MILES) {
    // Inside the mile — the requirement itself is met, so the ZIP is not consulted.
  } else {
    const cz = normZip(c.zip), sz = normZip(subjectZip);
    if (!cz || !sz) unknown = true;
    else if (cz !== sz) {
      reasons.push(miles != null
        ? `${miles} miles away and ZIP ${cz} ≠ subject ${sz} (needs within ${COMP_RADIUS_MILES} mile)`
        : `ZIP ${cz} ≠ subject ${sz} (the report does not state the distance; needs within ${COMP_RADIUS_MILES} mile)`);
    }
  }

  if (reasons.length) return { verdict: 'fail', reasons };
  return unknown ? { verdict: 'unknown', reasons: ['some of its data (sale date / net adjustment / distance or ZIP) could not be read'] } : { verdict: 'pass', reasons: [] };
}

function anchorFinding({ comps, grid, label, code, submittedDate, subjectZip }) {
  const verdicts = comps.map((c) => ({ c, ...compVerdict(c, { submittedDate, subjectZip }) }));
  if (verdicts.some((v) => v.verdict === 'pass')) return null;             // requirement met — silent
  if (submittedDate == null) {
    // Without a submission date the 12-month window is unverifiable for every comp — ask, never guess.
    return finding({ code, severity: 'warning', field: 'comps',
      title: `EMCAP anchor comp (${label}) could not be verified — no loan submission date on the file`,
      howTo: `EMCAP requires at least one ${label} comp settled within ${ANCHOR_MONTHS} months of the loan submission date, under ${ANCHOR_MAX_NET_ADJ_PCT}% net adjustment, within ${COMP_RADIUS_MILES} mile of the subject. The file has no submission date, so PILOT could not verify the ${ANCHOR_MONTHS}-month window — check the comps by hand.`,
      actions: ['acknowledge', 'dismiss'] });
  }
  if (verdicts.some((v) => v.verdict === 'unknown')) {
    const u = verdicts.filter((v) => v.verdict === 'unknown').map((v) => `#${v.c.seq}`).join(', ');
    return finding({ code, severity: 'warning', field: 'comps',
      title: `EMCAP anchor comp (${label}) could not be fully verified from the appraisal data`,
      appraisalValue: `unverifiable: ${u}`,
      howTo: `EMCAP requires at least one ${label} comp settled within ${ANCHOR_MONTHS} months of submission, under ${ANCHOR_MAX_NET_ADJ_PCT}% net adjustment, within ${COMP_RADIUS_MILES} mile of the subject (ZIP ${normZip(subjectZip) || '—'} where no distance is stated). None provably qualifies, but ${u} ${u.includes(',') ? 'are' : 'is'} missing some of the data — open the report and verify by hand.`,
      actions: ['acknowledge', 'dismiss'] });
  }
  // Every comp in the grid provably fails at least one requirement → the real fatal.
  const detail = verdicts.map((v) => `#${v.c.seq}: ${v.reasons.join('; ')}`).join(' · ');
  return finding({ code, severity: 'fatal', field: 'comps',
    appraisalValue: `${verdicts.length} ${label} comp${verdicts.length === 1 ? '' : 's'}, none qualifies`,
    title: `EMCAP: no ${label} anchor comp — none is a settled sale within ${ANCHOR_MONTHS} months, under ${ANCHOR_MAX_NET_ADJ_PCT}% net adjustment, within ${COMP_RADIUS_MILES} mile of the subject`,
    howTo: `EMCAP requires at least ONE ${label} comparable that is a settled sale within ${ANCHOR_MONTHS} months of the loan submission date, with under ${ANCHOR_MAX_NET_ADJ_PCT}% net adjustment, within ${COMP_RADIUS_MILES} mile of the subject (where the report does not state a distance, the subject's ZIP ${normZip(subjectZip) || '—'} is used instead). ${detail}. Ask the appraiser for a qualifying comp, or resolve this finding if EMCAP accepts the file as-is.`,
    actions: ['acknowledge', 'dismiss', 'request_revision'] });
}

// ---------- the pure compute over STORED shapes ----------
/**
 * @param {{
 *   noteBuyer: string|null,            // applications.lender
 *   submittedDate: string|null,        // 'YYYY-MM-DD' — the loan submission date
 *   strategy: string|null,             // field-registry normStrategy output
 *   appraisal: {                       // the current appraisals row (or row-shaped)
 *     form_type, subject_zip, arv_value, as_is_value, est_market_monthly_rent,
 *     lender_name, condition_of_appraisal, comp_split_needs_review, fields }|null,
 *   comps: Array<{seq, comp_set, zip, sale_date, net_adj_pct, net_adjustment, sale_price, sale_status}>,
 *   unitRentCount: number,             // appraisal_units rows carrying a market rent
 * }} input
 * @returns {Array} finding-shaped rows ({} keys matching findings.js: code/severity/field/title/howTo/…)
 */
function computeEmcapFindings(input) {
  const out = [];
  const i = input || {};
  if (!registry.isEmcapNoteBuyer(i.noteBuyer)) return out;   // EMCAP files only — silent otherwise
  const a = i.appraisal;
  if (!a) return out;                                        // no appraisal → nothing to judge

  const comps = (i.comps || []).map((c) => ({
    seq: c.seq, compSet: c.comp_set || 'unknown', zip: c.zip, saleDate: c.sale_date,
    netAdjPct: c.net_adj_pct, netAdjustment: c.net_adjustment, salePrice: c.sale_price, saleStatus: c.sale_status,
    // The appraiser's own stated distance to the subject ("0.55 miles SW"), which
    // is the requirement itself — the ZIP was only ever standing in for it.
    proximity: c.proximity,
  }));
  const fields = a.fields && typeof a.fields === 'object' ? a.fields : {};
  const fieldVal = (k) => (fields[k] && fields[k].value != null ? fields[k].value : null);
  const formType = String(a.form_type || '').toUpperCase();
  const hasArv = num(a.arv_value) != null;

  // ---- 1 + 2. The anchor comps, per grid ----
  const shared = { submittedDate: i.submittedDate || null, subjectZip: a.subject_zip };
  const gridComps = (set) => comps.filter((c) => c.compSet === set)
    .map((c) => ({ seq: c.seq, comp_set: c.compSet, zip: c.zip, saleDate: c.saleDate,
      netAdjPct: c.netAdjPct, netAdjustment: c.netAdjustment, salePrice: c.salePrice, saleStatus: c.saleStatus,
      proximity: c.proximity }));
  const asIsComps = gridComps('as_is');
  const arvComps = gridComps('arv');
  const unknownComps = comps.filter((c) => c.compSet === 'unknown');

  if (comps.length === 0) {
    out.push(finding({ code: 'emcap_comps_unreadable', severity: 'warning', field: 'comps',
      title: 'EMCAP comp requirements could not be verified — no comparables were readable from the appraisal data',
      howTo: 'EMCAP requires a qualifying As-Is anchor comp and a qualifying ARV anchor comp (settled within 12 months of submission, under 15% net adjustment, same ZIP as the subject). The data file carried no readable comparables — open the report and verify both by hand.',
      actions: ['acknowledge', 'dismiss'] }));
  } else {
    // The ARV anchor applies only when the appraisal carries an after-repair value.
    if (hasArv) {
      if (arvComps.length) {
        const f = anchorFinding({ comps: arvComps, grid: 'arv', label: 'ARV', code: 'emcap_arv_anchor', ...shared });
        if (f) out.push(f);
      } else {
        out.push(finding({ code: 'emcap_arv_anchor', severity: 'warning', field: 'comps',
          title: 'EMCAP ARV anchor comp could not be verified — no comps could be assigned to the ARV grid',
          howTo: 'EMCAP requires at least one ARV comp settled within 12 months of submission, under 15% net adjustment, in the subject\'s ZIP. PILOT could not tell which comparables support the after-repair value — verify the ARV grid by hand.',
          actions: ['acknowledge', 'dismiss'] }));
      }
    }
    // The As-Is anchor: judged off the As-Is grid when one is identified. On a renovation report
    // whose data file carries only the ARV grid (the As-Is comps live in an un-exported addendum),
    // it is UNVERIFIABLE from the data — a human check, never a fabricated fatal.
    if (asIsComps.length) {
      const f = anchorFinding({ comps: asIsComps, grid: 'as_is', label: 'As-Is', code: 'emcap_asis_anchor', ...shared });
      if (f) out.push(f);
    } else if (unknownComps.length) {
      out.push(finding({ code: 'emcap_asis_anchor', severity: 'warning', field: 'comps',
        title: 'EMCAP As-Is anchor comp could not be verified — the As-Is vs ARV comp split needs a human eye',
        howTo: 'EMCAP requires at least one As-Is comp settled within 12 months of submission, under 15% net adjustment, in the subject\'s ZIP. Some comparables could not be confidently assigned to a grid — verify by hand that one qualifying As-Is comp exists.',
        actions: ['acknowledge', 'dismiss'] }));
    } else if (hasArv) {
      // Every comp resolved to the ARV grid — the As-Is comps are not in the data file.
      out.push(finding({ code: 'emcap_asis_anchor', severity: 'warning', field: 'comps',
        title: 'EMCAP As-Is anchor comp could not be verified — the data file carries only the ARV grid',
        howTo: 'EMCAP requires at least one As-Is comp settled within 12 months of submission, under 15% net adjustment, in the subject\'s ZIP. The appraisal\'s As-Is comparables (usually an addendum grid) are not in the data file — open the PDF and verify one qualifying As-Is comp exists.',
        actions: ['acknowledge', 'dismiss'] }));
    }
    // (A straight as-is report: every comp IS an As-Is comp — handled by the asIsComps branch —
    // and there is no ARV grid to demand, so nothing else fires.)
  }

  // ---- 3. Rental exit needs a rental analysis (1025 built-in; 1004 needs a 1007) ----
  if (isRentalExit(i.strategy) && formType && formType.indexOf('1025') === -1) {
    const forms = Array.isArray(fieldVal('report.forms')) ? fieldVal('report.forms') : [];
    const formText = forms.map((fo) => [fo && fo.name, fo && fo.type, fo && fo.other].filter(Boolean).join(' ')).join(' | ');
    const namesRentSchedule = /1007|rent\s*schedule|comparable\s*rent/i.test(formText);
    const rentalGrids = num(fieldVal('report.rentalGrids')) || 0;
    const hasRent = num(a.est_market_monthly_rent) != null || (i.unitRentCount || 0) > 0;
    if (!hasRent && !namesRentSchedule && rentalGrids === 0) {
      out.push(finding({ code: 'emcap_rental_analysis', severity: 'fatal', field: 'form_type',
        appraisalValue: formType || null,
        title: 'EMCAP: rental exit with no rental analysis on the appraisal — a 1004 needs a 1007 rent schedule',
        howTo: 'This loan\'s exit is rental (Fix & Hold / DSCR), and EMCAP requires a rental analysis on the appraisal: a 1025 includes it; on a 1004 a 1007 (Comparable Rent Schedule) must be included. PILOT found no market rent, no rent schedule and no rental-comp grid in the appraisal data. Order the 1007 from the appraiser, or resolve this finding if the report includes one PILOT could not read.',
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // ---- 4. Interior photos ----
  // Heuristic over the report's OWN metadata (page listing + photo captions), so it is always a
  // WARNING asking a human to confirm — never a fatal built on absence of metadata.
  {
    const forms = Array.isArray(fieldVal('report.forms')) ? fieldVal('report.forms') : [];
    const images = Array.isArray(fieldVal('report.images')) ? fieldVal('report.images') : [];
    const INTERIOR = /interior|kitchen|bath|bed\s*room|living|dining|basement/i;
    const textOf = (x, keys) => keys.map((k) => (x && x[k] != null ? String(x[k]) : '')).join(' ');
    const interiorNamed = forms.some((fo) => INTERIOR.test(textOf(fo, ['name', 'type', 'other'])))
      || images.some((im) => INTERIOR.test(textOf(im, ['id', 'caption'])));
    if (!interiorNamed) {
      const hasMeta = forms.length > 0 || images.length > 0;
      out.push(finding({ code: 'emcap_interior_photos', severity: 'warning', field: 'photos',
        title: hasMeta
          ? 'EMCAP requires interior photos — none are named in the appraisal data; confirm on the PDF'
          : 'EMCAP requires interior photos — the appraisal data does not say whether they are included; confirm on the PDF',
        howTo: 'All appraisals going to EMCAP must include interior pictures. The data file\'s own page/photo listing did not name any interior photos — open the report PDF, confirm the interior photos are there, then resolve this finding (or go back to the appraiser if they are missing).',
        actions: ['acknowledge', 'dismiss', 'request_revision'] }));
    }
  }

  // ---- 5. The appraisal must be in OUR name ----
  // Only when the appraisal actually NAMES a lender (never an always-on nag), matched generously
  // for "ours" via the yscapital token — the same test the ISG transferred-appraisal signal uses.
  {
    const lender = String(a.lender_name == null ? '' : a.lender_name).trim();
    if (lender && !/yscapital/.test(registry.normNoteBuyer(lender) || '')) {
      out.push(finding({ code: 'emcap_lender_name', severity: 'fatal', field: 'appraiser',
        appraisalValue: lender,
        title: `EMCAP: the appraisal names "${lender}" as the lender — EMCAP requires it in OUR name`,
        howTo: 'EMCAP requires every appraisal to exhibit the name of the lender submitting the loan for funding (YS Capital Group). This appraisal was ordered by a different lender. Order a new appraisal in our name — then re-import it here.',
        actions: ['acknowledge', 'dismiss', 'decline', 'request_revision'] }));
    }
  }

  return out;
}

// ---------- the DB side: sync the stored findings to the file's CURRENT state ----------
/**
 * Recompute the note-buyer findings for a file off STORED data and reconcile the
 * `appraisal_findings` rows: insert what's newly required (honoring the finding_decisions
 * carry-forward), supersede open rows that no longer apply (buyer moved off EMCAP, appraisal
 * removed, or a requirement is now met). Never throws — a failure only means the findings
 * are stale until the next sync. `db` is the pool or a client.
 */
async function syncNoteBuyerFindings(db, appId) {
  const out = { ok: true, added: 0, retired: 0, carried: 0 };
  try {
    const ar = await db.query(
      `SELECT a.lender, a.program, a.loan_type, a.rehab_type,
              to_char(COALESCE(a.submitted_at, a.clickup_created_at, a.created_at), 'YYYY-MM-DD') AS submitted_day
         FROM applications a WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
    const app = ar.rows[0];
    const apr = app ? (await db.query(
      `SELECT id, form_type, subject_zip, arv_value, as_is_value, est_market_monthly_rent,
              lender_name, condition_of_appraisal, comp_split_needs_review, fields
         FROM appraisals WHERE application_id = $1 AND superseded = false
        ORDER BY imported_at DESC LIMIT 1`, [appId])).rows[0] : null;

    let desired = [];
    if (app && apr && registry.isEmcapNoteBuyer(app.lender)) {
      const comps = (await db.query(
        `SELECT seq, comp_set, zip, sale_date, net_adj_pct, net_adjustment, sale_price, sale_status, proximity
           FROM appraisal_comparables WHERE appraisal_id = $1 AND is_subject = false ORDER BY seq`, [apr.id])).rows;
      const units = (await db.query(
        `SELECT count(*)::int AS n FROM appraisal_units WHERE appraisal_id = $1 AND market_rent IS NOT NULL`, [apr.id])).rows[0];
      desired = computeEmcapFindings({
        noteBuyer: app.lender,
        submittedDate: app.submitted_day || null,
        strategy: registry.normStrategy([app.program, app.loan_type, app.rehab_type].filter(Boolean).join(' ')),
        appraisal: apr,
        comps,
        unitRentCount: units ? units.n : 0,
      });
    }

    const open = (await db.query(
      `SELECT id, code FROM appraisal_findings
        WHERE application_id = $1 AND source = $2 AND status = 'open'`, [appId, SOURCE])).rows;
    const desiredCodes = new Set(desired.map((f) => f.code));

    // Retire open rows no longer required (requirement met / buyer changed / appraisal gone).
    const stale = open.filter((r) => !desiredCodes.has(r.code)).map((r) => r.id);
    if (stale.length) {
      const r = await db.query(
        `UPDATE appraisal_findings SET status = 'superseded'
          WHERE id = ANY($1::uuid[]) AND status = 'open'`, [stale]);
      out.retired = r.rowCount || 0;
    }

    // Insert what's newly required — honoring durable human decisions (born dismissed, like the
    // import's carry-forward). The skip set is EVERY non-superseded row of the code on the
    // CURRENT appraisal, not only the open ones: a dismissed/resolved row is a decided finding,
    // and skipping only open rows made every later sync add ANOTHER carried "dismissed" row —
    // unbounded growth on a file whose ClickUp card re-ingests forever (pre-merge audit F1).
    // A re-import supersedes the whole set and mints a fresh appraisal_id, so a genuinely new
    // appraisal still re-raises everything.
    if (desired.length && apr) {
      // Skip a code that already has a live row on the CURRENT appraisal, OR any OPEN row on
      // the file (whatever appraisal it hangs on). The second arm hardens the narrow cross-door
      // race the re-audit flagged (finding #2): if an OPEN row briefly outlives its appraisal
      // — a concurrent import superseding the appraisal between this sync's read and its insert —
      // the appraisal-scoped set alone would double-raise. Keying the OPEN arm on the file closes
      // it without ever blocking a legitimate re-raise (a superseded appraisal's findings are
      // themselves superseded by import.js, so they are not 'open').
      const onCurrent = new Set((await db.query(
        `SELECT code FROM appraisal_findings
          WHERE source = $2
            AND ((appraisal_id = $1 AND status <> 'superseded') OR (application_id = $3 AND status = 'open'))`,
        [apr.id, SOURCE, appId])).rows.map((r) => r.code));
      const fdec = require('../underwriting/finding-decisions');
      const settled = await fdec.suppressedKeys(db, appId);
      for (const fd of desired) {
        if (onCurrent.has(fd.code)) continue;
        const carried = settled.size && fdec.isSuppressed(settled, {
          code: fd.code, field: fd.field,
          docValue: fd.appraisalValue == null ? null : String(fd.appraisalValue),
        });
        await db.query(
          `INSERT INTO appraisal_findings
             (appraisal_id, application_id, source, code, severity, field, appraisal_value, file_value, title, how_to, blocks_ctc, status, resolution, resolution_note)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [apr.id, appId, SOURCE, fd.code, fd.severity, fd.field,
           fd.appraisalValue == null ? null : String(fd.appraisalValue),
           fd.fileValue == null ? null : String(fd.fileValue),
           fd.title, fd.howTo, !!fd.blocksCtc,
           carried ? 'dismissed' : 'open',
           carried ? 'carried_forward' : null,
           carried ? 'A reviewer already decided this finding on this file — carried forward from their decision.' : null]);
        if (carried) out.carried += 1; else out.added += 1;
      }
    }
  } catch (e) {
    out.ok = false; out.error = e && e.message;
    try { console.error('[appraisal] note-buyer findings sync failed (non-fatal):', e && e.message); } catch (_) { /* noop */ }
  }
  return out;
}

module.exports = {
  computeEmcapFindings, syncNoteBuyerFindings, SOURCE,
  _internals: { compVerdict, anchorFinding, isRentalExit, monthsBetween, normZip, num, money },
};
