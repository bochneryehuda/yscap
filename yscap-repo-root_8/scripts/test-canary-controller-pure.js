'use strict';
/**
 * R5.48 — pure tests for the canary release + auto-rollback decision core.
 * Proves it (1) ROLLS BACK the instant the false-clear rate crosses the ceiling —
 * at ANY sample size (the dangerous signal trips fastest), (2) ROLLS BACK on a
 * material error/disagreement regression but ignores sub-floor noise, (3) HOLDS on
 * too few samples, (4) PROMOTES only with enough samples + no breach, (5) over a
 * history, rolls back immediately but promotes only after N consecutive clean
 * windows (a bad window resets the streak), and (6) never throws.
 */
const assert = require('assert');
const cc = require('../src/lib/underwriting/canary-controller');
const { DECISION } = cc;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- FALSE CLEAR over the ceiling → ROLLBACK, even below minSamples ---
let r = cc.evaluateCanary(
  { sampleSize: 5, falseClearRate: 0.02 },     // only 5 samples, but a false clear appeared
  { falseClearRate: 0 },
  { minSamples: 50, maxFalseClearRate: 0 });
assert.strictEqual(r.decision, DECISION.ROLLBACK, 'any false clear over baseline rolls back regardless of sample size');
assert.ok(r.breaches.some((b) => b.metric === 'falseClearRate'));
ok('a false-clear rate over the ceiling rolls back immediately — at any sample size');

// --- zero false clears + enough samples → PROMOTE ---
r = cc.evaluateCanary({ sampleSize: 200, falseClearRate: 0, errorRate: 0.01 }, { falseClearRate: 0, errorRate: 0.012 }, { minSamples: 50 });
assert.strictEqual(r.decision, DECISION.PROMOTE, 'no breaches + enough samples promotes');
assert.deepStrictEqual(r.breaches, []);
ok('zero false clears + enough samples + no regression → PROMOTE');

// --- too few samples, no breach → HOLD ---
r = cc.evaluateCanary({ sampleSize: 10, falseClearRate: 0 }, { falseClearRate: 0 }, { minSamples: 50 });
assert.strictEqual(r.decision, DECISION.HOLD, 'insufficient samples holds (does not promote)');
assert.ok(/need 50/.test(r.reasons.join(' ')));
ok('too few samples with no breach → HOLD, never a premature promote');

// --- error-rate regression beyond tolerance → ROLLBACK; sub-floor noise ignored ---
r = cc.evaluateCanary({ sampleSize: 200, falseClearRate: 0, errorRate: 0.20 }, { falseClearRate: 0, errorRate: 0.05 },
  { minSamples: 50, errorRegressionTolerance: 0.5, errorAbsoluteFloor: 0.02 });
assert.strictEqual(r.decision, DECISION.ROLLBACK, '0.20 vs 0.05 baseline (>1.5x) rolls back');
assert.ok(r.breaches.some((b) => b.metric === 'errorRate'));
// a tiny error rate under the floor is NOT a breach even if it "regressed" proportionally
r = cc.evaluateCanary({ sampleSize: 200, falseClearRate: 0, errorRate: 0.015 }, { falseClearRate: 0, errorRate: 0.001 },
  { minSamples: 50, errorRegressionTolerance: 0.5, errorAbsoluteFloor: 0.02 });
assert.strictEqual(r.decision, DECISION.PROMOTE, 'a rate under the absolute floor is noise, not a regression');
ok('an error-rate regression beyond tolerance rolls back; a sub-floor rate is treated as noise');

// --- disagreement regression is checked the same way ---
r = cc.evaluateCanary({ sampleSize: 200, falseClearRate: 0, disagreementRate: 0.30 }, { falseClearRate: 0, disagreementRate: 0.10 },
  { minSamples: 50, disagreementRegressionTolerance: 0.5, disagreementAbsoluteFloor: 0.05 });
assert.strictEqual(r.decision, DECISION.ROLLBACK, 'disagreement 0.30 vs 0.10 rolls back');
assert.ok(r.breaches.some((b) => b.metric === 'disagreementRate'));
ok('an underwriter-disagreement regression beyond tolerance rolls back');

// --- decideRollout: rollback in the most recent window wins immediately ---
let d = cc.decideRollout([
  { canary: { sampleSize: 200, falseClearRate: 0 }, baseline: { falseClearRate: 0 } },
  { canary: { sampleSize: 200, falseClearRate: 0 }, baseline: { falseClearRate: 0 } },
  { canary: { sampleSize: 200, falseClearRate: 0.03 }, baseline: { falseClearRate: 0 } }, // breach now
], { minSamples: 50, promoteAfterStableChecks: 3 });
assert.strictEqual(d.decision, DECISION.ROLLBACK, 'a breach in the latest window rolls back even after clean history');
assert.strictEqual(d.stableChecks, 0);
assert.ok(d.lastBreaches.length >= 1);
ok('decideRollout rolls back immediately when the most recent window breaches (no waiting)');

// --- decideRollout: PROMOTE only after N consecutive clean windows ---
const clean = { canary: { sampleSize: 200, falseClearRate: 0 }, baseline: { falseClearRate: 0 } };
d = cc.decideRollout([clean, clean], { minSamples: 50, promoteAfterStableChecks: 3 });
assert.strictEqual(d.decision, DECISION.HOLD, '2 clean windows is not yet enough to promote (need 3)');
assert.strictEqual(d.stableChecks, 2);
d = cc.decideRollout([clean, clean, clean], { minSamples: 50, promoteAfterStableChecks: 3 });
assert.strictEqual(d.decision, DECISION.PROMOTE, '3 consecutive clean windows promotes');
assert.strictEqual(d.stableChecks, 3);
ok('decideRollout promotes only after the required run of consecutive clean windows');

// --- a bad (HOLD, too-few-samples) window resets the stable streak ---
const thin = { canary: { sampleSize: 5, falseClearRate: 0 }, baseline: { falseClearRate: 0 } };
d = cc.decideRollout([clean, clean, thin, clean], { minSamples: 50, promoteAfterStableChecks: 3 });
assert.strictEqual(d.decision, DECISION.HOLD, 'only 1 clean window at the tail after the thin window');
assert.strictEqual(d.stableChecks, 1, 'the streak reset at the non-promote window');
ok('a non-promote window resets the stable streak (promotion requires an unbroken run)');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => cc.evaluateCanary(null, null));
assert.strictEqual(cc.evaluateCanary(null, null).decision, DECISION.HOLD, 'null canary with no samples holds, not a crash');
assert.doesNotThrow(() => cc.decideRollout(null));
assert.strictEqual(cc.decideRollout(null).decision, DECISION.HOLD);
assert.doesNotThrow(() => cc.decideRollout([null, 'junk', {}]));
assert.doesNotThrow(() => cc.evaluateCanary({ sampleSize: 'x', falseClearRate: 'y' }, {}));
assert.strictEqual(cc.evaluateCanary({ sampleSize: -5, falseClearRate: 0 }, {}, { minSamples: 1 }).sampleSize, 0, 'a negative sample size clamps to 0');
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.48 canary-controller pure — ${passed} checks passed`);
