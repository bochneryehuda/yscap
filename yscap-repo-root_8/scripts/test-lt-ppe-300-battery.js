#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE ~300-SCENARIO DEEP VERIFICATION BATTERY (owner-directed 2026-08-17: "run about 300
 * scenarios to cover every single angle — pricing, eligibility, and ineligibility — to verify your
 * pricing and eligibility deeply").
 *
 * Lender Price is NOT configured in this environment (no LP_USERNAME/LP_PASSWORD/LP_CLIENT_SECRET), so
 * the LIVE LP leg cannot run here. This is the OFFLINE half: it drives the SAME ~300-scenario battery
 * (agreement-scenarios.buildAgreementScenarios) through OUR OWN engine — the rate sheet (Layer 1
 * pricing), the eligibility matrix (Layer 2), and the PPP state matrix (Layer 3) — and proves OUR side
 * is COMPLETE and SELF-CONSISTENT across every angle:
 *   1. EVERY scenario gets a DEFINITE verdict — eligible + a priced rate ladder (>=1 rung), OR
 *      ineligible + at least one stated reason. No crash, no "unknown", no priced-but-empty.
 *   2. THE TWO ELIGIBILITY LAYERS AGREE — the Layer-1 rate-sheet eligibility and the independent
 *      Layer-2 matrix reach the same eligible/ineligible verdict on every scenario (any disagreement is
 *      a real finding — the L1<->L2 divergence the audit tracks). [Reported, not asserted 0, because the
 *      known max-LTV grid divergence is deliberately unresolved pending LP-live — see plan §4b.]
 *   3. Every INELIGIBLE-tagged probe is actually declined by our engine, with a reason.
 *   4. The informational layer produces reserves for every priced product.
 * The SAME battery is what runs against Lender Price the moment credentials are present (the LP leg is
 * lp-agreement-legs.buildLpLeg + runRatesheetAgreement) — this proves our side is ready for that gate.
 *
 * LT-only. Pure, offline. No network, no DB.
 */
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const { lpScenarioToFacts } = require('../src/longterm/ppe/lp-agreement-legs');
const { evaluateProgram } = require('../src/longterm/ppe/program-deephaven-dscr');
const { evaluateEligibility } = require('../src/longterm/ppe/deephaven-matrix');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — ~300-scenario deep verification battery (OUR engine; LP live not configured here)\n');

const PROGRAM = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const SETTINGS = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none' };

const { scenarios, count, byGroup } = buildAgreementScenarios();
ok(count >= 290, `the battery covers ~300 scenarios (${count} across ${Object.keys(byGroup).length} angle groups)`);
console.log('    groups: ' + JSON.stringify(byGroup) + '\n');

let indefinite = 0; let layerDrift = 0; let ineligMisTagged = 0; let noReserves = 0; let threw = 0;
const driftExamples = []; const indefExamples = [];

for (const sc of scenarios) {
  let facts, l1, prog;
  try {
    facts = lpScenarioToFacts(sc);
    l1 = quoteProgram({ scenario: facts, program: PROGRAM, settings: SETTINGS }); // Layer-1 sheet: eligibility + pricing
    prog = evaluateProgram(facts, { monthlyPitia: 3000 });                        // Layer-2 + Layer-3 + informational
  } catch (e) {
    threw += 1; console.log('    THREW on ' + sc._group + '/' + sc._label + ': ' + e.message); continue;
  }

  // (1) DEFINITE verdict from the pricing path: eligible → a real rate ladder; ineligible → a reason.
  const l1Elig = !!l1.eligible;
  if (l1Elig) {
    if (!Array.isArray(l1.ladder) || l1.ladder.length === 0) { indefinite += 1; if (indefExamples.length < 8) indefExamples.push(sc._group + '/' + sc._label + ' (eligible but no priced rung)'); }
  } else if (!Array.isArray(l1.declines) || l1.declines.length === 0) {
    indefinite += 1; if (indefExamples.length < 8) indefExamples.push(sc._group + '/' + sc._label + ' (ineligible but no reason)');
  }

  // (2) the two eligibility layers agree (L1 sheet vs L2 matrix). Note: the program adds Layer-3 PPP, so
  // compare L1 to the L2 MATRIX alone (matrix layer), and separately confirm the program is definite.
  const l2 = evaluateEligibility(facts);
  const l2Elig = l2.reasons.length === 0;
  if (l1Elig !== l2Elig) { layerDrift += 1; if (driftExamples.length < 10) driftExamples.push(`${sc._group}/${sc._label}: L1=${l1Elig} L2=${l2Elig}`); }

  // the 3-layer program is always definite: eligible OR (>=1 reason).
  if (!prog.eligible && prog.reasons.length === 0) { indefinite += 1; if (indefExamples.length < 8) indefExamples.push(sc._group + '/' + sc._label + ' (program ineligible with no reason)'); }

  // (3) an INELIGIBLE-tagged probe must actually be declined by the program (matrix or PPP).
  if (sc._ineligible && prog.eligible) { ineligMisTagged += 1; console.log('    MIS-TAGGED eligible (expected ineligible): ' + sc._label); }

  // (4) the informational layer produced reserves (every loan size has a reserve tier).
  if (!prog.reserves || !prog.reserves.months) { noReserves += 1; }
}

ok(threw === 0, `no scenario threw (${threw} threw)`);
ok(indefinite === 0, `every scenario gets a DEFINITE verdict — priced ladder or stated reason (${indefinite} indefinite)`);
if (indefExamples.length) console.log('    e.g. ' + indefExamples.join('; '));
ok(ineligMisTagged === 0, `every ineligible-tagged probe is actually declined (${ineligMisTagged} mis-tagged)`);
ok(noReserves === 0, `every scenario carries an informational reserve requirement (${noReserves} missing)`);

// L1<->L2 agreement is REPORTED (the known max-LTV grid divergence is deliberately open pending LP-live).
console.log(`\n  [layer agreement] L1 rate-sheet vs L2 matrix disagree on ${layerDrift}/${count} scenarios`);
if (driftExamples.length) console.log('    ' + driftExamples.join('\n    '));
console.log('    (the max-LTV grid divergence is the tracked, deliberately-open finding — plan §4b / task #64;');
console.log('     resolution requires Lender Price live as the arbiter — owner D36.)');

// Coverage summary by eligible/ineligible.
let elig = 0; let inelig = 0;
for (const sc of scenarios) { const p = evaluateProgram(lpScenarioToFacts(sc)); if (p.eligible) elig += 1; else inelig += 1; }
console.log(`\n  [coverage] ${count} scenarios: ${elig} eligible, ${inelig} ineligible (program verdict)`);

console.log(`\n=== LENDER PRICE LIVE: NOT RUN — LP is not configured in this environment (no credentials). ===`);
console.log(`    Add LP_USERNAME / LP_PASSWORD / LP_CLIENT_SECRET (or run where they are set) and this same`);
console.log(`    battery runs against LP via scripts/test-lt-lp-agreement-run.js (the E3 agreement gate).`);

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
