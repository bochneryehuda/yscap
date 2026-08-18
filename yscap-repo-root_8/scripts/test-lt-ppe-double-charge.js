#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE DOUBLE-CHARGE GUARD (adjustment-overlap.js), end to end through the REAL pipeline:
 * deephaven-grid.gridToRateSheet → ratesheet.rateSheetToProgram → quote.quoteProgram. Pure, offline.
 *
 * THE DEFECT, REPRODUCED WITH REAL NUMBERS (section 1): a sheet with two OVERLAPPING DSCR blocks and
 * one adjustment row PASTED TWICE compiled with `problems[]` EMPTY, and then charged a loan sitting in
 * the overlap 2.000 points where the sheet's own least-costly single reading is 0.750 — a 1.250-point
 * ($1,500 on a $120,000 loan) SILENT double charge, with nothing anywhere saying it happened.
 *
 * THE FIX: `rule-coverage.analyzeRuleSet` — the ONE definition of "these two pricing rules overlap",
 * which already exists — is asked at BOTH ends. At compile time the collision lands in the grid's
 * `problems[]` (the sheet is reported, never rewritten). At price time the colliding adjustments are
 * collapsed to ONE (the least costly, the safe direction) and every collision comes back on the
 * quote's `problems[]` in the checker's own words naming both rules.
 *
 * ⚠️ THE OPEN QUESTION: whether two overlapping bands are MEANT to stack is a business question about
 * an investor's sheet. This engine does not answer it — it takes the direction that can never
 * overcharge and records the question (docs/longterm/PPE-OVERLAPPING-BANDS-QUESTION.md).
 *
 * THE CONTROL (section 6) is the point of the whole file: over the canonical ~300-scenario agreement
 * battery on the REAL Deephaven DSCR sheet, every priced ladder is BYTE-FOR-BYTE what the unguarded
 * composition (rules.evaluateRules + pricing.priceLadder) produces, `problems[]` is empty, and nothing
 * is suppressed. A guard that changes a clean sheet's price by one milli-point fails here.
 *
 * LT-only. No network, no DB, no RTL imports.
 */

const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram, selectRungs } = require('../src/longterm/ppe/quote');
const { evaluateRules } = require('../src/longterm/ppe/rules');
const pricing = require('../src/longterm/ppe/pricing');
const overlap = require('../src/longterm/ppe/adjustment-overlap');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const { lpScenarioToFacts } = require('../src/longterm/ppe/lp-agreement-legs');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

// The checker's OWN sentence. Asserting on THIS (not on a count, not on a thrown error) is what makes
// a mutation's failure mean "the guard stopped detecting it" rather than "the test crashed".
const CHECKER_SENTENCE = /both charge on the .+ dimension across .+ — a loan in there is adjusted twice\./;

console.log('LT PPE — the double-charge guard (overlapping bands + duplicated rows)\n');

// ===========================================================================================
// 1. REPRODUCTION — a sheet with two overlapping DSCR blocks and a duplicated adjustment row
// ===========================================================================================
// Two FICO×CLTV blocks whose DSCR bands OVERLAP: [1.00, 1.25) charging 1.000 point and [1.20, 1.50)
// charging 0.500. A loan at DSCR 1.22 sits in BOTH. And the small-loan row is written twice, as a
// pasted-column import does. Base price is exactly par and the margin is zero so every milli-point of
// the final price is an adjustment and nothing is hidden by rounding.
const COLLIDING_GRID = {
  investor: 'acme', program: 'dscr', lockDays: 45, scale: 1000,
  terms: [{ key: '30yr', product: 'ACME_30F' }],
  base: [{ coupon: 7.000, prices: { '30yr': 100.000 } }],
  ficoCltvByDscr: [
    { dscr: { min: 1.00, max: 1.25 }, ficoBands: [{ min: 740, max: 760 }], cltvBands: [{ min: 70, max: 75 }], cells: [[-1.000]] },
    { dscr: { min: 1.20, max: 1.50 }, ficoBands: [{ min: 740, max: 760 }], cltvBands: [{ min: 70, max: 75 }], cells: [[-0.500]] },
  ],
  llpaTables: [
    { dimension: 'loan_amount', fact: 'loan_amount', reason: 'small loan', bands: [{ min: null, max: 150000, adj: -0.250 }] },
    { dimension: 'loan_amount', fact: 'loan_amount', reason: 'small loan (pasted twice)', bands: [{ min: null, max: 150000, adj: -0.250 }] },
  ],
  priceLimit: { minPrice: 90.000, roundingMode: 'none' },
};
const SETTINGS_RAW = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none' };
const IN_THE_OVERLAP = { fico: 750, ltv: 72000, dscr: 1220, loan_amount: 120000, lock_days: 45, product: 'ACME_30F' };

