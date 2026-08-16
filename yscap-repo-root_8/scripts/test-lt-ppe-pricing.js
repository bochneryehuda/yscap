#!/usr/bin/env node
'use strict';
/**
 * LT PPE pricing pipeline — pure offline test (MEGA plan §5).
 * Proves the verified invariants from the knowledge doc: points = 100 − price,
 * cost-positive LLPA stacking, the 0.25 margin rule, cumulative/order-independent
 * adjustments, round-once-then-clamp, rate-axis interpolation provenance, the
 * integer-basis-points discipline, and the reconstruction record shape (§5.4).
 *
 *   node scripts/test-lt-ppe-pricing.js
 */
const p = require('../src/longterm/ppe/pricing');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }
function threw(fn) { try { fn(); return false; } catch { return true; } }

console.log('LT PPE pricing — offline\n');

// 1) points = 100 − price, both directions, in milli-points (par = 100000).
ok(p.PAR_MILLI === 100000, 'par is 100.000 points = 100000 milli');
ok(p.priceToPoints(102850) === -2850, 'a 102.850 price is a 2.850-point CREDIT (negative points)');
ok(p.priceToPoints(98000) === 2000, 'a 98.000 price is 2.000 points the borrower PAYS');
ok(p.pointsToPrice(p.priceToPoints(101375)) === 101375, 'price↔points round-trips exactly');

// 2) The 0.25 margin rule (§5.3), proven with rounding DISABLED so we compare the
//    raw relationship exactly: Lender Price price = sheet price − 0.25.
{
  const r = p.priceRung({ basePriceMilli: 102850, marginMilli: 250, roundingIncrementMilli: 0 });
  ok(r.rawPriceMilli === 102600, 'sheet 102.850 − 0.250 margin = 102.600 raw');
  ok(r.finalPriceMilli === 102600, 'with no rounding the final price is exactly 0.25 below the sheet');
  ok(r.marginMilli === 250, 'the margin is carried as its OWN component, never folded into the base');
}

// 3) Cost-positive LLPA stacking (§5.2 #2): a positive LLPA is a COST that lowers
//    the price; a negative LLPA is a credit that raises it.
{
  const cost = p.priceRung({ basePriceMilli: 100000, roundingIncrementMilli: 0,
    adjustments: [{ code: 'ltv_hi', category: 'fico_ltv', adjMilli: 500 }] });
  ok(cost.finalPriceMilli === 99500, 'a +0.500 cost LLPA lowers price to 99.500');
  ok(cost.finalPointsMilli === 500, '…which is +0.500 points the borrower pays');

  const credit = p.priceRung({ basePriceMilli: 100000, roundingIncrementMilli: 0,
    adjustments: [{ code: 'reward', category: 'purpose', adjMilli: -250 }] });
  ok(credit.finalPriceMilli === 100250, 'a −0.250 credit LLPA raises price to 100.250');
  ok(credit.finalPointsMilli === -250, '…which is a 0.250-point credit to the borrower');
}

// 4) Adjustments are cumulative and ORDER-INDEPENDENT (integer bp — associative).
{
  const a = [{ code: 'a', adjMilli: 375 }, { code: 'b', adjMilli: -125 }, { code: 'c', adjMilli: 250 }];
  const forward = p.priceRung({ basePriceMilli: 100000, roundingIncrementMilli: 0, adjustments: a });
  const reversed = p.priceRung({ basePriceMilli: 100000, roundingIncrementMilli: 0, adjustments: [...a].reverse() });
  ok(forward.adjustmentCostMilli === 500, 'the signed stack sums to +0.500');
  ok(forward.finalPriceMilli === reversed.finalPriceMilli, 'the same stack in the opposite order prices identically');
}

// 5) The `unit:'price'` escape hatch — a sheet publishing a PRICE add-on has the
//    opposite sign, and the ORIGINAL value is kept verbatim in the trace.
{
  const r = p.priceRung({ basePriceMilli: 100000, roundingIncrementMilli: 0,
    adjustments: [{ code: 'rate_addon', adjMilli: 500, unit: 'price' }] });
  ok(r.finalPriceMilli === 100500, 'a +0.500 PRICE add-on RAISES the price (opposite sign)');
  ok(r.adjustments[0].sourceMilli === 500 && r.adjustments[0].costMilli === -500,
    'the sheet value is retained verbatim while the normalized cost is negated');
}

// 6) Margin, SRP and LPC comp are separate layers with the right direction.
{
  const r = p.priceRung({ basePriceMilli: 100000, marginMilli: 250, srpMilli: 1000, compMilli: 375, roundingIncrementMilli: 0 });
  // 100000 − 0 − 250 − 375 + 1000 = 100375
  ok(r.finalPriceMilli === 100375, 'srp raises, margin+comp lower — 100.000 → 100.375');
  ok(r.srpMilli === 1000 && r.compMilli === 375, 'srp and comp are each their own recorded component');
}

