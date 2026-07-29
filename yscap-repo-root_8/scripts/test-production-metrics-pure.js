'use strict';
/**
 * #218 — pure tests for the strict production-metrics dashboard. Proves the two
 * headline SAFETY numbers and the blunt readiness status:
 *   • a single false clear (AI cleared, reality didn't) → red + a blocker (the bar is ZERO);
 *   • missed-material findings are counted from the human_outcome flag and gate the status;
 *   • false FLAGS (over-flagging) are tracked but never dangerous;
 *   • below the minimum sample → insufficient_data (numbers aren't trusted yet);
 *   • a clean, large sample → green;
 *   • nothing ever throws.
 */
const assert = require('assert');
const pm = require('../src/lib/underwriting/production-metrics');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// helper: n correct clears
const clears = (n) => Array.from({ length: n }, () => ({ verdict: 'clear', outcome: 'clear' }));

// 1. One false clear among an otherwise-clean large sample → RED + blocker (zero-tolerance).
{
  const records = clears(40).concat([{ verdict: 'clear', outcome: 'decline' }]);
  const m = pm.productionMetrics(records);
  assert.strictEqual(m.falseClears, 1, 'the AI-cleared-but-declined record is a false clear');
  assert.ok(m.falseClearRate > 0);
  assert.strictEqual(m.status, 'red', 'a single false clear fails the production bar');
  assert.ok(m.blockers.some((b) => /false clear/i.test(b)), 'the blocker names the false clear');
  ok('one false clear → red status + a blocker (the bar is ZERO)');
}

// 2. Missed-material findings counted from the flag; over the threshold → red.
{
  // 40 scored, 3 flagged missed-material (7.5% > 2%) but NO false clears.
  const records = clears(37).concat([
    { verdict: 'decline', outcome: 'decline', missedMaterial: true },
    { verdict: 'refer', outcome: 'refer', missed_material: true },
    { verdict: 'decline', outcome: 'decline', missedMaterial: true },
  ]);
  const m = pm.productionMetrics(records);
  assert.strictEqual(m.falseClears, 0, 'no false clears here');
  assert.strictEqual(m.missedMaterial, 3, 'both missedMaterial and missed_material flags count');
  assert.ok(m.missedMaterialRate > 0.02);
  assert.strictEqual(m.status, 'red', 'missed-material over threshold is red');
  assert.ok(m.blockers.some((b) => /missed-material/i.test(b)));
  ok('missed-material findings are counted from the flag and gate the status');
}

// 3. False FLAGS (AI declined, reality clear) are tracked but never dangerous.
{
  const records = clears(30).concat(Array.from({ length: 6 }, () => ({ verdict: 'decline', outcome: 'clear' })));
  const m = pm.productionMetrics(records);
  assert.strictEqual(m.falseClears, 0, 'over-flagging is never a false clear');
  assert.strictEqual(m.falseFlags, 6);
  assert.ok(m.falseFlagRate > 0.15);
  assert.strictEqual(m.status, 'amber', 'heavy over-flagging is amber (a nuisance), not red');
  ok('false flags (over-flagging) are tracked, amber not red — never dangerous');
}

// 4. Below the minimum sample → insufficient_data.
{
  const m = pm.productionMetrics(clears(5));
  assert.strictEqual(m.status, 'insufficient_data', 'a tiny sample is not yet trustworthy');
  ok('below the minimum sample → insufficient_data');
}

// 5. A clean, large sample → green with zero on both headline numbers.
{
  const m = pm.productionMetrics(clears(50));
  assert.strictEqual(m.falseClears, 0);
  assert.strictEqual(m.missedMaterial, 0);
  assert.strictEqual(m.status, 'green');
  assert.strictEqual(m.headline.falseClearRate, 0);
  assert.strictEqual(m.headline.missedMaterialRate, 0);
  ok('a clean large sample → green, both headline numbers zero');
}

// 6. Unknown/pending outcomes never count against us (excluded from the denominator).
{
  const records = clears(25).concat([{ verdict: 'clear', outcome: null }, { verdict: 'clear', outcome: 'unknown' }]);
  const m = pm.productionMetrics(records);
  assert.strictEqual(m.sampleSize, 25, 'only records with a known outcome are scored (null / unknown excluded)');
  assert.strictEqual(m.status, 'green');
  ok('pending / unknown outcomes are excluded from the scored denominator');
}

// 7. Custom thresholds are honoured.
{
  const records = clears(40).concat([{ verdict: 'clear', outcome: 'decline' }]);
  const lenient = pm.productionMetrics(records, { thresholds: { falseClearMax: 1 } });
  assert.notStrictEqual(lenient.status, 'red', 'a raised false-clear tolerance no longer trips red on 1');
  ok('custom thresholds are honoured');
}

// 8. Hostile input never throws; degrades to insufficient_data.
{
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.doesNotThrow(() => pm.productionMetrics(bad));
    const m = pm.productionMetrics(bad);
    assert.strictEqual(m.status, 'insufficient_data');
  }
  ok('hostile input never throws; degrades to insufficient_data');
}

console.log(`\nproduction-metrics pure — ${passed} checks passed`);
