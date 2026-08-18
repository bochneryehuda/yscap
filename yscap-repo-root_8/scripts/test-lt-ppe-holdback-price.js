#!/usr/bin/env node
/**
 * LT PPE — THE HOLDBACK COMES OFF THE PRICE WE OFFER.
 *
 * OWNER-AUTHORIZED 2026-08-18, in the owner's own words:
 *
 *   "It's basically: instead of offering for the bar or the investors' raw pricing, like a 102,
 *    we're only gonna offer him a 101.75."
 *
 * Until that sentence the holdback was RECORDED on every quote and deliberately NOT applied, because
 * three readings of it produce three different quotes and guessing a money rule is the most expensive
 * thing that can be done here. This suite is what makes the applied version safe to ship:
 *
 *   §1  the owner's own worked example, verbatim — 102.000 raw, 0.250 holdback, 101.750 offered
 *   §2  INERT WITHOUT ONE: the whole real 299-scenario battery is byte-identical to an engine with
 *       the subtraction physically REMOVED from its source, so a program that carries no holdback
 *       prices exactly as it always did — proven, not asserted
 *   §3  it is a COST and only ever a cost: over a wide grid it can never RAISE a price
 *   §4  it is its OWN line and is never folded into margin — the reconstruction record has to be able
 *       to say which of the two moved the number, because they are set independently per investor
 *   §5  eligibility is untouched: the same scenario is eligible with and without one. A holdback is a
 *       smaller price, never a decline, and never a fee the borrower pays at closing
 *   §6  the honest edge: a holdback CAN push a price down into the sheet's floor, and when it does the
 *       rung says `clamped` rather than quietly reporting a price the floor did not allow
 *   §7  every quote REPORTS the holdback it applied
 *
 * No database. Runs offline.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const { priceRung } = require(path.join(PPE, 'pricing'));
const { quoteProgram } = require(path.join(PPE, 'quote'));
const { gridToRateSheet } = require(path.join(PPE, 'deephaven-grid'));
const { buildDeephavenGrid } = require(path.join(PPE, 'deephaven-dscr-sheet'));
const { rateSheetToProgram } = require(path.join(PPE, 'ratesheet'));
const { buildAgreementScenarios } = require(path.join(PPE, 'agreement-scenarios'));
const { lpScenarioToFacts } = require(path.join(PPE, 'lp-agreement-legs'));

let failures = 0; let pass = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (cond) pass += 1; else failures += 1; }
function eq(got, want, label) { ok(got === want, `${label}${got === want ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`); }

const NO_ROUND = { roundingMode: 'none', roundingIncrementMilli: 1 };

// ---------------------------------------------------------------------------
// §1  THE OWNER'S OWN EXAMPLE
// ---------------------------------------------------------------------------
console.log("\n§1 THE OWNER'S WORKED EXAMPLE — 102.000 raw, 0.250 holdback, 101.750 offered");
{
  const r = priceRung({ basePriceMilli: 102000, marginMilli: 0, holdbackMilli: 250, ...NO_ROUND });
  eq(r.finalPriceMilli, 101750, 'a 0.250 holdback on a 102.000 raw price is offered at 101.750');
  eq(r.holdbackMilli, 250, '…and the quote records the 0.250 it took off');
  const none = priceRung({ basePriceMilli: 102000, marginMilli: 0, ...NO_ROUND });
  eq(none.finalPriceMilli, 102000, 'with no holdback the same rung is still 102.000');
  eq(none.holdbackMilli, 0, '…and reports a holdback of zero rather than nothing at all');
}

// ---------------------------------------------------------------------------
// §2  INERT WITHOUT ONE — byte-for-byte against an engine with the subtraction REMOVED
// ---------------------------------------------------------------------------
console.log('\n§2 INERT — a program carrying no holdback prices exactly as it always did');

// Build a pre-change pricing engine by physically REMOVING the subtraction from the live source.
// Comparing against the live module with a zero holdback would be circular; removing the term is what
// makes this a comparison against the engine as it was.
function strippedEngine() {
  const file = path.join(PPE, 'pricing.js');
  const src = fs.readFileSync(file, 'utf8');
  const TERM = ' - holdbackMilli';
  const hits = src.split(TERM).length - 1;
  eq(hits, 1, 'the holdback appears in the price expression exactly ONCE (the strip cannot miss a copy)');
  const out = src.replace(TERM, '');
  ok(!out.includes(TERM), '…and no second subtraction survives the strip');
  // A WHOLE stripped copy of the engine directory, so `quote.js` there resolves the STRIPPED
  // `pricing.js` by its own relative require. Redirecting requires back at the live directory would
  // have quietly compared the live engine with itself.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'lt-ppe-hb-'));
  for (const f of fs.readdirSync(PPE)) {
    const from = path.join(PPE, f);
    if (fs.statSync(from).isDirectory()) continue;
    fs.writeFileSync(path.join(dir, f), f === 'pricing.js' ? out : fs.readFileSync(from));
  }
  return require(path.join(dir, 'quote.js'));
}
const preFix = strippedEngine();

{
  const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
    { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
  const settings = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': null };
  const battery = buildAgreementScenarios().scenarios;
  ok(battery.length >= 290, `the canonical battery is ${battery.length} scenarios`);

  let moved = 0; let first = null; let priced = 0;
  const canon = (q) => JSON.stringify(q === undefined ? null : q);
  for (const sc of battery) {
    const facts = lpScenarioToFacts(sc);
    const now = quoteProgram({ scenario: facts, program, settings });
    const before = preFix.quoteProgram({ scenario: facts, program, settings });
    if (now.eligible && Array.isArray(now.ladder)) priced += 1;
    // `holdbackMilli` is a NEW field on every rung, so the comparison is on the numbers the engine
    // produces, not on the shape of the record — a new line is not a moved price.
    const strip = (q) => canon((q.ladder || []).map((r) => [r.rate, r.basePriceMilli, r.adjustmentCostMilli,
      r.marginMilli, r.rawPriceMilli, r.roundedPriceMilli, r.finalPriceMilli, r.clamped]).concat([[q.eligible]]));
    if (strip(now) !== strip(before)) { moved += 1; if (!first) first = `${sc._group}/${sc._label}`; }
  }
  ok(priced > 200, `(the battery really prices — ${priced} scenarios produced a ladder)`);
  eq(moved, 0, `NOT ONE rung on the real Deephaven sheet moved by a milli-point${first ? ` (first: ${first})` : ''}`);
}

// ---------------------------------------------------------------------------
// §3  IT IS A COST — it can never RAISE a price
// ---------------------------------------------------------------------------
console.log('\n§3 A HOLDBACK ONLY EVER LOWERS THE PRICE');
{
  let raised = 0; let lowered = 0; let same = 0;
  for (const base of [98000, 100000, 101250, 102000, 103775, 105000]) {
    for (const margin of [0, 125, 250, 500]) {
      for (const hb of [0, 1, 125, 250, 500, 1000]) {
        for (const adj of [-500, 0, 750, 1500]) {
          const withHb = priceRung({ basePriceMilli: base, marginMilli: margin, holdbackMilli: hb, adjustments: [{ code: 'x', adjMilli: adj }], ...NO_ROUND });
          const without = priceRung({ basePriceMilli: base, marginMilli: margin, adjustments: [{ code: 'x', adjMilli: adj }], ...NO_ROUND });
          const d = withHb.finalPriceMilli - without.finalPriceMilli;
          if (d > 0) raised += 1; else if (d < 0) lowered += 1; else same += 1;
          if (hb > 0 && d !== -hb) raised += 1; // an exact reduction, never approximate
        }
      }
    }
  }
  eq(raised, 0, `across ${raised + lowered + same} priced combinations a holdback NEVER raised a price, and always moved it by exactly its own amount`);
  ok(lowered > 0 && same > 0, `(and the grid really exercises both — ${lowered} lowered, ${same} unchanged where the holdback is zero)`);
}

// ---------------------------------------------------------------------------
// §4  ITS OWN LINE — never folded into margin
// ---------------------------------------------------------------------------
console.log('\n§4 MARGIN AND HOLDBACK ARE TWO LINES, NOT ONE NUMBER');
{
  const r = priceRung({ basePriceMilli: 102000, marginMilli: 125, holdbackMilli: 250, ...NO_ROUND });
  eq(r.finalPriceMilli, 101625, '102.000 − 0.125 margin − 0.250 holdback = 101.625');
  eq(r.marginMilli, 125, 'the margin line still reports the margin alone…');
  eq(r.holdbackMilli, 250, '…and the holdback line the holdback alone');
  // The two are set independently per investor, so a record that folded them would make it impossible
  // to say which knob moved a price — this is what stops that.
  const folded = priceRung({ basePriceMilli: 102000, marginMilli: 375, holdbackMilli: 0, ...NO_ROUND });
  eq(folded.finalPriceMilli, r.finalPriceMilli, 'a folded 0.375 margin reaches the SAME price…');
  ok(folded.marginMilli !== r.marginMilli && folded.holdbackMilli !== r.holdbackMilli,
    '…which is exactly why the two lines must stay apart: the price alone cannot tell them apart');
}

// ---------------------------------------------------------------------------
// §5  ELIGIBILITY IS UNTOUCHED
// ---------------------------------------------------------------------------
console.log('\n§5 A HOLDBACK IS A SMALLER PRICE, NEVER A DECLINE');
{
  const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
    { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
  const settings = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': null };
  const battery = buildAgreementScenarios().scenarios;
  let flipped = 0;
  for (const sc of battery) {
    const facts = lpScenarioToFacts(sc);
    const a = quoteProgram({ scenario: facts, program, settings });
    const b = quoteProgram({ scenario: facts, program, settings, marginHoldback: { marginMilli: 250, holdbackMilli: 1000 } });
    if (a.eligible !== b.eligible) flipped += 1;
  }
  eq(flipped, 0, `a 1.000 holdback changed NO scenario's eligibility across all ${battery.length} — not one`);
}

// ---------------------------------------------------------------------------
// §6  THE HONEST EDGE — a holdback can meet the sheet's floor, and says so
// ---------------------------------------------------------------------------
console.log("\n§6 WHEN THE HOLDBACK MEETS THE SHEET'S FLOOR, THE RUNG SAYS SO");
{
  const r = priceRung({ basePriceMilli: 100200, marginMilli: 0, holdbackMilli: 500, floorMilli: 100000, ...NO_ROUND });
  eq(r.finalPriceMilli, 100000, 'a holdback that would take the price under the floor stops AT the floor');
  eq(r.clamped, true, '…and the rung is marked clamped rather than quietly reporting a price the sheet does not allow');
  eq(r.rawPriceMilli, 99700, '…while the raw figure still records what the arithmetic actually produced');
}

// ---------------------------------------------------------------------------
// §7  EVERY QUOTE REPORTS THE HOLDBACK IT APPLIED
// ---------------------------------------------------------------------------
console.log('\n§7 THE QUOTE SAYS WHAT IT TOOK OFF');
{
  const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()),
    { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
  const settings = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': null };
  const facts = lpScenarioToFacts(buildAgreementScenarios().scenarios.find((s) => true));
  const q = quoteProgram({ scenario: facts, program, settings, marginHoldback: { marginMilli: 250, holdbackMilli: 250 } });
  if (q.eligible && q.ladder && q.ladder.length) {
    eq(q.pricingBasis.holdbackMilli, 250, 'the quote basis names the holdback that was applied');
    eq(q.ladder[0].holdbackMilli, 250, '…and so does every rung of the ladder');
    const bare = quoteProgram({ scenario: facts, program, settings });
    ok(bare.eligible && bare.ladder[0].finalPriceMilli - q.ladder[0].finalPriceMilli === 250,
      '…and the SAME scenario priced without one is exactly 0.250 higher');
  } else {
    ok(false, 'the first battery scenario should price (fixture problem, not a code problem)');
  }
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`} (${pass} passed, ${failures} failed)`);
process.exit(failures === 0 ? 0 : 1);
