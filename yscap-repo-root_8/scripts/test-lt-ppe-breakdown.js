#!/usr/bin/env node
'use strict';
/**
 * LT PPE pricing-breakdown read-model — pure offline test.
 *
 * The "mother interface" (owner-directed 2026-08-17). Proves the read-model over the
 * REAL producers — our engine's reconstruction (`quote.quoteProgram` → `pricing.priceRung`)
 * and Lender Price's parsed sheet (`lp-normalize-full.normalizeLpFull`) — never a mock that
 * agrees with itself:
 *   • base price at the top, the itemized LLPA stack, the corporate margin as its OWN line;
 *   • every line is COST-POSITIVE on points (a positive value lowers the price);
 *   • the running effect FOOTS EXACTLY to the final price (base − Σ lines === final);
 *   • an ineligible scenario shows its reasons and no price to break down;
 *   • Lender Price's own disqualifications surface as their own panel;
 *   • the breakdown can be built from Lender Price's own sheet (source:'lp').
 *
 *   node scripts/test-lt-ppe-breakdown.js
 */

const quote = require('../src/longterm/ppe/quote');
const lpFullNorm = require('../src/longterm/ppe/lp-normalize-full');
const pb = require('../src/longterm/ppe/pricing-breakdown');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE pricing-breakdown — offline\n');

// ---------------------------------------------------------------------------
// A real program + settings, priced by the real engine.
// ---------------------------------------------------------------------------
const program = {
  code: 'TEST-DSCR', name: 'DSCR 30yr', investorCode: 'ACME',
  baseGrid: [
    { rate: 7.0, basePriceMilli: 99000 },
    { rate: 7.5, basePriceMilli: 100000 },
    { rate: 8.0, basePriceMilli: 101000 },
  ],
  rules: [
    // one COST LLPA and one CREDIT LLPA, both always-on (no `when`)
    { code: 'ltv_hi', kind: 'pricing', adjustment: { code: 'ltv_hi', category: 'fico_ltv', dimension: 'fico_ltv', adjMilli: 500, reason: 'High LTV' } },
    { code: 'purch_credit', kind: 'pricing', adjustment: { code: 'purch_credit', category: 'purpose', dimension: 'purpose', adjMilli: -250, reason: 'Purchase incentive' } },
    // a hard bound so we can force an ineligible scenario
    { code: 'max_ltv', kind: 'bound', target: 'ltv', op: 'max', value: 80000 },
  ],
};
const settings = {
  'pricing.correspondent_margin_milli': 250,
  'pricing.rounding_mode': 'nearest_eighth',
  'pricing.price_floor_milli': null,
};

const eligibleScenario = { ltv: 75000, purpose: 'purchase', loan_amount: 400000 };
const q = quote.quoteProgram({ scenario: eligibleScenario, program, settings });
ok(q.eligible === true, 'the real engine prices the eligible scenario');

// ---------------------------------------------------------------------------
// 1) the breakdown over OUR reconstruction
// ---------------------------------------------------------------------------
const view = pb.buildPricingBreakdown({ quote: q });
ok(view.source === 'ours', 'source is our reconstruction when only a quote is given');
ok(view.eligible === true, 'eligible carries through');
ok(view.eligibility.eligible === true && view.eligibility.reasons.length === 0, 'no decline reasons on an eligible deal');

// default featured rung is nearest-to-par: 7.5 (final 99500, dist 500) beats 7.0 (dist 1500),
// ties 8.0 (final 100500, dist 500) and breaks toward the lower rate.
ok(view.rate === 7.5, `featured rung is the at-par coupon 7.5 (got ${view.rate})`);
ok(view.base_price === 100000, 'base price is the featured rung grid cell (100000)');
ok(view.base_points === 0, 'base points = par − base price = 0');

// the itemized lines: two LLPAs + the margin component
const llpas = view.adjustments.filter((l) => l.kind === 'llpa');
ok(llpas.length === 2, `two itemized LLPA lines (got ${llpas.length})`);

const cost = llpas.find((l) => l.dimension === 'fico_ltv');
const credit = llpas.find((l) => l.dimension === 'purpose');
ok(cost && cost.points_milli === 500 && cost.cost_positive === true, 'the +0.500 cost line is cost-positive (lowers price)');
ok(credit && credit.points_milli === -250 && credit.cost_positive === false, 'the −0.250 credit line is NOT a cost (raises price)');
ok(cost.label === 'High LTV', 'the cost line carries its human label');
ok(cost.source_milli === 500, 'the source value is kept verbatim');

const margin = view.adjustments.find((l) => l.kind === 'margin');
ok(!!margin, 'the corporate margin is its OWN line, never folded into the base');
ok(margin.points_milli === 250 && margin.cost_positive === true, 'the margin is a +0.250 cost line');

