'use strict';
/** Unit tests for the document↔condition mapping (condition-map.js). Pure — no DB. */
const assert = require('assert');
const { conditionsForDoc, purposeForDoc, docReadiness, fileConditionCoverage, docTypesForCode, expectedDocTypeForCode } = require('../src/lib/underwriting/condition-map');

// Each document points at the real checklist condition code(s) it supports (RTL + legacy).
assert.ok(conditionsForDoc('government_id').includes('rtl_p1_id') && conditionsForDoc('government_id').includes('gov_id'));

// The insurance condition is backed by TWO document types: the binder AND the paid invoice.
assert.ok(conditionsForDoc('insurance').includes('rtl_cond_insurance'), 'the binder backs the insurance condition');
assert.ok(conditionsForDoc('insurance_invoice').includes('rtl_cond_insurance'), 'the paid invoice also backs the insurance condition');
assert.ok(/paid|invoice/i.test(purposeForDoc('insurance_invoice')), 'the invoice purpose names the paid receipt');
{
  const types = docTypesForCode('rtl_cond_insurance');
  assert.ok(types.includes('insurance') && types.includes('insurance_invoice'), 'the insurance condition maps to both the binder and the invoice');
  // The auto-reader reads a document filed under the insurance condition as the BINDER (the primary),
  // so adding the invoice type must not change which type the reader expects there.
  assert.strictEqual(expectedDocTypeForCode('rtl_cond_insurance'), 'insurance', 'the binder stays the primary/expected type for the insurance condition');
}

// The flood determination is filed under its OWN condition (rtl_cond_flood), not the insurance
// condition — so it reads AS a flood determination and its condition shows covered.
assert.deepStrictEqual(conditionsForDoc('flood'), ['rtl_cond_flood'], 'flood maps to its own flood condition');
assert.strictEqual(expectedDocTypeForCode('rtl_cond_flood'), 'flood', 'the flood condition expects a flood determination');
assert.ok(!docTypesForCode('rtl_cond_insurance').includes('flood'), 'flood no longer rides the insurance condition');
assert.ok(conditionsForDoc('operating_agreement').includes('rtl_llc_opagmt') && conditionsForDoc('operating_agreement').includes('rtl_p1_llc'));
assert.ok(conditionsForDoc('bank_statement').includes('rtl_p3_assets'));
assert.ok(conditionsForDoc('background_report').includes('rtl_cond_fraud'));
assert.deepStrictEqual(conditionsForDoc('unknown_type'), []);
assert.ok(/identity/i.test(purposeForDoc('government_id')));

// Readiness from findings.
assert.strictEqual(docReadiness([]), 'clean');
assert.strictEqual(docReadiness([{ severity: 'warning', status: 'open' }]), 'issues');
assert.strictEqual(docReadiness([{ severity: 'fatal', status: 'open' }]), 'blocked');
assert.strictEqual(docReadiness([{ severity: 'fatal', status: 'resolved' }]), 'clean', 'resolved findings do not block');

// File coverage: three conditions, one analyzed clean, one analyzed blocked, one not analyzed.
{
  const cov = fileConditionCoverage({
    conditions: [
      { code: 'rtl_p1_id', label: 'Borrower ID' },
      { code: 'rtl_cond_title', label: 'Title' },
      { code: 'rtl_p3_assets', label: 'Bank statements' },
      { code: 'rtl_p2_sp', label: 'SharePoint built' }, // not a document condition → excluded
    ],
    extractions: [
      { doc_type: 'government_id', document_id: 'd1' },
      { doc_type: 'title', document_id: 'd2' },
    ],
    findings: [
      { source: 'title', severity: 'fatal', status: 'open' },       // blocks the title condition
      { source: 'government_id', severity: 'info', status: 'open' }, // id is fine
    ],
  });
  const byCode = Object.fromEntries(cov.map((c) => [c.code, c]));
  assert.ok(!byCode.rtl_p2_sp, 'a non-document condition is excluded from coverage');
  assert.strictEqual(byCode.rtl_p1_id.analyzed, true);
  assert.strictEqual(byCode.rtl_p1_id.readiness, 'clean', 'ID analyzed with only an info finding → clean');
  assert.strictEqual(byCode.rtl_cond_title.readiness, 'blocked', 'title has an open fatal → blocked');
  assert.strictEqual(byCode.rtl_p3_assets.analyzed, false);
  assert.strictEqual(byCode.rtl_p3_assets.readiness, 'not_analyzed', 'no bank statement analyzed yet');
}

console.log('✓ test-underwriting-conditionmap: document↔condition mapping + file coverage pass');
