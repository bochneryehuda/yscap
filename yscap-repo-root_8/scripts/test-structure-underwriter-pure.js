'use strict';
/**
 * R6.6 — pure tests for the independent structure underwriter. Guarantees: the
 * ratios recompute correctly, a missing input yields a null ratio (no
 * divide-by-zero / fabricated 0), an over-cap non-waivable breach is
 * hard_ineligible (never a warning), and the binding constraint is identified.
 */
const assert = require('assert');
const su = require('../src/lib/underwriting/structure-underwriter');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// ratios recompute correctly.
const s = {
  totalLoan: 800000, initialAdvance: 600000, rehabHoldback: 200000,
  recognizedPurchasePrice: 750000, asIsValue: 800000, arv: 1000000, rehabBudget: 250000,
};
const r = su.computeRatios(s);
assert.strictEqual(r.acquisitionLtv, 0.8, '600k/750k = 0.80');
assert.strictEqual(r.asIsLtv, 0.75, '600k/800k = 0.75');
assert.strictEqual(r.costBasis, 1000000, 'purchase 750k + rehab 250k');
assert.strictEqual(r.ltc, 0.8, '800k/1000k = 0.80');
assert.strictEqual(r.arvLtv, 0.8, '800k/1000k = 0.80');
ok('leverage ratios recompute correctly');

// a missing input → null ratio, never a divide-by-zero or fabricated 0.
const r2 = su.computeRatios({ totalLoan: 800000, arv: 0, recognizedPurchasePrice: null });
assert.strictEqual(r2.arvLtv, null, 'divide-by-zero → null');
assert.strictEqual(r2.acquisitionLtv, null, 'missing purchase → null');
ok('a missing/zero input yields a null ratio (no divide-by-zero / fabricated 0)');

// classifyBreach: within cap → pass; over a non-waivable cap → hard_ineligible.
assert.strictEqual(su.classifyBreach(0.75, 0.80), 'pass');
assert.strictEqual(su.classifyBreach(0.85, 0.80, { nonWaivable: true }), 'hard_ineligible', 'non-waivable over-cap is hard-ineligible, NOT a warning');
assert.strictEqual(su.classifyBreach(0.85, 0.80, { exceptionAllowed: true }), 'approvable_exception');
assert.strictEqual(su.classifyBreach(0.85, 0.80, { manualReview: true }), 'manual_review');
// default over-cap (no policy) → manual_review, never a silent warning.
assert.strictEqual(su.classifyBreach(0.85, 0.80), 'manual_review');
// a rounding wisp over the cap is a pass (tolerance).
assert.strictEqual(su.classifyBreach(0.8001, 0.80), 'pass');
ok('a non-waivable over-cap is hard_ineligible; default over-cap is manual_review (never silent warning)');

// ledger identifies the binding constraint (smallest headroom).
const rows = su.ledger(s, {
  maxAcquisitionLtv: 0.85, maxAsIsLtv: 0.80, maxLtc: 0.90, maxArvLtv: 0.75,
  capPolicy: { arvLtv: { nonWaivable: true } },
});
const arv = rows.find((x) => x.metric === 'arv_ltv');
assert.strictEqual(arv.severity, 'hard_ineligible', 'arv 0.80 > cap 0.75 non-waivable');
assert.strictEqual(arv.passed, false);
// arv_ltv has the smallest headroom (0.75-0.80 = -0.05) → binding.
assert.strictEqual(arv.binding, true, 'the breached ratio binds');
const acq = rows.find((x) => x.metric === 'acquisition_ltv');
assert.strictEqual(acq.binding, false);
ok('the ledger classifies each row + identifies the binding constraint');

// compareToRegistered flags a material difference (stale/miscomputed quote).
const diffs = su.compareToRegistered(
  { acquisitionLtv: 0.80, ltc: 0.80 },
  { acquisitionLtv: 0.75, ltc: 0.80 });  // registered says 0.75, we computed 0.80
assert.strictEqual(diffs.length, 1);
assert.strictEqual(diffs[0].metric, 'acquisitionLtv');
ok('compareToRegistered flags a material difference vs the registered quote');

// an incomplete row (missing cap) is severity 'incomplete', not a pass.
const rows2 = su.ledger(s, { maxLtc: 0.90 });
const acq2 = rows2.find((x) => x.metric === 'acquisition_ltv');
assert.strictEqual(acq2.severity, 'incomplete', 'no cap → incomplete, not pass');
assert.strictEqual(acq2.passed, false);
ok('a calculation with no cap is incomplete (never a silent pass)');

console.log(`\nR6.6 structure-underwriter pure — ${passed} checks passed`);
