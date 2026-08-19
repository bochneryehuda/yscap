#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT TWO VOCABULARIES FILING ONE RULE DIFFERENTLY IS NOT A DISAGREEMENT.
 *
 * ⛔ THE DEFECT. The per-layer reconciler pairs declines by a SINGLE dimension each. OUR stamp names the
 * fact a rule CONSTRAINS (§2.101); Lender Price's `adjType` names the fact it FILES the rule under. Both
 * are compound rules mentioning several facts, so the two headings differ for the SAME refusal —
 * MEASURED live 2026-08-18 on scenarios both engines declined:
 *
 *   ours  loan_amount  "Minimum Loan Amount $75,000 (DSCR >= 1.00x)"
 *   LP    dscr         "DSCR >= 1.00, Minimum Loan Amount $75,000"          <- the same rule
 *   ours  ltv          "Max LTV/CLTV 70%: T1 FICO 640–679, purchase/rate-term, DSCR >= 1.00"
 *   LP    fico         "DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%"
 *
 * Both landed as `onlyOurs` + `onlyAuthority` — a DISAGREEMENT — which reads as "our rate sheet is
 * wrong here" and would send somebody to fix a sheet nothing has been shown to be wrong with. Five of
 * the six comparable scenarios in the live run failed this way.
 *
 * THE FIX READS EACH SIDE'S OWN STRUCTURE, NOT THE TWO TEXTS. A pair is RELATED when the authority's
 * dimension is one of the facts OUR rule's predicate actually tests. No prose is compared: the facts
 * come from the compiled rule, the dimension from the vendor's `adjType`, through the shared
 * `factsForDimension` so the cash-out alias is honoured once.
 *
 * ⛔ RELATED IS NOT AGREEMENT, and that is the load-bearing decision. Nearly every Deephaven rule tests
 * `dscr`, so treating a gate-fact overlap as agreement would merge genuinely different refusals and
 * manufacture a pass. It makes the layer INDETERMINATE — the honest "we cannot tell" — and the scenario
 * incomparable under its OWN name, `decline_reasons_unpaired`, so it is never confused with
 * `decline_reasons_unreadable`, which is a different piece of news (a parsing failure, not a vocabulary
 * gap).
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const { reconcileDisqualifiers } = require('../src/longterm/ppe/disqualifier-reconciler');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { runOne } = require('../src/longterm/ppe/ratesheet-agreement');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()));
const ourDecline = (code, reason) => ({ eligible: false, declines: [{ code, reason }] });
const lpDecline = (rule, adjType) => ({ ready: true, declined: [{ reasons: [{ rule, adjType }] }] });
const rec = (ours, lp) => reconcileDisqualifiers(ours, lp, { program });
// ⛔ READ `related` DEFENSIVELY. A mutation that removes the bucket entirely would otherwise make this
// file CRASH on `.length` — and a crashing test "fails" in a way that looks like proof while telling
// you nothing about which assertion bit. `[]` turns that into real, named failures.
const rel = (r) => ((r && r.layers && r.layers.layer2 && r.layers.layer2.related) || []);

// ---- A. THE LIVE PAIRS, verbatim -----------------------------------------------------------------
const A1 = rec(
  ourDecline('dhvn_min_loan_ge1', 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)'),
  lpDecline('DSCR >= 1.00, Minimum Loan Amount $75,000', 'SimpleRateAdjustment'),
);
ok(rel(A1).length === 1, `A1 the min-loan pair is RELATED — got ${JSON.stringify(rel(A1))}`);
ok(A1.layers.layer2.onlyOurs.length === 0 && A1.layers.layer2.onlyAuthority.length === 0,
  'A2 …and neither side is left standing alone (it is no longer a disagreement)');
ok(A1.verdict === 'indeterminate', `A3 …the verdict is the honest "cannot tell" — got ${A1.verdict}`);
ok(A1.relatedOnly === true, 'A4 …and the cause is named as the vocabulary gap');
ok((rel(A1)[0] || {}).via === 'dscr',
  `A5 …recording WHICH fact paired them, so nobody has to guess — got ${(rel(A1)[0] || {}).via}`);