// 7) Round ONCE to the increment, THEN clamp — the floor is the last word (§5.2 #3).
{
  const rounded = p.priceRung({ basePriceMilli: 102600, roundingIncrementMilli: 125 });
  ok(rounded.finalPriceMilli === 102625, '102.600 rounds to the nearest 1/8 → 102.625');

  const floored = p.priceRung({ basePriceMilli: 97000, floorMilli: 98000, roundingIncrementMilli: 0 });
  ok(floored.finalPriceMilli === 98000 && floored.clamped === true, 'a sub-floor price clamps UP to 98.000 and is flagged');

  const capped = p.priceRung({ basePriceMilli: 105000, capMilli: 103000, roundingIncrementMilli: 0 });
  ok(capped.finalPriceMilli === 103000 && capped.clamped === true, 'an over-cap price clamps DOWN to the tier ceiling and is flagged');
}

// 7b) The full rounding-mode set the settings expose (none/nearest/up/down/half_even).
ok(p.roundPrice(102600, 125, 'nearest') === 102625, 'nearest rounds 102.600 → 102.625');
ok(p.roundPrice(102600, 125, 'up') === 102625, 'up ceils to the next 1/8');
ok(p.roundPrice(102600, 125, 'down') === 102500, 'down floors to the prior 1/8');
ok(p.roundPrice(102600, 0, 'nearest') === 102600, 'a zero increment disables rounding');
ok(p.roundPrice(102600, 125, 'none') === 102600, 'mode none passes the value through');
ok(p.roundPrice(1050, 100, 'half_even') === 1000, 'half_even breaks a .5 tie toward the even multiple (down)');
ok(p.roundPrice(1150, 100, 'half_even') === 1200, 'half_even breaks the next .5 tie toward the even multiple (up)');
ok(threw(() => p.roundPrice(100, 125, 'sideways')), 'an unknown rounding mode is refused');
{
  const down = p.priceRung({ basePriceMilli: 102600, roundingIncrementMilli: 125, roundingMode: 'down' });
  ok(down.finalPriceMilli === 102500 && down.roundingMode === 'down', 'priceRung honors the rounding mode and records it');
}

// 8) Rate-axis interpolation blends price linearly and records provenance (§5.1).
{
  const mid = p.interpolatePrice({ rate: 7.0, priceMilli: 101000 }, { rate: 7.25, priceMilli: 100000 }, 7.125);
  ok(mid.priceMilli === 100500 && mid.weight === 0.5, 'the midpoint rate blends to the midpoint price');
  const off = p.interpolatePrice({ rate: 7.0, priceMilli: 101000 }, { rate: 7.25, priceMilli: 100000 }, 8.0);
  ok(off.weight === 1, 'a target beyond the bracket is clamped to the rung, never extrapolated');
}

// 9) The integer-basis-points discipline is ENFORCED, not hoped for.
ok(threw(() => p.priceRung({ basePriceMilli: 102850.5, roundingIncrementMilli: 0 })), 'a fractional base price is refused (integer milli only)');
ok(threw(() => p.priceRung({ basePriceMilli: 100000, adjustments: [{ adjMilli: 12.5 }] })), 'a fractional adjustment is refused');
ok(threw(() => p.priceRung({ basePriceMilli: 100000, adjustments: [{ adjMilli: 100, unit: 'bogus' }] })), 'an unknown adjustment unit is refused');

// 10) The reconstruction record (§5.4) carries every component the §10 parity
//     harness reconciles against Lender Price's priceBuild.
{
  const r = p.priceRung({
    basePriceMilli: 102850, rate: 71250, marginMilli: 250, roundingIncrementMilli: 0,
    adjustments: [{ code: 'dscr_115', category: 'dscr', adjMilli: 250, reason: 'DSCR 1.15–1.24' }],
    context: { fico: 740, ltv: 70000, dscr: 1200 },
  });
  const has = (k) => Object.prototype.hasOwnProperty.call(r, k);
  ok(['basePriceMilli', 'basePointsMilli', 'adjustments', 'adjustmentPointsMilli', 'marginMilli',
    'srpMilli', 'compMilli', 'finalPriceMilli', 'finalPointsMilli', 'rate', 'context'].every(has),
    'the record exposes base/adjustments/margin/srp/comp/final + rate + context');
  ok(r.adjustments[0].reason === 'DSCR 1.15–1.24' && r.adjustments[0].category === 'dscr',
    'each adjustment keeps its human reason and category for the trace');
  ok(r.finalPriceMilli === 102850 - 250 - 250, 'base − dscr cost − margin = the reconstructable final price');
}

// 11) The ladder prices every rung with the shared knobs applied once.
{
  const ladder = p.priceLadder(
    [{ rate: 70000, basePriceMilli: 101500 }, { rate: 71250, basePriceMilli: 102850 }, { rate: 72500, basePriceMilli: 104000 }],
    { marginMilli: 250, roundingIncrementMilli: 0 },
  );
  ok(ladder.length === 3, 'a rung per coupon');
  ok(ladder.every((r) => r.marginMilli === 250), 'the shared margin is applied to every rung');
  ok(ladder[1].finalPriceMilli === 102600, 'the middle rung reproduces the 0.25 margin result');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
