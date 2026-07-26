'use strict';
/**
 * CFPB Section 1071 coverage classifier — R2.10 (owner-directed 2026-07-22,
 * deep-research pass). For every loan on file, decide whether PILOT is on
 * the hook to collect small-business lending data for the 1071 report that
 * goes live January 1, 2028.
 *
 * The classifier composes three inputs:
 *   1. borrower_gross_annual_revenue_cents (per file — captured on the
 *      application) → is the borrower a "small business" (≤ $1M)?
 *   2. pilot_has_material_terms_authority (per file, boolean) → in a
 *      correspondent / table-funded structure, only the LAST institution with
 *      authority to set price / amount / repayment terms reports; if PILOT
 *      isn't that institution, the capital partner is the reporter.
 *   3. institution-level flag INSTITUTION_1071_COVERED (env / config) →
 *      the rule's institutional threshold rose to 1,000 covered originations
 *      in each of the prior two calendar years. If PILOT is below that,
 *      NOTHING needs to be reported — the whole obligation is off.
 *
 * The classifier ALWAYS returns a verdict + a plain-language reason. Missing
 * inputs land as 'pending' (never guessed).
 *
 * Product carve-outs (from the Small Entity Compliance Guide):
 *   * MCAs (merchant cash advance),
 *   * agricultural loans,
 *   * loans under $1,000.
 * Everything else — including business-purpose commercial-real-estate loans
 * (DSCR / Bridge / Fix-and-Flip / Ground-Up to an LLC investor entity) — is
 * a "covered credit transaction" if the borrower is a small business.
 *
 * Pure classify() takes inputs, returns { classification, reason, inputs }.
 * classifyAndPersist(client, appId) reads the file's inputs, calls classify,
 * writes a new section_1071_coverage row (superseding the prior current if
 * the verdict changed) — full audit trail preserved.
 */
let _db = null;
const db = () => (_db || (_db = require('../../db')));

// Environment flag: has PILOT met the 1,000-originations institutional
// threshold in each of the prior two calendar years? Default FALSE — the
// safer assumption for a private-lending platform (the CFPB's own impact
// estimate was that only 172-181 depository institutions would be covered
// under the final rule).
function institutionCovered() {
  return process.env.INSTITUTION_1071_COVERED === '1';
}

const SMALL_BUSINESS_REVENUE_CENTS = 100 * 100 * 10000;   // $1,000,000 as integer cents
const MIN_LOAN_CENTS = 1000 * 100;                        // $1,000 minimum

/**
 * PURE — classify one loan.
 * @param {object} inputs
 *   inputs.loan_amount_cents           — integer cents (required to check the $1,000 carve-out)
 *   inputs.loan_type                   — 'bridge' | 'flip' | 'fix-and-hold' | 'ground-up' | 'rental' | ...
 *                                        The pricing engine's loan-type vocabulary. MCA / agricultural
 *                                        are not in it today, so PILOT's own loans never hit those
 *                                        carve-outs organically.
 *   inputs.is_mca                      — bool (from a future MCA product; today always false)
 *   inputs.is_agricultural             — bool
 *   inputs.borrower_gross_annual_revenue_cents — bigint or null
 *   inputs.pilot_has_material_terms_authority   — bool or null
 *   inputs.institution_covered          — bool (from env)
 * @returns {{classification, reason, inputs}}
 */
