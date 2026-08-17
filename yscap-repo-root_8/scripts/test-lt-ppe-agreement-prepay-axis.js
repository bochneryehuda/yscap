#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE PREPAY AXIS IS MEASURABLE NOW, AND THE RUNNER MUST STOP IGNORING IT WHEN IT IS ON.
 *
 * Lender Price itemizes a `5 Year Prepay Penalty` of **0.625** on every scenario in the canonical
 * agreement battery (measured live 2026-08-17 — the battery defaults to a 60-month term). Our prepay
 * table reads **+0.625** for a 60-month standard term, so the two agree — but the agreement runner was
 * pricing the BASE sheet, which carries no prepay block at all, and passing `ignoreDimensions:
 * ['prepay']` to stop that absence being reported as a disagreement.
 *
 * That pairing is correct only while the sheet genuinely lacks the block. The hazard this suite exists
 * to pin is the pairing coming APART: turn the prepay block on and leave the ignore in place, and the
 * runner prices an axis it then refuses to look at — the LLPA could be wrong by any amount and the gate
 * would still read clean. It is the same shape as every other defect in this harness's history: a
 * comparison quietly not asking the question it appears to ask.
 *
 * WHY THE BLOCK IS OPT-IN rather than simply on: the base sheet is the 30-day / 3-year baseline every
 * earlier measurement was taken against, so switching it changes WHAT is being compared and has to be a
 * deliberate choice. The composed grid also carries the max-price caps and the lock-term pricing, which
 * are a different question again.
 *
 * PURE: no network, no DB, no live Lender Price.
 */
const fs = require('fs');
const path = require('path');
const M = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');

let pass = 0; const fails = [];
function ok(cond, label) { if (cond) { pass += 1; console.log(`  ok   ${label}`); } else { fails.push(label); console.log(` FAIL  ${label}`); } }

// ---------------------------------------------------------------------------------------------
// 1. OUR PREPAY TABLE AGREES WITH THE ONE LENDER PRICE VALUE WE HAVE MEASURED.
//    This is the whole reason the axis is worth turning on.
// ---------------------------------------------------------------------------------------------
const LP_MEASURED_5YR_STANDARD = 0.625;   // live, 2026-08-17, itemized as "5 Year Prepay Penalty"
ok(M.prepayLlpa(60, 'standard') === LP_MEASURED_5YR_STANDARD,
  `a 60-month standard prepay is +${LP_MEASURED_5YR_STANDARD} — exactly Lender Price's measured value (got ${M.prepayLlpa(60, 'standard')})`);

// The direction is the point, not just the size: a LONGER penalty is worth MORE to the investor, so it
// must IMPROVE the price. A table that got the sign wrong would still "match" LP's magnitude.
const ladder = [0, 12, 24, 36, 48, 60].map((t) => M.prepayLlpa(t, 'standard'));
ok(ladder.every((v) => typeof v === 'number'), `every standard term prices (${ladder.join(', ')})`);
let rising = true;
for (let i = 1; i < ladder.length; i += 1) if (ladder[i] < ladder[i - 1]) rising = false;
ok(rising, 'the standard ladder IMPROVES monotonically with the term — a longer penalty is never worth less');
ok(M.prepayLlpa(0, 'standard') < 0, 'no prepay penalty at all is a CHARGE (the investor loses the protection)');
ok(M.prepayLlpa(60, 'fixed5_promo') > M.prepayLlpa(60, 'standard'),
  'the 5% Fixed promo pays MORE than standard at the same term — the two pricing models are distinct');

// ---------------------------------------------------------------------------------------------
// 2. THE COMPOSED GRID REALLY CARRIES THE AXIS, and the base one really does not. If these ever
//    converged, the flag would be decorative and the ignore-list pairing below would be untestable.
// ---------------------------------------------------------------------------------------------
const base = buildDeephavenGrid();
const full = M.buildPrepayMaxPriceGrid();
const prepayIn = (g) => (g.llpaTables || []).filter((t) => t.dimension === 'prepay').length;
ok(prepayIn(base) === 0, 'the BASE sheet carries no prepay table at all — which is why the runner ignores the axis by default');
ok(prepayIn(full) > 0, `the composed sheet carries the prepay tables (${prepayIn(full)})`);
ok(full.llpaTables.length > base.llpaTables.length, 'the composed sheet is a strict superset of the base sheet\'s tables');

// The composed grid is the MODULE's own entry point — the runner must not re-compose the tables itself,
// or "the full sheet" would have two definitions that can drift.
const runner = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
ok(/buildPrepayMaxPriceGrid\(\)/.test(runner), 'the runner uses the module\'s own composed grid, never a second composition');