ok((rel(A1)[0] || {}).ourDimension === 'loan_amount' && (rel(A1)[0] || {}).lpDimension === 'dscr',
  'A6 …with BOTH headings kept, because the mismatch is the finding');

const A2 = rec(
  ourDecline('dhvn_ltv_t1_640_purchase_ge1', 'Max LTV/CLTV 70%: T1 FICO 640–679, purchase/rate-term, DSCR >= 1.00'),
  lpDecline('DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%', 'FicoRateAdjustment'),
);
ok(rel(A2).length === 1, `A7 the max-LTV pair is RELATED — got ${JSON.stringify(rel(A2))}`);
ok(A2.verdict === 'indeterminate' && A2.relatedOnly === true, 'A8 …same verdict, same named cause');

// ---- B. A GENUINE DISAGREEMENT IS STILL A DISAGREEMENT --------------------------------------------
// The rule that decides this must not become "anything both sides said pairs up". Our min-DSCR rule
// tests ONLY `dscr`, so an authority reason about `state` cannot relate to it.
const B = rec(
  ourDecline('dhvn_min_dscr', 'Minimum DSCR 0.75'),
  lpDecline('Other - State of DC, MA, NJ, NY', 'StatesRateAdjustment'),
);
ok(rel(B).length === 0, `B1 an unrelated pair does NOT relate — got ${JSON.stringify(rel(B))}`);
ok(B.layers.layer2.onlyOurs.length === 1 && B.layers.layer2.onlyAuthority.length === 1,
  'B2 …both sides stay standing alone');
ok(B.verdict === 'disagree', `B3 …and it is still a DISAGREEMENT — got ${B.verdict}`);
ok(B.relatedOnly === false, 'B4 …never reported as the vocabulary gap');

// ---- C. AN EXACT MATCH IS STILL AN AGREEMENT ------------------------------------------------------
// ⛔ NOT `"DSCR >=1.25%  only eligible on this program"`, which this case used until §2.107 — it
// resolves to `dscr` and so read as an ordinary stand-in, but it was MEASURED to be a statement about
// Lender Price's own program partition and is now set aside rather than scored. Pairing it with a real
// refusal of ours would assert the false agreement §2.107 exists to prevent. Another live-captured
// reason that resolves to `dscr`.
const C = rec(
  ourDecline('dhvn_min_dscr', 'Minimum DSCR 0.75'),
  lpDecline('DSCR >= 1.00, Minimum Loan Amount $75,000', 'SimpleRateAdjustment'),
);
ok(C.layers.layer2.agreements.length === 1, `C1 a same-dimension pair still AGREES — got ${JSON.stringify(C.layers.layer2)}`);
ok(rel(C).length === 0, 'C2 …and is not double-counted as related');
ok(C.verdict === 'agree', `C3 …with an agreeing verdict — got ${C.verdict}`);

// ---- D. ONE RELATED PAIR CANNOT LAUNDER A REAL DISAGREEMENT ---------------------------------------
// Two of ours, one relatable and one not. The unrelatable one must survive and force `disagree`.
const D = reconcileDisqualifiers(
  { eligible: false, declines: [
    { code: 'dhvn_min_loan_ge1', reason: 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)' },
    { code: 'dhvn_state_only', reason: 'made up', dimension: 'state' },
  ] },
  { ready: true, declined: [{ reasons: [{ rule: 'DSCR >= 1.00, Minimum Loan Amount $75,000', adjType: 'SimpleRateAdjustment' }] }] },
  { program },
);
ok(rel(D).length === 1, 'D1 the relatable pair still relates');
ok(D.layers.layer2.onlyOurs.length === 1, `D2 …and the unrelatable decline survives — got ${JSON.stringify(D.layers.layer2.onlyOurs)}`);
ok(D.verdict === 'disagree', `D3 …so the scenario still DISAGREES — got ${D.verdict}`);
ok(D.relatedOnly === false, 'D4 …and is not filed under the vocabulary gap');

