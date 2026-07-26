#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the 1071 classifier (src/lib/underwriting/section-1071.js).
 * No DB. Exercises every classification branch.
 */
const assert = require('assert');
const { classify, SMALL_BUSINESS_REVENUE_CENTS, MIN_LOAN_CENTS } = require('../src/lib/underwriting/section-1071');

// ---- institution not covered → fastest off-ramp ----
{
  const r = classify({
    loan_amount_cents: 500000 * 100, borrower_gross_annual_revenue_cents: 500000 * 100,
    pilot_has_material_terms_authority: true, institution_covered: false,
  });
  assert.strictEqual(r.classification, 'not_covered_institution');
  assert.ok(/threshold/i.test(r.reason));
}

// ---- product carve-outs ----
{
  const inst = { institution_covered: true, loan_amount_cents: 500000 * 100 };
  assert.strictEqual(classify({ ...inst, is_mca: true }).classification, 'not_covered_product');
  assert.strictEqual(classify({ ...inst, is_agricultural: true }).classification, 'not_covered_product');
  assert.strictEqual(classify({ institution_covered: true, loan_amount_cents: 500 * 100 }).classification, 'not_covered_product');
  // At exactly $1,000 → not a carve-out (>= threshold).
  const r = classify({ institution_covered: true, loan_amount_cents: 1000 * 100,
    pilot_has_material_terms_authority: true, borrower_gross_annual_revenue_cents: 500000 * 100 });
  assert.notStrictEqual(r.classification, 'not_covered_product');
}

// ---- material-terms authority missing → pending ----
{
  const r = classify({
    institution_covered: true, loan_amount_cents: 500000 * 100,
    borrower_gross_annual_revenue_cents: 500000 * 100,
    pilot_has_material_terms_authority: null,
  });
  assert.strictEqual(r.classification, 'pending');
  assert.ok(/material-terms authority/i.test(r.reason));
}

// ---- material-terms authority = false → capital partner reports ----
{
  const r = classify({
    institution_covered: true, loan_amount_cents: 500000 * 100,
    borrower_gross_annual_revenue_cents: 500000 * 100,
    pilot_has_material_terms_authority: false,
  });
  assert.strictEqual(r.classification, 'covered_report_partner');
  assert.ok(/capital partner/i.test(r.reason));
}

// ---- material-terms authority TRUE + missing borrower revenue → pending ----
{
  const r = classify({
    institution_covered: true, loan_amount_cents: 500000 * 100,
    pilot_has_material_terms_authority: true, borrower_gross_annual_revenue_cents: null,
  });
  assert.strictEqual(r.classification, 'pending');
  assert.ok(/revenue/i.test(r.reason));
}

// ---- borrower gross revenue > $1M → not a small business ----
{
  const r = classify({
    institution_covered: true, loan_amount_cents: 500000 * 100,
    pilot_has_material_terms_authority: true,
    borrower_gross_annual_revenue_cents: SMALL_BUSINESS_REVENUE_CENTS + 1,
  });
  assert.strictEqual(r.classification, 'not_covered_borrower');
  assert.ok(/exceeds/i.test(r.reason));
}

// ---- borrower gross revenue ≤ $1M + PILOT has authority → PILOT reports ----
{
  const r = classify({
    institution_covered: true, loan_amount_cents: 500000 * 100,
    pilot_has_material_terms_authority: true,
    borrower_gross_annual_revenue_cents: SMALL_BUSINESS_REVENUE_CENTS,
  });
  assert.strictEqual(r.classification, 'covered_report_pilot');
  assert.ok(/small business/i.test(r.reason));
}

// ---- borrower revenue $0/negative → pending (missing capture) ----
{
  const r0 = classify({
    institution_covered: true, loan_amount_cents: 500000 * 100,
    pilot_has_material_terms_authority: true,
    borrower_gross_annual_revenue_cents: 0,
  });
  assert.strictEqual(r0.classification, 'pending');
}

// ---- constants sanity ----
assert.strictEqual(SMALL_BUSINESS_REVENUE_CENTS, 100000000);   // $1M = 100M cents
assert.strictEqual(MIN_LOAN_CENTS, 100000);                    // $1,000 = 100K cents

console.log('test-section-1071-pure: every classification branch pass');
