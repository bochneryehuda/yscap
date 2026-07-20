'use strict';
/** Unit tests for the document↔condition mapping (condition-map.js). Pure — no DB. */
const assert = require('assert');
const { conditionsForDoc, purposeForDoc, docReadiness, fileConditionCoverage } = require('../src/lib/underwriting/condition-map');

// Each document points at the real checklist condition code(s) it supports (RTL + legacy).
assert.ok(conditionsForDoc('government_id').includes('rtl_p1_id') && conditionsForDoc('government_id').includes('gov_id'));
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
