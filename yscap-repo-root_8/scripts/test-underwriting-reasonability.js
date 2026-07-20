'use strict';
/**
 * Unit tests for the reasonability (value-level plausibility) engine (reasonability.js).
 * Pure — no AI, no DB. Verifies every rule fires on an implausible value, stays quiet on a sane
 * file, never emits a fatal (the layer is advisory), and never double-flags legitimately-future
 * dates (a contract's closing date, an ID/policy expiration, a policy effective date).
 */
const assert = require('assert');
const { assessReasonability, _internals } = require('../src/lib/underwriting/reasonability');

const TODAY = '2026-07-20';
const codesOf = (r) => r.findings.map((f) => f.code).sort();
const has = (r, code) => r.findings.some((f) => f.code === code);

// ---- A clean, sane file raises nothing ----
{
  const r = assessReasonability({
    today: TODAY,
    economics: { purchasePrice: 400000, loanAmount: 300000, asIsValue: 420000, arv: 550000, rehabBudget: 60000 },
    extractions: [
      { doc_type: 'government_id', document_id: 'd1', fields: { dateOfBirth: '1980-05-01', issueDate: '2022-01-01', expirationDate: '2030-01-01' } },
      { doc_type: 'purchase_contract', document_id: 'd2', fields: { purchasePrice: 400000, earnestMoney: 20000, closingDate: '2026-09-01' } },
      { doc_type: 'insurance', document_id: 'd3', fields: { policyEffective: '2026-07-01', policyExpiration: '2027-07-01' } },
      { doc_type: 'credit_report', document_id: 'd4', fields: { dob: '1980-05-01', reportDate: '2026-07-01', ficoScore: 720 } },
      { doc_type: 'settlement', document_id: 'd5', fields: { totalSources: 500000, totalUses: 500000 } },
    ],
  });
  assert.strictEqual(r.findings.length, 0, 'a sane file raises nothing');
  // A future closing date and future expirations are legitimate — never flagged.
  assert.ok(!has(r, 'document_future_dated'), 'a future closing/expiration is not a future-dating flag');
}

// ---- Every finding is advisory: warning or info, never fatal, never CTC-blocking ----
{
  const r = assessReasonability({
    today: TODAY,
    economics: { purchasePrice: -1, loanAmount: -5, asIsValue: 600000, arv: 500000, rehabBudget: 700000, assignmentFee: 20000, underlyingPrice: 100000 },
    extractions: [
      { doc_type: 'government_id', document_id: 'd1', fields: { dateOfBirth: '2015-01-01', issueDate: '2030-01-01', expirationDate: '2020-01-01' } },
      { doc_type: 'credit_report', document_id: 'd2', fields: { ficoScore: 999, reportDate: '2027-01-01' } },
      { doc_type: 'settlement', document_id: 'd3', fields: { totalSources: 500000, totalUses: 400000 } },
    ],
  });
  assert.ok(r.findings.length > 0, 'the implausible file raises findings');
  for (const f of r.findings) {
    assert.ok(f.severity === 'warning' || f.severity === 'info', `${f.code} is advisory`);
    assert.notStrictEqual(f.severity, 'fatal', 'reasonability never emits a fatal');
    assert.strictEqual(f.blocksCtc, false, `${f.code} never blocks clear-to-close`);
    assert.ok(Array.isArray(f.actions) && f.actions.length, `${f.code} carries an action menu`);
    assert.strictEqual(f.source, 'reasonability');
  }
}

// ---- Non-positive purchase price ----
{
  const r = assessReasonability({ today: TODAY, economics: { purchasePrice: 0 } });
  assert.ok(has(r, 'purchase_price_nonpositive'), 'zero price flagged');
  const r2 = assessReasonability({ today: TODAY, economics: { purchasePrice: -100 } });
  assert.ok(has(r2, 'purchase_price_nonpositive'), 'negative price flagged');
}

// ---- Negative amounts, per field ----
{
  const r = assessReasonability({ today: TODAY, economics: { purchasePrice: 400000, loanAmount: -1, rehabBudget: -2 } });
  const neg = r.findings.filter((f) => f.code === 'amount_negative').map((f) => f.field).sort();
  assert.deepStrictEqual(neg, ['loan_amount', 'rehab_budget'], 'each negative amount flagged by field');
}

// ---- Rehab > ARV and As-is > ARV ----
{
  const r = assessReasonability({ today: TODAY, economics: { purchasePrice: 400000, arv: 500000, rehabBudget: 600000, asIsValue: 550000 } });
  assert.ok(has(r, 'rehab_exceeds_arv'), 'rehab over ARV flagged');
  assert.ok(has(r, 'asis_exceeds_arv'), 'as-is over ARV flagged');
}

// ---- Assignment math reconciliation (info) ----
{
  // 100k seller + 20k fee should be 120k; file says 130k → unreconciled.
  const bad = assessReasonability({ today: TODAY, economics: { purchasePrice: 130000, underlyingPrice: 100000, assignmentFee: 20000 } });
  assert.ok(has(bad, 'assignment_math_unreconciled'), 'a mismatched assignment total is flagged');
  assert.strictEqual(bad.findings.find((f) => f.code === 'assignment_math_unreconciled').severity, 'info');
  // 100k + 20k = 120k exactly → quiet.
  const ok = assessReasonability({ today: TODAY, economics: { purchasePrice: 120000, underlyingPrice: 100000, assignmentFee: 20000 } });
  assert.ok(!has(ok, 'assignment_math_unreconciled'), 'a reconciled assignment is quiet');
}

