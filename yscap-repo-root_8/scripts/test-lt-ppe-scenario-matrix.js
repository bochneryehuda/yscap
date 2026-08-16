'use strict';
/**
 * Pure offline test for the LT PPE validation scenario matrix (src/longterm/ppe/scenario-matrix.js).
 *   node scripts/test-lt-ppe-scenario-matrix.js
 */

const assert = require('assert');
const M = require('../src/longterm/ppe/scenario-matrix');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const dq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// ---- fullSizeOf -------------------------------------------------------------
eq(M.fullSizeOf({}), 1, 'fullSizeOf: no axes -> 1 (base alone)');
eq(M.fullSizeOf({ a: [1, 2], b: [3, 4, 5] }), 6, 'fullSizeOf: product of axis lengths');
eq(M.fullSizeOf({ a: [1, 2], b: [] }), 0, 'fullSizeOf: an empty axis -> 0');

// ---- full cartesian product -------------------------------------------------
(() => {
  const { scenarios, fullSize, truncated, stride } = M.buildMatrix(
    { fico: [700, 740], ltv: [70, 75, 80] },
    { base: { product: '30yr', lock_days: 30 } },
  );
  eq(fullSize, 6, 'buildMatrix: fullSize = 6');
  eq(truncated, false, 'buildMatrix: not truncated');
  eq(stride, 1, 'buildMatrix: stride 1');
  eq(scenarios.length, 6, 'buildMatrix: 6 scenarios');

  // base merged under every scenario
  ok(scenarios.every((s) => s.product === '30yr' && s.lock_days === 30), 'base merged into every scenario');

  // last axis varies fastest, indices sequential
  eq(scenarios[0].fico, 700, 's0 fico');
  eq(scenarios[0].ltv, 70, 's0 ltv');
  eq(scenarios[1].ltv, 75, 's1 ltv (last axis fastest)');
  eq(scenarios[2].ltv, 80, 's2 ltv');
  eq(scenarios[3].fico, 740, 's3 fico rolls over');
  eq(scenarios[3].ltv, 70, 's3 ltv resets');
  dq(scenarios.map((s) => s._index), [0, 1, 2, 3, 4, 5], 'indices are the grid positions');
  eq(scenarios[0]._label, 'fico=700 ltv=70', 'label from axis keys');
})();

// ---- axis value wins over base on a name clash ------------------------------
(() => {
  const { scenarios } = M.buildMatrix({ product: ['a', 'b'] }, { base: { product: 'base' } });
  dq(scenarios.map((s) => s.product), ['a', 'b'], 'axis overrides base for the same key');
})();

// ---- empty axis -> no scenarios ---------------------------------------------
(() => {
  const r = M.buildMatrix({ fico: [700], ltv: [] });
  eq(r.scenarios.length, 0, 'empty axis -> no scenarios');
  eq(r.fullSize, 0, 'empty axis -> fullSize 0');
})();

// ---- no axes -> base alone --------------------------------------------------
(() => {
  const r = M.buildMatrix({}, { base: { product: 'x' } });
  eq(r.scenarios.length, 1, 'no axes -> one scenario (the base)');
  eq(r.scenarios[0].product, 'x', 'that scenario is the base');
})();

// ---- deterministic truncation, no silent cap --------------------------------
(() => {
  const r = M.buildMatrix({ a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }, { maxScenarios: 3 });
  eq(r.fullSize, 10, 'truncation: fullSize reports the real grid size');
  eq(r.truncated, true, 'truncation: flagged');
  eq(r.stride, 4, 'truncation: stride = ceil(10/3)');
  ok(r.scenarios.length <= 3, 'truncation: honors the ceiling');
  dq(r.scenarios.map((s) => s._index), [0, 4, 8], 'truncation: deterministic stride positions');

  // re-running yields the identical set (reproducible shadow runs)
  const r2 = M.buildMatrix({ a: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] }, { maxScenarios: 3 });
  dq(r2.scenarios.map((s) => s.a), r.scenarios.map((s) => s.a), 'truncation: deterministic across runs');
})();

// ---- ceiling never exceeded even when stride leaves a remainder -------------
(() => {
  const r = M.buildMatrix({ a: Array.from({ length: 7 }, (_, i) => i) }, { maxScenarios: 3 });
  ok(r.scenarios.length <= 3, 'ceiling honored (7 items, stride 3 -> [0,3,6], length 3)');
})();

// ---- custom label keys ------------------------------------------------------
(() => {
  const { scenarios } = M.buildMatrix({ fico: [700], ltv: [70], state: ['CA'] }, { label: ['state', 'fico'] });
  eq(scenarios[0]._label, 'state=CA fico=700', 'label uses the requested keys in order');
})();

// ---- describeScenario -------------------------------------------------------
eq(M.describeScenario({ a: 1, b: 'x', _index: 5 }), 'a=1 b=x', 'describeScenario: skips _-prefixed keys by default');
eq(M.describeScenario({ a: 1, b: 2 }, ['b']), 'b=2', 'describeScenario: honors explicit keys');

// ---- combinationAt internal -------------------------------------------------
(() => {
  const axes = { x: ['p', 'q'], y: [1, 2, 3] };
  dq(M._internals.combinationAt(axes, ['x', 'y'], 0), { x: 'p', y: 1 }, 'combinationAt 0');
  dq(M._internals.combinationAt(axes, ['x', 'y'], 3), { x: 'q', y: 1 }, 'combinationAt 3 rolls x');
  dq(M._internals.combinationAt(axes, ['x', 'y'], 5), { x: 'q', y: 3 }, 'combinationAt 5 (last cell)');
})();

console.log(`ok - lt ppe scenario matrix (${n} assertions)`);
