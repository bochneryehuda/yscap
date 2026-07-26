'use strict';
/**
 * R5.26 — pure tests for versioned condition contracts.
 * Proves a contract (1) is satisfied only when its acceptable evidence is present,
 * (2) refuses STALE evidence outside the freshness window, (3) refuses evidence
 * from the WRONG PARTY, (4) honors ALL vs ANY logic, (5) resolves the right
 * VERSION (latest by default, a pinned version for replay), (6) reports per-
 * requirement status in the clearance-outcome vocabulary, and (7) never throws.
 */
const assert = require('assert');
const cc = require('../src/lib/underwriting/condition-contract');
const { STATUS } = cc;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// A proof-of-funds contract: a recent bank statement OR a verification-of-deposit,
// from the borrower, no older than 30 days.
const pofV1 = {
  key: 'proof_of_funds', version: 1, title: 'Proof of funds', logic: 'all',
  requirements: [
    { key: 'liquid_assets', label: 'Recent liquid assets', party: 'borrower', freshnessDays: 30,
      acceptableDocTypes: ['bank_statement', 'verification_of_deposit'] },
  ],
};

// --- a fresh, right-party, acceptable-type document satisfies ---
let r = cc.evaluateContract(pofV1,
  [{ id: 'd1', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-07-10' }],
  { asOf: '2026-07-22' });
assert.strictEqual(r.satisfied, true, 'a fresh borrower bank statement cures proof of funds');
assert.strictEqual(r.requirements[0].status, STATUS.MET);
assert.deepStrictEqual(r.requirements[0].matched, ['d1'], 'the satisfying document is named');
assert.strictEqual(r.version, 1);
ok('a fresh, right-party, acceptable-type document satisfies the contract');

// --- a STALE document (outside the freshness window) does not cure ---
r = cc.evaluateContract(pofV1,
  [{ id: 'd2', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-05-01' }], // 82 days old
  { asOf: '2026-07-22' });
assert.strictEqual(r.satisfied, false, 'an 82-day-old statement is too stale');
assert.strictEqual(r.requirements[0].status, STATUS.STALE);
assert.deepStrictEqual(r.stale, ['liquid_assets']);
assert.ok(/30 days/.test(r.reasons[0]));
ok('a document outside the freshness window is reported STALE and does not cure');

// --- a FUTURE-dated document is not "fresh" (never cures on a bad date) ---
r = cc.evaluateContract(pofV1,
  [{ id: 'd3', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-08-15' }], // future
  { asOf: '2026-07-22' });
assert.strictEqual(r.requirements[0].status, STATUS.STALE, 'a future date is not a valid fresh date');
ok('a future-dated document is not treated as fresh');

// --- WRONG PARTY: a bank statement belonging to the seller does not cure ---
r = cc.evaluateContract(pofV1,
  [{ id: 'd4', docType: 'bank_statement', party: 'seller', asOfDate: '2026-07-10' }],
  { asOf: '2026-07-22' });
assert.strictEqual(r.satisfied, false, 'the wrong account holder does not cure');
assert.strictEqual(r.requirements[0].status, STATUS.WRONG_PARTY);
assert.deepStrictEqual(r.wrongParty, ['liquid_assets']);
ok('evidence from the wrong party is reported WRONG_PARTY and does not cure');

// --- MISSING: the wrong document type entirely ---
r = cc.evaluateContract(pofV1,
  [{ id: 'd5', docType: 'appraisal', party: 'borrower', asOfDate: '2026-07-10' }],
  { asOf: '2026-07-22' });
assert.strictEqual(r.requirements[0].status, STATUS.MISSING, 'an appraisal is not proof of funds');
assert.deepStrictEqual(r.missing, ['liquid_assets']);
ok('an unacceptable document type is reported MISSING');

// --- ALL vs ANY logic ---
const titleAll = {
  key: 'clear_title', version: 1, logic: 'all',
  requirements: [
    { key: 'commitment', acceptableDocTypes: ['title_commitment'] },
    { key: 'payoff', acceptableDocTypes: ['payoff_statement'] },
  ],
};
r = cc.evaluateContract(titleAll, [{ id: 't1', docType: 'title_commitment' }]);
assert.strictEqual(r.satisfied, false, 'ALL logic needs every requirement met');
assert.deepStrictEqual(r.met, ['commitment']);
assert.deepStrictEqual(r.missing, ['payoff']);
const titleAny = Object.assign({}, titleAll, { logic: 'any' });
r = cc.evaluateContract(titleAny, [{ id: 't1', docType: 'title_commitment' }]);
assert.strictEqual(r.satisfied, true, 'ANY logic is satisfied by one met requirement');
ok('ALL requires every requirement; ANY is satisfied by a single met requirement');

// --- versioning: latest by default, pinned version for replay ---
const pofV2 = Object.assign({}, pofV1, { version: 2, requirements: [
  Object.assign({}, pofV1.requirements[0], { freshnessDays: 10 }), // tightened window
] });
const contracts = [pofV1, pofV2];
assert.strictEqual(cc.resolveContract(contracts, 'proof_of_funds').version, 2, 'latest version wins by default');
assert.strictEqual(cc.resolveContract(contracts, 'proof_of_funds', 1).version, 1, 'a pinned version is returned for replay');
assert.strictEqual(cc.resolveContract(contracts, 'nope'), null, 'an unknown key resolves to null');
// the SAME evidence satisfies v1 (30d) but not v2 (10d) — a historical decision must
// be re-checkable against the version in effect then.
const ev = [{ id: 'd6', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-07-05' }]; // 17 days old
assert.strictEqual(cc.evaluateContract(cc.resolveContract(contracts, 'proof_of_funds', 1), ev, { asOf: '2026-07-22' }).satisfied, true, 'passes under v1 (30-day window)');
assert.strictEqual(cc.evaluateContract(cc.resolveContract(contracts, 'proof_of_funds', 2), ev, { asOf: '2026-07-22' }).satisfied, false, 'fails under v2 (tightened 10-day window)');
ok('resolveContract picks latest by default and a pinned version for replay; the same evidence can pass one version and fail another');

// --- freshness is only checked when BOTH a window and a reference date exist ---
r = cc.evaluateContract(pofV1, [{ id: 'd7', docType: 'bank_statement', party: 'borrower', asOfDate: '2020-01-01' }]); // no asOf
assert.strictEqual(r.requirements[0].status, STATUS.MET, 'with no reference date, freshness is not enforced');
ok('freshness is enforced only when both a window and a reference date are supplied');

// --- acceptableEvidenceFor lists everything a caller should ask for ---
assert.deepStrictEqual(cc.acceptableEvidenceFor(pofV1).sort(), ['bank_statement', 'verification_of_deposit']);
assert.deepStrictEqual(cc.acceptableEvidenceFor(titleAll).sort(), ['payoff_statement', 'title_commitment']);
ok('acceptableEvidenceFor lists every acceptable document type across the requirements');

// --- doc_type / as_of_date snake_case aliases are accepted ---
r = cc.evaluateContract(pofV1, [{ id: 'd8', doc_type: 'verification_of_deposit', party: 'borrower', as_of_date: '2026-07-20' }], { asOf: '2026-07-22' });
assert.strictEqual(r.satisfied, true, 'snake_case doc_type/as_of_date are read the same as camelCase');
ok('snake_case doc_type / as_of_date aliases are accepted');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => cc.evaluateContract(null, null));
assert.strictEqual(cc.evaluateContract(null, null).satisfied, false, 'a null contract is unsatisfied, not a crash');
assert.ok(cc.evaluateContract({ key: 'x' }, []).reasons[0].includes('invalid'), 'a contract with no requirements is invalid');
assert.doesNotThrow(() => cc.evaluateContract(pofV1, [null, { id: 'z' }, 'junk']));
assert.doesNotThrow(() => cc.resolveContract(null, 'x'));
assert.deepStrictEqual(cc.acceptableEvidenceFor(null), []);
assert.strictEqual(cc._internals.toUtcDays('2026-02-31'), null, 'an impossible calendar date is rejected, never "fresh"');
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.26 condition-contract pure — ${passed} checks passed`);
