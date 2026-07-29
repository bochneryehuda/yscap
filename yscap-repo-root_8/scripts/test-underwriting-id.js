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

// --- CO-BORROWER AWARENESS (owner-directed 2026-07-27) ---
// The file has TWO people. An ID belonging to EITHER is legitimate — never a fatal mismatch.
{
  const co = {
    first_name: 'Jane', last_name: 'Doe', date_of_birth: '1985-09-20',
    current_address: { line1: '77 Elm St', city: 'Austin', state: 'TX', zip: '78704' }, prior_address: null,
  };
  const set = { people: [borrower, co], ownerNames: [] };
  const coId = {
    documentType: 'driver_license', firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe',
    dateOfBirth: '1985-09-20', address: { line1: '77 Elm St', city: 'Austin', state: 'TX', zip: '78704' },
    documentNumber: 'TX7654321', expirationDate: '2028-01-01', readable: true,
  };
  // The co-borrower's own ID → clean (previously a DOUBLE fatal against the primary borrower).
  assert.deepStrictEqual(codes(computeIdFindings(coId, set, { today: TODAY })), [], "a co-borrower's ID matches the file → no findings");
  // The primary's ID → still clean against the same set.
  assert.deepStrictEqual(codes(computeIdFindings(goodId, set, { today: TODAY })), [], "the primary borrower's ID matches the set → no findings");
  // An ID matching NOBODY on the 2-person file → ONE name mismatch, no phantom DOB against an arbitrary person.
  const stranger = { ...coId, firstName: 'Robert', lastName: 'Jones', fullName: 'Robert Jones',
    dateOfBirth: '1970-01-01', address: { line1: '1 Nowhere Rd', city: 'X', state: 'TX', zip: '70000' } };
  const sf = computeIdFindings(stranger, set, { today: TODAY });
  assert.deepStrictEqual(codes(sf), ['id_name_mismatch'], 'an ID matching nobody → name mismatch only (no phantom DOB)');
  assert.strictEqual(summarize(sf).fatal, 1, 'exactly one fatal, not two');
  // A matched co-borrower's REAL DOB typo is still caught.
  assert.deepStrictEqual(codes(computeIdFindings({ ...coId, dateOfBirth: '1985-09-21' }, set, { today: TODAY })),
    ['id_dob_mismatch'], "a matched co-borrower's DOB typo is still caught");
  // A matched co-borrower's address is compared against the CO-borrower (not the primary).
  assert.deepStrictEqual(codes(computeIdFindings({ ...coId, address: { line1: '999 Far Ave', city: 'Y', state: 'TX', zip: '79999' } }, set, { today: TODAY })),
    ['id_address_mismatch'], 'address compared against the matched co-borrower');
}

// --- LLC OWNER NAME accepted (name-only; no DOB/address held for them) ---
{
  const set = { people: [borrower], ownerNames: ['Aaron Green'] };
  const ownerId = { ...goodId, firstName: 'Aaron', lastName: 'Green', fullName: 'Aaron Green',
    dateOfBirth: '1975-03-03', address: { line1: '5 Owner Ln', city: 'Z', state: 'TX', zip: '70001' } };
  // A named LLC owner's ID is legitimate → no name mismatch, and NO DOB/address compare against the borrower.
  assert.deepStrictEqual(codes(computeIdFindings(ownerId, set, { today: TODAY })), [], "a named LLC owner's ID is accepted with no phantom mismatches");
}

// --- Back-compat: a one-person people-set behaves exactly like the bare borrowers row ---
assert.deepStrictEqual(
  codes(computeIdFindings({ ...goodId, firstName: 'Jon', fullName: 'Jon Smith', dateOfBirth: '1980-05-16' }, { people: [borrower], ownerNames: [] }, { today: TODAY })),
  ['id_dob_mismatch', 'id_name_mismatch'],
  'a single-person people-set still compounds name + DOB like the bare-row subject');

console.log('✓ test-underwriting-id: all government-ID findings cases pass');