function classify(inputs) {
  const inp = inputs || {};
  const rec = (classification, reason) => ({ classification, reason, inputs: inp });

  // 1. Institution-level: if PILOT is below the 1,000-originations threshold,
  //    nothing needs to be collected or reported. This is the FASTEST off-ramp
  //    — saves burden until PILOT genuinely scales past the threshold.
  if (!inp.institution_covered) {
    return rec('not_covered_institution',
      'PILOT is below the CFPB threshold of 1,000 covered small-business originations in each of the prior two calendar years — the reporting obligation does not apply to this institution. Re-classify when annual origination volume changes materially.');
  }

  // 2. Product carve-outs: MCAs, agricultural loans, loans under $1,000.
  if (inp.is_mca === true) {
    return rec('not_covered_product',
      'Merchant cash advances are carved out of the 1071 rule.');
  }
  if (inp.is_agricultural === true) {
    return rec('not_covered_product',
      'Agricultural loans are carved out of the 1071 rule.');
  }
  const loanCents = Number(inp.loan_amount_cents);
  if (Number.isFinite(loanCents) && loanCents > 0 && loanCents < MIN_LOAN_CENTS) {
    return rec('not_covered_product',
      `Loan amount is under $1,000 — below the 1071 threshold for a covered credit transaction.`);
  }

  // 3. Material-terms authority: in correspondent / table-funded structures
  //    the CAPITAL PARTNER (last with authority to set price / amount /
  //    duration) reports, not PILOT. Missing flag → pending (never guess).
  if (inp.pilot_has_material_terms_authority == null) {
    return rec('pending',
      'Set the "PILOT has material-terms authority" flag on this file — it decides who owns the 1071 report in a correspondent structure.');
  }
  if (inp.pilot_has_material_terms_authority === false) {
    return rec('covered_report_partner',
      'The capital partner is the last institution with authority to set material terms on this loan, so PILOT is not the reporting institution — the capital partner owns the 1071 report if the borrower is a small business.');
  }

  // 4. Small-business borrower check. Missing revenue capture → pending.
  const rev = Number(inp.borrower_gross_annual_revenue_cents);
  if (!Number.isFinite(rev) || rev <= 0) {
    return rec('pending',
      'Capture the borrower entity\'s gross annual revenue on this file — required to decide whether the borrower is a "small business" under 1071 ($1M or less gross revenue).');
  }
  if (rev > SMALL_BUSINESS_REVENUE_CENTS) {
    return rec('not_covered_borrower',
      `Borrower entity gross annual revenue $${Math.round(rev / 100).toLocaleString('en-US')} exceeds the 1071 "small business" threshold ($1,000,000) — not a covered borrower.`);
  }

  return rec('covered_report_pilot',
    `Borrower entity is a small business (gross revenue $${Math.round(rev / 100).toLocaleString('en-US')} ≤ $1M) and PILOT is the last institution with material-terms authority — PILOT owns the 1071 report for this loan.`);
}

/**
 * DB — read a file's inputs + classify + persist. Supersedes the prior
 * current row if the verdict changed; a no-op update if not.
 * Runs on the caller's transaction.
 * @returns {{classification, reason, changed, inputs, id}}
 */
async function classifyAndPersist(client, appId) {
  if (!appId) throw new Error('classifyAndPersist: appId required');
  const app = (await client.query(
    `SELECT loan_amount, loan_type, borrower_gross_annual_revenue_cents,
            pilot_has_material_terms_authority
       FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!app) throw new Error('classifyAndPersist: application not found');
  const inputs = {
    loan_amount_cents: app.loan_amount != null ? Math.round(Number(app.loan_amount) * 100) : null,
    loan_type: app.loan_type || null,
    is_mca: false,   // no MCA product today; wire when one exists
    is_agricultural: false,
    borrower_gross_annual_revenue_cents: app.borrower_gross_annual_revenue_cents != null ? Number(app.borrower_gross_annual_revenue_cents) : null,
    pilot_has_material_terms_authority: app.pilot_has_material_terms_authority,
    institution_covered: institutionCovered(),
  };
  const verdict = classify(inputs);
  const cur = (await client.query(
    `SELECT id, classification FROM section_1071_coverage WHERE application_id=$1 AND superseded_at IS NULL`,
    [appId])).rows[0];
  const changed = !cur || cur.classification !== verdict.classification;
  if (!changed) return { ...verdict, changed: false, id: cur.id };
  if (cur) {
    await client.query(`UPDATE section_1071_coverage SET superseded_at=now() WHERE id=$1`, [cur.id]);
  }
  const ins = await client.query(
    `INSERT INTO section_1071_coverage
       (application_id, classification, reason, inputs_snapshot, classifier_version)
     VALUES ($1,$2,$3,$4::jsonb,'v1') RETURNING id`,
    [appId, verdict.classification, verdict.reason, JSON.stringify(inputs)]);
  return { ...verdict, changed: true, id: ins.rows[0].id };
}

/** Read the current live classification for a file. */
async function currentForFile(appId, client) {
  client = client || db();
  const r = await client.query(
    `SELECT * FROM section_1071_coverage WHERE application_id=$1 AND superseded_at IS NULL`, [appId]);
  return r.rows[0] || null;
}

module.exports = {
  SMALL_BUSINESS_REVENUE_CENTS, MIN_LOAN_CENTS,
  institutionCovered, classify, classifyAndPersist, currentForFile,
};
