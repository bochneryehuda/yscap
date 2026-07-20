'use strict';
/**
 * Unit tests for the derived-metrics engine (metrics.js). Pure — no AI, no DB.
 * Verifies the ratios, the min-of-caps binding constraint, over-leverage findings, and the
 * "never invent a denominator" rule (a metric with a missing base is omitted, not guessed).
 */
const assert = require('assert');
const { computeMetrics, DEFAULT_CAPS } = require('../src/lib/underwriting/metrics');

// ---- A well-within-caps loan → all metrics present, no findings ----
{
  const r = computeMetrics({ loanAmount: 300000, purchasePrice: 400000, asIsValue: 420000, arv: 550000, rehabBudget: 60000 });
  assert.strictEqual(r.findings.length, 0, 'a conservative loan raises nothing');
  const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  assert.ok(byKey.ltp && byKey.ltv && byKey.ltc && byKey.arv_ltv, 'all four metrics computed');
  // LTC = 300k / (400k + 60k) = 0.652
  assert.strictEqual(byKey.ltc.value, 0.65);
  // ARV-LTV = 300k / 550k = 0.545
  assert.strictEqual(byKey.arv_ltv.value, 0.55);
  // maxLoan = min cap amount. Caps: ltp .9*400k=360k, ltv .8*420k=336k, ltc .9*460k=414k, arv .75*550k=412.5k
  // → binding is LTV as-is at 336k.
  assert.strictEqual(r.binding, 'ltv');
  assert.strictEqual(r.maxLoan, 336000);
}

// ---- An over-leveraged loan → a warning per breached cap, with the shortfall ----
{
  const r = computeMetrics({ loanAmount: 430000, purchasePrice: 400000, asIsValue: 420000, arv: 550000, rehabBudget: 60000 });
  const codes = r.findings.map((f) => f.code).sort();
  // 430k exceeds ltp(360k), ltv(336k), ltc(414k), arv(412.5k) → all four breached.
  assert.deepStrictEqual(codes, ['over_arv_ltv', 'over_ltc', 'over_ltp', 'over_ltv']);
  for (const f of r.findings) {
    assert.strictEqual(f.severity, 'warning', 'over-leverage is a warning, never an auto-block');
    assert.strictEqual(f.blocksCtc, false);
    assert.ok(f.actions.includes('grant_exception'), 'an exception path is offered');
  }
  const ltv = r.metrics.find((m) => m.key === 'ltv');
  assert.strictEqual(ltv.over, 94000, '430k - 336k cap = 94k over on the binding metric');
  assert.strictEqual(ltv.pass, false);
}

// ---- Missing denominators are OMITTED, never guessed ----
{
  // No appraisal values (as-is/arv absent) → only LTP and LTC computable.
  const r = computeMetrics({ loanAmount: 300000, purchasePrice: 400000, rehabBudget: 50000 });
  const keys = r.metrics.map((m) => m.key).sort();
  assert.deepStrictEqual(keys, ['ltc', 'ltp'], 'as-is/arv metrics dropped when those values are absent');
  assert.strictEqual(r.binding, 'ltp', 'min of ltp(360k) and ltc(.9*450k=405k) is ltp');
}

// ---- No purchase price → cost also drops (cost depends on price); nothing to compute ----
{
  const r = computeMetrics({ loanAmount: 300000, arv: 500000 });
  const keys = r.metrics.map((m) => m.key).sort();
  assert.deepStrictEqual(keys, ['arv_ltv'], 'only ARV-LTV survives with just arv');
}

// ---- Rehab absent but price present → LTC uses purchase alone (rehab = 0) ----
{
  const r = computeMetrics({ loanAmount: 360000, purchasePrice: 400000 });
  const ltc = r.metrics.find((m) => m.key === 'ltc');
  assert.strictEqual(ltc.baseAmount, 400000, 'cost falls back to purchase when rehab is absent');
}

// ---- Caps are overridable per program ----
{
  const tight = { ...DEFAULT_CAPS, ltp: { cap: 0.70, base: 'purchasePrice', label: 'Loan-to-purchase', baseLabel: 'purchase price' } };
  const r = computeMetrics({ loanAmount: 300000, purchasePrice: 400000 }, tight);
  const ltp = r.metrics.find((m) => m.key === 'ltp');
  assert.strictEqual(ltp.capAmount, 280000, '0.70 * 400k');
  assert.ok(ltp.over > 0, '300k over the 280k tight cap');
}

console.log('test-underwriting-metrics: LTV/LTC/ARV-LTV ratios, binding constraint, over-leverage pass');
