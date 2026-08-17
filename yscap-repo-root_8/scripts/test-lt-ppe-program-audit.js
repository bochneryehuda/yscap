#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE PROGRAM SELF-AUDIT (#49, offline our-side half).
 *
 *  A) DIGEST MATH — on a controlled synthetic descriptor, prove the counting is PER SCENARIO (a layer /
 *     code counts once per scenario, not per reason), that eligible+ineligible = total, and that the
 *     tallies are exactly right.
 *  B) REACHABILITY — run the REAL Deephaven program over a broad fact-axis battery and prove every
 *     overlay decline CODE fires at least once (no dead / unreachable overlay rule), that both eligible
 *     and ineligible verdicts occur, and that `neverFired` correctly flags a code that CANNOT fire.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { auditProgram } = require('../src/longterm/ppe/program-audit');
const { assertDescriptor } = require('../src/longterm/ppe/program-engine');
const { buildMatrix } = require('../src/longterm/ppe/scenario-matrix');
const deephaven = require('../src/longterm/ppe/program-deephaven-dscr');
const { DEEPHAVEN_OVERLAY_CUTS } = require('../src/longterm/ppe/deephaven-overlay-rules');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const ltv = (pct) => pct * 1000;

console.log('LT PPE — program self-audit (#49)\n');

// ---- A) DIGEST MATH on a synthetic descriptor ------------------------------------------------------
{
  // eligibility declines a low FICO (code e_fico); PPP prohibits when prepay requested (code p_ppp);
  // overlay declines twice on one armed fact (codes o_1 AND o_2) so we can prove per-scenario counting.
  const DESC = assertDescriptor({
    investor: 'Syn', programName: 'Syn',
    evaluateEligibility: (f) => ({
      reasons: f.fico < 660 ? [{ code: 'e_fico', dimension: 'fico', declineReason: 'low', citation: 'S' }] : [],
      maxLtvMilli: 70000, cell: null, unverifiable: [],
    }),
    pppInputFromFacts: (f) => ({ prepay: f.prepay_months > 0 }),
    pppResult: () => ({ result: 'standard', terms: null, matched: true }),
    pppDisqualifier: (i) => (i.prepay ? { code: 'p_ppp', dimension: 'prepay_state', declineReason: 'no', citation: 'S' } : null),
    // when armed (renovation true), emit TWO overlay declines in one scenario
    evaluateOverlay: (f) => (f.renovation === true
      ? { declines: [{ code: 'o_1', fact: 'renovation', reason: 'a', citation: 'c', overlay: true }, { code: 'o_2', fact: 'renovation', reason: 'b', citation: 'c', overlay: true }], enforced: [{ overlay: 'renovation', cuts: ['a', 'b'] }], stillFlagged: [] }
      : { declines: [], enforced: [], stillFlagged: [{ overlay: 'reno-flag', needs: 'x' }] }),
    evaluateInformational: () => ({ reserves: null, informational: [], exceptions: [] }),
  });

  const facts = [
    { fico: 600, prepay_months: 0, renovation: false },   // e_fico only
    { fico: 720, prepay_months: 60, renovation: false },  // p_ppp only
    { fico: 720, prepay_months: 0, renovation: true },    // overlay o_1 + o_2 (one scenario)
    { fico: 600, prepay_months: 60, renovation: true },   // all three layers
    { fico: 720, prepay_months: 0, renovation: false },   // eligible
  ];
  const d = auditProgram(DESC, facts);
  ok(d.total === 5 && d.eligible === 1 && d.ineligible === 4 && d.eligible + d.ineligible === d.total, 'digest: total / eligible / ineligible add up (1 eligible, 4 ineligible of 5)');
  ok(d.layerHitCounts.eligibility_matrix === 2 && d.layerHitCounts.ppp_matrix === 2 && d.layerHitCounts.overlay === 2, 'digest: layer hit counts are PER SCENARIO (eligibility 2, ppp 2, overlay 2)');
  ok(d.declineCodeCounts.e_fico === 2 && d.declineCodeCounts.p_ppp === 2 && d.declineCodeCounts.o_1 === 2 && d.declineCodeCounts.o_2 === 2, 'digest: decline code counts (each fires in exactly 2 scenarios; o_1 and o_2 both counted from one scenario)');
  ok(d.overlayArmedCounts.renovation === 2 && d.stillFlaggedCounts['reno-flag'] === 3, 'digest: overlay armed count (2) and stillFlagged count (3 — the scenarios where renovation was off)');
  // expectedCodes → neverFired flags a code that cannot fire
  const d2 = auditProgram(DESC, facts, { expectedCodes: ['e_fico', 'p_ppp', 'o_1', 'o_2', 'ghost_code'] });
  ok(Array.isArray(d2.neverFired) && d2.neverFired.length === 1 && d2.neverFired[0] === 'ghost_code', 'digest: neverFired flags exactly the expected code that never fired (ghost_code)');
}

// ---- B) REACHABILITY of every Deephaven overlay code over a broad battery --------------------------
{
  const overlayCodes = DEEPHAVEN_OVERLAY_CUTS.flatMap((g) => (g.cuts || []).map((c) => c.code));
  ok(overlayCodes.length === 12, `the Deephaven overlay table publishes 12 decline codes (${overlayCodes.length})`);

  const { scenarios, fullSize } = buildMatrix({
    fico: [660, 700, 720, 760],
    ltv: [ltv(60), ltv(65), ltv(70), ltv(75), ltv(80)],
    dscr: [900, 1000, 1150, 1250],
    loan_amount: [150000, 400000, 1500001],
    units: [1, 2],
    short_term_rental: [false, true],
    first_time_investor: [false, true],
    rural_property: [false, true],
    declining_market: [false, true],
    foreign_national: [false, true],
    occupancy: ['leased', 'vacant'],
  }, { base: { purpose: 'purchase', state: 'NY', borrower_type: 'LLC', prepay_months: 60 }, maxScenarios: 100000 });
  ok(scenarios.length === fullSize && fullSize > 5000, `the fact-axis battery is the FULL grid, not truncated (${scenarios.length} scenarios)`);

  const d = auditProgram(deephaven.PROGRAM.descriptor, scenarios, { expectedCodes: overlayCodes });
  ok(d.eligible > 0 && d.ineligible > 0, 'audit: the battery produces both eligible AND ineligible verdicts');
  ok(d.neverFired.length === 0, `audit: EVERY overlay decline code is reachable — no dead overlay rule (${overlayCodes.length} codes, 0 never-fired)`);
  if (d.neverFired.length) console.log('   never fired:', d.neverFired.join(', '));
  ok(d.layerHitCounts.overlay > 0 && d.layerHitCounts.eligibility_matrix > 0, 'audit: both the overlay and eligibility layers declined at least one scenario');
  // the reconciled geo/delivery overlays are the ones that stay unverifiable across the whole battery
  ok(Object.keys(d.stillUnverifiableCounts).some((k) => /Philadelphia/.test(k)) && d.stillUnverifiableCounts[Object.keys(d.stillUnverifiableCounts).find((k) => /Philadelphia/.test(k))] === scenarios.length, 'audit: the Philadelphia geo overlay is unverifiable on every scenario (a fact no layer carries)');
  // occupancy=vacant armed the D27 flag on the vacant half
  ok(Object.keys(d.stillFlaggedCounts).some((k) => /Vacant\/Unleased/.test(k)), 'audit: the vacant-occupancy D27 rule shows up in the stillFlagged tally');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
