'use strict';
/**
 * Unit tests for the derived-metrics engine (metrics.js). Pure — no AI, no DB.
 * Verifies the ratios, the numerator rule (acquisition metrics use the INITIAL ADVANCE, the rest use
 * the TOTAL loan), the min-of-caps binding constraint, over-leverage findings, and the "never invent a
 * denominator / never assess acquisition leverage on the wrong numerator" rule.
 */
const assert = require('assert');
const { computeMetrics, capsFromRegistration, DEFAULT_CAPS } = require('../src/lib/underwriting/metrics');

// ---- capsFromRegistration: the file's ACTUAL registered engine caps drive the metrics, so a
//      validly-sized registered loan never exceeds its own caps (no spurious over-leverage). ----
{
  // The owner's real file: total 401,250, cost = 435,000 + 9,750 = 444,750 → LTC 90.22%. With the
  // GENERIC 90% LTC cap this false-flags ~$975 over; with the engine's actual maxLtc (e.g. 0.905) it does not.
  const generic = computeMetrics({ loanAmount: 401250, initialAdvance: 391500, purchasePrice: 435000, rehabBudget: 9750 });
  assert.ok(generic.findings.some((f) => f.code === 'over_ltc'), 'generic 90% LTC cap false-flags the holdback deal');
  const regCaps = capsFromRegistration({ maxAcqLtv: 0.90, maxArvLtv: 0.75, maxLtc: 0.905 });
  const real = computeMetrics({ loanAmount: 401250, initialAdvance: 391500, purchasePrice: 435000, rehabBudget: 9750 }, regCaps);
  assert.ok(!real.findings.some((f) => f.code === 'over_ltc'), 'the file’s real registered LTC cap clears the holdback deal — no spurious finding');
  // Missing registered caps → falls back to the generic defaults unchanged.
  assert.strictEqual(capsFromRegistration(null), DEFAULT_CAPS, 'no registered caps → generic defaults');
  // maxAcqLtv maps onto BOTH ltp and ltv; a missing sub-cap keeps the generic value.
  const partial = capsFromRegistration({ maxAcqLtv: 0.85 });
  assert.strictEqual(partial.ltp.cap, 0.85, 'maxAcqLtv → ltp cap');
  assert.strictEqual(partial.ltv.cap, 0.85, 'maxAcqLtv → ltv cap');
  assert.strictEqual(partial.ltc.cap, DEFAULT_CAPS.ltc.cap, 'missing maxLtc keeps the generic LTC cap');
}

// ---- REGRESSION (owner-directed 2026-07-21): a fix-&-flip whose TOTAL loan is >90% of purchase
//      because of the rehab HOLDBACK is NOT over the loan-to-purchase cap — LTP is on the INITIAL
//      advance, which is within cap. Real file: purchase 435k, total loan 401,250 (=92% of purchase),
//      initial advance 391,500 (=90% of purchase, exactly at cap), holdback 9,750. ----
{
  const r = computeMetrics({ loanAmount: 401250, initialAdvance: 391500, purchasePrice: 435000, rehabBudget: 9750 });
  const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  // LTP uses the INITIAL advance (391,500 / 435,000 = 90.0%), not the total loan (92%).
  assert.strictEqual(byKey.ltp.numer, 'initial', 'LTP is measured on the initial advance');
  assert.strictEqual(byKey.ltp.loanAmount, 391500, 'LTP numerator is the initial advance, not the total loan');
  assert.strictEqual(byKey.ltp.value, 0.9, 'LTP = initial advance / purchase = 90%');
  assert.strictEqual(byKey.ltp.over, 0, 'the initial advance is within the 90% loan-to-purchase cap — NO over-leverage finding');
  assert.ok(!r.findings.some((f) => f.code === 'over_ltp'), 'no false loan-to-purchase over-leverage finding on a holdback deal');
  // LTC uses the TOTAL loan: 401,250 / (435,000 + 9,750) = 0.9022 → cap .9*444,750 = 400,275 → slightly over.
  assert.strictEqual(byKey.ltc.numer, 'total', 'LTC is measured on the total loan');
  assert.strictEqual(byKey.ltc.loanAmount, 401250, 'LTC numerator is the total loan');
}

