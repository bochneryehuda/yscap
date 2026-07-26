'use strict';
/**
 * assembleTapeLoan(appId, db) — gather ONE loan file's facts into a single
 * normalized object that any capital-provider tape mapper can read from.
 *
 * This is deliberately tape-AGNOSTIC: it pulls the raw application row (plus the
 * pricing FICO, the current registered product/quote, the current appraisal, the
 * vesting entity, the assigned officer, the borrower's experience counts and a
 * repeat-borrower flag) and hands it back untouched. Each tape (fidelis.js, and
 * future ones) decides how to map these facts onto ITS columns. Reusing one
 * assembler means every tape sees the same source-of-truth numbers.
 *
 * Mirrors the pricing loader (staff.js loadFileForPricing): the FICO is the
 * GREATEST across borrower + co-borrower, and the experience count is the
 * claimed-of-record figure with a fall-back to verified recent (≤36mo) exits —
 * the exact basis our own engine prices on, so a tape's tier matches our price.
 */
const { RECENT_EXIT_SQL } = require('../experience');

function num(v) { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; }

async function assembleTapeLoan(appId, db) {
  const a = await db.query(
    `SELECT a.*, NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS pricing_fico,
            b.first_name AS b_first, b.last_name AS b_last, b.email AS b_email,
            b.citizenship AS b_citizenship, b.fico AS b_fico,
            cb.first_name AS cb_first, cb.last_name AS cb_last, cb.fico AS cb_fico,
            cb.citizenship AS cb_citizenship,
            l.llc_name AS vesting_llc, l.ein AS vesting_ein, l.formation_state AS vesting_state,
            lo.full_name AS officer_name, lo.nmls AS officer_nmls, lo.email AS officer_email, lo.phone AS officer_phone
       FROM applications a
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
       LEFT JOIN llcs l ON l.id = a.llc_id
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
      WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId]);
  const app = a.rows[0];
  if (!app) return { found: false };

  // Current registered product + its normalized server-computed quote (the
  // priced structure: sizing.totalLoan / initialAdvance / rehabHoldback /
  // financedReserve / ltcPct / acqLtvPct / arvPct, noteRate, …).
  const reg = (await db.query(
    `SELECT program, product_label, note_rate, total_loan, target_ltc, status, quote, term_options, created_at
       FROM product_registrations WHERE application_id = $1 AND is_current LIMIT 1`, [appId])).rows[0] || null;

  // Current appraisal (superseded=false, newest import) — subject descriptors +
  // as-is / ARV values only used as a fall-back to the application's own numbers.
  let appraisal = null;
  try {
    appraisal = (await db.query(
      `SELECT form_type, as_is_value, arv_value, appraised_value, units, gla, beds, baths_full, baths_half,
              effective_date, report_signed_date
         FROM appraisals WHERE application_id = $1 AND superseded = false
         ORDER BY imported_at DESC LIMIT 1`, [appId])).rows[0] || null;
  } catch (_) { appraisal = null; }

  // Experience: claimed-of-record with a fall-back to verified recent exits, per
  // category, exactly like loadFileForPricing. Drives the tape's "projects
  // completed" (and therefore the investor sheet's borrower tier).
  const expIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const verified = { flips: 0, holds: 0, ground: 0 };
  try {
    const tr = await db.query(
      `SELECT lower(coalesce(deal_type,'')) AS dt, count(*)::int AS n
         FROM track_records WHERE borrower_id = ANY($1::uuid[]) AND is_verified = true AND (${RECENT_EXIT_SQL}) GROUP BY 1`,
      [expIds]);
    for (const row of tr.rows) {
      if (row.dt.indexOf('ground') > -1 || row.dt.indexOf('construction') > -1) verified.ground += row.n;
      else if (row.dt.indexOf('flip') > -1) verified.flips += row.n;
      else verified.holds += row.n;
    }
  } catch (_) { /* no track records → zero experience */ }
  const claimed = (v, fb) => (v != null ? (Number(v) || 0) : fb);
  const exp = {
    flips: claimed(app.requested_exp_flips, verified.flips),
    holds: claimed(app.requested_exp_holds, verified.holds),
    ground: claimed(app.requested_exp_ground, verified.ground),
  };
  exp.total = (exp.flips || 0) + (exp.holds || 0) + (exp.ground || 0);
  exp.verified = verified;
  exp.verifiedTotal = verified.flips + verified.holds + verified.ground;

  // Repeat borrower = this borrower (or co-borrower) has any OTHER live loan file
  // with us. Best-effort; a failure just yields false.
  let repeatBorrower = false;
  try {
    const rb = await db.query(
      `SELECT count(*)::int AS n FROM applications
        WHERE id <> $1 AND deleted_at IS NULL
          AND (borrower_id = ANY($2::uuid[]) OR co_borrower_id = ANY($2::uuid[]))`,
      [appId, expIds]);
    repeatBorrower = (rb.rows[0] && rb.rows[0].n > 0) || false;
  } catch (_) { repeatBorrower = false; }

  // Released rehab draws (our own money ledger — draw_disbursements). Each row is
  // a wired draw; we sum the GROSS approved amount (what converts from the rehab
  // holdback into outstanding principal) with its release date (falling back to
  // when the row was recorded when the wire date is blank), for the seasoned-loan
  // "current balance / current rehab" snapshot. Cents in the ledger → dollars.
  // Best-effort: any error (or a DB without the draw system) → no draws → the tape
  // stays at origination values.
  let releases = [];
  try {
    const dr = await db.query(
      `SELECT approved_cents, COALESCE(release_date, created_at::date) AS rdate
         FROM draw_disbursements
        WHERE application_id = $1 AND kind = 'draw' AND funded_status = 'released'
        ORDER BY COALESCE(release_date, created_at::date)`, [appId]);
    releases = dr.rows
      .map((r) => ({ date: r.rdate ? String(r.rdate).slice(0, 10) : null, amount: (Number(r.approved_cents) || 0) / 100 }))
      .filter((r) => r.amount > 0);
  } catch (_) { releases = []; }

  // Property address is a jsonb blob on the application (no separate table).
  const addr = app.property_address || {};

  return {
    found: true,
    app,
    fico: num(app.pricing_fico),
    address: {
      line1: addr.line1 || addr.street || '',
      line2: addr.line2 || '',
      city: addr.city || '',
      state: addr.state || '',
      zip: addr.zip || '',
      oneLine: addr.oneLine || '',
    },
    borrower: { first: app.b_first, last: app.b_last, email: app.b_email, fico: num(app.b_fico), citizenship: app.b_citizenship },
    coBorrower: app.co_borrower_id ? { first: app.cb_first, last: app.cb_last, fico: num(app.cb_fico), citizenship: app.cb_citizenship } : null,
    vesting: { llc: app.vesting_llc || '', ein: app.vesting_ein || '', state: app.vesting_state || '' },
    officer: { name: app.officer_name || app.loan_officer_name || '', nmls: app.officer_nmls || '', email: app.officer_email || '', phone: app.officer_phone || '' },
    registration: reg,
    quote: (reg && reg.quote) || {},
    appraisal,
    exp,
    repeatBorrower,
    noteBuyerRaw: app.lender || null,
    // Released rehab draws for the seasoned-loan snapshot (see seasoning.js).
    releases,
    // Funding date proxy — the platform-wide "when the loan closed/funded" date.
    fundingDate: app.actual_closing || null,
    // Staff-entered answers for tape columns we can't derive (e.g. the Fidelis
    // New-Construction-only fields). Keyed by tape field key; see db/309.
    supplemental: app.tape_supplemental || {},
  };
}

module.exports = { assembleTapeLoan };
