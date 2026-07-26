'use strict';
/**
 * R6.4 — pure tests for the whole-loan status vocabulary + issuability gates.
 * The cardinal guarantee: MANUAL_PENDING / NOT_READY / DATA_CONFLICT / STALE are
 * NEVER issuable, and only ELIGIBLE + MANUAL_APPROVED are — so "status !==
 * INELIGIBLE" can never be used to issue terms.
 */
const assert = require('assert');
const S = require('../src/lib/underwriting/uw-status');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// classify: engine ELIGIBLE → ELIGIBLE.
assert.strictEqual(S.classify({ engineStatus: 'ELIGIBLE' }), S.STATUS.ELIGIBLE);
// engine MANUAL without approval → MANUAL_PENDING; with approval → MANUAL_APPROVED.
assert.strictEqual(S.classify({ engineStatus: 'MANUAL' }), S.STATUS.MANUAL_PENDING);
assert.strictEqual(S.classify({ engineStatus: 'MANUAL', manualApproved: true }), S.STATUS.MANUAL_APPROVED);
// engine INELIGIBLE → INELIGIBLE.
assert.strictEqual(S.classify({ engineStatus: 'INELIGIBLE' }), S.STATUS.INELIGIBLE);
ok('engine status maps to the whole-loan status');

// stops beat a pass, in precedence order.
assert.strictEqual(S.classify({ engineStatus: 'ELIGIBLE', stale: true }), S.STATUS.STALE);
assert.strictEqual(S.classify({ engineStatus: 'ELIGIBLE', conflict: true }), S.STATUS.DATA_CONFLICT);
assert.strictEqual(S.classify({ engineStatus: 'ELIGIBLE', missingRequired: true }), S.STATUS.NOT_READY);
// INELIGIBLE beats even stale/conflict.
assert.strictEqual(S.classify({ engineStatus: 'INELIGIBLE', stale: true, conflict: true }), S.STATUS.INELIGIBLE);
// an unknown/absent engine status is NOT a pass.
assert.strictEqual(S.classify({}), S.STATUS.NOT_READY);
assert.strictEqual(S.classify({ engineStatus: 'garbage' }), S.STATUS.NOT_READY);
ok('a stop always beats a pass; an unknown engine status is never a pass');

// THE cardinal gate: only ELIGIBLE + MANUAL_APPROVED are issuable.
assert.strictEqual(S.canIssueTermSheet(S.STATUS.ELIGIBLE), true);
assert.strictEqual(S.canIssueTermSheet(S.STATUS.MANUAL_APPROVED), true);
for (const bad of [S.STATUS.MANUAL_PENDING, S.STATUS.NOT_READY, S.STATUS.DATA_CONFLICT, S.STATUS.STALE, S.STATUS.INELIGIBLE]) {
  assert.strictEqual(S.canIssueTermSheet(bad), false, `${bad} must NOT be issuable`);
}
ok('only ELIGIBLE + MANUAL_APPROVED can issue a term sheet (MANUAL_PENDING cannot)');

// "status !== INELIGIBLE" is proven insufficient: MANUAL_PENDING !== INELIGIBLE
// yet is NOT issuable.
assert.notStrictEqual(S.STATUS.MANUAL_PENDING, S.STATUS.INELIGIBLE);
assert.strictEqual(S.canIssueTermSheet(S.STATUS.MANUAL_PENDING), false);
ok('the old "!== INELIGIBLE" test can no longer issue MANUAL_PENDING terms');

// CTC gate: issuable AND no fatal finding.
assert.strictEqual(S.canClearToClose(S.STATUS.ELIGIBLE, { hasFatalFinding: false }), true);
assert.strictEqual(S.canClearToClose(S.STATUS.ELIGIBLE, { hasFatalFinding: true }), false, 'a fatal finding blocks CTC');
assert.strictEqual(S.canClearToClose(S.STATUS.MANUAL_PENDING, {}), false);
ok('CTC requires issuable AND no fatal finding');

// funding gate: issuable AND not stale AND no fatal.
assert.strictEqual(S.canFund(S.STATUS.MANUAL_APPROVED, {}), true);
assert.strictEqual(S.canFund(S.STATUS.MANUAL_APPROVED, { staleRun: true }), false, 'funding from a stale run is blocked');
assert.strictEqual(S.canFund(S.STATUS.INELIGIBLE, {}), false);
ok('funding requires issuable AND a fresh run AND no fatal finding');

// block reasons exist for every stop.
for (const st of [S.STATUS.INELIGIBLE, S.STATUS.STALE, S.STATUS.DATA_CONFLICT, S.STATUS.NOT_READY, S.STATUS.MANUAL_PENDING]) {
  assert.ok(typeof S.blockReason(st) === 'string' && S.blockReason(st).length, `${st} has a block reason`);
}
assert.strictEqual(S.blockReason(S.STATUS.ELIGIBLE), null);
ok('every stop status has a plain-language block reason');

console.log(`\nR6.4 uw-status pure — ${passed} checks passed`);
