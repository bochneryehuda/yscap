/**
 * esign/gate.js — the appraisal send-gate (owner-directed 2026-07-19).
 *
 * A DocuSign package (term-sheet OR Iska) may be sent ONLY after all three:
 *   1. Appraisal is back        — rtl_cond_appraisaldocs is satisfied.
 *   2. Appraisal review cleared — rtl_p3_apprreview is satisfied.
 *   3. P&P re-signed AFTER the appraisal — rtl_p1_product is satisfied AND its
 *      signed_off_at >= the appraisal-back time. A P&P sign-off from BEFORE the
 *      appraisal does NOT count (enforces "re-registered on the appraised value").
 *
 * Returns { ready, outstanding:[{code,label,reason}] } for the staff UI. The
 * server re-checks this on the actual send — the client is never trusted.
 * No-guessing: if the appraisal has no sign-off timestamp to compare against, the
 * "re-signed after" test cannot be proven, so P&P is treated as NOT ready.
 *
 * See docs/DOCUSIGN-WORKFORCE-BUILD-SPEC.md §2.
 */
const dbDefault = require('../../db');
const manualProgram = require('../manual-program');

const APPRAISAL_BACK = 'rtl_cond_appraisaldocs';
const APPRAISAL_REVIEW = 'rtl_p3_apprreview';
const PRODUCT_PRICING = 'rtl_p1_product';

/**
 * R6.4 — MANUAL is a STOP, not a clean approval. A binding DocuSign package may
 * NOT issue while the current registration is MANUAL/Manual-Program and still
 * awaiting a super-admin exception approval, or while it is STALE (priced on
 * inputs that have since changed). The borrower "terms ready" email already
 * withholds for MANUAL (needsSuperAdminApproval), but the ISSUANCE gate had
 * diverged from it — this closes that gap (audit-flagged, the critical fix).
 *
 * Returns an array of outstanding blockers (empty when the registration is
 * issuable). Fails CLOSED: if the registration can't be read, it is treated as
 * not-issuable (never a silent pass).
 */
async function registrationIssuabilityBlockers(applicationId, db) {
  const out = [];
  let reg;
  try {
    reg = (await db.query(
      `SELECT status, is_manual, stale, stale_reason
         FROM product_registrations
        WHERE application_id = $1 AND is_current
        ORDER BY created_at DESC LIMIT 1`, [applicationId])).rows[0] || null;
  } catch (_) {
    return [{ code: 'registration', label: 'Product registration', reason: 'Could not confirm the registration status — cannot issue.' }];
  }
  // No current registration → the P&P condition check already covers this; don't
  // duplicate a blocker here.
  if (!reg) return out;

  if (reg.stale) {
    out.push({ code: 'registration_stale', label: 'Registration is current',
      reason: reg.stale_reason || 'The registered terms were priced on inputs that have since changed — re-register on the current inputs and issue a new term sheet.' });
  }

  // MANUAL / Manual-Program requires a recorded super-admin approval. It is
  // approved only when there is NO open/countered escalation for the file.
  const isManual = manualProgram.needsSuperAdminApproval({ program: reg.is_manual ? 'manual' : undefined, status: reg.status });
  if (isManual) {
    let pending = null;
    try { pending = await manualProgram.pendingForApp(applicationId, db); }
    catch (_) { pending = { unknown: true }; }
    if (pending) {
      out.push({ code: 'manual_approval', label: 'Super-admin exception approval',
        reason: 'This is a manual-review structure. A super-admin must approve the exception before a term sheet can be issued.' });
    }
  }
  return out;
}

