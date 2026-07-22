'use strict';
/**
 * R5.46 — pure tests for the hard release gates. The load-bearing guarantee:
 * the gate is conservative — a missing safety metric FAILS (never an assumed
 * pass), a single dangerous false clear blocks, and any per-slice regression
 * blocks even when the overall average improves.
 */
const assert = require('assert');
const { evaluate, BOUNDARY_F1_MIN } = require('../src/lib/underwriting/release-gate');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// A fully-clean candidate passes.
const clean = {
  dangerousFalseClears: 0,
  fatalRecall: { candidate: 0.98, baseline: 0.97 },
  unsupportedFactCount: 0,
  nonexistentCitationCount: 0,
  boundaryF1ByFamily: { bank_statement: 0.95, title: 0.93 },
  conditionClearPrecision: { candidate: 0.9, baseline: 0.88 },
  sliceRegressions: [],
  suppressionRules: [{ code: 'x', scoped: true, hidesMaterial: false }],
};
let r = evaluate(clean);
assert.strictEqual(r.pass, true, 'a fully-clean candidate passes');
assert.strictEqual(r.blockers.length, 0);
ok('a clean candidate passes all gates');

// One dangerous false clear blocks.
r = evaluate({ ...clean, dangerousFalseClears: 1 });
assert.strictEqual(r.pass, false);
assert.ok(r.blockers.some((b) => b.startsWith('gate1')));
ok('a single dangerous false clear blocks (gate 1)');

// Fatal-recall drop blocks.
r = evaluate({ ...clean, fatalRecall: { candidate: 0.90, baseline: 0.97 } });
assert.strictEqual(r.pass, false);
assert.ok(r.blockers.some((b) => b.startsWith('gate2')));
ok('a fatal-recall reduction blocks (gate 2)');

// Unsupported fact / hallucinated citation blocks.
assert.strictEqual(evaluate({ ...clean, unsupportedFactCount: 2 }).pass, false);
assert.strictEqual(evaluate({ ...clean, nonexistentCitationCount: 1 }).pass, false);
ok('unsupported fact / nonexistent citation blocks (gate 3)');

// Boundary F1 below threshold on ANY family blocks.
r = evaluate({ ...clean, boundaryF1ByFamily: { bank_statement: 0.95, title: 0.80 } });
assert.strictEqual(r.pass, false);
assert.ok(r.blockers.some((b) => b.includes('title')));
ok('boundary F1 below threshold on any family blocks (gate 4)');

// Per-slice regression blocks even with a clean overall.
r = evaluate({ ...clean, sliceRegressions: [{ slice: 'FL', metric: 'precision', delta: -0.05 }] });
assert.strictEqual(r.pass, false);
assert.ok(r.blockers.some((b) => b.startsWith('gate6')));
ok('a per-slice regression blocks even when overall improves (gate 6)');

// Suppression that hides a material finding, or is unscoped, blocks.
assert.strictEqual(evaluate({ ...clean, suppressionRules: [{ code: 'c', scoped: true, hidesMaterial: true }] }).pass, false);
assert.strictEqual(evaluate({ ...clean, suppressionRules: [{ code: 'c', scoped: false, hidesMaterial: false }] }).pass, false);
ok('a material-hiding or unscoped suppression blocks (gate 7)');

// CONSERVATIVE: missing safety metrics FAIL (never an assumed pass).
r = evaluate({});
assert.strictEqual(r.pass, false, 'an empty metrics object cannot pass');
assert.ok(r.blockers.some((b) => b.startsWith('gate1')));
assert.ok(r.blockers.some((b) => b.startsWith('gate2')));
ok('missing safety metrics FAIL (no assumed pass)');

// An EXPLICIT null (a SQL NULL read from the DB) must FAIL gate 1 — it is "not
// measured", never a measured zero. (Regression guard for the audit blocker.)
r = evaluate({ ...clean, dangerousFalseClears: null });
assert.strictEqual(r.pass, false, 'an explicit null dangerousFalseClears cannot pass');
assert.ok(r.blockers.some((b) => b.startsWith('gate1')), 'gate1 blocks on an explicit null');
r = evaluate({ ...clean, dangerousFalseClears: 'NaN' });
assert.strictEqual(r.pass, false, 'a non-numeric dangerousFalseClears cannot pass');
ok('an explicit null / non-numeric safety metric fails its gate');

assert.strictEqual(BOUNDARY_F1_MIN, 0.90);
ok('boundary F1 threshold is 0.90');

console.log(`\nR5.46 release-gate pure — ${passed} checks passed`);
