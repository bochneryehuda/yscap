'use strict';
/**
 * TOTAL COST / LTC GO BY THE LOWER OF THE PURCHASE PRICE AND THE AS-IS VALUE
 * (owner-directed 2026-08-05; the explicit written authorization the frozen-engine
 * HARD RULE requires — CLAUDE.md). In the owner's own words:
 *
 *   "The total cost should include the purchase price and the rehab budget … we
 *    should always use the purchase price. If the as-is value is more than the
 *    purchase price we should not use the as-is value, we should use the purchase
 *    price. If the as-is value is less than the purchase price then we can't use the
 *    default purchase price, we need to use that as-is value. This is for all the
 *    programs … we need to use that as-is value for the cost calculation and not the
 *    purchase price."
 *
 * The acquisition figure in the cost basis is now `acqDenom` — min(purchase, as-is)
 * on a purchase, the as-is value on a refinance — the SAME number the initial-advance
 * cap already used. The interest reserve is untouched (these scenarios request none,
 * so cost basis == acquisition + rehab exactly).
 *
 * PURE — no DB, no network. Covers the three frozen engines (which share sizeLoan)
 * plus the two backend re-derivations that must stay in step with the engine:
 * `metrics.js` (the underwriting LTC ratio) and `structure-underwriter.js` (its
 * fallback cost basis when the registered quote carries none).
 */
