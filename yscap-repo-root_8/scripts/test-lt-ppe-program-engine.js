#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GENERIC PROGRAM ENGINE + INVESTOR REGISTRY (PPE #47).
 *
 * Proves:
 *  A) EQUIVALENCE — `program-registry.evaluateProgramFor('deephaven', …)` is BYTE-IDENTICAL to
 *     `program-deephaven-dscr.evaluateProgram(…)` over a battery that exercises every layer (eligibility
 *     grid, PPP state matrix, the D36 overlay declines, informational), so routing the Deephaven program
 *     through the shared engine changed nothing.
 *  B) ENGINE — `runProgram` composes a SYNTHETIC (second-investor) descriptor correctly: each layer's
 *     reason is labelled to its layer, the informational layer never gates, and `eligible` is exactly
 *     "no reasons". `assertDescriptor` rejects a descriptor missing any slot.
 *  C) REGISTRY — aliases resolve to Deephaven; an unknown investor yields null (never a silent default);
 *     the catalog lists the registered program.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const deephaven = require('../src/longterm/ppe/program-deephaven-dscr');
const registry = require('../src/longterm/ppe/program-registry');
const { runProgram, assertDescriptor } = require('../src/longterm/ppe/program-engine');
const { lpScenarioToFacts } = require('../src/longterm/ppe/lp-agreement-legs');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const J = (x) => JSON.stringify(x);
const ltv = (pct) => pct * 1000;

console.log('LT PPE — generic program engine + investor registry (PPE #47)\n');

// ---- A) EQUIVALENCE: evaluateProgramFor('deephaven') ≡ evaluateProgram over a layer-exercising battery
{
  const FICO = [680, 700, 720, 760];
  const LTVP = [65, 70, 75, 78, 80];
  const DSCR = [900, 1000, 1150, 1250];
  const LOAN = [150000, 400000, 1500001, 2300000];
  const PURP = ['purchase', 'refinance', 'cashout'];
  const STATE = ['NY', 'NJ', 'IL', 'MD'];
  const BT = ['LLC', 'Individual'];
  const UNITS = [1, 2, 4];
  const PREPAY = [0, 60];
  // overlay facts (a few combinations, incl. the relative declining-market cut that reads the grid cap)
  const OVL = [
    {},
    { short_term_rental: true },
    { first_time_investor: true },
    { rural_property: true },
    { declining_market: true },
    { foreign_national: true },
    { occupancy: 'vacant' },
    { short_term_rental: true, declining_market: true, foreign_national: true },
  ];
  // deterministic LCG sample (no Math.random)
  let seed = 20260817;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  let checked = 0; let mismatches = 0; let firstBad = null; let sawIneligible = false; let sawOverlay = false;
  for (let i = 0; i < 4000; i++) {
    const facts = {
      fico: pick(FICO), ltv: ltv(pick(LTVP)), dscr: pick(DSCR), loan_amount: pick(LOAN),
      purpose: pick(PURP), state: pick(STATE), borrower_type: pick(BT), units: pick(UNITS),
      prepay_months: pick(PREPAY), apr: pick([undefined, 7, 9]),
      ...pick(OVL),
    };
    const opts = { monthlyPitia: pick([undefined, 1800, 3000]) };
    const a = deephaven.evaluateProgram(facts, opts);
    const b = registry.evaluateProgramFor('deephaven', facts, opts);
    const c = runProgram(deephaven.DESCRIPTOR, facts, opts);
    checked++;
    if (J(a) !== J(b) || J(a) !== J(c)) { mismatches++; if (!firstBad) firstBad = { facts, opts, a, b }; }
    if (!a.eligible) sawIneligible = true;
    if (a.reasons.some((r) => r.layer === 'overlay')) sawOverlay = true;
  }
  ok(mismatches === 0, `EQUIVALENCE: registry ≡ program ≡ runProgram over ${checked} layer-exercising scenarios (0 mismatches)`);
  if (firstBad) console.log('   first mismatch:\n     facts=' + J(firstBad.facts) + '\n     a=' + J(firstBad.a) + '\n     b=' + J(firstBad.b));
  ok(sawIneligible && sawOverlay, 'the battery genuinely exercised the layers (produced ineligible verdicts AND overlay-layer declines)');
}

