'use strict';
/**
 * Part 2 — pure tests for the Encompass borrower-profile enrichment extractors
 * and dedupe canon (no DB). The DB write behavior (add-only-if-absent, never
 * replace, conservative matching) is covered by test-encompass-enrich-db.js.
 */
const assert = require('assert');
const enrich = require('../src/encompass/enrich');
const { normName, normDob, addrKey, normAddr, extractParties, subjectAddress, vestingLlc } = enrich._internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// normDob
assert.strictEqual(normDob('1985-03-10'), '1985-03-10');
assert.strictEqual(normDob('1985-03-10T00:00:00Z'), '1985-03-10');
assert.strictEqual(normDob(''), null);
assert.strictEqual(normDob(null), null);
ok('normDob → YYYY-MM-DD (tolerates a time component), null when absent');

// addrKey — canon matches ClickUp ingest.addrKey (lowercase, strip non-alnum)
assert.strictEqual(addrKey({ formatted_address: '12 Churchill Lane, Brooklyn, NY 11230' }), '12churchilllanebrooklynny11230');
assert.strictEqual(addrKey({ oneLine: '12 Churchill Ln' }), '12churchillln');
assert.strictEqual(addrKey({}), null);
ok('addrKey canonicalizes an address for dedupe (same shape as the ClickUp builder)');

// normAddr — the STRONG cross-source key: Encompass "Lane" must equal a geocoded
// ClickUp "Ln, …, USA" so an already-present property is not re-added.
assert.strictEqual(
  normAddr({ oneLine: '12 Churchill Lane, Brooklyn, NY 11230' }),
  normAddr({ formatted_address: '12 Churchill Ln, Brooklyn, NY 11230, USA' }),
  'Lane ≡ Ln and trailing USA is dropped');
assert.strictEqual(
  normAddr('45 North Ave, Spring Valley, NY 10977-1234'),
  normAddr('45 N Avenue, Spring Valley, NY 10977'),
  'N ≡ North, Ave ≡ Avenue, ZIP+4 → 5');
assert.notStrictEqual(
  normAddr('12 Churchill Lane, Brooklyn'),
  normAddr('14 Churchill Lane, Brooklyn'),
  'different house numbers stay distinct');
assert.strictEqual(normAddr(''), null);
ok('normAddr canonicalizes street-type/direction abbreviations + drops country/ZIP+4 for cross-source dedupe');

// extractParties
const raw = {
  applications: [{
    borrower: { firstName: 'Yehuda', lastName: 'Bochner', birthDate: '1985-03-10T00:00:00Z' },
    coBorrower: { firstName: 'Sara', lastName: 'Bochner', birthDate: '1987-06-01' },
  }],
  property: { streetAddress: '12 Churchill Lane', city: 'Brooklyn', state: 'NY', postalCode: '11230' },
  customFields: [
    { fieldName: 'CX.LLCNAME', value: 'Churchill Holdings LLC' },
    { fieldName: 'CX.LLCSTATE', value: 'NY' },
    { fieldName: 'CX.REHABBUDGET', value: '100000' },
  ],
};
const parties = extractParties(raw);
assert.strictEqual(parties.length, 2, 'borrower + co-borrower');
assert.strictEqual(parties[0].first, 'Yehuda');
assert.strictEqual(parties[0].last, 'Bochner');
assert.strictEqual(parties[0].dob, '1985-03-10', 'DOB normalized');
assert.strictEqual(parties[0].nameKey, 'yehuda bochner');
assert.deepStrictEqual(extractParties({}), [], 'no applications → no parties');
assert.deepStrictEqual(extractParties({ applications: [{ borrower: { firstName: '', lastName: '' } }] }), [], 'nameless party skipped');
ok('extractParties reads borrower + co-borrower name/DOB across applications');

// subjectAddress
const addr = subjectAddress(raw);
assert.strictEqual(addr.oneLine, '12 Churchill Lane, Brooklyn, NY 11230');
assert.strictEqual(addr.formatted_address, addr.oneLine);
assert.strictEqual(addr.state, 'NY');
assert.strictEqual(subjectAddress({}), null, 'no property → null');
assert.strictEqual(subjectAddress({ property: {} }), null, 'empty property → null');
ok('subjectAddress builds a canonical one-line address from property.*');

// vestingLlc
const llc = vestingLlc(raw);
assert.strictEqual(llc.name, 'Churchill Holdings LLC');
assert.strictEqual(llc.state, 'NY');
assert.strictEqual(vestingLlc({ customFields: [] }), null, 'no LLC field → null (skip, never fabricate)');
assert.strictEqual(vestingLlc({ subjectLLCVesting: 'ABC LLC' }).name, 'ABC LLC', 'falls back to a raw vesting field');
ok('vestingLlc extracts the LLC name/state, null when absent (never invents one)');

// normName
assert.strictEqual(normName('ABC Holdings, LLC'), 'abc holdings llc');
ok('normName lowercases + strips punctuation for matching');

console.log(`\nPart 2 Encompass enrichment pure — ${passed} checks passed`);
