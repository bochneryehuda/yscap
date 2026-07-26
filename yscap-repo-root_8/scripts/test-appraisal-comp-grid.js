/**
 * Comp-grid split unit tests — the As-Is vs ARV separation must NEVER put a comp in the wrong
 * grid. Verifies narrative naming, price proximity, single-grid defaults, and the never-guess
 * fallbacks against synthetic inputs (no DB, no corpus needed). Run: node scripts/test-appraisal-comp-grid.js
 */
const assert = require('assert');
const { splitComps, _internals } = require('../src/lib/appraisal/comp-grid');

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log('PASS', msg); pass++; };
const comp = (seq, sale, adj) => ({ seq: String(seq), salePrice: sale, adjustedPrice: adj });

// ---- number-list expansion ----
{
  const e = _internals.expandNumberList;
  assert.deepStrictEqual([...e('1, 2, and 3')].sort(), [1, 2, 3]);
  assert.deepStrictEqual([...e('4-6')].sort(), [4, 5, 6]);
  assert.deepStrictEqual([...e('7 thru 9')].sort(), [7, 8, 9]);
  assert.deepStrictEqual([...e('4, #5, #6 and #7')].sort((a, b) => a - b), [4, 5, 6, 7]);
  ok(true, 'expandNumberList handles ranges, comma+and, #-prefixed, thru');
}

// ---- narrative: two-sided naming ("used for" role verb) ----
{
  const texts = ['Comparables 1, 2, and 3 are used for the As-Repaired Value and comparables 4, 5, and 6 are used for the as-is value.'];
  const r = splitComps({ basis: 'ARV', asIsValue: null, arvValue: 500000, texts,
    comps: [1, 2, 3, 4, 5, 6].map((s) => comp(s, null, null)) });
  const set = Object.fromEntries(r.comps.map((c) => [c.seq, c.comp_set]));
  ok(r.confidence === 'narrative' && set['1'] === 'arv' && set['4'] === 'as_is' && set['6'] === 'as_is',
    'two-sided narrative → 1-3 ARV, 4-6 As-Is');
}

// ---- narrative: incidental mention must NOT bind (never-guess) ----
{
  const texts = ['The estimated "as repaired" value for the subject is $268,000 with comparable 1 considered the most similar comparable.'];
  const r = splitComps({ basis: 'ARV', asIsValue: null, arvValue: 268000, texts,
    comps: [1, 2, 3, 4, 5, 6].map((s) => comp(s, 200000, 260000)) });
  ok(r.confidence === 'single_grid' && r.comps.every((c) => c.comp_set === 'arv'),
    'incidental "comparable 1 is most similar" does NOT fabricate a split → single ARV grid');
}

// ---- narrative: As-Is carved out → the rest default to ARV (safe asymmetry) ----
{
  const texts = ['Comparable 7, 8 & 9 reflect the As-Is Value.'];
  const r = splitComps({ basis: 'ARV', asIsValue: 615000, arvValue: 850000, texts,
    comps: [comp(1, 840000, 845000), comp(2, 850000, 852000), comp(7, 610000, 618000), comp(8, 620000, 616000), comp(9, 600000, 614000)] });
  const set = Object.fromEntries(r.comps.map((c) => [c.seq, c.comp_set]));
  ok(set['7'] === 'as_is' && set['9'] === 'as_is' && set['1'] === 'arv' && set['2'] === 'arv',
    'As-Is comps named (7,8,9) → the rest default to ARV');
}

// ---- narrative: ARV-only naming → unnamed stay UNKNOWN, never fabricated as As-Is ----
{
  const texts = ['Comparables 1, 2, and 3 were used for the As-Repaired Value.'];
  const r = splitComps({ basis: 'ARV', asIsValue: null, arvValue: 140000, texts,
    comps: [1, 2, 3, 4, 5, 6].map((s) => comp(s, null, null)) });
  const set = Object.fromEntries(r.comps.map((c) => [c.seq, c.comp_set]));
  ok(set['1'] === 'arv' && set['4'] === 'unknown' && set['6'] === 'unknown' && r.needsReview,
    'ARV-only naming with no As-Is anchor → 1-3 ARV, rest UNKNOWN + review (never guessed As-Is)');
}

// ---- proximity: both raw & adjusted must agree ----
{
  const r = splitComps({ basis: 'ARV', asIsValue: 420000, arvValue: 640000, texts: [],
    comps: [comp(1, 715000, 639700), comp(2, 650000, 649326), comp(3, 655000, 635700), comp(7, 460000, 461700), comp(8, 375000, 412700)] });
  const set = Object.fromEntries(r.comps.map((c) => [c.seq, c.comp_set]));
  ok(r.confidence === 'proximity' && set['1'] === 'arv' && set['7'] === 'as_is' && set['8'] === 'as_is',
    'proximity: high comps → ARV, low comps → As-Is (raw & adjusted agree)');
}

