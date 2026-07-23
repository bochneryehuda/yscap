'use strict';
/**
 * R5.27 — pure tests for the multi-document evidence-set builder.
 * Proves it (1) assembles the BEST document per requirement (right party, fresh,
 * most recent), (2) reports what is still needed as a plain shopping list with the
 * right reason, (3) marks the cure COMPLETE only when the contract's ALL/ANY logic
 * is met by the selected set, (4) lists unused documents, (5) hands a set that
 * condition-contract.evaluateContract confirms, and (6) never throws.
 */
const assert = require('assert');
const esb = require('../src/lib/underwriting/evidence-set-builder');
const cc = require('../src/lib/underwriting/condition-contract');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const pof = {
  key: 'proof_of_funds', version: 3, logic: 'all',
  requirements: [
    { key: 'liquid_assets', label: 'Liquid assets', party: 'borrower', freshnessDays: 30,
      acceptableDocTypes: ['bank_statement', 'verification_of_deposit'] },
  ],
};

// --- picks the MOST RECENT fresh, right-party document ---
let r = esb.buildEvidenceSet(pof, [
  { id: 'old', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-07-02' },
  { id: 'new', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-07-18' }, // most recent
  { id: 'seller', docType: 'bank_statement', party: 'seller', asOfDate: '2026-07-20' }, // wrong party
], { asOf: '2026-07-22' });
assert.strictEqual(r.complete, true, 'a fresh borrower statement completes the cure');
assert.strictEqual(r.selected.length, 1);
assert.strictEqual(r.selected[0].evidenceId, 'new', 'the most recent fresh right-party doc is chosen');
assert.deepStrictEqual(r.satisfied, ['liquid_assets']);
assert.ok(r.unused.includes('old') && r.unused.includes('seller'), 'the older + wrong-party docs are unused');
ok('builds the best (fresh, right-party, most recent) document per requirement');

// --- the assembled set is confirmed by condition-contract.evaluateContract ---
const confirm = cc.evaluateContract(pof, r.selected.map((s) => ({ id: s.evidenceId, docType: s.docType, party: s.party, asOfDate: s.asOfDate })), { asOf: '2026-07-22' });
assert.strictEqual(confirm.satisfied, true, 'evaluateContract agrees the built set cures the condition');
ok('the built evidence set is independently confirmed by condition-contract.evaluateContract');

// --- shopping list: nothing acceptable yet → still needed, with the right reason ---
r = esb.buildEvidenceSet(pof, [{ id: 'x', docType: 'appraisal', party: 'borrower', asOfDate: '2026-07-20' }], { asOf: '2026-07-22' });
assert.strictEqual(r.complete, false);
assert.strictEqual(r.selected.length, 0);
assert.strictEqual(r.stillNeeded.length, 1);
assert.strictEqual(r.stillNeeded[0].requirementKey, 'liquid_assets');
assert.deepStrictEqual(r.stillNeeded[0].acceptableDocTypes.sort(), ['bank_statement', 'verification_of_deposit']);
assert.ok(/provide/.test(r.stillNeeded[0].reason));
ok('when nothing acceptable is present, the requirement is on the shopping list with acceptable types + reason');

// --- stale-only evidence → still needed with a freshness reason ---
r = esb.buildEvidenceSet(pof, [{ id: 'stale', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-05-01' }], { asOf: '2026-07-22' });
assert.strictEqual(r.complete, false);
assert.strictEqual(r.stillNeeded[0].status, cc.STATUS.STALE);
assert.ok(/30 days/.test(r.stillNeeded[0].reason));
ok('a stale-only requirement is still needed with a freshness reason');

// --- wrong-party-only evidence → still needed with a party reason ---
r = esb.buildEvidenceSet(pof, [{ id: 'sel', docType: 'bank_statement', party: 'seller', asOfDate: '2026-07-20' }], { asOf: '2026-07-22' });
assert.strictEqual(r.complete, false);
assert.strictEqual(r.stillNeeded[0].status, cc.STATUS.WRONG_PARTY);
assert.ok(/borrower/.test(r.stillNeeded[0].reason));
ok('a wrong-party-only requirement is still needed with a party reason');

// --- multi-requirement ALL: assembles across several documents ---
const titleAll = {
  key: 'clear_title', version: 1, logic: 'all',
  requirements: [
    { key: 'commitment', acceptableDocTypes: ['title_commitment'], party: 'title' },
    { key: 'payoff', acceptableDocTypes: ['payoff_statement'], party: 'lender' },
  ],
};
r = esb.buildEvidenceSet(titleAll, [
  { id: 'c', docType: 'title_commitment', party: 'title' },
  { id: 'p', docType: 'payoff_statement', party: 'lender' },
  { id: 'extra', docType: 'flood_cert' },
]);
assert.strictEqual(r.complete, true, 'both requirements met across two documents');
assert.deepStrictEqual(r.selected.map((s) => s.evidenceId).sort(), ['c', 'p']);
assert.deepStrictEqual(r.unused, ['extra']);
// remove the payoff → incomplete, payoff still needed
r = esb.buildEvidenceSet(titleAll, [{ id: 'c', docType: 'title_commitment', party: 'title' }]);
assert.strictEqual(r.complete, false);
assert.deepStrictEqual(r.satisfied, ['commitment']);
assert.deepStrictEqual(r.stillNeeded.map((s) => s.requirementKey), ['payoff']);
ok('a multi-requirement ALL contract assembles across documents and reports the missing one');

// --- ANY logic: one satisfying document completes the cure ---
const anyC = { key: 'insurance', version: 1, logic: 'any', requirements: [
  { key: 'binder', acceptableDocTypes: ['insurance_binder'] },
  { key: 'policy', acceptableDocTypes: ['insurance_policy'] },
] };
r = esb.buildEvidenceSet(anyC, [{ id: 'b', docType: 'insurance_binder' }]);
assert.strictEqual(r.complete, true, 'ANY logic completes with a single satisfied requirement');
ok('ANY-logic cure completes when a single requirement is satisfied');

// --- pickBest is exposed and returns the freshest right-party candidate ---
const best = esb.pickBest(
  cc.normalizeContract(pof).requirements[0],
  [{ id: 'a', docType: 'bank_statement', party: 'borrower', asOfDate: '2026-07-01' },
   { id: 'b', docType: 'verification_of_deposit', party: 'borrower', asOfDate: '2026-07-20' }].map((e) => cc._internals.normEvidence(e)),
  { asOf: '2026-07-22' });
assert.strictEqual(best.evidenceId, 'b', 'the most recent acceptable document is the best pick');
ok('pickBest returns the freshest acceptable right-party candidate');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => esb.buildEvidenceSet(null, null));
assert.strictEqual(esb.buildEvidenceSet(null, null).complete, false, 'a null contract yields an incomplete set, not a crash');
assert.ok(esb.buildEvidenceSet({ key: 'x' }, []).stillNeeded[0].status === 'invalid_contract');
assert.doesNotThrow(() => esb.buildEvidenceSet(pof, [null, 'junk', { id: 'z' }], { asOf: '2026-07-22' }));
assert.deepStrictEqual(esb.buildEvidenceSet(pof, []).stillNeeded.map((s) => s.requirementKey), ['liquid_assets']);
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.27 evidence-set-builder pure — ${passed} checks passed`);