// ---- B) ENGINE composes a SYNTHETIC second-investor descriptor -------------------------------------
{
  // a trivial stand-in for a second investor: an eligibility layer that declines a low FICO, a PPP layer
  // that prohibits on a flag, an overlay layer that never fires, and an informational layer.
  const DESC = assertDescriptor({
    investor: 'Acme', programName: 'Acme DSCR',
    evaluateEligibility: (f) => ({
      reasons: (f.fico < 660 ? [{ code: 'acme_min_fico', dimension: 'fico', declineReason: 'FICO too low', citation: 'Acme' }] : []),
      maxLtvMilli: 70000, cell: { tier: 't1' }, unverifiable: ['acme note'],
    }),
    pppInputFromFacts: (f) => ({ prepayRequested: f.prepay_months > 0 }),
    pppResult: () => ({ result: 'standard', terms: null, matched: true }),
    pppDisqualifier: (i) => (i.prepayRequested ? { code: 'acme_ppp', dimension: 'prepay_state', declineReason: 'no PPP', citation: 'Acme' } : null),
    evaluateOverlay: () => ({ declines: [], enforced: [], stillFlagged: [] }),
    evaluateInformational: () => ({ reserves: { months: 6 }, informational: ['info'], exceptions: [] }),
  });

  const clean = runProgram(DESC, { fico: 720, prepay_months: 0 });
  ok(clean.eligible && clean.reasons.length === 0 && clean.investor === 'Acme' && clean.program === 'Acme DSCR', 'engine: a clean synthetic-investor scenario is eligible, carrying the descriptor investor/program name');
  ok(J(clean.reserves) === J({ months: 6 }) && J(clean.informational) === J(['info']) && J(clean.unverifiable) === J(['acme note']), 'engine: the informational + unverifiable outputs pass through unchanged');

  const badFico = runProgram(DESC, { fico: 600, prepay_months: 0 });
  ok(!badFico.eligible && badFico.reasons.length === 1 && badFico.reasons[0].layer === 'eligibility_matrix' && badFico.reasons[0].code === 'acme_min_fico', 'engine: an eligibility decline is labelled to the eligibility_matrix layer');

  const badPpp = runProgram(DESC, { fico: 720, prepay_months: 60 });
  ok(!badPpp.eligible && badPpp.reasons.some((r) => r.layer === 'ppp_matrix' && r.code === 'acme_ppp'), 'engine: a PPP disqualifier is labelled to the ppp_matrix layer');

  // informational never gates: even a fully clean deal keeps reserves/info without changing eligible
  ok(clean.eligible && clean.reserves && clean.informational.length > 0, 'engine: the informational layer enriches but never changes eligible');

  // an overlay decline from a synthetic overlay slot is labelled to the overlay layer
  const OVL = assertDescriptor({ ...DESC, evaluateOverlay: () => ({ declines: [{ code: 'x', fact: 'renovation', reason: 'r', citation: 'c', overlay: true }], enforced: [], stillFlagged: [] }) });
  const ovl = runProgram(OVL, { fico: 720, prepay_months: 0 });
  ok(!ovl.eligible && ovl.reasons.some((r) => r.layer === 'overlay' && r.code === 'x' && r.dimension === 'renovation'), 'engine: an overlay decline is labelled to the overlay layer with dimension=fact');
}

// ---- assertDescriptor rejects an incomplete descriptor ---------------------------------------------
{
  const full = { investor: 'A', programName: 'A', evaluateEligibility: () => {}, pppInputFromFacts: () => {}, pppResult: () => {}, pppDisqualifier: () => {}, evaluateOverlay: () => {}, evaluateInformational: () => {} };
  let threwMissing = false; let threwBadInvestor = false; let okFull = false;
  try { assertDescriptor({ ...full, evaluateOverlay: undefined }); } catch (e) { threwMissing = /evaluateOverlay/.test(e.message); }
  try { assertDescriptor({ ...full, investor: '' }); } catch (e) { threwBadInvestor = /investor/.test(e.message); }
  try { okFull = assertDescriptor(full) === full; } catch (e) { okFull = false; }
  ok(threwMissing, 'assertDescriptor: THROWS naming a missing function slot');
  ok(threwBadInvestor, 'assertDescriptor: THROWS on an empty investor name');
  ok(okFull, 'assertDescriptor: returns a complete descriptor unchanged');
}

// ---- C) REGISTRY: aliases resolve, unknown → null, catalog lists Deephaven --------------------------
{
  ok(registry.programFor('Deephaven') === deephaven.DESCRIPTOR, 'registry: "Deephaven" resolves to the Deephaven descriptor');
  ok(registry.programFor('deephaven mortgage') === deephaven.DESCRIPTOR && registry.programFor('DEEPHAVEN-DSCR') === deephaven.DESCRIPTOR, 'registry: aliases + spelling variants resolve to the same program');
  ok(registry.programFor('SomeOtherInvestor') === null, 'registry: an unknown investor resolves to null (never a wrong/default program)');
  ok(registry.evaluateProgramFor('nobody', { fico: 720 }) === null, 'registry: evaluateProgramFor an unknown investor → null (caller decides what unknown means)');
  const cat = registry.listPrograms();
  ok(cat.length >= 1 && cat.some((p) => p.investor === 'Deephaven' && p.programName === 'Deephaven DSCR'), 'registry: the catalog lists the Deephaven DSCR program');

  // an equivalence spot-check via lpScenarioToFacts (the live-scenario path)
  const facts = lpScenarioToFacts({ value: 500000, loan: 350000, fico: 760, dscr: 1.25, purpose: 'Purchase', state: 'NY', borrowerType: 'LLC', prepayMonths: 60 });
  ok(J(registry.evaluateProgramFor('deephaven', facts)) === J(deephaven.evaluateProgram(facts)), 'registry: a live-shaped scenario prices identically through the registry');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