// A related pair is used ONCE: one authority row must not pair with several of ours.
// ⛔ THE TWO OF OURS MUST CARRY DIFFERENT DIMENSIONS. `reconcileLayer` keys our rows by dimension and
// keeps the FIRST per dimension, so two `loan_amount` rules collapse to one before relateLayer ever
// sees them — the first version of this fixture did exactly that and the mutation that removes the
// once-only guard stayed GREEN against it. These two differ (`loan_amount` and `ltv`) and BOTH test
// `dscr`, which is the authority row's dimension, so both are genuinely pairable.
const E = reconcileDisqualifiers(
  { eligible: false, declines: [
    { code: 'dhvn_min_loan_ge1', reason: 'min loan ge1' },
    { code: 'dhvn_max_ltv_lt100', reason: 'max ltv lt1' },
  ] },
  { ready: true, declined: [{ reasons: [{ rule: 'DSCR >= 1.00, Minimum Loan Amount $75,000', adjType: 'SimpleRateAdjustment' }] }] },
  { program },
);
ok(rel(E).length === 1,
  `E1 one authority row pairs with exactly ONE of ours — got ${rel(E).length}: ${JSON.stringify(rel(E).map((r) => r.ourReason))}`);
ok(E.layers.layer2.onlyOurs.length === 1,
  `E2 …and the other of ours is left standing, not silently absorbed — got ${JSON.stringify(E.layers.layer2.onlyOurs.map((r) => r.reason))}`);

// ---- F. THE SCENARIO NAMES ITS OWN CAUSE ---------------------------------------------------------
(async () => {
  const SC = { _label: 'v', fico: 740, ltv: 50000, dscr: 1250, loan_amount: 60000 };
  const OPTS = { filter: { investor: 'Deephaven Mortgage' }, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'], program };
  const lpLeg = (rule, adjType) => async () => ({
    full: { programs: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR 1.00-1.24',
      options: [{ priceBuild: { noteRate: 6.125, price: 99.25, basePoints: 0.75, adjustmentPoints: 0 }, adjustments: [] }] }] },
    disqualified: { ready: true, lenders: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', items: [{ program: 'DSCR 1.00-1.24', reasons: [{ rule, adjType }] }] }] },
  });
  const oursLeg = (code, reason) => async () => ({ eligible: false, ladder: [], declines: [{ code, reason, source: 'base' }] });

  const unpaired = await runOne(SC,
    oursLeg('dhvn_min_loan_ge1', 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)'),
    lpLeg('DSCR >= 1.00, Minimum Loan Amount $75,000', 'SimpleRateAdjustment'), OPTS);
  ok(unpaired.incomparableReason === 'decline_reasons_unpaired',
    `F1 the scenario is named for the vocabulary gap, not for unreadable reasons — got ${unpaired.incomparableReason}`);
  ok(unpaired.agree === false, 'F2 …and is NOT scored as an agreement (related is not proof)');

  const unreadable = await runOne(SC,
    oursLeg('dhvn_min_loan_ge1', 'Minimum Loan Amount $75,000 (DSCR >= 1.00x)'),
    lpLeg('something the crosswalk cannot read at all', null), OPTS);
  ok(unreadable.incomparableReason === 'decline_reasons_unreadable',
    `F3 …while a genuinely unreadable reason keeps its own name — got ${unreadable.incomparableReason}`);

  // ---- G. A CONTAINER-PARTITION SENTENCE IS NOT A REFUSAL, END TO END (§2.107) ---------------------
  // The reason this case belongs HERE rather than only in the reconciler's own suite: this is the exact
  // sentence the two surviving live disagreements carried, and it resolves cleanly to `dscr`, so at
  // every layer it LOOKS like an ordinary refusal. It is measured to be Lender Price refusing a
  // CONTAINER — a sibling container priced the same loan on the same request — so it may never pair
  // with a real refusal of ours and call the result an agreement.
  const partition = await runOne(SC,
    oursLeg('dhvn_min_dscr', 'Minimum DSCR 0.75'),
    lpLeg('DSCR >=1.25%  only eligible on this program', 'SimpleRateAdjustment'), OPTS);
  ok(partition.agree !== true, 'G1 a partition sentence never agrees with a real decline of ours');
  ok(partition.declineOutcome !== 'agree',
    `G2 …and the reconciliation does not call it an agreement — got ${partition.declineOutcome}`);

  console.log(`${fails.length ? 'FAIL' : 'PASS'} — decline vocabulary guard: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(fails.length ? 1 : 0);
})();