// ---- proximity disagreement → unknown, never guessed ----
{
  const r = splitComps({ basis: 'ARV', asIsValue: 230000, arvValue: 350000, texts: [],
    comps: [comp(1, 340000, 348000), comp(2, 345000, 349000), comp(3, 342000, 351000), comp(4, 228000, 349000), comp(5, 239000, 350000)] });
  const set = Object.fromEntries(r.comps.map((c) => [c.seq, c.comp_set]));
  ok(set['4'] === 'unknown' && set['5'] === 'unknown' && r.needsReview,
    'carried-over adjustments (raw says As-Is, adjusted says ARV) → UNKNOWN + review');
}

// ---- single-grid As-Is basis (no reno) → all as_is, no fabricated ARV ----
{
  const r = splitComps({ basis: 'ASIS', asIsValue: 1050000, arvValue: null, texts: [],
    comps: [1, 2, 3, 4, 5].map((s) => comp(s, 1000000, 1040000)) });
  ok(r.confidence === 'single_grid' && r.comps.every((c) => c.comp_set === 'as_is'),
    'straight As-Is appraisal → single As-Is grid, every comp as_is');
}

// ---- pure As-Is even when prices look bimodal (the 09709435 trap) ----
{
  const r = splitComps({ basis: 'ASIS', asIsValue: 650000, arvValue: null, texts: [],
    comps: [comp(1, 700000, 690000), comp(2, 680000, 670000), comp(7, 400000, 410000), comp(8, 380000, 390000)] });
  ok(r.comps.every((c) => c.comp_set === 'as_is'),
    'bimodal prices on a NON-reno file never manufacture an As-Is/ARV split (single grid)');
}

// ---- a condition/quality description must NOT bind (audit T2 — bare label + soft verb) ----
{
  const texts = ["Comparable 3 best reflects the subject's as-is condition and quality."];
  const r = splitComps({ basis: 'ARV', asIsValue: 200000, arvValue: 300000, texts,
    comps: [1, 2, 3, 4].map((s) => comp(s, 290000, 295000)) });
  ok(!r.comps.some((c) => c.comp_set === 'as_is'),
    '"reflects the as-is condition" (a condition description) never fabricates an As-Is comp');
}

// ---- proximity needs a REAL two-grid: a lonely low comp is not an As-Is grid (audit #1) ----
{
  // ARV 530k; five comps mostly near ARV, one lonely low comp at 401k that does NOT bracket As-Is 475k.
  const r = splitComps({ basis: 'ARV', asIsValue: 475000, arvValue: 530000, texts: [],
    comps: [comp(1, 520000, 525000), comp(2, 528000, 531000), comp(3, 515000, 524000), comp(4, 519000, 527000), comp(5, 401000, 401000)] });
  ok(!r.comps.some((c) => c.comp_set === 'as_is') && r.needsReview,
    'a single low comp does not form a phantom As-Is grid (proximity validity gate) → review');
}

// ---- a comp named on BOTH sides → unknown + review, never defaulted into a grid (audit #4) ----
{
  const texts = ['Comparables 1 and 2 are used for the as-repaired value. Comparable 2 is used for the as-is value.'];
  const r = splitComps({ basis: 'ARV', asIsValue: 300000, arvValue: 450000, texts,
    comps: [1, 2, 3].map((s) => comp(s, 400000, 420000)) });
  const set = Object.fromEntries(r.comps.map((c) => [c.seq, c.comp_set]));
  ok(set['2'] === 'unknown' && r.needsReview,
    'a comp named on BOTH sides is left unknown + review, never defaulted into a grid');
}

// ---- stale narrative (names a comp seq not in the grid) → rejected, not trusted ----
{
  const texts = ['Comparable 7, 8 & 9 reflect the As-Is Value.'];
  const r = splitComps({ basis: 'ARV', asIsValue: 615000, arvValue: 850000, texts,
    comps: [comp(1, 840000, 845000), comp(2, 850000, 852000), comp(3, 830000, 848000)] }); // no 7,8,9!
  ok(!r.comps.some((c) => c.comp_set === 'as_is'),
    'narrative naming seqs absent from the grid (stale boilerplate) is not trusted');
}

console.log(`\nALL ${pass} comp-grid assertions passed`);
