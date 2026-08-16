'use strict';
/**
 * Pure offline test for the LT PPE rate-sheet ingestion normalizer
 * (src/longterm/ppe/ratesheet-ingest.js).
 *   node scripts/test-lt-ppe-ratesheet-ingest.js
 */

const assert = require('assert');
const I = require('../src/longterm/ppe/ratesheet-ingest');
const D = require('../src/longterm/ppe/ratesheet-diff');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const crosswalk = { 'DSCR30': 'p_dscr_30', 'DSCR30IO': 'p_dscr_30_io' };

// ---- normalizeGrid: happy path ----------------------------------------------
(() => {
  const rows = [
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 102.850 },
    { productCode: 'DSCR30', noteRate: 7.25, lockDays: 30, price: 101.500 },
    { productCode: 'DSCR30IO', noteRate: 7.5, lockDays: 45, price: 100.000, term: 30 },
  ];
  const r = I.normalizeGrid(rows, crosswalk);
  eq(r.problems.length, 0, 'no problems on clean rows');
  eq(r.rows.length, 3, 'three cells emitted');
  eq(r.cells['p_dscr_30/7000/30'], 102850, 'rate->milli-percent, price->milli-points, cell keyed');
  eq(r.cells['p_dscr_30_io/7500/45'], 100000, 'second product mapped via crosswalk');
  eq(r.rows[2].term, 30, 'term carried when present');
  eq(r.rows[0].productId, 'p_dscr_30', 'crosswalk applied');
})();

// ---- normalizeGrid: unmapped product is a problem, not a guess --------------
(() => {
  const r = I.normalizeGrid([{ productCode: 'MYSTERY', noteRate: 7, lockDays: 30, price: 100 }], crosswalk);
  eq(r.rows.length, 0, 'unmapped product excluded');
  ok(r.problems[0].reason.includes('unmapped product'), 'reported as unmapped');
})();

// ---- normalizeGrid: bad numbers / lockDays ---------------------------------
(() => {
  const r = I.normalizeGrid([
    { productCode: 'DSCR30', noteRate: 'x', lockDays: 30, price: 100 },
    { productCode: 'DSCR30', noteRate: 7, lockDays: 30, price: null },
    { productCode: 'DSCR30', noteRate: 7, lockDays: 0, price: 100 },
  ], crosswalk);
  eq(r.rows.length, 0, 'all three bad rows excluded');
  eq(r.problems.length, 3, 'each bad row reported');
})();

// ---- normalizeGrid: duplicate cells -----------------------------------------
(() => {
  const exact = I.normalizeGrid([
    { productCode: 'DSCR30', noteRate: 7, lockDays: 30, price: 102.85 },
    { productCode: 'DSCR30', noteRate: 7, lockDays: 30, price: 102.85 },
  ], crosswalk);
  eq(exact.rows.length, 1, 'an exact duplicate cell is deduped');
  eq(exact.problems.length, 0, 'exact duplicate is not a problem');

  const conflict = I.normalizeGrid([
    { productCode: 'DSCR30', noteRate: 7, lockDays: 30, price: 102.85 },
    { productCode: 'DSCR30', noteRate: 7, lockDays: 30, price: 101.00 },
  ], crosswalk);
  eq(conflict.rows.length, 1, 'conflicting duplicate excluded (first kept)');
  ok(conflict.problems[0].reason.includes('different price'), 'conflict reported');
})();

// ---- validateShape: monotonicity -------------------------------------------
(() => {
  const good = I.normalizeGrid([
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 100.0 },
    { productCode: 'DSCR30', noteRate: 7.25, lockDays: 30, price: 101.0 },
    { productCode: 'DSCR30', noteRate: 7.5, lockDays: 30, price: 102.0 },
  ], crosswalk);
  eq(I.validateShape(good).ok, true, 'a monotonic ladder is valid');

  const bad = I.normalizeGrid([
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 100.0 },
    { productCode: 'DSCR30', noteRate: 7.25, lockDays: 30, price: 99.0 }, // price falls as rate rises
  ], crosswalk);
  const v = I.validateShape(bad);
  eq(v.ok, false, 'a non-monotonic ladder is invalid');
  eq(v.problems[0].kind, 'monotonicity', 'monotonicity problem reported');
})();

// ---- validateShape: min rungs + missing lock -------------------------------
(() => {
  const norm = I.normalizeGrid([
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 100.0 },
  ], crosswalk);
  const v = I.validateShape(norm, { minRungsPerLadder: 2, expectedLockDays: [30, 45] });
  ok(v.problems.some((p) => p.kind === 'too_few_rungs'), 'too few rungs flagged');
  ok(v.problems.some((p) => p.kind === 'missing_lock' && p.lockDays === 45), 'missing lock 45 flagged');
})();

// ---- ingestGrid: ok gate ----------------------------------------------------
(() => {
  const rows = [
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 100.0 },
    { productCode: 'DSCR30', noteRate: 7.25, lockDays: 30, price: 101.0 },
  ];
  const g = I.ingestGrid(rows, crosswalk);
  eq(g.ok, true, 'clean + monotonic -> ok');
  eq(Object.keys(g.cells).length, 2, 'cells produced');

  const bad = I.ingestGrid([{ productCode: 'MYSTERY', noteRate: 7, lockDays: 30, price: 100 }], crosswalk);
  eq(bad.ok, false, 'a normalization problem makes the snapshot not ok');
})();

// ---- end-to-end: two days ingested -> diffed --------------------------------
(() => {
  const day1 = I.ingestGrid([
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 102.850 },
    { productCode: 'DSCR30', noteRate: 7.25, lockDays: 30, price: 101.500 },
  ], crosswalk);
  const day2 = I.ingestGrid([
    { productCode: 'DSCR30', noteRate: 7.0, lockDays: 30, price: 102.900 }, // +50 milli
    { productCode: 'DSCR30', noteRate: 7.25, lockDays: 30, price: 101.500 },
  ], crosswalk);
  const diff = D.diffRulesets(day1.cells, day2.cells);
  eq(diff.changed.length, 1, 'one cell moved between the two ingested days');
  eq(diff.changed[0].key, 'p_dscr_30/7000/30', 'the right cell');
  const cls = D.classifyDiff(diff, { maxDeltaMilli: 250, maxPct: 0.05 });
  eq(cls.autoApply.length, 1, 'the small move auto-applies — the ingest->diff->classify pipeline joins up');
})();

console.log(`ok - lt ppe ratesheet-ingest (${n} assertions)`);
