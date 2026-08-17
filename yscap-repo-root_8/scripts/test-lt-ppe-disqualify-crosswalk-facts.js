#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE CROSSWALK NEVER MAPS AN LP DISQUALIFIER TO A FACT THE ENGINE CANNOT EVALUATE
 * (the DEAD-MAP class; CLAUDE.md "one definition, prove they agree" + "fail closed, never silently").
 *
 * `disqualify-crosswalk.keyToPredicate` turns ONE Lender Price disqualification (its `adjType` + human
 * `rule` text) into one of OUR rule predicates, so that adding that predicate as an overlay rule makes
 * our engine decline exactly what Lender Price declined. That only works if the predicate names a fact
 * a live scenario actually PRODUCES: `rules._evalLeaf` FAILS SAFE — an unknown fact short-circuits the
 * leaf to `false` — so a predicate reading a fact `lpScenarioToFacts` never emits produces a rule that
 * can NEVER decline. It "successfully crosswalks", authors cleanly, and silently fails to replicate the
 * decline. That is the exact bug this guard closes, and it had TWO live instances:
 *
 *   • "Interest Only not available in NY" → the crosswalk emitted `{ fact: 'io' }`, but the engine's
 *     canonical fact is `interest_only`. Dead.
 *   • "Max CLTV exceeded / CLTV > 80.0 %" → the crosswalk emitted `{ fact: 'cltv' }`, but no `cltv`
 *     fact existed at all (only `ltv` + `subordinate_amount`). Dead.
 *
 * THE INVARIANT, proven three ways over a battery covering every `ADJTYPE_FACT` dimension plus the two
 * text-feature branches (interest-only, cash-out):
 *
 *   1. EVERY emitted predicate, evaluated against the canonical facts a scenario produces, references
 *      ONLY known facts — `evalPredicate(...).unknown` is EMPTY. (An `io`/`cltv` regression repopulates
 *      it and fails here — the direct dead-map catch.)
 *   2. Each predicate FIRES (declines) on a scenario engineered to trip it AND does NOT fire on one
 *      engineered not to — both with zero unknowns, so a `false` is proven to come from the FACT, not
 *      from a fail-safe on a missing fact. (This is what a `.unknown`-only check cannot prove.)
 *   3. The battery COVERS every `ADJTYPE_FACT` dimension, so a newly-added adjType that maps to an
 *      unknown fact is caught the day it is added — the guard grows with the crosswalk, not by hand.
 *
 * PURE. No DB, no network. LT-only; no RTL import.
 */
const xw = require('../src/longterm/ppe/disqualify-crosswalk');
const rules = require('../src/longterm/ppe/rules');
const { lpScenarioToFacts } = require('../src/longterm/ppe/lp-agreement-legs');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — the disqualify crosswalk never maps to a fact the engine cannot evaluate\n');

// Collect every fact NAME a predicate references (recursing through all/any groups).
function factsOf(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node.all)) node.all.forEach((n) => factsOf(n, acc));
  else if (Array.isArray(node.any)) node.any.forEach((n) => factsOf(n, acc));
  else if (node.fact) acc.add(node.fact);
  return acc;
}

// A battery: one row per crosswalk dimension. `trip` is a scenario the predicate MUST decline; `pass`
// is one it must NOT. Every scenario is a full DSCR deal so the whole facts vocabulary is present.
const DEAL = { purpose: 'Purchase', value: 500000, loan: 375000, fico: 740, dscr: 1.30, state: 'FL', units: 1 };
const BATTERY = [
  { name: 'FICO floor',   in: { adjType: 'FicoRateAdjustment', rule: 'FICO - below 660' },
    trip: { fico: 640 }, pass: { fico: 720 } },
  { name: 'DSCR floor',   in: { adjType: 'DscrRateAdjustment', rule: 'DSCR - below 1.0' },
    trip: { dscr: 0.90 }, pass: { dscr: 1.25 } },
  { name: 'Loan amount',  in: { adjType: 'LoanAmountRateAdjustment', rule: 'Loan Amount - below 100000' },
    trip: { value: 120000, loan: 90000 }, pass: { value: 500000, loan: 375000 } },
  { name: 'LTV ceiling',  in: { adjType: 'CapAdjustment', rule: 'Max LTV exceeded / LTV > 80.0 %' },
    trip: { value: 500000, loan: 425000 }, pass: { value: 500000, loan: 350000 } },
  { name: 'CLTV ceiling', in: { adjType: 'CapAdjustment', rule: 'Max CLTV exceeded / CLTV > 80.0 %' },
    trip: { value: 500000, loan: 350000, subordinateLoanAmount: 120000 }, pass: { value: 500000, loan: 350000, subordinateLoanAmount: 0 } },
  { name: 'State ban',    in: { adjType: 'StatesRateAdjustment', rule: 'Not available in NY' },
    trip: { state: 'NY' }, pass: { state: 'FL' } },
  { name: 'IO + state',   in: { adjType: 'StatesRateAdjustment', rule: 'Interest Only not available in NY' },
    trip: { state: 'NY', io: true }, pass: { state: 'NY', io: false } },
  { name: 'Cash-out + state', in: { adjType: 'StatesRateAdjustment', rule: 'Cash out not available in TX' },
    trip: { state: 'TX', purpose: 'CashOut' }, pass: { state: 'TX', purpose: 'Purchase' } },
];

