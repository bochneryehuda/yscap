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

const APPRAISAL_BACK = 'rtl_cond_appraisaldocs';
const APPRAISAL_REVIEW = 'rtl_p3_apprreview';
const PRODUCT_PRICING = 'rtl_p1_product';

async function esignSendGate(applicationId, { db = dbDefault } = {}) {
  const r = await db.query(
    `SELECT t.code, ci.status, ci.signed_off_at
       FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1 AND t.code = ANY($2)`,
    [applicationId, [APPRAISAL_BACK, APPRAISAL_REVIEW, PRODUCT_PRICING]]);
  const by = {};
  for (const row of r.rows) by[row.code] = row;

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

  return { ready: apprOk && reviewOk && ppOk, outstanding };
}

module.exports = { esignSendGate, APPRAISAL_BACK, APPRAISAL_REVIEW, PRODUCT_PRICING };
