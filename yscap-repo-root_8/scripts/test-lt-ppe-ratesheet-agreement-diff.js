#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the two agreement comparators (ratesheet-agreement-diff.js), pure. Proves the itemized
 * per-dimension LLPA reconciliation catches what a stack-total check cannot (two offsetting cell
 * errors), that LP's separately-itemized fico/cltv/dscr fold into our one grid cell, and the cap/floor
 * probe. LT-only. No network, no DB, no RTL imports.
 */
const { reconcileLlpas, boundsProbe, lpLlpaDimension } = require('../src/longterm/ppe/ratesheet-agreement-diff');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — Lender Price agreement comparators\n');

// LP itemizes fico/cltv/dscr separately; our grid folds them into ONE fico_cltv_dscr cell.
ok(lpLlpaDimension({ adjType: 'FicoRateAdjustment' }) === 'fico_cltv_dscr', 'LP FicoRateAdjustment → our fico_cltv_dscr');
ok(lpLlpaDimension({ adjType: 'CapAdjustment' }) === 'fico_cltv_dscr', 'LP CapAdjustment (CLTV wall) → fico_cltv_dscr');
ok(lpLlpaDimension({ adjType: 'DscrRateAdjustment' }) === 'fico_cltv_dscr', 'LP DscrRateAdjustment → fico_cltv_dscr');
ok(lpLlpaDimension({ adjType: 'LoanAmountRateAdjustment' }) === 'loan_amount', 'LP LoanAmount → loan_amount');
ok(lpLlpaDimension({ adjType: 'StatesRateAdjustment' }) === 'state', 'LP States → state');
ok(lpLlpaDimension({ adjType: 'MysteryAdjustment', reason: 'x' }) === null, 'an unknown LP adjType → null (caller keys it other:<reason>)');

// ---- reconcileLlpas: a MATCHING rung ---------------------------------------
// Ours: one fico_cltv_dscr cell +500, one loan_amount -100.  (cost-positive points)
const ourAdj = [
  { dimension: 'fico_cltv_dscr', adjMilli: 500, reason: 'FICO 780 × CLTV 70 × DSCR≥1.25' },
  { dimension: 'loan_amount', adjMilli: -100, reason: 'loan ≥ 1.5M' },
];
// LP: fico +300, cltv +150, dscr +50 (sum 500) + loanamount -100 → folds to the same two dimensions.
const lpMatch = [
  { adjType: 'FicoRateAdjustment', valueMilli: 300, reason: 'FICO' },
  { adjType: 'cltv', valueMilli: 150, reason: 'CLTV' },
  { adjType: 'DscrRateAdjustment', valueMilli: 50, reason: 'DSCR' },
  { adjType: 'LoanAmountRateAdjustment', valueMilli: -100, reason: 'loan amount' },
];
const rMatch = reconcileLlpas(ourAdj, lpMatch);
ok(rMatch.agree === true && rMatch.worstDeltaMilli === 0, 'a matching rung: every dimension reconciles (LP\'s 3 credit items sum to our one cell)');
ok(rMatch.itemized.find((x) => x.dimension === 'fico_cltv_dscr').lpMilli === 500, 'LP fico+cltv+dscr summed to 500 under the one fico_cltv_dscr key');

