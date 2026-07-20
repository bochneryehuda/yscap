'use strict';
/**
 * Unit tests for the government-ID findings engine (src/lib/underwriting/id-checks.js).
 * Pure logic — no DB, no network, no keys. Includes the audit's false-fatal cases.
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
const idFindings = (over) => computeIdFindings({ ...goodId, ...over }, borrower, { today: TODAY });

// 1. Clean, matching ID → no findings.
assert.deepStrictEqual(codes(idFindings({})), [], 'a matching ID should raise no findings');
assert.strictEqual(summarize(idFindings({})).blocksCtc, false);

// --- Audit false-fatal fixes: tolerant name matching (must NOT flag) ---
assert.deepStrictEqual(codes(idFindings({ firstName: 'John', lastName: 'Smith', fullName: 'John Andrew Smith' })), [], 'middle name must not fatal');
assert.deepStrictEqual(codes(idFindings({ fullName: 'John A Smith', firstName: 'John', lastName: 'Smith' })), [], 'middle initial must not fatal');
assert.deepStrictEqual(codes(idFindings({ firstName: null, lastName: null, fullName: 'SMITH, JOHN' })), [], '"LAST, FIRST" order must not fatal');
assert.deepStrictEqual(codes(idFindings({ firstName: 'John', lastName: 'Smith Jr' })), [], 'Jr suffix must not fatal');

// 2. A real spelling difference IS still caught → FATAL.
{
  const f = idFindings({ firstName: 'Jon', fullName: 'Jon Smith' });
  assert.deepStrictEqual(codes(f), ['id_name_mismatch']);
  assert.strictEqual(summarize(f).blocksCtc, true);
}

// --- Audit false-fatal fix: DOB format drift (must NOT flag) ---
assert.deepStrictEqual(codes(idFindings({ dateOfBirth: '05/15/1980' })), [], 'DOB format difference must not fatal');
// A real DOB difference IS still caught.
{
  const f = idFindings({ dateOfBirth: '1980-05-16' });
  assert.deepStrictEqual(codes(f), ['id_dob_mismatch']);
  assert.strictEqual(summarize(f).blocksCtc, true);
}

// 3. Address differs from BOTH current and prior → WARNING (not blocking).
{
  const f = idFindings({ address: { line1: '500 Pine Rd', city: 'Houston', state: 'TX', zip: '77002' } });
  assert.deepStrictEqual(codes(f), ['id_address_mismatch']);
  assert.strictEqual(f[0].severity, 'warning');
  assert.strictEqual(summarize(f).blocksCtc, false);
}
// Address matches the borrower's PRIOR address → no false finding.
assert.deepStrictEqual(codes(idFindings({ address: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' } })), []);

// 4. Expired ID → WARNING.
{
  const f = idFindings({ expirationDate: '2024-01-01' });
  assert.deepStrictEqual(codes(f), ['id_expired']);
  assert.strictEqual(f[0].severity, 'warning');
}

// 5. Unreadable ID → single verify finding, no false mismatches.
{
  const f = idFindings({ readable: false, firstName: 'Zzz', dateOfBirth: '1900-01-01' });
  assert.deepStrictEqual(codes(f), ['id_unreadable']);
  assert.strictEqual(f[0].opensCondition, 'underwriting_review_cleared');
}

// 6. Multiple fatals compound and still block.
{
  const f = idFindings({ firstName: 'Jon', fullName: 'Jon Smith', dateOfBirth: '1980-05-16' });
  assert.deepStrictEqual(codes(f), ['id_dob_mismatch', 'id_name_mismatch']);
  assert.strictEqual(summarize(f).fatal, 2);
}

// --- Age at DOB (general identity/eligibility flag) ---
{
  // The borrower is a MINOR by the ID's DOB → underage flag (warning, and the DOB also mismatches the file).
  const minor = computeIdFindings({ ...goodId, dateOfBirth: '2012-06-01' }, borrower, { today: TODAY });
  assert.ok(minor.some((f) => f.code === 'id_underage' && f.severity === 'warning'), 'under-18 DOB is flagged');
  assert.strictEqual(minor.find((f) => f.code === 'id_underage').blocksCtc, false, 'underage is a warning, not a hard block');
  // A plausible adult DOB → no age flag.
  assert.ok(!idFindings({}).some((f) => /id_underage|id_age_implausible/.test(f.code)), 'a 46-year-old raises no age flag');
  // BOUNDARY (calendar age, not days/365.25): someone EXACTLY 18 today is NOT underage; a day short IS.
  const onTODAY = (dob) => computeIdFindings({ ...goodId, dateOfBirth: dob }, { ...borrower, date_of_birth: dob }, { today: '2026-07-20' });
  assert.ok(!onTODAY('2008-07-20').some((f) => f.code === 'id_underage'), 'exactly 18 today is NOT underage');
  assert.ok(onTODAY('2008-07-21').some((f) => f.code === 'id_underage'), 'one day short of 18 IS underage');
  // An impossible age (born 1902 → ~124) → implausible-age flag (a misread).
  const oldId = computeIdFindings({ ...goodId, dateOfBirth: '1902-06-01' }, { ...borrower, date_of_birth: '1902-06-01' }, { today: TODAY });
  assert.ok(oldId.some((f) => f.code === 'id_age_implausible'), 'age >120 is flagged as a misread');
  // No `today` → no age flag (never guesses off the wall clock).
  assert.ok(!computeIdFindings({ ...goodId, dateOfBirth: '2012-06-01' }, borrower, {}).some((f) => f.code === 'id_underage'), 'no today → no age flag');
}

console.log('✓ test-underwriting-id: all government-ID findings cases pass');