const C = gridToRateSheet(COLLIDING_GRID);
const cSheet = { version: { id: 'acme' }, basePrices: C.basePrices, adjustments: C.adjustments, priceLimit: C.priceLimit };
const cProgram = rateSheetToProgram(cSheet, { code: 'ACME' });

// What the rules evaluator sees — the faithful record, deliberately unchanged by this fix.
const fired = evaluateRules(cProgram.rules, IN_THE_OVERLAP);
const firedCost = fired.adjustments.reduce((s, a) => s + pricing.normalizeAdjustment(a, 0).costMilli, 0);
ok(fired.adjustments.length === 4, 'the evaluator still reports ALL FOUR rules that fired (the audit trail is untouched)');
ok(firedCost === 2000, `the four fired rules total 2.000 points of cost (${firedCost} milli) — the double charge, as written`);

const q = quoteProgram({ scenario: IN_THE_OVERLAP, program: cProgram, settings: SETTINGS_RAW });
const rung = q.ladder[0];
console.log(`\n    MEASURED: rules fired = ${firedCost} milli-points of cost; charged after the guard = ${rung.adjustmentCostMilli}.`);
console.log(`    Double charge avoided = ${firedCost - rung.adjustmentCostMilli} milli-points`
  + ` (${((firedCost - rung.adjustmentCostMilli) / 1000).toFixed(3)} points`
  + ` = $${(((firedCost - rung.adjustmentCostMilli) / 100000) * IN_THE_OVERLAP.loan_amount).toFixed(2)} on a $${IN_THE_OVERLAP.loan_amount} loan).\n`);

// ===========================================================================================
// 2. COMPILE TIME — the grid's own problems[] carries it, in plain words, naming BOTH rules
// ===========================================================================================
ok(C.problems.length === 2, `the colliding grid compiles with 2 problems, not silence (got ${C.problems.length})`);

const dscrProblem = C.problems.find((p) => p.dimension === 'fico_cltv_dscr');
ok(!!dscrProblem && dscrProblem.kind === 'double_charge', 'the overlapping DSCR blocks are reported as a double charge');
ok(!!dscrProblem && CHECKER_SENTENCE.test(dscrProblem.reason), 'the DSCR problem carries the checker\'s OWN sentence ("…both charge on the … dimension … a loan in there is adjusted twice.")');
ok(!!dscrProblem && dscrProblem.rules.length === 2
  && dscrProblem.rules.some((r) => /1_1\.25/.test(r)) && dscrProblem.rules.some((r) => /1\.2_1\.5/.test(r)),
  'the DSCR problem NAMES both rules — the [1.00,1.25) block and the [1.20,1.50) block');
ok(!!dscrProblem && /dscr \[1200, 1250\)/.test(dscrProblem.reason), 'the DSCR problem names the exact band where the two collide (dscr [1200, 1250))');
ok(!!dscrProblem && /never charged twice/.test(dscrProblem.reason), 'the DSCR problem records the open question for the sheet\'s owner');

