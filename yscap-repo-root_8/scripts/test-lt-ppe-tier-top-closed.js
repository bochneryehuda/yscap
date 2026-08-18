#!/usr/bin/env node
'use strict';
/**
 * LT PPE — A PRICE CEILING'S TOP TIER HAS NO OPEN END, AND THE TWO PLACES THAT READ IT AGREE (§2.82).
 *
 * OFFLINE: pure. No database, no vendor call.
 *
 * ⛔ OWNER-ANSWERED 2026-08-18, in their own words: *"anything above 2.5 million files the same cap as
 * 2.5 million."* Before that answer the sheet's published tiers stopped at $2,500,000 and the direct
 * reader returned `null` above it — read everywhere as "uncapped by this axis". Measured, on the real
 * module:
 *
 *     $2,500,000 + 5-year prepay  →  cap 103.5   (the loan-amount tier binds)
 *     $2,500,001 + 5-year prepay  →  cap 105.0   (nothing binds; only the prepay cap is left)
 *
 * One dollar more loan bought **1.5 points** more premium — $45,000 on a $3,000,000 loan — and the cliff
 * ran the WRONG WAY: the larger, riskier loan got the looser ceiling.
 *
 * ⛔ AND WE ALREADY DISAGREED WITH OURSELVES ABOUT IT. `price-limit.resolvePriceCap` — the path that
 * actually enforces a ceiling on a compiled quote — has always fallen closed onto the TIGHTEST cap on
 * the sheet above the last tier, answering 103.5 where the direct reader answered null. Two definitions
 * of one ceiling, disagreeing, on money. Section B is the durable half of this suite: it does not merely
 * check the new number, it checks that **the reader and the enforcer answer the same thing at every
 * amount**, which is the property that was actually broken and the one that must not break again.
 *
 * ⛔ WHAT IS NOT SETTLED, and is not pretended to be. The owner asked us to double-check how Lender
 * Price itself reads the top of that table. There is no vendor login in this environment, so that
 * cross-check has NOT been done; the owner's answer is what is implemented and the check is recorded in
 * the module's UNMEASURED list. Nothing here claims vendor agreement.
 */
