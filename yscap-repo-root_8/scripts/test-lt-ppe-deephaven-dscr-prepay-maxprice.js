#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the Deephaven DSCR PREPAY / MAX-PRICE / LOCK block (deephaven-dscr-prepay-maxprice.js),
 * validated against the REAL rate sheet (docs/longterm/ppe-research/matrices/
 * deephaven-dscr-ratesheet-corr-t0.json) and against the live Lender Price prices it must reproduce.
 *
 * ⛔ THE RULE HERE, inherited from the sibling suite and for the same reason: **assert on the PRICE and
 * its DIRECTION, never on a bare magnitude.** Lender Price DISPLAYS an absolute value and does not
 * carry the direction; the direction lives on the rate sheet. A suite that compares magnitudes passed
 * 44/44 on a sheet that mispriced every strong-credit loan by twice the cell value. So every money
 * assertion below either compares a composed PRICE against a documented Lender Price measurement, or
 * asserts which WAY the price moves. A sign flip anywhere fails this suite.
 *
 * ⛔ THE SECOND RULE, from the owner (2026-08-17): **the sheet is the INVESTOR's pre-holdback number and
 * Lender Price shows the POST-holdback view** — `LP = sheet − holdback`. So the stored tables are
 * asserted against the JSON un-shifted, and the holdback is asserted as its own explicit step, sourced
 * from the ONE existing definition (margin-holdback.js) rather than a literal. §6 proves the whole
 * relationship end to end, including across all 28 coupons of the base ladder.
 *
 * ROUNDING: the program's own rounding mode is forced to 'none' here for the same reason the sibling
 * suite compares on `rawPriceMilli` — Lender Price's quotes are NOT eighth-rounded (105.175 / 105.675
 * are not multiples of 0.125), so an eighth-rounded price cannot tie out to LP. Rounding remains an
 * open item in the sheet's UNMEASURED. With rounding off, `finalPriceMilli` is the composed price
 * AFTER the floor/cap clamp — which is exactly what §3 needs to prove a cap actually bites.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const M = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');
const { SHEET_TABLES: BASE_SHEET } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const { resolveMarginHoldback } = require('../src/longterm/ppe/margin-holdback');
const { marginHoldbackDeltaOf, pppMarginHoldbackRules } = require('../src/longterm/ppe/ppp-structures');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — Deephaven DSCR prepay / max price / lock: the PRICE agrees with the rate sheet\n');

const grid = M.buildPrepayMaxPriceGrid();
const sheet = gridToRateSheet(grid);
ok(sheet.problems.length === 0, `grid builds with no problems (${JSON.stringify(sheet.problems.slice(0, 3))})`);