// ---- the case a STACK TOTAL check MISSES: two offsetting cell errors --------
// Ours total = 500 + (-200) = 300.  LP total = 300 + 0 = 300.  TOTAL AGREES, per-dimension does NOT.
const ourOffset = [
  { dimension: 'fico_cltv_dscr', adjMilli: 500 },
  { dimension: 'loan_amount', adjMilli: -200 },
];
const lpOffset = [
  { adjType: 'FicoRateAdjustment', valueMilli: 300 },
  { adjType: 'LoanAmountRateAdjustment', valueMilli: 0 },
];
const ourTot = ourOffset.reduce((s, a) => s + a.adjMilli, 0);
const lpTot = lpOffset.reduce((s, a) => s + a.valueMilli, 0);
ok(ourTot === lpTot, 'the offsetting case: the STACK TOTALS are equal (300 == 300) — a total check would pass');
const rOff = reconcileLlpas(ourOffset, lpOffset);
ok(rOff.agree === false, '…but reconcileLlpas FAILS it (two cell errors that cancel in the total)');
// The deltas are MAGNITUDE deltas (see reconcileLlpas: Lender Price publishes no direction on an
// itemized line, so comparing our signed value against its magnitude flagged every credit in the book —
// 8,344 lines on the live battery, all `ours === -lp`). loan_amount is ours −200 vs LP 0, which is a
// 200-magnitude adjustment we apply and LP does not, so its delta reads +200 rather than the −200 this
// assertion expected while the comparison was signed. The property under test is unchanged and still
// holds: two cell errors that CANCEL in the stack total are still caught per dimension.
ok(rOff.itemized.find((x) => x.dimension === 'fico_cltv_dscr').deltaMilli === 200
  && rOff.itemized.find((x) => x.dimension === 'loan_amount').deltaMilli === 200,
  'both offending dimensions are itemized with their real magnitude deltas (+200 / +200)');
ok(rOff.itemized.find((x) => x.dimension === 'loan_amount').ourSignedMilli === -200,
  '…and our SIGNED value rides along, so a reader still sees the direction we applied');

// ---- LP PUBLISHES A MAGNITUDE, SO A CREDIT MUST NOT READ AS A DISAGREEMENT -------------------------
// This is the defect that took the live battery from 82.71% to 20.34% — and it appeared only AFTER the
// sheet's signs were CORRECTED, because the pre-rebuild sheet made every value positive and collided
// with LP's magnitudes by accident. Direction is NOT knowable here; it is proven on the composed PRICE
// in test-lt-ppe-deephaven-dscr-sheet.js. Do not re-add a signed comparison.
{
  const rCredit = reconcileLlpas(
    [{ dimension: 'fico_cltv_dscr', adjMilli: -1000 }, { dimension: 'state', adjMilli: 375 }],
    [{ adjType: 'FicoRateAdjustment', valueMilli: 1000, reason: 'DSCR (All) - 780+ / CLTV To 50.0%' },
      { adjType: 'StatesRateAdjustment', valueMilli: 375, reason: 'Other - State of DC, MA, NJ, NY' }]);
  ok(rCredit.agree === true, 'a CREDIT of 1.000 against LP\'s magnitude 1.000 AGREES (it used to read as a 2.000 gap)');
  ok(rCredit.itemized.find((x) => x.dimension === 'fico_cltv_dscr').ourSignedMilli === -1000,
    '…while still recording that OUR value was a credit');
  ok(rCredit.itemized.credits === 1, 'and the credit is COUNTED, so a book that silently loses every credit is visible');
  // A real size disagreement is still caught — magnitude-blind is not value-blind.
  const rWrong = reconcileLlpas([{ dimension: 'fico_cltv_dscr', adjMilli: -1250 }],
    [{ adjType: 'FicoRateAdjustment', valueMilli: 1000 }]);
  ok(rWrong.agree === false && rWrong.itemized[0].deltaMilli === 250,
    'a credit of the WRONG SIZE still disagrees (1.250 vs 1.000 → +0.250)');
}