const YSP = require('../web/tools/standard-program.js');
const GSP = require('../web/tools/gold-standard.js');
const SVP = require('../web/tools/silver-program.js');
const { computeMetrics } = require('../src/lib/underwriting/metrics.js');
const { computeRatios } = require('../src/lib/underwriting/structure-underwriter.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? '  ok ' : ' FAIL'} ${msg}`); if (!cond) failures++; };
const near = (a, b, eps = 0.5) => Math.abs(Number(a) - Number(b)) <= eps;

function deal(over) {
  return Object.assign({
    strategy: 'Fix & Flip', state: 'NJ', fico: 740, term: 12,
    arv: 486000, rehabBudget: 60000, irMonths: 0,
    expFlips: 5, expHolds: 2, propertyType: 'Single Family', units: 1,
  }, over);
}

console.log('A. every frozen engine sizes the cost basis on min(purchase, as-is)');
for (const [name, eng] of [['Standard', YSP], ['Gold', GSP], ['Silver', SVP]]) {
  const below = eng.evaluate(deal({ loanType: 'Purchase', purchasePrice: 300000, asIsValue: 210000 })).sizing;
  const above = eng.evaluate(deal({ loanType: 'Purchase', purchasePrice: 300000, asIsValue: 400000 })).sizing;
  const blank = eng.evaluate(deal({ loanType: 'Purchase', purchasePrice: 300000, asIsValue: 0 })).sizing;
  const refi = eng.evaluate(deal({ loanType: 'Refinance', purchasePrice: 0, asIsValue: 260000 })).sizing;

  // as-is BELOW the price → the cost basis (and the acq cap) go by the as-is value.
  ok(below && near(below.acqDenom, 210000), `${name}: as-is < price ⇒ acqDenom = as-is (210000), got ${below && below.acqDenom}`);
  ok(below && near(below.costBasis, 210000 + 60000), `${name}: as-is < price ⇒ costBasis = as-is + rehab (270000), got ${below && Math.round(below.costBasis)}`);
  ok(below && near(below.ltcPct, below.totalLoan / (210000 + 60000)), `${name}: as-is < price ⇒ LTC measured on the as-is cost basis`);

  // as-is ABOVE the price → keep the purchase price (never the higher as-is).
  ok(above && near(above.acqDenom, 300000), `${name}: as-is > price ⇒ acqDenom = price (300000), got ${above && above.acqDenom}`);
  ok(above && near(above.costBasis, 300000 + 60000), `${name}: as-is > price ⇒ costBasis = price + rehab (360000), got ${above && Math.round(above.costBasis)}`);

  // as-is BLANK on a purchase → the purchase price stands in (unchanged behaviour).
  ok(blank && near(blank.acqDenom, 300000), `${name}: as-is blank ⇒ acqDenom = price (300000), got ${blank && blank.acqDenom}`);
  ok(blank && near(blank.costBasis, 360000), `${name}: as-is blank ⇒ costBasis = price + rehab (360000)`);

  // REFINANCE → the as-is value is the basis (there is no purchase price).
  ok(refi && near(refi.acqDenom, 260000), `${name}: refinance ⇒ acqDenom = as-is (260000), got ${refi && refi.acqDenom}`);
  ok(refi && near(refi.costBasis, 260000 + 60000), `${name}: refinance ⇒ costBasis = as-is + rehab (320000)`);

  // The min actually bit: the as-is<price basis is strictly below the price basis.
  ok(below && above && below.costBasis < above.costBasis - 1,
    `${name}: the min lowered the cost basis (${Math.round(below.costBasis)} < ${Math.round(above.costBasis)})`);
}

console.log('B. the acq-LTV cap is unchanged — the initial advance never grows from this change');
for (const [name, eng] of [['Standard', YSP], ['Gold', GSP], ['Silver', SVP]]) {
  // The acquisition (initial) advance was already capped on min(price, as-is); the
  // change only lowers the LTC ceiling, so the initial advance can only stay flat or
  // drop — never rise. Compare a below-price deal's initial to a would-be higher one.
  const below = eng.evaluate(deal({ loanType: 'Purchase', purchasePrice: 300000, asIsValue: 210000 })).sizing;
  ok(below && below.acqLtvPct <= (eng.evaluate(deal({ loanType: 'Purchase', purchasePrice: 300000, asIsValue: 210000 })).caps.maxAcqLTV) + 0.002,
    `${name}: as-is-based initial advance respects the acq-LTV cap`);
}

console.log('C. metrics.js LTC ratio uses min(purchase, as-is); LTP/LTV keep their own bases');
{
  const below = computeMetrics({ loanAmount: 249000, initialAdvance: 189000, purchasePrice: 300000, asIsValue: 210000, rehabBudget: 60000 });
  const above = computeMetrics({ loanAmount: 330000, initialAdvance: 270000, purchasePrice: 300000, asIsValue: 400000, rehabBudget: 60000 });
  const noAsIs = computeMetrics({ loanAmount: 401250, initialAdvance: 391500, purchasePrice: 435000, rehabBudget: 9750 });
  const refi = computeMetrics({ loanAmount: 268000, initialAdvance: 208000, purchasePrice: null, asIsValue: 260000, rehabBudget: 60000 });
  const M = (r, k) => r.metrics.find((m) => m.key === k);

  ok(M(below, 'ltc') && near(M(below, 'ltc').baseAmount, 270000), `metrics: as-is < price ⇒ LTC base = as-is + rehab (270000), got ${M(below, 'ltc') && M(below, 'ltc').baseAmount}`);
  ok(M(below, 'ltp') && near(M(below, 'ltp').baseAmount, 300000), 'metrics: LTP base stays the purchase price (300000)');
  ok(M(below, 'ltv') && near(M(below, 'ltv').baseAmount, 210000), 'metrics: LTV base stays the as-is value (210000)');
  ok(M(above, 'ltc') && near(M(above, 'ltc').baseAmount, 360000), `metrics: as-is > price ⇒ LTC base = price + rehab (360000), got ${M(above, 'ltc') && M(above, 'ltc').baseAmount}`);
  ok(M(noAsIs, 'ltc') && near(M(noAsIs, 'ltc').baseAmount, 444750), 'metrics: no as-is ⇒ LTC base = price + rehab (444750) [regression: existing behaviour]');
  ok(!M(refi, 'ltc'), 'metrics: refinance (no purchase price) ⇒ the LTC metric is skipped, never fabricated');
}

console.log('D. structure-underwriter fallback cost basis uses min(recognized price, as-is)');
{
  // No registered costBasis on the structure → fall back to min(price, as-is) + rehab.
  const below = computeRatios({ totalLoan: 249000, recognizedPurchasePrice: 300000, asIsValue: 210000, rehabBudget: 60000 });
  const above = computeRatios({ totalLoan: 330000, recognizedPurchasePrice: 300000, asIsValue: 400000, rehabBudget: 60000 });
  const noAsIs = computeRatios({ totalLoan: 330000, recognizedPurchasePrice: 300000, rehabBudget: 60000 });
  const registered = computeRatios({ totalLoan: 249000, recognizedPurchasePrice: 300000, asIsValue: 210000, rehabBudget: 60000, costBasis: 999999 });
  const refi = computeRatios({ totalLoan: 268000, asIsValue: 260000, rehabBudget: 60000 });

  ok(near(below.costBasis, 270000), `structure: as-is < price ⇒ costBasis = 270000, got ${below.costBasis}`);
  ok(near(above.costBasis, 360000), `structure: as-is > price ⇒ costBasis = 360000, got ${above.costBasis}`);
  ok(near(noAsIs.costBasis, 360000), 'structure: no as-is ⇒ costBasis = price + rehab (360000)');
  ok(near(registered.costBasis, 999999), 'structure: a registered costBasis still wins over the fallback');
  ok(refi.costBasis == null, 'structure: no recognized price (refinance) ⇒ null cost basis (LTC row skipped), never fabricated');
  ok(near(below.ltc, 249000 / 270000), 'structure: LTC ratio measured on the as-is cost basis');
}

console.log(failures === 0 ? '\ncost-basis-as-is: ALL PASS' : `\ncost-basis-as-is: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