const factsVocab = new Set(Object.keys(lpScenarioToFacts(DEAL)));
const allEmitted = new Set();

for (const row of BATTERY) {
  const r = xw.keyToPredicate(row.in);
  ok(r && r.ok === true, `[${row.name}] the crosswalk maps it to a predicate` + (r && r.ok ? '' : `\n        got: ${JSON.stringify(r)}`));
  if (!r || !r.ok) continue;

  // (1) every fact the predicate names is one a scenario produces.
  const refs = [...factsOf(r.predicate, new Set())];
  refs.forEach((f) => allEmitted.add(f));
  const unknownFacts = refs.filter((f) => !factsVocab.has(f));
  ok(unknownFacts.length === 0, `[${row.name}] every fact it references is in the scenario facts vocabulary`
    + (unknownFacts.length ? `\n        UNKNOWN fact(s): ${unknownFacts.join(', ')} — a predicate reading these is a DEAD MAP (rules._evalLeaf fails safe to false)` : ''));

  // (2) fires on the trip scenario, does NOT fire on the pass scenario — both with ZERO unknown facts,
  //     so a `false` is proven to be the FACT deciding, not a fail-safe on a missing fact.
  const trip = rules.evalPredicate(r.predicate, lpScenarioToFacts({ ...DEAL, ...row.trip }));
  const good = rules.evalPredicate(r.predicate, lpScenarioToFacts({ ...DEAL, ...row.pass }));
  ok(trip.value === true && trip.unknown.size === 0, `[${row.name}] DECLINES the tripping scenario with no unknown fact`
    + (trip.value === true && trip.unknown.size === 0 ? '' : `\n        value=${trip.value} unknown=[${[...trip.unknown].join(',')}]`));
  ok(good.value === false && good.unknown.size === 0, `[${row.name}] does NOT decline the passing scenario, and not because a fact was missing`
    + (good.value === false && good.unknown.size === 0 ? '' : `\n        value=${good.value} unknown=[${[...good.unknown].join(',')}]`));
}

// (3) the battery covered every dimension the crosswalk classifies by adjType, so a new adjType that
//     maps to an unknown fact is caught the moment it is added. `ltv_cap` always resolves to ltv/cltv
//     (never leaks as a fact), so the covered set is the resolved facts, not the raw ADJTYPE_FACT values.
const EXPECTED_COVERED = ['fico', 'dscr', 'loan_amount', 'ltv', 'cltv', 'state', 'interest_only', 'purpose'];
const missingCover = EXPECTED_COVERED.filter((f) => !allEmitted.has(f));
ok(missingCover.length === 0, 'the battery exercises every crosswalk-emittable fact'
  + (missingCover.length ? `\n        not exercised: ${missingCover.join(', ')} — extend the battery` : ''));

// And every dimension named in ADJTYPE_FACT is reachable by the battery (its resolved fact was emitted).
const dims = Object.values(xw.ADJTYPE_FACT).map((d) => (d === 'ltv_cap' ? null : d)).filter(Boolean);
const dimGap = dims.filter((d) => !allEmitted.has(d));
ok(dimGap.length === 0, 'every ADJTYPE_FACT dimension is covered by the battery'
  + (dimGap.length ? `\n        uncovered adjType dimension(s): ${dimGap.join(', ')}` : ''));

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