const dupProblem = C.problems.find((p) => p.dimension === 'loan_amount');
ok(!!dupProblem && CHECKER_SENTENCE.test(dupProblem.reason), 'the duplicated row is reported with the same checker sentence');
ok(!!dupProblem && dupProblem.rules[0] !== dupProblem.rules[1]
  && dupProblem.rules.every((r) => r.startsWith('acme_dscr_loan_amount__150000')),
  'the two duplicated rows share ONE code, so the report tells them apart positionally while still naming the code');

ok(C.adjustments.length === 4, 'the compiler REPORTS the sheet and never rewrites it — all four rows survive compilation');

// ===========================================================================================
// 3. PRICE TIME — charged ONCE, and the quote says so
// ===========================================================================================
ok(q.eligible === true, 'the colliding sheet still prices — the guard reports, it never refuses to quote');
ok(rung.adjustments.length === 2, `exactly two adjustments reach the price (one per colliding group), not four (got ${rung.adjustments.length})`);
ok(rung.adjustmentCostMilli === 750, `the loan is charged 0.750 points once each (${rung.adjustmentCostMilli} milli), not 2.000`);
ok(rung.finalPriceMilli === 99250, `the rung prices to 99.250 (par 100.000 − 0.750), not 98.000 (got ${rung.finalPriceMilli})`);

ok(Array.isArray(q.problems) && q.problems.length === 2, `the quote's problems[] carries both collisions (got ${(q.problems || []).length})`);
const qDscr = (q.problems || []).find((p) => p.dimension === 'fico_cltv_dscr');
ok(!!qDscr && CHECKER_SENTENCE.test(qDscr.reason), 'the quote problem carries the checker\'s OWN sentence');
ok(!!qDscr && /PILOT applied .+ once \(500 milli-points of cost\) and suppressed the other/.test(qDscr.reason),
  'the quote problem says WHAT WAS DONE — which rule was applied, and that the other was suppressed');
ok(!!qDscr && qDscr.applied && /1\.2_1\.5/.test(qDscr.applied), 'the quote problem names the rule that was applied');

// ===========================================================================================
// 4. THE SAFE DIRECTION — the LEAST COSTLY of the colliding adjustments is the one applied
// ===========================================================================================
const applied = rung.adjustments.map((a) => a.costMilli).sort((a, b) => a - b);
ok(JSON.stringify(applied) === JSON.stringify([250, 500]),
  `the 0.500 DSCR cell is applied and the 1.000 one suppressed — the borrower is never overcharged (applied ${JSON.stringify(applied)})`);
ok(q.suppressedAdjustments.length === 2, 'both suppressions are recorded on the quote as an audit trail');
const supDscr = q.suppressedAdjustments.find((s) => s.costMilli === 1000);
ok(!!supDscr && supDscr.appliedCostMilli === 500 && /1_1\.25/.test(supDscr.code),
  'the audit names the suppressed rule, its cost, and the cheaper one applied in its place');

// a THREE-way overlap collapses to ONE charge, not to two (pairwise suppression would leave two).
const THREE = JSON.parse(JSON.stringify(COLLIDING_GRID));
THREE.ficoCltvByDscr.push({ dscr: { min: 1.15, max: 1.30 }, ficoBands: [{ min: 740, max: 760 }], cltvBands: [{ min: 70, max: 75 }], cells: [[-0.750]] });
const T = gridToRateSheet(THREE);
const tq = quoteProgram({
  scenario: IN_THE_OVERLAP,
  program: rateSheetToProgram({ version: { id: 't' }, basePrices: T.basePrices, adjustments: T.adjustments, priceLimit: T.priceLimit }, { code: 'T' }),
  settings: SETTINGS_RAW,
});
ok(tq.ladder[0].adjustments.length === 2 && tq.ladder[0].adjustmentCostMilli === 750,
  `three overlapping DSCR blocks collapse to ONE charge of 0.500 (+ the loan-amount 0.250) = 0.750 (got ${tq.ladder[0].adjustmentCostMilli})`);