async function esignSendGate(applicationId, { db = dbDefault, purpose } = {}) {
  const r = await db.query(
    `SELECT t.code, ci.status, ci.signed_off_at
       FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = ANY($2)
      ORDER BY ci.created_at DESC`,
    [applicationId, [APPRAISAL_BACK, APPRAISAL_REVIEW, PRODUCT_PRICING]]);
  // Newest row per code (a stale duplicate must never let the gate read an old
  // 'satisfied' when the current one reopened) — matches resolveConditionItem.
  const by = {};
  for (const row of r.rows) if (!(row.code in by)) by[row.code] = row;

  const outstanding = [];
  const appr = by[APPRAISAL_BACK];
  const review = by[APPRAISAL_REVIEW];
  const pp = by[PRODUCT_PRICING];

  const apprOk = !!(appr && appr.status === 'satisfied');
  if (!apprOk) outstanding.push({ code: APPRAISAL_BACK, label: 'Appraisal documents received', reason: 'The appraisal must be back and this condition signed off.' });

  const reviewOk = !!(review && review.status === 'satisfied');
  if (!reviewOk) outstanding.push({ code: APPRAISAL_REVIEW, label: 'Appraisal review cleared', reason: 'The internal appraisal review must be signed off.' });

  // P&P must be satisfied AND provably re-signed at/after the appraisal came back.
  const apprAt = appr && appr.signed_off_at;
  let ppOk = false;
  if (!(pp && pp.status === 'satisfied')) {
    outstanding.push({ code: PRODUCT_PRICING, label: 'Product & pricing registered', reason: 'Register and sign off product & pricing.' });
  } else if (!apprOk) {
    // Appraisal not back yet — the re-sign-after test can't pass. (Appraisal already flagged above.)
    outstanding.push({ code: PRODUCT_PRICING, label: 'Product & pricing re-registered after appraisal', reason: 'Re-register product & pricing on the appraised value once the appraisal is back.' });
  } else if (apprAt && pp.signed_off_at && new Date(pp.signed_off_at) >= new Date(apprAt)) {
    ppOk = true;
  } else {
    outstanding.push({ code: PRODUCT_PRICING, label: 'Product & pricing re-registered after appraisal', reason: 'Product & pricing was signed off before the appraisal (or the timing cannot be confirmed). Re-register on the appraised value and sign off again.' });
  }

  // Estimated closing date required for the TERM SHEET package (owner-directed
  // 2026-07-22): the final term sheet's first-payment + maturity dates are derived
  // from the estimated closing date, so it must be on the file before the package
  // is sent for signature — otherwise the signed term sheet is missing those dates.
  // Applies to the term-sheet package AND the default/UI readiness view; the Heter
  // Iska package (which carries no such dates) is exempt.
  let closingOk = true;
  if (purpose !== 'heter_iska') {
    // The canonical closing date is applications.expected_closing (staff-editable,
    // ClickUp-synced); est_closing_date is the term-sheet mirror. Accept EITHER so
    // the gate is satisfied no matter which surface the date was entered on.
    const cd = await db.query(`SELECT expected_closing, est_closing_date FROM applications WHERE id = $1`, [applicationId]);
    const row = cd.rows[0] || {};
    closingOk = !!(row.expected_closing || row.est_closing_date);
    if (!closingOk) outstanding.push({
      code: 'expected_closing',
      label: 'Estimated closing date',
      reason: 'Enter the estimated closing date so the term sheet’s first payment and maturity dates are built correctly before the package is sent for signature.',
    });
  }

  // R6.4 — MANUAL/stale registration is a hard stop for ISSUANCE (not just the
  // borrower email). Appended after the appraisal/P&P checks so the staff UI
  // shows every blocker at once.
  const regBlockers = await registrationIssuabilityBlockers(applicationId, db);
  for (const b of regBlockers) outstanding.push(b);

  return { ready: apprOk && reviewOk && ppOk && closingOk && regBlockers.length === 0, outstanding };
}

/**
 * The moment the appraisal came back (its condition's signed_off_at) — the same
 * anchor the gate uses to prove "P&P re-signed AFTER the appraisal." Used to prove
 * a stored package document (term sheet / application export) was ALSO produced on
 * the appraised value: a doc created before this instant predates the appraisal and
 * may carry a pre-appraisal loan figure. Returns a Date or null (no appraisal yet).
 */
async function appraisalBackAt(applicationId, { db = dbDefault } = {}) {
  const r = await db.query(
    `SELECT ci.signed_off_at
       FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = $2 AND ci.status = 'satisfied'
      ORDER BY ci.created_at DESC
      LIMIT 1`, [applicationId, APPRAISAL_BACK]);
  const at = r.rows[0] && r.rows[0].signed_off_at;
  return at ? new Date(at) : null;
}

module.exports = { esignSendGate, registrationIssuabilityBlockers, appraisalBackAt, APPRAISAL_BACK, APPRAISAL_REVIEW, PRODUCT_PRICING };
