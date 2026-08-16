'use strict';
/**
 * Pure offline test for the LT PPE coverage generators (src/longterm/ppe/coverage.js).
 *   node scripts/test-lt-ppe-coverage.js
 */

const assert = require('assert');
const C = require('../src/longterm/ppe/coverage');
const M = require('../src/longterm/ppe/scenario-matrix');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

// Independent verifier: does `scenarios` cover every value pair from `axes`?
function allPairsCovered(axes, scenarios) {
  const keys = Object.keys(axes).filter((k) => axes[k].length > 0);
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      for (const vi of axes[keys[i]]) {
        for (const vj of axes[keys[j]]) {
          const hit = scenarios.some((s) => s[keys[i]] === vi && s[keys[j]] === vj);
          if (!hit) return `${keys[i]}=${vi} & ${keys[j]}=${vj}`;
        }
      }
    }
  }
  return null; // all covered
}

// ---- Layer A: one-field goldens ---------------------------------------------
(() => {
  const baseline = { purpose: 'Purchase', propertyType: 'SFR', fico: 740 };
  const g = C.oneFieldGoldens(baseline, { purpose: ['Purchase', 'Refinance', 'Cash out'], propertyType: ['SFR', 'Condo'] });
  eq(g[0]._probe, 'baseline', 'first is the baseline');
  // baseline + 3 purposes + 2 property types = 6
  eq(g.length, 6, 'one golden per option + baseline');
  ok(g.every((s) => s.fico === 740), 'untouched fields keep the baseline value');
  const refi = g.find((s) => s._probe === 'purpose=Refinance');
  eq(refi.purpose, 'Refinance', 'the varied field changed');
  eq(refi.propertyType, 'SFR', 'only one field changes at a time');
  ok(g.every((s) => s._layer === 'A'), 'tagged layer A');

  // includeBaselineValue:false drops options equal to the baseline
  const g2 = C.oneFieldGoldens(baseline, { purpose: ['Purchase', 'Refinance'] }, { includeBaselineValue: false });
  ok(!g2.some((s) => s._probe === 'purpose=Purchase'), 'baseline-equal option skipped when asked');
})();

// ---- Layer B: numeric boundaries -------------------------------------------
(() => {
  const b = C.boundaryScenarios({ fico: 740 }, 'fico', { min: 660, max: 800, edges: [680, 700, 720], epsilon: 1 });
  const vals = b.map((s) => s.fico);
  ok(vals.includes(659), 'below-min present');
  ok(vals.includes(660), 'min present');
  ok(vals.includes(800), 'max present');
  ok(vals.includes(801), 'above-max present');
  ok(vals.includes(730), 'midpoint present ((660+800)/2)');
  ok(vals.includes(679) && vals.includes(680), 'just-below and at each edge (680)');
  ok(vals.includes(719) && vals.includes(720), 'edge 720 covered');
  ok(b.every((s) => s._layer === 'B'), 'tagged layer B');
  // no duplicate values
  eq(new Set(vals).size, vals.length, 'boundary values are deduped');
})();

// ---- Layer C: pairwise correctness -----------------------------------------
(() => {
  const axes = {
    purpose: ['Purchase', 'Refinance', 'Cash out'],
    propertyType: ['SFR', 'Condo', '2-4'],
    occupancy: ['Investment', 'Primary'],
    io: [true, false],
  };
  const { scenarios, pairsTotal, pairsCovered, complete } = C.pairwise(axes, { base: { term: 30 } });
  eq(C.pairwise(axes).complete, true, 'pairwise reports complete');
  ok(complete, 'complete flag set');
  eq(pairsCovered, pairsTotal, 'every pair counted as covered');
  eq(allPairsCovered(axes, scenarios), null, 'INDEPENDENT check: every value pair appears together');
  ok(scenarios.every((s) => s.term === 30), 'base merged into every case');
  ok(scenarios.every((s) => s._layer === 'C'), 'tagged layer C');

  // far smaller than the full cartesian (3*3*2*2 = 36)
  const full = M.fullSizeOf(axes);
  ok(scenarios.length < full, `pairwise (${scenarios.length}) is smaller than cartesian (${full})`);
  ok(scenarios.length >= 9, 'at least max(axis sizes)^2 = 9 cases needed for 3x3');
})();

// ---- pairwise determinism ---------------------------------------------------
(() => {
  const axes = { a: [1, 2, 3], b: ['x', 'y', 'z'], c: [true, false] };
  const r1 = C.pairwise(axes).scenarios.map((s) => `${s.a}${s.b}${s.c}`);
  const r2 = C.pairwise(axes).scenarios.map((s) => `${s.a}${s.b}${s.c}`);
  assert.deepStrictEqual(r1, r2, 'pairwise is deterministic across runs'); n += 1;
})();

// ---- pairwise degenerate axes ----------------------------------------------
(() => {
  eq(C.pairwise({}).scenarios.length, 1, '0 axes -> one base case');
  const one = C.pairwise({ purpose: ['Purchase', 'Refinance', 'Cash out'] });
  eq(one.scenarios.length, 3, '1 axis -> one case per value');
  eq(one.pairsTotal, 0, '1 axis -> no pairs');
  const empty = C.pairwise({ a: [1, 2], b: [] });
  // b is empty so only a is a live axis -> 1-axis behavior
  eq(empty.scenarios.length, 2, 'an empty axis is ignored');
})();

// ---- a larger pairwise still fully covers ----------------------------------
(() => {
  const axes = {
    state: ['CA', 'NY', 'TX', 'FL'],
    fico: [680, 700, 720, 740],
    ltv: [70, 75, 80],
    dscr: [1.0, 1.25],
    product: ['30yr', 'IO'],
  };
  const { scenarios, complete } = C.pairwise(axes);
  ok(complete, 'large pairwise completes');
  eq(allPairsCovered(axes, scenarios), null, 'large pairwise: every pair covered');
  ok(scenarios.length < M.fullSizeOf(axes), 'and far smaller than the 192-cell cartesian');
})();

console.log(`ok - lt ppe coverage (${n} assertions)`);