// ===========================================================================================
// 5. WHAT IT CANNOT READ IS REPORTED, NEVER COLLAPSED (no invented discount)
// ===========================================================================================
// `neq` is a complement, so `rule-coverage` refuses to reduce it to a region and reports it as
// unanalyzable. Two such rules on one dimension both firing is a POSSIBLE double charge nobody can
// prove — so both are applied and the quote says the check could not be made.
const BLIND_PROGRAM = {
  code: 'BLIND',
  baseGrid: [{ rate: 7000, lockDays: 45, product: 'P', basePriceMilli: 100000 }],
  rules: [
    { code: 'blind_a', kind: 'pricing', when: { fact: 'state', op: 'neq', value: 'NY' }, adjustment: { code: 'blind_a', dimension: 'geo', adjMilli: 250, unit: 'points' } },
    { code: 'blind_b', kind: 'pricing', when: { fact: 'occupancy', op: 'neq', value: 'primary' }, adjustment: { code: 'blind_b', dimension: 'geo', adjMilli: 125, unit: 'points' } },
  ],
};
const bq = quoteProgram({ scenario: { state: 'FL', occupancy: 'investment', lock_days: 45, product: 'P' }, program: BLIND_PROGRAM, settings: SETTINGS_RAW });
ok(bq.ladder[0].adjustments.length === 2 && bq.ladder[0].adjustmentCostMilli === 375,
  'a collision the checker cannot read is NOT collapsed — suppressing an unproven collision would be inventing a discount');
const blindProblem = (bq.problems || []).find((p) => p.kind === 'double_charge_unverified');
ok(!!blindProblem && /could not be read/.test(blindProblem.reason) && /Check by hand/.test(blindProblem.reason),
  '…and it is REPORTED as unverified rather than passing as clean — "could not judge" never looks like "no problem"');
ok(!!blindProblem && blindProblem.rules.includes('blind_a') && blindProblem.rules.includes('blind_b'),
  'the unverified report names both rules');

// ===========================================================================================
// 6. THE CONTROL — a clean sheet is BYTE-FOR-BYTE unchanged over the canonical ~300 battery
// ===========================================================================================
const REAL = gridToRateSheet(buildDeephavenGrid());
ok(REAL.problems.length === 0, `the REAL Deephaven DSCR sheet compiles with ZERO problems — the guard never cries wolf (got ${REAL.problems.length}: ${JSON.stringify(REAL.problems.slice(0, 2))})`);
ok(REAL.adjustments.length === 133, `…over all ${REAL.adjustments.length} of its pricing rules`);