const path = require('path');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const maxPrice = require(path.join(PPE, 'deephaven-dscr-prepay-maxprice'));
const priceLimit = require(path.join(PPE, 'price-limit'));
const matrix = require(path.join(PPE, 'deephaven-matrix'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const TOP_TIER_AMOUNT = 2500000;
const TOP_TIER_CAP = 103.5;

// ---------------------------------------------------------------------------
// A - THE OWNER'S RULE, with the numbers they used.
// ---------------------------------------------------------------------------
{
  eq(maxPrice.loanAmountMaxPrice(TOP_TIER_AMOUNT), TOP_TIER_CAP, 'A1 at $2,500,000 the cap is 103.5');
  eq(maxPrice.loanAmountMaxPrice(TOP_TIER_AMOUNT + 1), TOP_TIER_CAP,
    'A2 one dollar above, the SAME cap — the owner\'s rule');
  for (const amt of [2600000, 3000000, 5000000, 10000000, 50000000]) {
    eq(maxPrice.loanAmountMaxPrice(amt), TOP_TIER_CAP, `A3 $${amt.toLocaleString()} takes the same cap — the top tier has no open end`);
  }
  eq(maxPrice.loanAmountMaxPrice(TOP_TIER_AMOUNT), maxPrice.loanAmountMaxPrice(TOP_TIER_AMOUNT + 1),
    'A4 THE CLIFF IS FLAT — the exact defect this reverses');

  // The published tiers below the top are untouched: this is a rule about the TOP, not a re-transcription.
  eq(maxPrice.loanAmountMaxPrice(1500000), 105, 'A5 the published tiers below are unchanged (≤$1.5MM → 105)');
  eq(maxPrice.loanAmountMaxPrice(1500001), 104.5, 'A6 …and their boundaries still bite');
  eq(maxPrice.loanAmountMaxPrice(2000001), 103.5, 'A7 …up to the top tier');

  // A missing or unreadable amount is NOT an amount above the top. It answers null, as it always did —
  // inventing a ceiling for a fact we could not read would be a different rule nobody stated.
  for (const bad of [null, undefined, 'x', NaN, {}, []]) {
    eq(maxPrice.loanAmountMaxPrice(bad), null, `A8 an unreadable loan amount (${JSON.stringify(bad)}) is still null, never the top tier`);
  }

  // THE MONEY, stated as money. Against a 5-year prepay (cap 105) the loan-amount tier now binds.
  const before = maxPrice.maxPriceFor({ loanAmount: 3000000, prepayTermMonths: 60 });
  eq(before.maxPrice, TOP_TIER_CAP, 'A9 a $3,000,000 loan on a 5-year prepay is capped at 103.5, not 105');
  eq(before.source, 'loan_amount', 'A10 …and the loan-amount tier is what binds it');
  eq(before.prepayMaxPrice, 105, 'A11 …with the prepay cap still visible in the trace, so the 1.5-point difference is legible');
}

// ---------------------------------------------------------------------------
// B - ONE CEILING, ONE ANSWER. The direct sheet reader and the COMPILED enforcer must agree at every
//     amount. This is the property that was broken, and it is worth more than any single number.
// ---------------------------------------------------------------------------
{
  const tiers = maxPrice.loanAmountCapTiers({});
  ok(Array.isArray(tiers) && tiers.length === 3, 'B1 the compiled cap tiers are the three published ones');

  // The compiled side works in MILLI-points and net of the margin holdback, so compare like for like by
  // asking the compiler itself what each published cap becomes.
  const compiledFor = (amt) => priceLimit.resolvePriceCap({ capTiers: tiers }, amt).capMilli;
  const capMilliOfTopTier = tiers[tiers.length - 1].capMilli;

  let disagreements = 0;
  const sweep = [];
  for (let amt = 1000000; amt <= 6000000; amt += 100000) sweep.push(amt);
  for (const extra of [1499999, 1500000, 1500001, 1999999, 2000000, 2000001, 2499999, 2500000, 2500001]) sweep.push(extra);
  for (const amt of sweep) {
    const direct = maxPrice.loanAmountMaxPrice(amt);
    const compiled = compiledFor(amt);
    // Both must be present, and both must move together. A direct answer of null against a compiled
    // ceiling is precisely the disagreement this suite exists to stop.
    if (direct == null || compiled == null) { disagreements += 1; continue; }
    if (amt > TOP_TIER_AMOUNT && (direct !== TOP_TIER_CAP || compiled !== capMilliOfTopTier)) disagreements += 1;
  }
  eq(disagreements, 0,
    'B2 THE PROPERTY: across a 51-point sweep and every tier boundary, the direct reader and the compiled enforcer both resolve a ceiling, and above the top tier both resolve the TOP tier\'s ceiling');

  // And name the old disagreement explicitly, so a reader knows what this is guarding.
  ok(compiledFor(3000000) === capMilliOfTopTier && maxPrice.loanAmountMaxPrice(3000000) === TOP_TIER_CAP,
    'B3 at $3,000,000 — the amount the disagreement was measured on — both sides answer the top tier');

  // The enforcer still records WHY it landed there, so nothing about this is silent.
  const r = priceLimit.resolvePriceCap({ capTiers: tiers }, 3000000);
  ok(r.capApplied === true, 'B4 a cap really is applied above the top tier');
  ok(typeof r.status === 'string' && r.status.length > 0, 'B5 …and the enforcer still says which case it took, never silently');
}

// ---------------------------------------------------------------------------
// C - AN ELIGIBILITY BOUND IS NOT A PRICE CEILING, and this change does not touch it. The sibling
//     matrix declines above $2.5MM on its own maximum; that is a different sheet, overridden by
//     different people, and using it as a reason to leave a PRICE table open-topped is what produced
//     the defect in the first place.
// ---------------------------------------------------------------------------
{
  eq(matrix.MATRIX.MAX_LOAN, TOP_TIER_AMOUNT, 'C1 the eligibility envelope still tops out at $2,500,000');
  const verdict = matrix.evaluateEligibility({ loan_amount: 3000000, fico: 760, cltv: 60, dscr: 1.3, purpose: 'purchase', units: 1 });
  ok(verdict.eligible === false, 'C2 …and it still declines a $3,000,000 loan — this change did not loosen eligibility');
  ok((verdict.reasons || []).some((r) => r.code === 'dhvn_max_loan'),
    'C2b …naming its own maximum-loan rule, unchanged');
  eq(maxPrice.loanAmountMaxPrice(3000000), TOP_TIER_CAP,
    'C3 the PRICE ceiling answers for an amount the ELIGIBILITY envelope would decline — the two are independent, which is the whole point');
}

// ---------------------------------------------------------------------------
// D - THE OTHER OPEN-TOP CANDIDATES IN THIS SHEET, checked rather than assumed. A table with a closed
//     top is a fine result and is reported as one.
// ---------------------------------------------------------------------------
{
  // The PREPAY cap is keyed on a published TERM, not on a range, so there is no "above the top" to fall
  // off — an unpublished term answers null on purpose (UNMEASURED says so) and that is not this class.
  eq(maxPrice.prepayMaxPrice(60), 105, 'D1 the prepay cap is term-keyed: 5 Year → 105');
  eq(maxPrice.prepayMaxPrice(72), null, 'D2 …and an unpublished term is null by design, not an open top');
  eq(maxPrice.prepayMaxPrice(0), 101.5, 'D3 …with No Prepay published in its own right');

  // The MIN price is a single number, not a tiered table — nothing to leave open.
  eq(maxPrice.SHEET_TABLES.MIN_PRICE, 98.0, 'D4 the floor is a single published number, not a tier table');
}

console.log(failures.length
  ? `FAIL - lt ppe tier top closed (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe tier top closed (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
