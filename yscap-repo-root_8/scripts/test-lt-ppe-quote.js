#!/usr/bin/env node
'use strict';
/**
 * LT PPE quote façade — pure offline test (MEGA plan §5 + §9.2).
 * Proves the façade composes the rules evaluator + the pricing pipeline: an
 * ineligible scenario returns structured reasons (never dropped); an eligible
 * one returns a priced ladder with the margin/rounding/floor/cap/cumulative-cap
 * all resolved from settings (Rule #1 — nothing hardcoded), a program override
 * winning over the tenant default; the settings rounding enum maps correctly;
 * and the loan-size price cap tier is selected right.
 *
 *   node scripts/test-lt-ppe-quote.js
 */
const { quoteProgram, resolveRounding, capForLoanAmount } = require('../src/longterm/ppe/quote');
const settings = require('../src/longterm/ppe/settings');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function threw(fn) { try { fn(); return false; } catch { return true; } }

console.log('LT PPE quote — offline\n');

const BASE_GRID = [
  { rate: 70000, lockDays: 30, basePriceMilli: 101500 },
  { rate: 71250, lockDays: 30, basePriceMilli: 102850 },
  { rate: 72500, lockDays: 30, basePriceMilli: 104000 },
];
const RULES = [
  { code: 'no_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'New York not eligible' },
  { code: 'max_ltv', kind: 'bound', target: 'ltv', op: 'max', value: 80000 },
  { code: 'cashout', kind: 'pricing', when: { fact: 'purpose', op: 'eq', value: 'cashout' }, adjustment: { code: 'cashout', category: 'purpose', adjMilli: 500 } },
];
const program = { code: 'DHVN_DSCR30', name: 'DSCR 30yr', investorCode: 'DHVN', rules: RULES, baseGrid: BASE_GRID };

// 1) resolveRounding maps every settings enum.
ok(resolveRounding({ 'pricing.rounding_mode': 'none' }).incrementMilli === 0, 'none disables rounding');
ok(resolveRounding({ 'pricing.rounding_mode': 'nearest_eighth' }).incrementMilli === 125, 'nearest_eighth = 1/8 point');
ok(resolveRounding({ 'pricing.rounding_mode': 'nearest_increment', 'pricing.rounding_increment_milli': 250 }).incrementMilli === 250, 'nearest_increment honors the configured increment');
{
  const d = resolveRounding({ 'pricing.rounding_mode': 'down', 'pricing.rounding_increment_milli': 125 });
  ok(d.mode === 'down' && d.incrementMilli === 125, 'down carries mode + increment');
}
ok(threw(() => resolveRounding({ 'pricing.rounding_mode': 'sideways' })), 'an unknown rounding mode is refused');

// 2) capForLoanAmount picks the tier.
const tiers = [{ uptoLoanAmount: 1000000, capMilli: 103000 }, { uptoLoanAmount: 2000000, capMilli: 102000 }];
ok(capForLoanAmount(tiers, 500000) === 103000, 'a small loan gets the first (highest) cap tier');
ok(capForLoanAmount(tiers, 1500000) === 102000, 'a mid loan falls into the second tier');
ok(capForLoanAmount(tiers, 3000000) === null, 'a loan above every tier is uncapped (a bound should decline it)');
ok(capForLoanAmount(null, 500000) === null, 'no tiers → no cap');

// 3) An ineligible scenario returns structured reasons and NO ladder (§5.2 #5).
{
  const q = quoteProgram({ scenario: { state: 'NY', ltv: 70000, purpose: 'purchase', lock_days: 30, loan_amount: 500000 }, program, settings: {} });
  ok(q.eligible === false && !q.ladder, 'a NY scenario is ineligible and is not priced');
  ok(q.declines.some((d) => /New York/.test(d.reason)), 'the decline carries the human reason');
}
{
  const q = quoteProgram({ scenario: { state: 'TX', ltv: 85000, purpose: 'purchase', lock_days: 30, loan_amount: 500000 }, program, settings: {} });
  ok(q.eligible === false && q.declines.some((d) => /ltv max 80000 exceeded \(requested 85000\)/.test(d.reason)),
    'an over-LTV scenario declines with the exact numbers');
}

// 4) An eligible scenario prices the whole ladder; the 0.25 margin is applied per
//    rung (rounding disabled here to compare the raw relationship exactly).
{
  const S = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': 98000 };
  const q = quoteProgram({ scenario: { state: 'TX', fico: 740, ltv: 70000, dscr: 1200, purpose: 'purchase', lock_days: 30, loan_amount: 500000 }, program, settings: S });
  ok(q.eligible === true && q.ladder.length === 3, 'a clean scenario is eligible with a 3-rung ladder');
  ok(q.pricingBasis.marginMilli === 250, 'the margin came from settings, not a constant');
  ok(q.ladder[1].finalPriceMilli === 102600, 'the 102.850 rung prices to exactly 0.25 below the sheet');
  ok(q.ladder.every((r) => r.marginMilli === 250), 'every rung carries the same margin component');
}

// 5) With the REAL product defaults the rounding is applied (nearest 1/8).
{
  const S = settings.resolveAll().values; // margin 250, rounding nearest_eighth, floor 98000
  const q = quoteProgram({ scenario: { state: 'TX', fico: 740, ltv: 70000, dscr: 1200, purpose: 'purchase', lock_days: 30, loan_amount: 500000 }, program, settings: S });
  ok(q.pricingBasis.roundingMode === 'nearest' && q.pricingBasis.roundingIncrementMilli === 125, 'the real default is nearest 1/8');
  ok(q.ladder[1].finalPriceMilli === 102625, '102.600 raw rounds to 102.625 under the default');
}

// 6) A pricing rule accumulates onto every rung; a cumulative-adjustment cap bites.
{
  const S = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none' };
  const cashout = quoteProgram({ scenario: { state: 'TX', ltv: 70000, purpose: 'cashout', lock_days: 30, loan_amount: 500000 }, program, settings: S });
  ok(cashout.ladder[1].finalPriceMilli === 102100, 'cashout +0.500 and margin −0.250: 102.850 → 102.100');
  ok(cashout.ladder[1].adjustments.some((a) => a.code === 'cashout'), 'the itemized cashout adjustment is on the record');

  const capped = quoteProgram({ scenario: { state: 'TX', ltv: 70000, purpose: 'cashout', lock_days: 30, loan_amount: 500000 }, program, settings: { ...S, 'pricing.cumulative_adjustment_cap_milli': 300 } });
  ok(capped.ladder[1].adjustmentCostMilli === 300 && capped.ladder[1].adjustmentCapped === true, 'the +0.500 stack is capped to the 0.300 cumulative cap');
  ok(capped.ladder[1].adjustmentCostRawMilli === 500, 'and the uncapped raw total is retained');
  ok(capped.ladder[1].finalPriceMilli === 102300, '102.850 − 0.300 capped cost − 0.250 margin = 102.300');
}

// 7) A program's own priceLimit overrides the tenant default.
{
  const withLimit = { ...program, priceLimit: { floorMilli: 99000, roundingMode: 'none', capTiers: tiers } };
  const S = settings.resolveAll().values;
  const q = quoteProgram({ scenario: { state: 'TX', ltv: 70000, purpose: 'purchase', lock_days: 30, loan_amount: 500000 }, program: withLimit, settings: S });
  ok(q.pricingBasis.floorMilli === 99000 && q.pricingBasis.roundingMode === 'none', 'the program floor + rounding override the settings default');
  ok(q.pricingBasis.capMilli === 103000, 'the program cap tier applied for the loan size');
}

// 8) lock_days filters the ladder.
{
  const grid2 = [
    { rate: 71250, lockDays: 30, basePriceMilli: 102850 },
    { rate: 71250, lockDays: 45, basePriceMilli: 102600 },
  ];
  const q = quoteProgram({ scenario: { state: 'TX', ltv: 70000, purpose: 'purchase', lock_days: 45, loan_amount: 500000 }, program: { ...program, baseGrid: grid2 }, settings: { 'pricing.rounding_mode': 'none' } });
  ok(q.ladder.length === 1 && q.ladder[0].context.lockDays === 45, 'only the requested lock period is priced');
}

// 9) Guards.
ok(threw(() => quoteProgram({ scenario: {}, program: { code: 'x', rules: [], baseGrid: [] }, settings: {} })), 'a program with no base grid is refused');
ok(threw(() => quoteProgram({ scenario: null, program, settings: {} })), 'a missing scenario is refused');

// 10) Layer 2 — the per-investor margin/holdback hook is ADDITIVE and OPT-IN.
{
  const S = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none' };
  const scen = { state: 'TX', fico: 740, ltv: 70000, dscr: 1200, purpose: 'purchase', lock_days: 30, loan_amount: 500000 };

  // (a) NO marginHoldback → byte-identical to the settings-driven quote.
  const baseline = quoteProgram({ scenario: scen, program, settings: S });
  const noHook = quoteProgram({ scenario: scen, program, settings: S });
  ok(JSON.stringify(baseline.ladder) === JSON.stringify(noHook.ladder), 'no marginHoldback → ladder byte-identical');
  ok(baseline.pricingBasis.marginSource === 'settings', 'margin source reported as settings when no hook');
  ok(baseline.pricingBasis.holdbackMilli === null, 'holdback is null when no hook');

  // (b) A resolved per-investor margin OVERRIDES the settings margin (400 vs 250 → 0.15 lower price).
  const withMargin = quoteProgram({ scenario: scen, program, settings: S, marginHoldback: { marginMilli: 400, marginSource: 'rule' } });
  ok(withMargin.pricingBasis.marginMilli === 400 && withMargin.pricingBasis.marginSource === 'rule', 'resolved margin 400 wins over settings 250');
  ok(withMargin.ladder[1].finalPriceMilli === baseline.ladder[1].finalPriceMilli - 150, 'a 150-milli larger margin lowers the price by exactly 150');

  // (c) holdback is CARRIED for the record but does NOT move the price (money rule pending owner).
  const withHold = quoteProgram({ scenario: scen, program, settings: S, marginHoldback: { marginMilli: 250, holdbackMilli: 250 } });
  ok(withHold.pricingBasis.holdbackMilli === 250, 'holdback carried into the reconstruction record');
  ok(withHold.ladder[1].finalPriceMilli === baseline.ladder[1].finalPriceMilli, 'holdback does NOT change the price (not wired — money rule)');

  // (d) a garbage resolved margin (negative / non-integer) is ignored → settings margin stands.
  const bad = quoteProgram({ scenario: scen, program, settings: S, marginHoldback: { marginMilli: -5 } });
  ok(bad.pricingBasis.marginMilli === 250 && bad.pricingBasis.marginSource === 'settings', 'a garbage resolved margin falls back to settings');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