// ---- A well-within-caps loan (with an initial advance) → all four metrics present, no findings ----
{
  const r = computeMetrics({ loanAmount: 300000, initialAdvance: 280000, purchasePrice: 400000, asIsValue: 420000, arv: 550000, rehabBudget: 60000 });
  assert.strictEqual(r.findings.length, 0, 'a conservative loan raises nothing');
  const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  assert.ok(byKey.ltp && byKey.ltv && byKey.ltc && byKey.arv_ltv, 'all four metrics computed');
  // LTP = initial 280k / 400k = 0.70; LTV = 280k / 420k = 0.667
  assert.strictEqual(byKey.ltp.value, 0.7);
  assert.strictEqual(byKey.ltv.value, 0.67);
  // LTC = total 300k / (400k + 60k) = 0.652; ARV-LTV = 300k / 550k = 0.545
  assert.strictEqual(byKey.ltc.value, 0.65);
  assert.strictEqual(byKey.arv_ltv.value, 0.55);
  // maxLoan considers only the TOTAL-loan caps (ltc .9*460k=414k, arv .75*550k=412.5k) → arv binds at 412.5k.
  assert.strictEqual(r.binding, 'arv_ltv');
  assert.strictEqual(r.maxLoan, 412500);
}

// ---- Over-leveraged ACQUISITION (initial advance too high) → over_ltp / over_ltv ----
{
  const r = computeMetrics({ loanAmount: 400000, initialAdvance: 390000, purchasePrice: 400000, asIsValue: 420000, rehabBudget: 10000 });
  const byKey = Object.fromEntries(r.metrics.map((m) => [m.key, m]));
  // initial 390k vs ltp cap .9*400k=360k → over 30k; vs ltv cap .8*420k=336k → over 54k.
  assert.ok(r.findings.some((f) => f.code === 'over_ltp'), 'initial advance over the loan-to-purchase cap flags');
  assert.strictEqual(byKey.ltp.over, 30000, '390k - 360k = 30k over');
  assert.strictEqual(byKey.ltv.over, 54000, '390k - 336k = 54k over');
  const ltp = r.findings.find((f) => f.code === 'over_ltp');
  assert.strictEqual(ltp.severity, 'warning', 'over-leverage is a warning, never an auto-block');
  assert.strictEqual(ltp.blocksCtc, false);
  assert.ok(ltp.actions.includes('grant_exception'), 'an exception path is offered');
  assert.ok(/initial advance/i.test(ltp.title) && /initial advance/i.test(ltp.howTo), 'the finding names the initial advance, not the total loan');
}

// ---- NO initial advance (unregistered file) → acquisition metrics are SKIPPED, never computed off the total ----
{
  const r = computeMetrics({ loanAmount: 300000, purchasePrice: 400000, asIsValue: 420000, arv: 550000, rehabBudget: 60000 });
  const keys = r.metrics.map((m) => m.key).sort();
  assert.deepStrictEqual(keys, ['arv_ltv', 'ltc'], 'LTP/LTV dropped when there is no initial advance — never assessed off the total loan');
  assert.ok(!r.findings.some((f) => f.code === 'over_ltp' || f.code === 'over_ltv'), 'no acquisition over-leverage finding without an initial advance');
}

// ---- Missing denominators are OMITTED, never guessed ----
{
  // No appraisal values (as-is/arv absent) + an initial advance → only LTP and LTC computable.
  const r = computeMetrics({ loanAmount: 300000, initialAdvance: 280000, purchasePrice: 400000, rehabBudget: 50000 });
  const keys = r.metrics.map((m) => m.key).sort();
  assert.deepStrictEqual(keys, ['ltc', 'ltp'], 'as-is/arv metrics dropped when those values are absent');
  assert.strictEqual(r.binding, 'ltc', 'only the total-loan LTC constrains the max loan here');
}

// ---- No purchase price → cost also drops (cost depends on price); only ARV survives ----
{
  const r = computeMetrics({ loanAmount: 300000, initialAdvance: 280000, arv: 500000 });
  const keys = r.metrics.map((m) => m.key).sort();
  assert.deepStrictEqual(keys, ['arv_ltv'], 'only ARV-LTV survives with just arv');
}

// ---- Rehab absent but price present → LTC uses purchase alone (rehab = 0) ----
{
  const r = computeMetrics({ loanAmount: 360000, initialAdvance: 340000, purchasePrice: 400000 });
  const ltc = r.metrics.find((m) => m.key === 'ltc');
  assert.strictEqual(ltc.baseAmount, 400000, 'cost falls back to purchase when rehab is absent');
}

// ---- Caps are overridable per program (numer preserved) ----
{
  const tight = { ...DEFAULT_CAPS, ltp: { cap: 0.70, base: 'purchasePrice', numer: 'initial', label: 'Loan-to-purchase', baseLabel: 'purchase price' } };
  const r = computeMetrics({ loanAmount: 300000, initialAdvance: 300000, purchasePrice: 400000 }, tight);
  const ltp = r.metrics.find((m) => m.key === 'ltp');
  assert.strictEqual(ltp.capAmount, 280000, '0.70 * 400k');
  assert.ok(ltp.over > 0, '300k initial over the 280k tight cap');
}

console.log('test-underwriting-metrics: initial-advance LTP/LTV vs total-loan LTC/ARV, binding, over-leverage, holdback regression pass');