const program0 = rateSheetToProgram(sheet, { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
// Rounding OFF (see the header) so the clamp is the only thing that can move a composed price.
const program = { ...program0, priceLimit: { ...program0.priceLimit, roundingMode: 'none', roundingIncrementMilli: 0 } };
const S = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none' };
const RATE = 7500; // the coupon every live probe was taken at

function quote(sc, prog) { return quoteProgram({ scenario: sc, program: prog || program, settings: S }); }
function rungAt(sc, prog) {
  const r = quote(sc, prog);
  if (!r.eligible) return null;
  // NOT PRICED is a third answer beside eligible/ineligible: the engine refuses to
  // price a scenario it cannot price confidently (a missing price-bearing fact, or
  // a lock the sheet publishes no rung for) and returns no ladder at all rather
  // than an empty one — see quote.js. Either way there is no rung here.
  if (r.priced === false) return null;
  return r.ladder.find((x) => x.rate === RATE) || null;
}
// The composed price at 7.500, in points, BEFORE the floor/cap clamp.
function priceAt(sc, prog) { const g = rungAt(sc, prog); return g ? g.rawPriceMilli / 1000 : null; }
// The composed price at 7.500 AFTER the clamp — what a quote would actually show.
function finalAt(sc, prog) { const g = rungAt(sc, prog); return g ? g.finalPriceMilli / 1000 : null; }
function rungAtRate(sc, rate, prog) {
  const r = quote(sc, prog);
  if (!r.eligible) return null;
  return r.ladder.find((x) => x.rate === rate) || null;
}

// The BARE base price at 7.500 — the sheet's own ladder, before any adjustment. This is the 105.175
// Lender Price itself quoted in the analysis §1 prepay probe.
const BARE = (() => {
  const row = sheet.basePrices.find((b) => b.note_rate_milli_pct === RATE);
  if (!row) throw new Error('test setup: no base-price row at 7.500');
  return row.price_milli / 1000;
})();
ok(BARE === 105.175, `the bare base at 7.500 is Lender Price's own 105.175 (got ${BARE})`);

// A scenario on a $500k property at a given whole CLTV, carrying the lock facts and a prepay term.
// Defaults: FICO 760 / CLTV 50 / CA / DSCR 1.20 / 3-year prepay (the sheet's own baseline).
function sc(over = {}) {
  const cltv = over.cltv == null ? 50 : over.cltv;
  const value = over.value == null ? 500000 : over.value;
  const loan = over.loan == null ? Math.round(value * cltv / 100) : over.loan;
  const out = {
    fico: 760, dscr: 1200, state: 'CA', purpose: 'purchase',
    loan, value, ltv: Math.round((loan / value) * 100000), loan_amount: loan,
    prepay_months: 36,
    ...M.lockTermFacts(30),
    // The sibling sheet's OTHER LLPA tables read these facts too, and the engine now
    // REFUSES to price a scenario whose price-bearing facts it cannot decide
    // (quote.js `missing_price_bearing_fact`) rather than quietly pricing as if the
    // adjustment did not exist. Stated at the same NEUTRAL values
    // `lp-agreement-legs` emits for a plain deal, so no measured price moves.
    // (`prepay_pricing_model` is deliberately NOT here: this sheet DECLARES that an
    // absent model prices on the standard column, and the engine reads that
    // declaration off the rule set — rules.declaredAbsentFacts.)
    property_type: 'SingleFamily', units: 1,
    interest_only: false, escrow_waiver: false, non_warrantable: false, short_term_rental: false,
    ...over,
  };
  delete out.cltv;
  if (over.loan != null || over.value != null) {
    out.ltv = over.ltv != null ? over.ltv : Math.round((out.loan / out.value) * 100000);
    out.loan_amount = over.loan_amount != null ? over.loan_amount : out.loan;
  }
  return out;
}

// ═══ 1. THE PREPAY LLPA — the PRICE moves by the sheet's own signed value, in the right direction ═══
const PREPAY_BASELINE = priceAt(sc()); // 3-year standard: the sheet's own zero row
{
  // 1a. The BASELINE emits NOTHING. A 0 cell must not become a 0-point line on the quote.
  const g = rungAt(sc());
  const prepayLines = g.adjustments.filter((a) => String(a.code || '').startsWith('dhvn_prepay_'));
  ok(prepayLines.length === 0, `3-year standard is the BASELINE — no prepay line at all (got ${JSON.stringify(prepayLines.map((a) => a.code))})`);
  // …while the 5% Fixed column at the SAME term is +0.25 and DOES emit.
  const g5 = rungAt(sc({ prepay_pricing_model: 'fixed5_promo' }));
  const p5 = g5.adjustments.filter((a) => String(a.code || '').startsWith('dhvn_prepay_'));
  ok(p5.length === 1 && p5[0].code === 'dhvn_prepay_fixed5_36', '…but the 5% Fixed column at 3 years DOES emit its +0.25');
}
{
  // 1b. EVERY term × model moves the price by the sheet's own signed value. Asserted on the PRICE.
  let checked = 0; let good = 0; const miss = [];
  for (const row of M.SHEET_TABLES.PREPAY) {
    for (const [model, want] of [['standard', row.llpaOther], ['fixed5_promo', row.llpa5PctFixed]]) {
      const p = priceAt(sc({ prepay_months: row.termMonths, prepay_pricing_model: model }));
      checked += 1;
      const delta = p == null ? null : +(p - BARE - (PREPAY_BASELINE - BARE)).toFixed(6);
      if (delta === want) good += 1; else miss.push(`${row.term}/${model}: sheet ${want}, price moved ${delta}`);
    }
  }
  ok(good === checked, `all ${checked} prepay LLPA values move the PRICE by the sheet's own signed value${miss.length ? ' — ' + miss.slice(0, 4).join(' | ') : ''}`);
}
{
  // 1c. DIRECTION — a LONGER prepay term must IMPROVE the price. This is the assertion a sign flip
  // cannot survive, and it is the whole reason the sibling sheet was rebuilt.
  const P = (m, model) => priceAt(sc({ prepay_months: m, prepay_pricing_model: model }));
  let mono = true; let prev = null;
  for (const m of [0, 12, 24, 36, 48, 60]) { const p = P(m, 'standard'); if (prev != null && !(p > prev)) mono = false; prev = p; }
  ok(mono, 'a LONGER prepay term always IMPROVES the price (No Prepay → 1 → 2 → 3 → 4 → 5 years, strictly increasing)');
  ok(P(60, 'standard') > PREPAY_BASELINE, 'a 5-year prepay IMPROVES the price over the 3-year baseline');
  ok(+(P(60, 'standard') - PREPAY_BASELINE).toFixed(6) === 0.625, '…by exactly the sheet\'s +0.625');
  ok(P(0, 'standard') < PREPAY_BASELINE, 'No Prepay WORSENS the price');
  ok(+(PREPAY_BASELINE - P(0, 'standard')).toFixed(6) === 2, '…by exactly 2.00');
  ok(P(12, 'standard') < PREPAY_BASELINE && +(PREPAY_BASELINE - P(12, 'standard')).toFixed(6) === 1, 'a 1-year prepay WORSENS the price by exactly 1.00');
  ok(P(24, 'standard') < PREPAY_BASELINE && +(PREPAY_BASELINE - P(24, 'standard')).toFixed(6) === 0.5, 'a 2-year prepay WORSENS the price by exactly 0.50');
  // 1d. THE PROMO — the 5% Fixed must BEAT standard by exactly 0.500 at the 5-year term.
  ok(P(60, 'fixed5_promo') > P(60, 'standard'), 'the 5% Fixed promo BEATS standard at the 5-year term');
  ok(+(P(60, 'fixed5_promo') - P(60, 'standard')).toFixed(6) === 0.5, '…by exactly 0.500 (1.125 − 0.625)');
  ok(+(P(48, 'fixed5_promo') - P(48, 'standard')).toFixed(6) === 0.25, 'the promo beats standard by 0.25 at 4 years');
  ok(+(P(36, 'fixed5_promo') - P(36, 'standard')).toFixed(6) === 0.25, 'the promo beats standard by 0.25 at 3 years');
  for (const m of [24, 12, 0]) {
    ok(P(m, 'fixed5_promo') === P(m, 'standard'), `at ${m === 0 ? 'No Prepay' : m + ' months'} the two columns are IDENTICAL on the sheet — the promo is worth nothing there`);
  }
  // 1e. An ABSENT pricing model prices on the STANDARD column (the sheet's default).
  const noModel = sc({ prepay_months: 60 }); delete noModel.prepay_pricing_model;
  ok(priceAt(noModel) === P(60, 'standard'), 'a scenario naming no pricing model prices on the STANDARD column (the sheet\'s default)');
}
{
  // 1f. THE LIVE LENDER PRICE ANCHOR (analysis §1, coupon 7.500, base 105.175). The arithmetic the
  // owner's own cross-check closes on, asserted in the PRICE frame.
  const LIVE = [
    [60, 'standard', 105.800, '5 Year Prepay Penalty 0.625'],
    [60, 'fixed5_promo', 106.300, '5 Year Prepay Penalty - 5% 1.125'],
    [0, 'standard', 103.175, 'No Prepay Penalty 2.000'],
    [36, 'standard', 105.175, '(no line — the baseline)'],
  ];
  for (const [m, model, lpPrice, note] of LIVE) {
    const delta = priceAt(sc({ prepay_months: m, prepay_pricing_model: model })) - PREPAY_BASELINE;
    ok(+(BARE + delta).toFixed(6) === lpPrice, `LIVE LP: ${note} → 105.175 ${delta >= 0 ? '+' : '−'} ${Math.abs(delta)} = ${lpPrice}`);
  }
}
{
  // 1g. A prepay term the sheet does NOT publish prices no line at all — never a guessed 0 and never
  // an interpolation between the published terms.
  const odd = priceAt(sc({ prepay_months: 30 }));
  ok(odd === PREPAY_BASELINE, 'a 30-month prepay term (not on the sheet) emits NO prepay line — never interpolated');
  ok(M.prepayLlpa(30, 'standard') === null && M.prepayMaxPrice(30) === null, '…and both the LLPA and the cap resolve to null, never 0');
}
{
  // 1h. THE THIRD PPP TIER — the custom softer structures price off the STANDARD column and their
  // softness is the EXISTING +0.375 margin holdback, which this module does not re-implement.
  const facts = M.prepayFactsFor('33321');
  ok(facts.prepay_pricing_model === 'standard' && facts.prepay_months === 60, 'custom softer 3/3/3/2/1 resolves to the STANDARD column at 60 months');
  ok(priceAt(sc({ ...facts })) === priceAt(sc({ prepay_months: 60, prepay_pricing_model: 'standard' })), '…and prices IDENTICALLY to a plain standard 5-year prepay');
  ok(marginHoldbackDeltaOf('33321') === 375 && marginHoldbackDeltaOf('3321') === 375, 'the +0.375 holdback lives on the EXISTING structure library, not here');
  const mh = resolveMarginHoldback({ rules: pppMarginHoldbackRules(), facts: { ppp_structure_key: '33321' } });
  ok(mh.holdbackBaseMilli === 250 && mh.holdbackDeltaMilli === 375 && mh.holdbackMilli === 625,
    `…and composes through the EXISTING margin-holdback module (0.250 base + 0.375 extra = ${mh.holdbackMilli / 1000})`);
  const f4 = M.prepayFactsFor('3321');
  ok(f4.prepay_pricing_model === 'standard' && f4.prepay_months === 48, 'custom softer 3/3/2/1 resolves to the STANDARD column at 48 months');
  ok(M.prepayFactsFor('fixed5', 5).prepay_pricing_model === 'fixed5_promo', 'the fixed5 structure resolves to the PROMO column');
  ok(M.prepayFactsFor('none').prepay_months === 0, 'the No-PPP structure resolves to 0 months');
  ok(M.prepayFactsFor('not_a_structure') === null, 'an unknown structure resolves to null — never a guessed default');
}

// ═══ 2. THE MAX PRICE — per term, per loan amount, and the sheet's OWN combining rule ══════════════
{
  for (const row of M.SHEET_TABLES.PREPAY) {
    ok(M.prepayMaxPrice(row.termMonths) === row.maxPrice, `max price for ${row.term} is ${row.maxPrice}`);
  }
  // loan-amount tiers, INCLUSIVE at the top ("≤ $1,500,000"), and their exact boundaries.
  const T = [
    [1000000, 105], [1500000, 105], [1500001, 104.5], [2000000, 104.5],
    [2000001, 103.5], [2500000, 103.5],
  ];
  for (const [amt, want] of T) ok(M.loanAmountMaxPrice(amt) === want, `loan $${amt.toLocaleString()} → max price ${want}`);
  ok(M.loanAmountMaxPrice(2500001) === null, 'above $2,500,000 there is NO published tier — null, never an invented ceiling');
  ok(M.loanAmountMaxPrice(null) === null && M.loanAmountMaxPrice('x') === null, 'a missing/garbage loan amount resolves to null');
}
{
  // THE COMBINING RULE — "the LOWER of Max Price Tiers and Prepay Buydown, when applicable."
  const cases = [
    // [loanAmount, prepayMonths, expected, expectedSource, why]
    [1400000, 36, 104, 'prepay', 'tier 105 vs prepay 104 → the PREPAY cap is lower'],
    [2400000, 60, 103.5, 'loan_amount', 'tier 103.5 vs prepay 105 → the TIER is lower'],
    [1400000, 0, 101.5, 'prepay', 'tier 105 vs No-Prepay 101.5 → the PREPAY cap is lower'],
    [2400000, 12, 102, 'prepay', 'tier 103.5 vs prepay 102 → the PREPAY cap is lower'],
    [1900000, 24, 102.75, 'prepay', 'tier 104.5 vs prepay 102.75 → the PREPAY cap is lower'],
  ];
  let good = 0;
  for (const [loanAmount, prepayTermMonths, want, wantSrc, why] of cases) {
    const r = M.maxPriceFor({ loanAmount, prepayTermMonths });
    const hit = r.maxPrice === want && r.source === wantSrc;
    if (hit) good += 1;
    ok(hit, `LOWEST WINS: ${why} → ${want} (got ${r.maxPrice} from ${r.source})`);
  }
  ok(good === cases.length, 'every combining case takes the LOWER cap');
  // …and the lower one is never the higher one, stated as a property over the whole cross-product.
  let everLower = true;
  for (const amt of [1000000, 1600000, 2100000, 2500000]) {
    for (const m of [0, 12, 24, 36, 48, 60]) {
      const r = M.maxPriceFor({ loanAmount: amt, prepayTermMonths: m });
      if (r.maxPrice !== Math.min(M.loanAmountMaxPrice(amt), M.prepayMaxPrice(m))) everLower = false;
    }
  }
  ok(everLower, 'over every (loan amount × prepay term) pair the combined cap IS the minimum of the two');
  // "WHEN APPLICABLE" — one side missing means the other one governs; neither means uncapped.
  ok(M.maxPriceFor({ loanAmount: 1400000, prepayTermMonths: null }).maxPrice === 105, 'no prepay term → the loan-amount tier governs');
  ok(M.maxPriceFor({ loanAmount: null, prepayTermMonths: 12 }).maxPrice === 102, 'no loan amount → the prepay cap governs');
  ok(M.maxPriceFor({ loanAmount: 3000000, prepayTermMonths: null }).maxPrice === null, 'neither applicable → no cap at all, never a fabricated ceiling');
  ok(M.SHEET_TABLES.MIN_PRICE === 98.0, 'the min price is 98.000');
}

// ═══ 3. THE CAP AND THE FLOOR ACTUALLY BITE — proven on a composed PRICE ═══════════════════════════
{
  // A high coupon prices far above every ceiling, so the clamp is the only thing that can bring it down.
  const HIGH = 9500; // base 109.927
  const capCase = (loan, value, months) => {
    const s = sc({ loan, value, cltv: Math.round((loan / value) * 100), prepay_months: months });
    const prog = M.programWithPriceLimit(program, s);
    const g = rungAtRate(s, HIGH, prog);
    const lim = M.priceLimitFor(s);
    return { s, g, lim };
  };
  {
    const { g, lim } = capCase(1400000, 2800000, 36); // tier 105 vs prepay 104 → 104 → 103.75 post-holdback
    ok(g.rawPriceMilli > g.finalPriceMilli, `the raw price ${g.rawPriceMilli / 1000} EXCEEDS the ceiling and is clamped down`);
    ok(g.clamped === true, '…and the rung records that it was clamped');
    ok(g.finalPriceMilli === lim.capMilli && g.finalPriceMilli === 103750, `…to exactly 103.750 (sheet 104 − 0.250 holdback) (got ${g.finalPriceMilli / 1000})`);
    ok(lim.capSource === 'prepay', '…and the PREPAY cap is the one that bound it');
  }
  {
    const { g, lim } = capCase(2400000, 4800000, 60); // tier 103.5 vs prepay 105 → 103.5 → 103.25
    ok(g.finalPriceMilli === lim.capMilli && g.finalPriceMilli === 103250, `the LOAN-AMOUNT tier binds when it is lower → 103.250 (got ${g.finalPriceMilli / 1000})`);
    ok(lim.capSource === 'loan_amount', '…and the tier is recorded as the binding ceiling');
  }
  {
    const { g } = capCase(1400000, 2800000, 0); // No Prepay 101.5 → 101.25
    ok(g.finalPriceMilli === 101250, `No Prepay's 101.5 cap binds → 101.250 (got ${g.finalPriceMilli / 1000})`);
  }
  {
    // THE LOWER OF THE TWO WINS, on the PRICE: the same loan at two prepay terms is capped differently,
    // and the tighter ceiling always produces the lower final price.
    const a = capCase(2400000, 4800000, 60).g.finalPriceMilli; // 103.5 tier
    const b = capCase(2400000, 4800000, 0).g.finalPriceMilli;  // 101.5 prepay
    ok(b < a, 'a tighter prepay ceiling produces a LOWER final price on the same loan');
  }
  {
    // WITHOUT the scenario-resolved limit the STATIC grid tiers still cap — by the loan-amount tier
    // alone, which is the HIGHER (less restrictive) of the two ceilings. Documented, and proven.
    const s = sc({ loan: 1400000, value: 2800000, cltv: 50, prepay_months: 0 });
    const g = rungAtRate(s, HIGH);
    ok(g.finalPriceMilli === 104750, `the grid's static loan-amount tier alone caps at 104.750 (105 − 0.250) (got ${g.finalPriceMilli / 1000})`);
    const gc = rungAtRate(s, HIGH, M.programWithPriceLimit(program, s));
    ok(gc.finalPriceMilli < g.finalPriceMilli, '…and routing the same scenario through programWithPriceLimit applies the LOWER combined ceiling');
  }
  {
    // THE FLOOR BITES TOO. A weak file at a low coupon composes below 98 and is floored, not quoted.
    const s = sc({ fico: 645, cltv: 70, loan: 300000, value: 428571, prepay_months: 0 });
    const g = rungAtRate(s, 6125, M.programWithPriceLimit(program, s)); // base 100.150
    ok(g != null, 'the weak-file scenario is eligible (so the floor, not a decline, is what is under test)');
    ok(g.rawPriceMilli < 98000, `…its raw price ${g.rawPriceMilli / 1000} is BELOW the 98.000 minimum`);
    ok(g.finalPriceMilli === 98000, `…and it is floored at exactly 98.000 (got ${g.finalPriceMilli / 1000})`);
  }
  {
    // THE FLOOR IS NOT SHIFTED BY THE HOLDBACK (see UNMEASURED) — it is the sheet's own 98.000.
    ok(M.priceLimitFor(sc()).floorMilli === 98000, 'the 98.000 floor is carried EXACTLY as the sheet states it — no holdback applied to a MINIMUM');
    // …and the clamp order (floor-then-cap in the engine vs cap-then-floor on the sheet) is
    // indistinguishable here, because every published ceiling sits above the floor. Asserted, not assumed.
    const hb = M.resolveHoldbackMilli();
    const lowestCap = Math.min(...M.SHEET_TABLES.PREPAY.map((r) => r.maxPrice), ...M.SHEET_TABLES.MAX_PRICE_TIERS.map((t) => t.maxPrice)) * 1000 - hb;
    ok(lowestCap > 98000, `the LOWEST published ceiling (${lowestCap / 1000} after the holdback) is above the 98.000 floor, so the clamp order cannot matter here`);
  }
}

// ═══ 4. LOCK TERM AND EXTENSIONS ═══════════════════════════════════════════════════════════════════
{
  ok(M.lockTermAdjustment(30) === 0, 'a 30-day lock is the BASE — no adjustment');
  ok(M.lockTermAdjustment(45) === -0.15 && M.lockTermAdjustment(60) === -0.3, 'the 45/60-day lock adjustments are the sheet\'s −0.15 / −0.30');
  ok(M.lockTermAdjustment(15) === null && M.lockTermAdjustment(90) === null, 'a lock period the sheet does not publish resolves to null — never interpolated');
  // …on the PRICE, and in the right direction: a LONGER lock must WORSEN the price.
  const base30 = priceAt(sc({ ...M.lockTermFacts(30) }));
  const p45 = priceAt(sc({ ...M.lockTermFacts(45) }));
  const p60 = priceAt(sc({ ...M.lockTermFacts(60) }));
  ok(base30 === PREPAY_BASELINE, 'a 30-day lock leaves the price at the base (the sheet\'s own baseline)');
  ok(p45 < base30, 'a 45-day lock WORSENS the price');
  ok(+(base30 - p45).toFixed(6) === 0.15, '…by exactly the sheet\'s 0.15');
  ok(p60 < p45, 'a 60-day lock WORSENS it further');
  ok(+(base30 - p60).toFixed(6) === 0.3, '…by exactly the sheet\'s 0.30');
  ok(priceAt(sc({ ...M.lockTermFacts(15) })) === base30, 'an unpublished lock period emits NO line — never a guessed charge');
  // the two facts travel together, and lock_days stays on the base ladder so the rungs stay selectable
  ok(M.lockTermFacts(45).lock_days === 30 && M.lockTermFacts(45).lock_term_days === 45,
    'lockTermFacts pins lock_days to the base ladder\'s 30 and carries the requested period as lock_term_days');
  ok(rungAt(sc({ lock_days: 45, lock_term_days: 45 })) === null,
    'and the reason: setting lock_days to 45 makes the 30-day base ladder unselectable — no price at all (which is why the pricing fact is separate)');
}
{
  // EXTENSIONS — resolved and validated, deliberately NOT priced into the grid.
  for (const r of M.SHEET_TABLES.EXTENSION.rows) ok(M.extensionAdjustment(r.days) === r.adj, `a ${r.days}-day extension is ${r.adj}`);
  ok(M.extensionAdjustment(7) === null && M.extensionAdjustment(20) === null, 'an unpublished extension length resolves to null — never pro-rated');
  ok(M.SHEET_TABLES.EXTENSION.rows.every((r) => r.adj < 0), 'every extension is a CHARGE (it would worsen the price)');
  let mono = true; let prev = 1;
  for (const r of M.SHEET_TABLES.EXTENSION.rows) { if (!(r.adj < prev)) mono = false; prev = r.adj; }
  ok(mono, 'a LONGER extension costs strictly more');
  // the sheet's own limit — "Max 3 for Max 30 Days"
  ok(M.extensionProblem({ days: [] }) === null, 'no extension is within the limit');
  ok(M.extensionProblem({ days: [15, 15] }) === null, '2 extensions totalling 30 days is within the limit');
  ok(M.extensionProblem({ days: [5, 10, 15] }) === null, '3 extensions totalling 30 days is within the limit');
  ok(/exceeds the sheet's maximum of 3/.test(M.extensionProblem({ days: [5, 5, 5, 5] }) || ''), '4 extensions exceeds the 3-extension maximum');
  ok(/30 days/.test(M.extensionProblem({ days: [15, 15, 15] }) || ''), '45 extension days exceeds the 30-day maximum');
  ok(/not on the sheet/.test(M.extensionProblem({ days: [7] }) || ''), 'an unpublished extension length is refused, never priced');
  // …and NOT in the grid (the composition with a lock-term adjustment is unstated — see UNMEASURED)
  const codes = sheet.adjustments.map((a) => String(a.code || ''));
  ok(!codes.some((c) => /extension|_ext_/i.test(c)), 'the EXTENSION table is deliberately NOT a grid adjustment (its composition with the lock term is unstated)');
  ok(M.UNMEASURED.some((u) => /EXTENSION COMPOSITION/i.test(u)), '…and that open question is recorded in UNMEASURED');
}

// ═══ 5. THE SHEET IS THE SOURCE OF TRUTH — every encoded value traces to the JSON ══════════════════
{
  const jsonPath = path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'matrices', 'deephaven-dscr-ratesheet-corr-t0.json');
  const J = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const jp = J.maxPricePrepayBuydown.rows.map((r) => ({ term: r.term, termMonths: r.termMonths, llpaOther: r.llpaOther, llpa5PctFixed: r.llpa5PctFixed, maxPrice: r.maxPrice }));
  ok(JSON.stringify(jp) === JSON.stringify(M.SHEET_TABLES.PREPAY), 'the PREPAY table matches the rate-sheet JSON row for row (term, months, both LLPA columns, max price)');
  const jt = J.maxPriceTiersByLoanAmount.rows.map((r) => ({ loanAmountMax: r.loanAmountMax, maxPrice: r.maxPrice }));
  ok(JSON.stringify(jt) === JSON.stringify(M.SHEET_TABLES.MAX_PRICE_TIERS), 'the MAX-PRICE TIERS match the JSON');
  ok(J.maxPriceTiersByLoanAmount.minPrice === M.SHEET_TABLES.MIN_PRICE, 'the MIN price matches the JSON (98.000)');
  ok(M.SHEET_TABLES.MAX_PRICE_RULE === J.maxPriceTiersByLoanAmount._rule.replace(/^B48 verbatim: '/, '').replace(/' — THE LOWEST WINS\.$/, ''),
    'the combining rule is the sheet\'s own words, quoted verbatim from the JSON');
  ok(/lower of Max Price Tiers and Prepay Buydown/.test(M.SHEET_TABLES.MAX_PRICE_RULE), '…and it is the LOWER of the two');
  const jl = J.termExtensionAdjustments.lockTerm.map((r) => ({ days: r.days, adj: r.adj }));
  ok(JSON.stringify(jl) === JSON.stringify(M.SHEET_TABLES.LOCK_TERM), 'the LOCK-TERM table matches the JSON');
  const je = J.termExtensionAdjustments.extension;
  ok(JSON.stringify(je.rows.map((r) => ({ days: r.days, adj: r.adj }))) === JSON.stringify(M.SHEET_TABLES.EXTENSION.rows), 'the EXTENSION table matches the JSON');
  ok(je.maxExtensions === M.SHEET_TABLES.EXTENSION.maxExtensions && je.maxTotalDays === M.SHEET_TABLES.EXTENSION.maxTotalDays,
    'the extension limit is the JSON\'s own "Max 3 for Max 30 Days"');
  ok(/3-YEAR PREPAY/.test(J._baseline) && /30-DAY LOCK/.test(J._baseline), 'the JSON itself states the 30-day / 3-year baseline this module builds on');
  ok(/PREMIUM-POSITIVE/.test(J._signConvention), 'the JSON declares PREMIUM-POSITIVE — the convention this module follows with NO negation');
  // the three pricing tiers of §1a, straight from the JSON
  const pm = J.prepayPricingModels;
  ok(pm.standard.marginHoldbackDeltaMilli === 0 && pm.fixed5Promo.marginHoldbackDeltaMilli === 0 && pm.customSofterOverlay.marginHoldbackDeltaMilli === 375,
    'the JSON records the three PPP tiers: standard and 5% Fixed carry no holdback, custom softer carries +0.375');
  ok(pm.customSofterOverlay.marginHoldbackDeltaMilli === marginHoldbackDeltaOf('33321'),
    '…and that +0.375 is the SAME number the existing structure library carries (one definition, not two)');
}

// ═══ 6. THE MARGIN HOLDBACK — sheet = investor (pre-holdback); Lender Price = post-holdback ════════
{
  const hb = M.resolveHoldbackMilli();
  ok(hb === resolveMarginHoldback({}).holdbackMilli, 'the holdback comes from the EXISTING margin-holdback module\'s own default, not a literal here');
  ok(hb === 250, `…which is 0.250 today (got ${hb / 1000})`);
  // The owner's own worked example.
  ok(M.lpPriceMilli(104) === 103750, 'the owner\'s example: an investor max price of 104 shows in Lender Price as 103.75');
  // Every published ceiling, both families.
  let good = 0;
  for (const r of M.SHEET_TABLES.PREPAY) if (M.lpPriceMilli(r.maxPrice) === Math.round(r.maxPrice * 1000) - hb) good += 1;
  for (const t of M.SHEET_TABLES.MAX_PRICE_TIERS) if (M.lpPriceMilli(t.maxPrice) === Math.round(t.maxPrice * 1000) - hb) good += 1;
  ok(good === 9, 'all 6 prepay caps and all 3 loan-amount tiers shift by exactly the holdback');
  ok(M.loanAmountCapTiers().map((t) => t.capMilli).join(',') === '104750,104250,103250',
    'the loan-amount tiers reach the engine as 104.750 / 104.250 / 103.250 (105 / 104.5 / 103.5 − 0.250)');
  // THE STORED TABLE IS NEVER PRE-SHIFTED — the sheet's own numbers stay on the sheet.
  ok(M.SHEET_TABLES.MAX_PRICE_TIERS[0].maxPrice === 105 && M.SHEET_TABLES.PREPAY[2].maxPrice === 104,
    'the stored tables carry the INVESTOR\'s pre-holdback numbers, un-shifted');
  // THE HOLDBACK IS NOT HARD-CODED — change it and every ceiling moves with it.
  const alt = M.priceLimitFor(sc({ loan: 1400000, value: 2800000, cltv: 50, prepay_months: 36 }), { holdbackMilli: 500 });
  ok(alt.holdbackMilli === 500 && alt.sheetCapMilli === 104000 && alt.capMilli === 103500,
    'a per-investor holdback of 0.500 moves the ceiling to 103.500 — the 0.250 is resolved, never hard-coded');
  const zero = M.priceLimitFor(sc({ prepay_months: 36 }), { holdbackMilli: 0 });
  ok(zero.capMilli === 104000, 'a zero holdback leaves the investor\'s own 104.000 untouched');
  // A per-SCENARIO holdback rule reaches it too, through the existing module's own rule mechanism.
  const withRule = M.priceLimitFor(sc({ prepay_months: 36 }), { rules: pppMarginHoldbackRules(), facts: { ppp_structure_key: '33321' } });
  ok(withRule.holdbackMilli === 625 && withRule.capMilli === 103375,
    'a custom-softer scenario\'s +0.375 rule flows through the same module and moves the ceiling to 103.375');
  // THE BASE LADDER — the relationship the owner just explained, across all 28 coupons.
  const J = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'matrices', 'deephaven-dscr-ratesheet-corr-t0.json'), 'utf8'));
  const ourMilli = new Map(BASE_SHEET.BASE.map(([c, bp]) => [c, Math.round((100 - bp) * 1000)]));
  let checked = 0; let within = 0; const off = [];
  for (const row of J.basePricing.coupons) {
    const ours = ourMilli.get(row.coupon);
    if (ours == null) { off.push(`coupon ${row.coupon} missing from our ladder`); continue; }
    checked += 1;
    const diff = (row.price30yFixed * 1000 - hb) - ours;
    // ≤ half a milli-point: the sheet carries five decimals on six coupons, Lender Price quotes on the
    // milli grid, so three of them are EXACT half-milli ties. Anything larger would be a real gap.
    if (Math.abs(diff) <= 0.5) within += 1; else off.push(`coupon ${row.coupon}: sheet−holdback ${(row.price30yFixed * 1000 - hb) / 1000} vs ours ${ours / 1000}`);
  }
  ok(checked === 28 && within === 28, `the base ladder is sheet − holdback at ALL 28 coupons, to the milli-point${off.length ? ' — off: ' + off.slice(0, 3).join(' | ') : ''}`);
  ok(J.basePricing.coupons.find((r) => r.coupon === 7.5).price30yFixed === 105.425 && BARE === 105.175,
    'worked example at 7.500: the sheet says 105.425, Lender Price shows 105.175 — exactly the 0.250 holdback');
}