// ---- ESCROW WAIVER HAS ITS OWN adjType, MEASURED LIVE ---------------------------------------------
// `EscrowWaiverRateAdjustment`, not SimpleRateAdjustment — so the reason-keyed branch never saw it and
// every escrow line fell through to `other:<reason>`, reporting ours EXTRA and LP's MISSING with the
// same 250 on both sides (140 lines on the live battery).
{
  // Required locally: the file's own `deephavenLpDimension` binding is declared further down, and a
  // temporal-dead-zone ReferenceError here would CRASH the suite — which several harnesses report as
  // something other than a clean failure (this repo's own rule: a crashing test also "fails", and looks
  // like proof).
  const { deephavenLpDimension: dimOf } = require('../src/longterm/ppe/ratesheet-agreement-diff');
  const dim = dimOf({ adjType: 'EscrowWaiverRateAdjustment', reason: 'Other - Escrow Waiver / CLTV >65.01 % <= 70.0 %' });
  ok(dim === 'escrow_waiver', `LP's own EscrowWaiverRateAdjustment keys to escrow_waiver (got ${dim})`);
  // Through the DEEPHAVEN classifier — the one the agreement runner injects as opts.dimensionOf. The
  // default `lpLlpaDimension` deliberately does not know this investor's adjTypes.
  const rEsc = reconcileLlpas([{ dimension: 'escrow_waiver', adjMilli: 250 }],
    [{ adjType: 'EscrowWaiverRateAdjustment', valueMilli: 250, reason: 'Other - Escrow Waiver / CLTV >65.01 % <= 70.0 %' }],
    { dimensionOf: dimOf });
  ok(rEsc.agree === true, '…so our escrow line and LP\'s reconcile instead of double-reporting');
  // The fail-safe itself must stay: an adjType nobody has measured still SURFACES rather than merging.
  const unknown = dimOf({ adjType: 'SomeBrandNewRateAdjustment', reason: 'Other - Something New' });
  ok(unknown === null, 'an UNMEASURED adjType still returns null so it surfaces as a disagreement — the fail-safe is not loosened');
}

// ---- one-sided LLPAs -------------------------------------------------------
const rMissing = reconcileLlpas([{ dimension: 'loan_amount', adjMilli: -100 }], [{ adjType: 'StatesRateAdjustment', valueMilli: 250 }]);
ok(rMissing.itemized.find((x) => x.dimension === 'state').status === 'llpa_missing_ours', 'an LP LLPA we lack → llpa_missing_ours');
ok(rMissing.itemized.find((x) => x.dimension === 'loan_amount').status === 'llpa_extra_ours', 'an LLPA we have that LP lacks → llpa_extra_ours');
const rUnknown = reconcileLlpas([], [{ adjType: 'WeirdThing', valueMilli: 40, reason: 'Weird Thing' }]);
ok(rUnknown.itemized[0].dimension === 'other:weirdthing', 'an unknown LP adjType is keyed other:<reason>, never merged');

// ---- boundsProbe: cap / floor ----------------------------------------------
ok(boundsProbe({ finalPriceMilli: 103100, floorMilli: 98000, capMilli: null, clamped: false }, 103100).agree === true,
  'unclamped, same final price → agree');
ok(boundsProbe({ finalPriceMilli: 103100, clamped: false }, 103099).agree === false,
  'a 1-milli final-price difference → disagree (to the penny)');
ok(boundsProbe({ finalPriceMilli: 98000, floorMilli: 98000, capMilli: 106000, clamped: true }, 98000).agree === true,
  'clamped to the FLOOR, LP landed on the same 98000 → agree + clamp faithful');
ok(boundsProbe({ finalPriceMilli: 106000, floorMilli: 98000, capMilli: 106000, clamped: true }, 106000).agree === true,
  'clamped to the CAP, LP landed on the same 106000 → agree');
ok(boundsProbe({ finalPriceMilli: 104000, floorMilli: 98000, capMilli: 106000, clamped: true }, 104000).agree === false,
  'clamped but the final is neither cap nor floor → NOT faithful (our bound is a coincidence)');

// ---- PROVEN TO FAIL: mutate one cell by 125 milli --------------------------
const good = reconcileLlpas(ourAdj, lpMatch);
const mutated = reconcileLlpas([{ dimension: 'fico_cltv_dscr', adjMilli: 500 + 125 }, { dimension: 'loan_amount', adjMilli: -100 }], lpMatch);
ok(good.agree === true && mutated.agree === false, 'PROVEN-TO-FAIL: a 125-milli cell error flips agree true→false');
ok(mutated.itemized.filter((x) => x.deltaMilli !== 0).length === 1
  && mutated.itemized.find((x) => x.dimension === 'fico_cltv_dscr').deltaMilli === 125,
  '…and EXACTLY one dimension (fico_cltv_dscr, +125) is flagged — the control stays green');

