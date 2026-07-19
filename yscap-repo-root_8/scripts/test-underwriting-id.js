'use strict';
/**
 * Unit tests for the government-ID findings engine (src/lib/underwriting/id-checks.js).
 * Pure logic — no DB, no network, no keys. Mirrors scripts/test-appraisal-findings.js.
 */
const assert = require('assert');
const { computeIdFindings, summarize } = require('../src/lib/underwriting/id-checks');

const TODAY = '2026-07-19';
const borrower = {
  first_name: 'John', last_name: 'Smith', date_of_birth: '1980-05-15',
  current_address: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  prior_address:   { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' },
};
const goodId = {
  documentType: 'driver_license', firstName: 'John', lastName: 'Smith', fullName: 'John Smith',
  dateOfBirth: '1980-05-15',
  address: { line1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701' },
  documentNumber: 'TX1234567', expirationDate: '2028-01-01', issueDate: '2022-01-01',
  readable: true, notes: null,
};
const codes = (fs) => fs.map((f) => f.code).sort();

// 1. Clean, matching ID → no findings.
{
  const f = computeIdFindings(goodId, borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), [], 'a matching ID should raise no findings');
  assert.strictEqual(summarize(f).blocksCtc, false);
}

// 2. Name spelling mismatch → FATAL, blocks CTC.
{
  const f = computeIdFindings({ ...goodId, firstName: 'Jon', fullName: 'Jon Smith' }, borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), ['id_name_mismatch']);
  assert.strictEqual(f[0].severity, 'fatal');
  assert.strictEqual(summarize(f).blocksCtc, true, 'a name mismatch must block clear-to-close');
}

// 3. Date-of-birth mismatch → FATAL.
{
  const f = computeIdFindings({ ...goodId, dateOfBirth: '1980-05-16' }, borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), ['id_dob_mismatch']);
  assert.strictEqual(summarize(f).blocksCtc, true);
}

// 4. Address differs from BOTH current and prior → WARNING (not blocking).
{
  const f = computeIdFindings(
    { ...goodId, address: { line1: '500 Pine Rd', city: 'Houston', state: 'TX', zip: '77002' } },
    borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), ['id_address_mismatch']);
  assert.strictEqual(f[0].severity, 'warning');
  assert.strictEqual(summarize(f).blocksCtc, false, 'an address mismatch is a warning, not a blocker');
}

// 5. Address matches the borrower's PRIOR address → no false address finding.
{
  const f = computeIdFindings(
    { ...goodId, address: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' } },
    borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), [], 'an ID showing the known prior address should not flag');
}

// 6. Expired ID → WARNING.
{
  const f = computeIdFindings({ ...goodId, expirationDate: '2024-01-01' }, borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), ['id_expired']);
  assert.strictEqual(f[0].severity, 'warning');
}

// 7. Unreadable ID → single verify finding, and NO false mismatches even if other fields differ.
{
  const f = computeIdFindings(
    { ...goodId, readable: false, firstName: 'Zzz', dateOfBirth: '1900-01-01' },
    borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), ['id_unreadable']);
  assert.strictEqual(f[0].opensCondition, 'underwriting_review_cleared');
}

// 8. Multiple fatals compound and still block.
{
  const f = computeIdFindings({ ...goodId, firstName: 'Jon', fullName: 'Jon Smith', dateOfBirth: '1980-05-16' }, borrower, { today: TODAY });
  assert.deepStrictEqual(codes(f), ['id_dob_mismatch', 'id_name_mismatch']);
  assert.strictEqual(summarize(f).fatal, 2);
  assert.strictEqual(summarize(f).blocksCtc, true);
}

console.log('✓ test-underwriting-id: all government-ID findings cases pass');