// ---------------------------------------------------------------------------------------------
// 3. THE PAIRING — this is the assertion the suite exists for. `prepay` may be ignored ONLY while the
//    block is off. On with the block, an ignore would price an axis and then refuse to look at it.
// ---------------------------------------------------------------------------------------------
ok(/ignoreDimensions: \(builtin && !withPrepay\) \? \['prepay'\] : undefined/.test(runner),
  'the prepay ignore is conditioned on the block being OFF — never priced-but-unlooked-at');
ok(/const withPrepay = flag\('--with-prepay'\)/.test(runner), 'the flag exists and is read once');
ok(/withPrepay \? require\('\.\.\/src\/longterm\/ppe\/deephaven-dscr-prepay-maxprice'\)\.buildPrepayMaxPriceGrid\(\) : buildDeephavenGrid\(\)/.test(runner),
  'and the SAME flag chooses the grid — one switch, so the sheet and the ignore-list can never disagree');
ok(/\+ PREPAY\/max-price block/.test(runner),
  'the run PRINTS which sheet it measured — a report that does not say what it compared is not evidence');

// ---------------------------------------------------------------------------------------------
// 4. THE MAX-PRICE CAPS RIDE ALONG, AND THEY ARE ALREADY IN LENDER PRICE'S FRAME. Worth pinning
//    because the owner's rule is that LP shows every number AFTER our 0.25 margin holdback, and a cap
//    carried at the sheet's pre-holdback value would clamp our prices 0.25 above LP's.
// ---------------------------------------------------------------------------------------------
const caps = (full.priceLimit && full.priceLimit.capTiers) || [];
ok(caps.length > 0, `the composed sheet carries the max-price cap tiers (${caps.length})`);
ok(caps.some((c) => c.capMilli === 104750),
  'the top cap is 104.750 — the sheet\'s 105.000 MINUS the 0.25 holdback, i.e. already in Lender Price\'s frame');
ok(full.priceLimit.minPrice === 98, 'and the 98.000 floor rides with it');
ok(base.priceLimit.minPrice === null, '…while the base sheet states no floor, so the two are genuinely different sheets');


// ---------------------------------------------------------------------------------------------
// 5. BOTH LEGS MUST BE TOLD THE SAME LOAN — the scenario is ONE object driving two engines.
//
// MEASURED LIVE 2026-08-17: the battery's short-term-rental scenario set our overlay fact
// `short_term_rental: true` and nothing else. The thing Lender Price actually reads is `rentalTerm`,
// which buildSearch maps to the real transmitted token `Short_Term_Rental_Property` and which DEFAULTS
// TO LONG-TERM when omitted. So our engine priced a short-term rental and LP priced a long-term one:
// 28 `llpa_extra_ours` lines, our 0.5 charge against nothing. It surfaced as "a cell we DO encode
// disagrees", and it was not a sheet disagreement at all — it was two different loans.
//
// The general hazard is a fact with TWO names, one per leg. This asserts the pairing for every scenario
// in the battery, so the next fact that gains an LP-facing counterpart cannot be set on one side only.
// ---------------------------------------------------------------------------------------------
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const { _internals: model } = require('../src/longterm/lenderprice/search-model');
const scenarios = buildAgreementScenarios().scenarios;
ok(scenarios.length >= 200, `the canonical battery is intact (${scenarios.length} scenarios)`);

const strScenarios = scenarios.filter((s) => s.short_term_rental === true || s.shortTermRental === true);
ok(strScenarios.length > 0, `the battery exercises short-term rental at all (${strScenarios.length})`);
ok(strScenarios.every((s) => model.mapRentalTerm(s.rentalTerm) === 'Short_Term_Rental_Property'),
  'every short-term-rental scenario ALSO tells Lender Price it is short-term — never our fact alone');

// …and the inverse: a scenario that does NOT claim short-term rental must not accidentally tell LP that
// it is, or LP would price an adjustment we never asked for.
const nonStr = scenarios.filter((s) => !(s.short_term_rental === true || s.shortTermRental === true));
ok(nonStr.every((s) => model.mapRentalTerm(s.rentalTerm) === 'Long_Term_Rental_Property'),
  'and every other scenario tells Lender Price long-term — the default, stated rather than assumed');

// The token itself must be the vendor's real one, not a value we invented.
ok(model.mapRentalTerm('short') === 'Short_Term_Rental_Property' && model.mapRentalTerm('long') === 'Long_Term_Rental_Property',
  'the rental-term tokens are the vendor\'s own (Short_/Long_Term_Rental_Property)');
ok(model.mapRentalTerm(undefined) === 'Long_Term_Rental_Property',
  'an OMITTED rental term defaults to long-term — which is exactly why stating only our overlay fact silently disagreed');

console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
process.exit(fails.length ? 1 : 0);