// ---- the REASON-AWARE Deephaven classifier + reconcile opts (live 2026-08-17) ------------------
const { deephavenLpDimension } = require('../src/longterm/ppe/ratesheet-agreement-diff');
ok(deephavenLpDimension({ adjType: 'FicoRateAdjustment', reason: 'DSCR (All) - 780+ / CLTV >65.01 % <= 70.0 %' }) === 'fico_cltv_dscr', 'Deephaven: FicoRateAdjustment "DSCR (All)" → fico_cltv_dscr');
ok(deephavenLpDimension({ adjType: 'FicoRateAdjustment', reason: 'Other - Cash Out Refinance, FICO >= 720 / CLTV ...' }) === 'cashout', 'Deephaven: FicoRateAdjustment "Cash Out" → cashout (NOT the FICO cell)');
ok(deephavenLpDimension({ adjType: 'SimpleRateAdjustment', reason: 'DSCR Ratio - DSCR >= 1.25 / CLTV ...' }) === 'dscr', 'Deephaven: SimpleRateAdjustment "DSCR Ratio" → dscr (separate, not folded into the FICO cell)');
ok(deephavenLpDimension({ adjType: 'SimpleRateAdjustment', reason: '5 Year Prepay Penalty' }) === 'prepay', 'Deephaven: SimpleRateAdjustment "5 Year Prepay" → prepay');
ok(deephavenLpDimension({ adjType: 'StatesRateAdjustment', reason: 'Other - State of DC, MA, NJ, NY / CLTV ...' }) === 'state', 'Deephaven: StatesRateAdjustment → state');
ok(deephavenLpDimension({ adjType: 'AllCondoRateAdjustment', reason: 'Other - Condo / CLTV >60.01 % <= 65.0 %' }) === 'property_type', 'Deephaven: AllCondoRateAdjustment → property_type');
ok(deephavenLpDimension({ adjType: 'UnitRateAdjustment', reason: 'Other - 2-4 Units / CLTV >65.01 % <= 70.0 %' }) === 'units', 'Deephaven: UnitRateAdjustment → units');

// our real grid keeps fico / dscr / state SEPARATE — reconcile with the reason-aware classifier
const ourDh = [
  { dimension: 'fico_cltv_dscr', adjMilli: 125, reason: 'FICO 780 × CLTV 70' },
  { dimension: 'dscr', adjMilli: 250, reason: 'DSCR ≥1.25' },
  { dimension: 'state', adjMilli: 375, reason: 'NY' },
];
const lpDh = [
  { adjType: 'FicoRateAdjustment', reason: 'DSCR (All) - 780+ / CLTV >65.01 % <= 70.0 %', valueMilli: 125 },
  { adjType: 'SimpleRateAdjustment', reason: 'DSCR Ratio - DSCR >= 1.25 / CLTV >65.01 % <= 70.0 %', valueMilli: 250 },
  { adjType: 'StatesRateAdjustment', reason: 'Other - State of DC, MA, NJ, NY / CLTV >65.01 % <= 70.0 %', valueMilli: 375 },
];
const rDh = reconcileLlpas(ourDh, lpDh, { dimensionOf: deephavenLpDimension });
ok(rDh.agree === true, 'Deephaven reconcile: our separate fico/dscr/state each line up with LP itemized (agree)');
// the DEFAULT classifier would FOLD dscr into fico_cltv_dscr and DISAGREE — proving the classifier matters
const rFolded = reconcileLlpas(ourDh, lpDh);
ok(rFolded.agree === false, '…and the default adjType-only crosswalk would MIS-fold and disagree (why the classifier is needed)');

// opts.ignore drops a not-yet-modelled axis (prepay) so it is not counted as a disagreement
const lpWithPrepay = [...lpDh, { adjType: 'SimpleRateAdjustment', reason: '5 Year Prepay Penalty', valueMilli: 625 }];
ok(reconcileLlpas(ourDh, lpWithPrepay, { dimensionOf: deephavenLpDimension }).agree === false, 'an unignored prepay line disagrees (we do not model prepay yet)');
ok(reconcileLlpas(ourDh, lpWithPrepay, { dimensionOf: deephavenLpDimension, ignore: ['prepay'] }).agree === true, 'opts.ignore:["prepay"] drops the unmodelled axis → the modelled dimensions still agree');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
