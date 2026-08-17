#!/usr/bin/env node
'use strict';
/**
 * LT PPE #49 part 2 — the PER-LAYER DISQUALIFIER RECONCILER (disqualifier-reconciler.js). PURE,
 * offline, no DB, no network, no RTL imports.
 *
 * Proves it itemizes agree / disagree (only_ours, only_authority) / unknown PER LAYER (Layer 2
 * eligibility, Layer 3 PPP), reads OUR decline dimensions from the program's rules (never the prose),
 * crosswalks the authority's reasons, and NEVER guesses a missing verdict — an uncrosswalkable reason
 * or a not-ready authority feed stays `unknown` and the verdict is `indeterminate`, never `agree`.
 *
 * PROVEN TO FAIL (mutation): removing our fico decline turns an AGREE into an `only_authority`
 * disagreement (the dangerous direction — we would price a loan LP declines). The CONTROL is green.
 */
const { reconcileDisqualifiers } = require('../src/longterm/ppe/disqualifier-reconciler');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

const program = { rules: [
  { code: 'elig_fico_min', kind: 'eligibility', when: { fact: 'fico', op: 'lt', value: 660 }, declineReason: 'FICO below 660' }, // dimension via sole-leaf fact
  { code: 'elig_prepay_ny', kind: 'eligibility', when: { all: [{ fact: 'prepay', op: 'eq', value: 'none' }, { fact: 'state', op: 'eq', value: 'NY' }] }, dimension: 'prepay' },
] };
const lpDeclineFico = { ready: true, declined: [{ program: 'DSCR', reasons: [{ rule: 'FICO - below 660', adjType: 'FicoRateAdjustment' }] }] };

console.log('#49.2 per-layer disqualifier reconciler — agree / disagree / unknown, never guessed');

// ---- CONTROL: both decline on fico (Layer 2) ⇒ agree ----
const oursDeclineFico = { eligible: false, declines: [{ code: 'elig_fico_min', reason: 'FICO below 660', source: 'base' }] };
const A = reconcileDisqualifiers(oursDeclineFico, lpDeclineFico, { program });
ok(A.verdict === 'agree', 'AGREE-1 both decline on fico ⇒ verdict agree');
ok(A.layers.layer2.agreements.length === 1 && A.layers.layer2.agreements[0].dimension === 'fico', 'AGREE-2 the agreement is itemized on Layer 2 / fico');
ok(A.layers.layer2.verdict === 'agree' && A.layers.layer3.verdict === 'agree', 'AGREE-3 both layers agree');
ok(A.summary.agree === 1 && A.summary.disagree === 0 && A.summary.unknown === 0, 'AGREE-4 summary tallies match');
ok(A.layers.layer2.agreements[0].dimension === 'fico' /* dimension read from the rule, not the text */, 'AGREE-5 our decline dimension came from the rule (sole-leaf fact)');

// ---- MUTATION: we do NOT decline (LP does) ⇒ only_authority disagreement (dangerous direction) ----
const oursEligible = { eligible: true, declines: [] };
const M = reconcileDisqualifiers(oursEligible, lpDeclineFico, { program });
ok(M.verdict === 'disagree', 'MUT-1 we price a loan LP declines ⇒ verdict disagree');
ok(M.layers.layer2.onlyAuthority.length === 1 && M.layers.layer2.onlyAuthority[0].dimension === 'fico', 'MUT-2 surfaced as only_authority on fico');
ok(M.layers.layer2.onlyOurs.length === 0, 'MUT-3 nothing is only_ours here');
ok(A.verdict === 'agree', 'MUT-4 CONTROL — the unmutated case stays agree (green on either side)');

// ---- only_ours: we decline, LP prices ----
const O = reconcileDisqualifiers(oursDeclineFico, { ready: true, declined: [] }, { program });
ok(O.verdict === 'disagree' && O.layers.layer2.onlyOurs.length === 1 && O.layers.layer2.onlyOurs[0].dimension === 'fico', 'ONLYOURS-1 we decline what LP prices ⇒ only_ours disagreement');

// ---- LAYER SPLIT: agree on Layer 2 fico, disagree on Layer 3 prepay ----
const oursTwoLayers = { eligible: false, declines: [
  { code: 'elig_fico_min', reason: 'FICO below 660' },
  { code: 'elig_prepay_ny', reason: 'No-prepay not allowed in NY' },
] };
const L = reconcileDisqualifiers(oursTwoLayers, lpDeclineFico, { program });
ok(L.layers.layer2.agreements.length === 1 && L.layers.layer2.agreements[0].dimension === 'fico', 'LAYER-1 Layer 2 agrees on fico');
ok(L.layers.layer3.onlyOurs.length === 1 && L.layers.layer3.onlyOurs[0].dimension === 'prepay', 'LAYER-2 Layer 3 (PPP) shows our prepay decline as only_ours');
ok(L.verdict === 'disagree', 'LAYER-3 a mismatch on a DIFFERENT layer is a disagreement, not a pass');

// ---- UNKNOWN: an authority reason the crosswalk refuses is surfaced, never guessed ----
const U = reconcileDisqualifiers(oursEligible, { ready: true, declined: [{ reasons: [{ rule: 'Some vendor rule', adjType: 'MysteryAdjustment' }] }] }, { program });
ok(U.verdict === 'indeterminate', 'UNK-1 an uncrosswalkable authority reason ⇒ indeterminate, never agree/disagree');
ok(U.unknown.some((x) => x.side === 'authority' && x.adjType === 'MysteryAdjustment'), 'UNK-2 the unknown reason is surfaced with its adjType');
ok(U.summary.agree === 0 && U.summary.disagree === 0, 'UNK-3 an unknown is scored as neither agree nor disagree');

// ---- authority feed NOT READY ⇒ indeterminate (never assume agreement from silence) ----
const N = reconcileDisqualifiers(oursEligible, { ready: false }, { program });
ok(N.verdict === 'indeterminate' && N.summary.authorityReady === false, 'NOTREADY-1 a not-ready authority feed ⇒ indeterminate');
ok(N.unknown.some((x) => x.why === 'authority_not_ready'), 'NOTREADY-2 the not-ready state is surfaced as unknown');

// ---- our decline whose dimension cannot be read ⇒ unknown (never guessed onto a dimension) ----
const D = reconcileDisqualifiers({ declines: [{ code: 'nope_unknown', reason: 'mystery decline' }] }, { ready: true, declined: [] }, { program });
ok(D.unknown.some((x) => x.side === 'ours' && x.why === 'no_dimension'), 'NODIM-1 an our-decline with no readable dimension is surfaced as unknown');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