// ---- Future-dated document (an "as of" date), NOT a legitimately-future date ----
{
  const r = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'credit_report', document_id: 'd1', fields: { reportDate: '2026-12-01' } },
  ] });
  assert.ok(has(r, 'document_future_dated'), 'a credit report dated in the future is flagged');
  // Grace: a report dated today is not "future".
  const r2 = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'credit_report', document_id: 'd1', fields: { reportDate: TODAY } },
  ] });
  assert.ok(!has(r2, 'document_future_dated'), 'a document dated today is fine');
}

// ---- Inverted date pairs ----
{
  const id = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'government_id', document_id: 'd1', fields: { issueDate: '2022-01-01', expirationDate: '2018-01-01', dateOfBirth: '1980-01-01' } },
  ] });
  assert.ok(has(id, 'id_dates_inverted'), 'expiration before issue flagged');

  const born = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'government_id', document_id: 'd1', fields: { issueDate: '1975-01-01', dateOfBirth: '1980-01-01', expirationDate: '2030-01-01' } },
  ] });
  assert.ok(has(born, 'id_issued_before_birth'), 'ID issued before birth flagged');

  const pol = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'insurance', document_id: 'd1', fields: { policyEffective: '2026-07-01', policyExpiration: '2026-01-01' } },
  ] });
  assert.ok(has(pol, 'policy_dates_inverted'), 'policy expiring before effective flagged');
}

// ---- DOB age plausibility ----
{
  const young = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'government_id', document_id: 'd1', fields: { dateOfBirth: '2015-06-01' } },
  ] });
  assert.ok(has(young, 'borrower_underage'), 'under-18 DOB flagged');

  // 1900 parses (toISODate floors at year 1900) and yields age 126 → implausible.
  const old = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'credit_report', document_id: 'd1', fields: { dob: '1900-01-01' } },
  ] });
  assert.ok(has(old, 'dob_implausible'), 'impossible age flagged');

  // A 17th-birthday edge: born 2009-07-21, today 2026-07-20 → still 16 (birthday tomorrow) → underage.
  assert.strictEqual(_internals.ageOn('2009-07-21', '2026-07-20'), 16, 'age math respects the day-of-month');
  assert.strictEqual(_internals.ageOn('2009-07-20', '2026-07-20'), 17, 'age turns over on the birthday');
}

// ---- Earnest money larger than the price ----
{
  const r = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'purchase_contract', document_id: 'd1', fields: { purchasePrice: 100000, earnestMoney: 250000 } },
  ] });
  assert.ok(has(r, 'earnest_exceeds_price'), 'deposit over the price flagged');
}

// ---- Ownership percentage out of range ----
{
  const r = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'operating_agreement', document_id: 'd1', fields: { members: [{ name: 'A', ownershipPct: 50 }, { name: 'B', ownershipPct: 150 }] } },
  ] });
  assert.ok(has(r, 'ownership_pct_out_of_range'), 'a >100% ownership share flagged');
}

// ---- FICO out of range ----
{
  const r = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'credit_report', document_id: 'd1', fields: { ficoScore: 250 } },
  ] });
  assert.ok(has(r, 'fico_out_of_range'), 'a sub-300 FICO flagged');
}

// ---- Settlement out of balance ----
{
  const r = assessReasonability({ today: TODAY, extractions: [
    { doc_type: 'settlement', document_id: 'd1', fields: { totalSources: 500000, totalUses: 480000 } },
  ] });
  assert.ok(has(r, 'settlement_out_of_balance'), 'sources ≠ uses flagged');
}

// ---- Never-guess: missing values raise nothing (empty in → empty out) ----
{
  const r = assessReasonability({ today: TODAY, economics: {}, extractions: [
    { doc_type: 'government_id', document_id: 'd1', fields: {} },
    { doc_type: 'settlement', document_id: 'd2', fields: { totalSources: 500000 } }, // only one side → can't judge balance
  ] });
  assert.strictEqual(r.findings.length, 0, 'absent values are never judged');
  // The transparency list still records the rules that ran.
  assert.ok(Array.isArray(r.checks) && r.checks.length > 0, 'checks list is populated');
}

// ---- No `today` → date-relative rules simply skip (never throw) ----
{
  const r = assessReasonability({ economics: { purchasePrice: 400000 }, extractions: [
    { doc_type: 'credit_report', document_id: 'd1', fields: { reportDate: '2099-01-01', dob: '2015-01-01' } },
  ] });
  assert.ok(!has(r, 'document_future_dated'), 'no today → no future-dating judgment');
  assert.ok(!has(r, 'borrower_underage'), 'no today → no age judgment');
}

console.log('test-underwriting-reasonability: plausibility rules, advisory-only, future-date grace, never-guess pass');
