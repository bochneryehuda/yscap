#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the AVM consensus math (src/lib/underwriting/avm-consensus.js).
 * No DB — exercises computeConsensus + compareToAppraisal.
 */
const assert = require('assert');
const { computeConsensus, compareToAppraisal, _internals } = require('../src/lib/underwriting/avm-consensus');
const { median, mean, stddev } = _internals;

// ---- basic stats ----
assert.strictEqual(median([]), null);
assert.strictEqual(median([500000]), 500000);
assert.strictEqual(median([400000, 500000, 600000]), 500000);
assert.strictEqual(median([400000, 500000, 600000, 700000]), 550000);
assert.strictEqual(mean([100, 200, 300]), 200);
assert.strictEqual(Math.round(stddev([100, 100, 100])), 0);

// ---- three AVMs all agreeing ----
{
  const c = computeConsensus([
    { source_id: 'housecanary', value: 500000 },
    { source_id: 'clearcapital', value: 505000 },
    { source_id: 'attom', value: 495000 },
  ]);
  assert.strictEqual(c.count, 3);
  assert.strictEqual(c.median, 500000);
  assert.ok(c.agreementScore > 0.98, `high-agreement score should be near 1, got ${c.agreementScore}`);
  assert.ok(c.cv < 0.02, `cv should be tiny, got ${c.cv}`);
}

// ---- three AVMs wildly disagreeing ----
{
  const c = computeConsensus([
    { source_id: 'housecanary', value: 500000 },
    { source_id: 'clearcapital', value: 300000 },
    { source_id: 'attom', value: 700000 },
  ]);
  assert.strictEqual(c.median, 500000);
  assert.ok(c.agreementScore < 0.8, `wide-spread score should be lower, got ${c.agreementScore}`);
}

// ---- empty ----
{
  const c = computeConsensus([]);
  assert.strictEqual(c.count, 0);
  assert.strictEqual(c.median, null);
  assert.strictEqual(c.agreementScore, null);
}

// ---- ignores non-numeric ----
{
  const c = computeConsensus([{ source_id: 'x', value: 500000 }, { source_id: 'y', value: 'garbage' }, { source_id: 'z', value: null }]);
  assert.strictEqual(c.count, 1);
  assert.strictEqual(c.median, 500000);
}

// ---- compareToAppraisal: within threshold ----
{
  const r = compareToAppraisal(510000, 500000, 0.10);   // 2% high, within 10%
  assert.strictEqual(r.disagrees, false);
  assert.ok(!/HIGHER|LOWER/.test(r.message));
}

// ---- compareToAppraisal: over threshold LOWER ----
{
  const r = compareToAppraisal(420000, 500000, 0.10);   // 16% low
  assert.strictEqual(r.disagrees, true);
  assert.ok(r.message.includes('LOWER'), r.message);
  assert.ok(r.diff < 0);
}

// ---- compareToAppraisal: over threshold HIGHER ----
{
  const r = compareToAppraisal(590000, 500000, 0.10);   // 18% high
  assert.strictEqual(r.disagrees, true);
  assert.ok(r.message.includes('HIGHER'), r.message);
  assert.ok(r.diff > 0);
}

// ---- compareToAppraisal: missing data ----
{
  const r = compareToAppraisal(null, 500000);
  assert.strictEqual(r.disagrees, false);
}
{
  const r = compareToAppraisal(500000, null);
  assert.strictEqual(r.disagrees, false);
}
{
  const r = compareToAppraisal(500000, 0);
  assert.strictEqual(r.disagrees, false);
}

// ---- custom threshold ----
{
  const r5 = compareToAppraisal(530000, 500000, 0.05);    // 6% high, over 5%
  assert.strictEqual(r5.disagrees, true);
  const r20 = compareToAppraisal(530000, 500000, 0.20);   // 6% high, under 20%
  assert.strictEqual(r20.disagrees, false);
}

console.log('test-avm-consensus-pure: consensus math + appraisal comparison pass');