// 2) THE RUNNING EFFECT FOOTS EXACTLY: base − Σ points === final price.
{
  const sumPoints = view.adjustments.reduce((s, l) => s + (Number.isInteger(l.points_milli) ? l.points_milli : 0), 0);
  ok(view.base_price - sumPoints === view.final_price, `base − Σ line points === final price (${view.base_price} − ${sumPoints} === ${view.final_price})`);
  const last = view.adjustments[view.adjustments.length - 1];
  ok(last.running_price_milli === view.final_price, 'the last line’s running price lands on the final price');
  ok(view.final_price === 99500, 'final price is 99.500 (100000 − 500 cost + 250 credit − 250 margin)');
  ok(view.final_points === 500, 'final points = par − final price = 500 (the borrower pays 0.500)');
}

// 3) the whole ladder is present, one rung flagged featured
ok(view.ladder.length === 3, 'the compact ladder carries every coupon');
ok(view.ladder.filter((r) => r.featured).length === 1, 'exactly one ladder rung is the featured one');
ok(view.ladder.find((r) => r.featured).rate === 7.5, 'the featured ladder rung matches the breakdown');

// 4) an explicit rate override features that coupon
{
  const v80 = pb.buildPricingBreakdown({ quote: q, rate: 8.0 });
  ok(v80.rate === 8.0 && v80.base_price === 101000, 'an explicit rate features that rung');
}

// ---------------------------------------------------------------------------
// 5) an INELIGIBLE scenario — reasons, no price
// ---------------------------------------------------------------------------
{
  const bad = quote.quoteProgram({ scenario: { ltv: 85000, purpose: 'purchase' }, program, settings });
  ok(bad.eligible === false, 'the engine declines an over-LTV scenario');
  const v = pb.buildPricingBreakdown({ quote: bad });
  ok(v.eligible === false, 'the view is ineligible');
  ok(v.eligibility.reasons.length >= 1 && /ltv/i.test(v.eligibility.reasons.join(' ')), 'the decline reason is surfaced');
  ok(v.base_price === null && v.final_price === null && v.adjustments.length === 0, 'no price to break down');
  ok(typeof v.note === 'string' && /ineligible/i.test(v.note), 'the note says why there is no breakdown');
}

// ---------------------------------------------------------------------------
// 6) Lender Price's OWN disqualifications → the decline panel
// ---------------------------------------------------------------------------
{
  const disqRaw = {
    ready: true,
    lenders: [{
      lender: 'ACME', investor: 'ACME',
      items: [{ program: 'DSCR 30yr', reasons: [{ rule: 'min_fico_680', adjType: 'decline' }, { rule: 'max_ltv_75', adjType: 'decline' }] }],
    }],
  };
  const dq = lpFullNorm.normalizeLpDisqualified(disqRaw, {});
  const v = pb.buildPricingBreakdown({ quote: q, lpDisqualified: dq });
  ok(v.disqualify_reasons.length === 2, 'both Lender Price decline rules are surfaced');
  ok(v.disqualify_reasons[0].rule === 'min_fico_680' && v.disqualify_reasons[0].label === 'Min FICO 680', 'a disqualify reason carries its rule + human label');
}

// ---------------------------------------------------------------------------
// 7) build the breakdown from Lender Price's OWN sheet (source:'lp')
// ---------------------------------------------------------------------------
{
  const parseFull = {
    programs: [{
      lender: 'ACME', investor: 'ACME', program: 'DSCR 30yr', product: '30yr',
      options: [{
        priceBuild: { noteRate: 7.5, price: 99.5, baseRate: 7.25, basePoints: 0, adjustmentPoints: 0.5 },
        adjustments: [{ group: 'fico_ltv', reason: 'High LTV', adjType: 'llpa', value: 0.5 }],
        holdback: { lender: [{ value: 0.25 }], investor: [] },
        flags: {},
      }],
    }],
  };
  const full = lpFullNorm.normalizeLpFull(parseFull, {});
  const v = pb.buildPricingBreakdown({ quote: q, lpFull: full, source: 'lp' });
  ok(v.source === 'lp', 'the breakdown is built from Lender Price’s own sheet');
  ok(v.base_price === 100000, 'LP base price = par − base points (100000)');
  const lpCost = v.adjustments.find((l) => l.kind === 'llpa');
  ok(lpCost && lpCost.points_milli === 500 && lpCost.cost_positive === true, 'LP’s LLPA is a cost-positive 0.500-point line');
  const lpMargin = v.adjustments.find((l) => l.kind === 'margin');
  ok(lpMargin && lpMargin.points_milli === 250, 'LP’s margin (0.25 holdback) is its own line');
  ok(v.final_price === 99500, 'the published LP final price is shown (99.500)');
}

// ---------------------------------------------------------------------------
// 8) humanLabel acronyms + shapes
// ---------------------------------------------------------------------------
ok(pb.humanLabel('fico_ltv') === 'FICO LTV', 'known acronyms read in caps');
ok(pb.humanLabel('minFicoBand') === 'Min FICO Band', 'camelCase splits and acronyms cap');
ok(pb.humanLabel('') === 'Adjustment', 'an empty code never renders a blank cell');

// ---------------------------------------------------------------------------
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
