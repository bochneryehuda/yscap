'use strict';
/**
 * #194 — pure tests for the calibration-loop reliability report. Proves the
 * scoring closes the loop honestly: a known-outcome match is correct, an AI-clear
 * that reality did NOT clear is a dangerous miss, an unknown outcome is never
 * scored, and the calibration math (accuracy, Brier score, per-bucket gap, ECE,
 * dangerous-miss rate, per-component slices) is exact.
 */
const assert = require('assert');
const rel = require('../src/lib/underwriting/reliability');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg} (got ${a}, want ${b})`);

// 1. scoreOutcome: agreement, the dangerous miss, and unknown-is-not-wrong.
{
  assert.strictEqual(rel.scoreOutcome('clear', 'clear').correct, true);
  assert.strictEqual(rel.scoreOutcome('approved', 'cleared').correct, true, 'different spellings canonicalize');
  const dm = rel.scoreOutcome('clear', 'declined');
  assert.strictEqual(dm.correct, false);
  assert.strictEqual(dm.dangerousMiss, true, 'AI cleared what reality declined = dangerous miss');
  const flag = rel.scoreOutcome('decline', 'clear');
  assert.strictEqual(flag.correct, false);
  assert.strictEqual(flag.dangerousMiss, false, 'AI declined what cleared is wrong but NOT dangerous');
  assert.strictEqual(rel.scoreOutcome('clear', null).correct, null, 'unknown outcome is never scored');
  assert.strictEqual(rel.scoreOutcome('', 'clear').correct, null, 'unknown AI verdict is never scored');
  ok('scoreOutcome: agreement / dangerous-miss / non-dangerous-wrong / unknown-not-scored');
}

// 2. reliabilityReport: exact accuracy, Brier, calibration buckets, ECE, dangerous rate.
{
  const records = [
    { aiVerdict: 'clear', confidence: 1.0, outcome: 'clear', component: 'fico' },     // correct, bucket .9-1.0
    { aiVerdict: 'decline', confidence: 1.0, outcome: 'decline', component: 'fico' },  // correct, bucket .9-1.0
    { aiVerdict: 'clear', confidence: 0.8, outcome: 'decline', component: 'ltv' },     // WRONG + dangerous, bucket .8-.9
    { aiVerdict: 'clear', confidence: 0.9, outcome: null, component: 'ltv' },          // unknown → not scored
  ];
  const r = rel.reliabilityReport(records);
  assert.strictEqual(r.n, 4);
  assert.strictEqual(r.scored, 3);
  assert.strictEqual(r.unscored, 1);
  near(r.accuracy, 0.6667, 'accuracy = 2/3');
  near(r.brierScore, 0.2133, 'brier = (0+0+0.64)/3');
  assert.strictEqual(r.dangerousMisses, 1);
  near(r.dangerousMissRate, 0.3333, 'dangerous rate = 1/3');
  near(r.ece, 0.2667, 'ECE = (2*0 + 1*0.8)/3');

  const hi = r.calibration.find((b) => b.bucket === '0.9-1.0');
  const mid = r.calibration.find((b) => b.bucket === '0.8-0.9');
  assert.ok(hi && mid, 'both non-empty buckets present');
  assert.strictEqual(hi.n, 2); near(hi.accuracy, 1.0, 'hi bucket accuracy'); near(hi.gap, 0, 'hi bucket well-calibrated');
  assert.strictEqual(mid.n, 1); near(mid.accuracy, 0.0, 'mid bucket accuracy'); near(mid.gap, -0.8, 'mid bucket overconfident');

  assert.strictEqual(r.byComponent.fico.scored, 2); near(r.byComponent.fico.accuracy, 1.0, 'fico slice');
  assert.strictEqual(r.byComponent.ltv.scored, 1); assert.strictEqual(r.byComponent.ltv.dangerousMisses, 1, 'ltv slice carries the dangerous miss');
  ok('reliabilityReport: accuracy / Brier / per-bucket calibration + gap / ECE / dangerous-miss rate / slices exact');
}

// 3. Perfectly-confident-and-correct → Brier 0, ECE 0, accuracy 1.
{
  const r = rel.reliabilityReport([
    { verdict: 'clear', confidence: 1.0, outcome: 'clear' },
    { verdict: 'decline', confidence: 1.0, outcome: 'decline' },
  ]);
  near(r.accuracy, 1.0, 'all correct');
  near(r.brierScore, 0, 'perfectly confident + correct → Brier 0');
  near(r.ece, 0, 'perfectly calibrated → ECE 0');
  ok('a perfectly confident + correct batch scores Brier 0 / ECE 0 / accuracy 1');
}

// 4. Records with NO confidence still score accuracy, but Brier/ECE are null (not 0).
{
  const r = rel.reliabilityReport([
    { verdict: 'clear', outcome: 'clear' },
    { verdict: 'clear', outcome: 'decline' },
  ]);
  assert.strictEqual(r.scored, 2);
  near(r.accuracy, 0.5, 'accuracy without confidence');
  assert.strictEqual(r.confidenceScored, 0);
  assert.strictEqual(r.brierScore, null, 'no confidence → Brier null, never a fake 0');
  assert.strictEqual(r.ece, null, 'no confidence → ECE null');
  ok('confidence-less records score accuracy but leave Brier/ECE null (never a fake 0)');
}

// 5. Hostile input never throws — safe empty report.
{
  const a = rel.reliabilityReport(null);
  const b = rel.reliabilityReport([null, 42, { verdict: {} }, 'x']);
  assert.strictEqual(a.scored, 0);
  assert.strictEqual(b.scored, 0, 'unreadable records are simply not scored');
  ok('hostile input degrades to a safe empty report, never throws');
}

console.log(`\nreliability pure — ${passed} checks passed`);