const REAL_PROGRAM = rateSheetToProgram(REAL, { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const BATTERY_SETTINGS = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'nearest_eighth', 'pricing.price_floor_milli': 98000 };
const { scenarios, count } = buildAgreementScenarios();

let compared = 0; let drift = 0; let noisy = 0; let suppressedAny = 0; let threw = 0;
const driftExamples = [];
for (const sc of scenarios) {
  let facts; let quoted;
  try {
    facts = lpScenarioToFacts(sc);
    quoted = quoteProgram({ scenario: facts, program: REAL_PROGRAM, settings: BATTERY_SETTINGS });
  } catch (e) { threw += 1; continue; }

  if ((quoted.problems || []).length) { noisy += 1; continue; }
  if ((quoted.suppressedAdjustments || []).length) { suppressedAny += 1; }
  if (!quoted.eligible) { compared += 1; continue; } // nothing priced, nothing to compare

  // THE UNGUARDED COMPOSITION: the evaluator's OWN adjustment list (every rule that fired, nothing
  // suppressed) through the pricing pipeline, on the basis the façade itself published. This is
  // exactly what quoteProgram did before the guard, so a byte-identical ladder is a byte-identical
  // price for every rung, every itemized adjustment, and every provenance field.
  const d = evaluateRules(REAL_PROGRAM.rules, facts);
  const pb = quoted.pricingBasis;
  const before = pricing.priceLadder(
    selectRungs(REAL_PROGRAM.baseGrid, facts).map((r) => ({ rate: r.rate, basePriceMilli: r.basePriceMilli, context: { lockDays: r.lockDays, product: r.product || null } })),
    {
      adjustments: d.adjustments,
      marginMilli: pb.marginMilli,
      roundingMode: pb.roundingMode,
      roundingIncrementMilli: pb.roundingIncrementMilli,
      floorMilli: pb.floorMilli,
      capMilli: pb.capMilli,
      cumulativeAdjustmentCapMilli: pb.cumulativeAdjustmentCapMilli,
    },
  );
  compared += 1;
  if (JSON.stringify(before) !== JSON.stringify(quoted.ladder)) {
    drift += 1;
    if (driftExamples.length < 5) driftExamples.push(`${sc._group}/${sc._label}`);
  }
}

ok(count >= 290, `the control battery is wide (${count} scenarios across the canonical agreement axes)`);
ok(threw === 0, `no scenario threw (${threw})`);
ok(noisy === 0, `NOT ONE of the ${count} scenarios on the real sheet reports a collision — the guard is silent on a clean sheet (${noisy} noisy)`);
ok(suppressedAny === 0, `NOTHING is suppressed on a clean sheet across the whole battery (${suppressedAny})`);
ok(compared >= 250, `${compared} scenarios were compared against the unguarded composition`);
ok(drift === 0, `every priced ladder is BYTE-FOR-BYTE identical to the unguarded composition (${drift} drifted${driftExamples.length ? ': ' + driftExamples.join(', ') : ''})`);

// …and the guard is a strict no-op on the clean sheet at the adjustment level too (belt to the braces
// above: this catches a re-ordering the ladder comparison could in principle absorb).
let reorder = 0;
for (const sc of scenarios.slice(0, 120)) {
  const facts = lpScenarioToFacts(sc);
  const d = evaluateRules(REAL_PROGRAM.rules, facts);
  const r = overlap.resolveDoubleCharges(d.matchedPricingRules, d.adjustments);
  if (JSON.stringify(r.adjustments) !== JSON.stringify(d.adjustments)) reorder += 1;
}
ok(reorder === 0, `the guard returns the evaluator's adjustment list byte-for-byte on a clean sheet (${reorder} changed)`);

// The small clean fixture from the grid test stays clean too (a second, differently-shaped sheet).
const CLEAN_SMALL = gridToRateSheet({
  investor: 'acme', program: 'clean', lockDays: 45, scale: 1000,
  terms: [{ key: '30yr', product: 'P' }],
  base: [{ coupon: 7.000, prices: { '30yr': 100.000 } }],
  ficoCltvByDscr: [
    { dscr: { min: null, max: 1.25 }, ficoBands: [{ min: 740, max: 760 }, { min: 760, max: null }], cltvBands: [{ min: 70, max: 75 }, { min: 75, max: 80 }], cells: [[-1.000, -1.250], [-0.500, -0.750]] },
    { dscr: { min: 1.25, max: null }, ficoBands: [{ min: 740, max: 760 }, { min: 760, max: null }], cltvBands: [{ min: 70, max: 75 }, { min: 75, max: 80 }], cells: [[0.000, -0.250], [0.250, 0.125]] },
  ],
  llpaTables: [{ dimension: 'loan_amount', fact: 'loan_amount', bands: [{ min: null, max: 150000, adj: -0.250 }, { min: 1500000, max: null, adj: -0.500 }] }],
  priceLimit: { minPrice: 90.000, roundingMode: 'none' },
});
ok(CLEAN_SMALL.problems.length === 0, 'a correctly-banded two-block DSCR sheet (bands meeting at 1.25, never crossing) compiles with zero problems');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
