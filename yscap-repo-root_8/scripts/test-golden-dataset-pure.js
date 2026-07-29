'use strict';
/**
 * R5.44 — pure tests for the golden-dataset seed builder.
 * Proves it (1) classifies each correction's risk tier + weight (false clear >
 * false flag), (2) skips agrees + unreadable (nothing to learn), (3) escalates a
 * fatal-severity false clear to the top tier, (4) de-duplicates by a stable key
 * keeping the heaviest, (5) caps to a target size while RESERVING representation
 * of every tier + component (never drops all the minors), (6) rolls up tier +
 * component coverage, and (7) never throws.
 */
const assert = require('assert');
const gd = require('../src/lib/underwriting/golden-dataset');
const { TIER } = gd;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- classify: a false clear outweighs a false flag ---
let fc = gd.classifyCorrection({ component: 'title', aiVerdict: 'clear', correctVerdict: 'declined' });
let ff = gd.classifyCorrection({ component: 'income', aiVerdict: 'declined', correctVerdict: 'approved' });
assert.strictEqual(fc.tier, TIER.FALSE_CLEAR);
assert.strictEqual(ff.tier, TIER.MINOR, 'a false flag (AI declined, human cleared) is a minor tier');
assert.ok(fc.weight > ff.weight, 'a false clear weighs more than a false flag');
ok('a false clear is a higher tier + weight than a false flag');

// --- a FATAL-severity false clear escalates to the top tier ---
let fatal = gd.classifyCorrection({ component: 'title', aiVerdict: 'clear', correctVerdict: 'declined', severity: 'fatal' });
assert.strictEqual(fatal.tier, TIER.FATAL);
assert.ok(fatal.weight >= fc.weight, 'the fatal false clear weighs at least as much as a normal one');
ok('a fatal-severity false clear escalates to the FATAL tier');

// --- an explicit weight multiplier hand-boosts a nasty case (never below the floor) ---
let boosted = gd.classifyCorrection({ component: 'assets', aiVerdict: 'clear', correctVerdict: 'refer', weight: 3 });
assert.ok(boosted.weight > gd.TIER_WEIGHT.false_clear, 'the multiplier lifts the weight above the tier floor');
let unboosted = gd.classifyCorrection({ component: 'assets', aiVerdict: 'clear', correctVerdict: 'refer', weight: 0.1 });
assert.strictEqual(unboosted.weight, gd.TIER_WEIGHT.false_clear, 'a tiny multiplier never drops below the tier floor');
ok('an explicit weight multiplier boosts a case but never below its tier floor');

// --- agrees + unreadable are skipped (nothing to learn) ---
assert.strictEqual(gd.classifyCorrection({ component: 'x', aiVerdict: 'clear', correctVerdict: 'approved' }), null, 'an agree is not a correction');
assert.strictEqual(gd.classifyCorrection({ component: 'x', aiVerdict: 'gibberish', correctVerdict: 'declined' }), null, 'an unreadable verdict is skipped');
ok('agrees and unreadable verdicts are skipped (not candidates)');

// --- buildDataset caps to targetSize but reserves every tier + component ---
const corrections = [];
// 20 false clears on title (heaviest)
for (let i = 0; i < 20; i++) corrections.push({ id: `fc${i}`, component: 'title', aiVerdict: 'clear', correctVerdict: 'declined' });
// 5 false flags on income (minor tier)
for (let i = 0; i < 5; i++) corrections.push({ id: `ff${i}`, component: 'income', aiVerdict: 'declined', correctVerdict: 'approved' });
// 1 fatal on assets
corrections.push({ id: 'fatal1', component: 'assets', aiVerdict: 'clear', correctVerdict: 'declined', severity: 'critical' });
const ds = gd.buildDataset(corrections, { targetSize: 10, minPerComponent: 1 });
assert.strictEqual(ds.selected, 10, 'the dataset is capped to the target size');
assert.strictEqual(ds.total, 26, 'all 26 disagreements are candidates');
assert.strictEqual(ds.droppedForCap, 16);
assert.ok(ds.tierDistribution.fatal >= 1, 'the single fatal case is reserved despite the cap');
assert.ok(ds.componentCoverage.income >= 1, 'a minor-tier income case is reserved (not starved by heavy title cases)');
assert.ok(ds.componentCoverage.assets >= 1, 'the assets component is represented');
assert.ok(ds.componentCoverage.title >= 1);
assert.strictEqual(ds.cases[0].tier, TIER.FATAL, 'the dataset is ordered worst-tier first');
ok('buildDataset caps to target size while reserving every tier + component (fatal + minor never dropped)');

// --- de-duplication: the same correction twice collapses to the heaviest ---
const dup = gd.buildDataset([
  { component: 'title', aiVerdict: 'clear', correctVerdict: 'declined', input: 'same', weight: 1 },
  { component: 'title', aiVerdict: 'clear', correctVerdict: 'declined', input: 'same', weight: 4 }, // heavier dup
], { targetSize: 100 });
assert.strictEqual(dup.selected, 1, 'the duplicate collapses to one case');
assert.strictEqual(dup.cases[0].weight, gd.TIER_WEIGHT.false_clear * 4, 'the heavier instance survives');
ok('duplicate corrections collapse to a single case keeping the heaviest weight');

// --- weightedTotal + distribution reflect the selected set ---
const w = gd.buildDataset([
  { id: 'a', component: 'c1', aiVerdict: 'clear', correctVerdict: 'declined' }, // false_clear w4
  { id: 'b', component: 'c2', aiVerdict: 'declined', correctVerdict: 'clear' }, // minor w1
], { targetSize: 100 });
assert.strictEqual(w.weightedTotal, 5, '4 + 1');
assert.strictEqual(w.tierDistribution.false_clear, 1);
assert.strictEqual(w.tierDistribution.minor, 1);
ok('weightedTotal and tier distribution reflect the selected cases');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => gd.buildDataset(null));
assert.strictEqual(gd.buildDataset(null).selected, 0);
assert.deepStrictEqual(gd.buildDataset([]).cases, []);
assert.doesNotThrow(() => gd.buildDataset([null, 'junk', {}, { component: 'x' }]));
assert.strictEqual(gd.buildDataset([null, 'junk', {}]).skipped, 3, 'null/junk/agree-less are skipped, not crashes');
assert.strictEqual(gd.classifyCorrection(null), null);
// a circular input (no id) must not throw when building the de-dupe key
const circ = { component: 'title', aiVerdict: 'clear', correctVerdict: 'declined' };
circ.input = circ; // circular
assert.doesNotThrow(() => gd.buildDataset([circ]), 'a circular input never throws (JSON.stringify guarded)');
assert.strictEqual(gd.buildDataset([circ]).selected, 1, 'a circular-input correction is still classified');
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.44 golden-dataset pure — ${passed} checks passed`);
