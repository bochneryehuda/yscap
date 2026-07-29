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

// ── CLOSED DEALS ONLY (owner-directed 2026-07-27) ──────────────────────────
// The gate that keeps a property OFF the track record until the deal is done.
const closed = (input) => enrich.loanClosed(input).closed;

// THE REPORTED BUG: the file the borrower is in the middle of right now. Our own
// status says it has not closed, and nothing in Encompass may overrule that.
assert.strictEqual(closed({ raw, app: { status: 'underwriting' } }), false, 'a file in underwriting has not closed');
assert.strictEqual(closed({ raw, app: { status: 'clear_to_close' } }), false, 'cleared to close is still not closed');
assert.strictEqual(closed({ raw, app: { status: 'on_hold' } }), false, 'a parked file has not closed');
assert.strictEqual(closed({ raw, app: { status: 'declined' } }), false, 'a declined file never closed');
ok('our own file decides: anything short of funded means the property does NOT go on the track record');

// With no file of ours to ask, Encompass has to SHOW a closing.
assert.strictEqual(closed({ raw }), false, 'silence is not a closing — the default is no');
assert.strictEqual(closed({ raw: { milestoneCurrentName: 'LO Prep', milestoneStage: 'PREQUAL' } }), false,
  'an early milestone is not a closing');
assert.strictEqual(closed({ raw: { milestoneCurrentName: 'Clear to Close' } }), false, '"Clear to Close" is not closed');
assert.strictEqual(closed({ raw: { milestoneCurrentName: 'Active Closing' } }), false, '"Active Closing" is on the WAY to closed');
assert.strictEqual(closed({ raw: { milestoneCurrentName: 'Scheduling Closing' } }), false, 'a scheduled closing is not a closing');
assert.strictEqual(closed({ raw: { milestoneCurrentName: 'Funding' } }), false, 'sitting AT funding is not funded');
assert.strictEqual(closed({ raw: { closingDocument: { fundingDate: '2099-04-01' } } }), false,
  'a funding date in the FUTURE is a plan, not a closing');
assert.strictEqual(closed({ raw: { customFields: [{ fieldName: '1401', value: '525450' }] } }), false,
  'a number that is not a date never reads as a funded date');
ok('nothing in flight counts — early milestone, clear-to-close, active closing, a future funding date, a non-date');

// A deal that DIED is not experience, however far it got.
assert.strictEqual(closed({ raw: {}, loanFolder: 'Adverse' }), false, 'an adverse file is not experience');
assert.strictEqual(closed({ raw: { closingDocument: { fundingDate: '2024-02-01' } }, loanFolder: 'Cancelled' }), false,
  'cancelled beats a stale funding date');
ok('a dead deal (adverse / cancelled / withdrawn / trash) never lands on the track record');

// The real closings — read whichever way this tenant records them.
assert.strictEqual(closed({ raw: {}, app: { status: 'funded' } }), true, 'our file marked funded');
assert.strictEqual(closed({ raw: {}, app: { status: 'processing', fundedDate: '2025-01-02' } }), true,
  'our file carries a funded date');
assert.strictEqual(closed({ raw: { closingDocument: { fundingDate: '2024-02-01T00:00:00Z' } } }), true, 'the money went out');
assert.strictEqual(closed({ raw: { customFields: [{ fieldName: '1999', value: '2023-06-15' }] } }), true, 'funds released (field 1999)');
assert.strictEqual(closed({ raw: { milestoneCurrentName: 'Funded' } }), true, 'the milestone says funded');
assert.strictEqual(closed({ raw: {}, loanFolder: 'Closed Loans' }), true, 'the loan lives in a closed folder');
assert.strictEqual(closed({ raw: { milestones: [{ milestoneName: 'Funding', doneIndicator: true }] } }), true,
  'a COMPLETED funding milestone is a closing');
assert.strictEqual(closed({ raw: { loanFolder: 'Pipeline', milestoneCurrentName: 'Completion' } }), true,
  'a closed loan still sitting in the pipeline folder still counts');
ok('a real closing is recognized from our file, a funding date, a milestone, a completed milestone, or the folder');

console.log(`\nPart 2 Encompass enrichment pure — ${passed} checks passed`);