// ═══ 7. WHAT IS DELIBERATELY NOT DECIDED IS RECORDED (never guessed) ══════════════════════════════
ok(Array.isArray(M.UNMEASURED) && M.UNMEASURED.length >= 10, `UNMEASURED records every open question (${M.UNMEASURED.length} entries)`);
for (const [re, what] of [
  [/EXTENSION COMPOSITION/i, 'how an extension composes with a lock-term adjustment'],
  [/EXTENSION LIMIT READING/i, 'how "Max 3 for Max 30 Days" should be read'],
  [/LOCK-TERM WIRING/i, 'the lock_term_days vs lock_days engine question'],
  [/MIN PRICE vs THE HOLDBACK/i, 'whether the holdback shifts the 98.000 floor'],
  [/WHICH KNOB IS THE 0\.25/i, 'margin vs holdback — which knob the owner means'],
  // The engine DOES subtract the holdback now (§2.69), so this entry records the frame question that
  // is genuinely still open rather than the wiring that is not. That the note matches the code is proven
  // biconditionally in test-lt-ppe-sheet-claims.js — this row only asserts the sheet still records it.
  [/THE HOLDBACK AND THE BASE LADDER'S FRAME/i, 'which frame the base ladder is in'],
  [/CLAMP ORDER/i, 'cap-then-floor vs floor-then-cap'],
  [/ABOVE \$2,500,000/i, 'no published tier above the max loan'],
  [/ONE CAP PER TERM/i, 'one max-price column for both pricing models'],
  [/PRICING-MODEL FACT/i, 'which layer sets prepay_pricing_model'],
]) ok(M.UNMEASURED.some((u) => re.test(u)), `UNMEASURED records: ${what}`);

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
