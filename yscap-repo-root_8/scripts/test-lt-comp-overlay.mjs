// LONG-TERM PRICING ENGINE — the compensation overlay's money rules (owner-directed 2026-08-23).
//
// The spec is the owner's own worked rows, spoken in the message that ordered the build, so the
// expected figures below are DERIVED from those sentences — never copied from a failing run:
//
//   · lender-paid 2.0: raw 102 shows 100 (par, no origination); raw 103 shows 101 and the
//     borrower receives a 1.000 credit; raw 101 shows 99 and the borrower pays a buydown.
//     (The dictation said "1.4" on that last row; the owner confirmed 2026-08-23 it was a
//     slip of language — the rule as stated gives 1.000.)
//   · borrower-paid 2.0 at raw 99: "two points borrower paid origination and one point buydown".
//   · YSP 0.25 at raw 100.25: shows 100, the fee list carries the origination only, and the
//     YSP itself is invisible.
//   · the waive takes the $1,595 + $500 out in CASH: "if it's a $100[k] loan, then this
//     deduction is more than two points, but if it's a $1 million loan, then the deduction is
//     less than [about] 0.2 points".
//
// Runs with no bundler and no browser: compOverlay.js is plain ESM.

import { readFileSync } from 'node:fs';
import {
  COMP_MODES, DEFAULT_COMP_MODE, DEFAULT_COMP_PLAN,
  normalizePlan, compShiftPoints, shiftedPrice, shiftBuild, quoteCharges, closingSheet,
} from '../app-v2/src/longterm/compOverlay.js';

let bad = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad += 1; console.error(`  FAIL ${label}`); }
};
const eq = (a, b, label) => ok(Object.is(a, b), `${label} (${JSON.stringify(a)} vs ${JSON.stringify(b)})`);

const PLAN = { lenderPaid: 2, borrowerPaid: 2, ysp: 0, applicationFee: 1595, commitmentFee: 500 };
const LOAN = 350000;
const lineOf = (c, key) => c.lines.find((l) => l.key === key) || null;

console.log('\nA. the switch itself');
eq(COMP_MODES.map((m) => m.value).join(','), 'borrowerPaid,raw,lenderPaid',
  'A1 three positions, raw in the middle — the owner drew the order');
eq(DEFAULT_COMP_MODE, 'raw', 'A2 the default is raw pricing');

console.log('\nB. the plan is normalized or refused whole');
ok(normalizePlan(PLAN) !== null, 'B1 a complete plan is accepted');
ok(normalizePlan({ ...PLAN, lenderPaid: undefined }) === null, 'B2 a missing figure refuses the WHOLE plan');
ok(normalizePlan({ ...PLAN, ysp: -1 }) === null, 'B3 a negative figure refuses the whole plan');
ok(normalizePlan({ ...PLAN, applicationFee: 'abc' }) === null, 'B4 an unreadable fee refuses the whole plan');
ok(normalizePlan(null) === null, 'B5 no plan is no plan');
ok(normalizePlan({ ...PLAN, lenderPaid: '2.25' }).lenderPaid === 2.25, 'B6 a numeric string reads as its number');

console.log('\nC. the shift per position');
eq(compShiftPoints('raw', null), 0, 'C1 raw shifts by zero even with NO plan — the identity');
eq(compShiftPoints('lenderPaid', PLAN), 2, 'C2 lender-paid shifts by the lender-paid comp');
eq(compShiftPoints('borrowerPaid', PLAN), 0, 'C3 borrower-paid shifts by the YSP (default zero)');
eq(compShiftPoints('borrowerPaid', { ...PLAN, ysp: 0.25 }), 0.25, 'C4 …and by a set YSP');
ok(compShiftPoints('lenderPaid', null) === null, 'C5 no plan → null — CANNOT overlay, never a silent 0');
ok(compShiftPoints('nonsense', PLAN) === null, 'C6 an unknown position answers null, never a guess');

console.log('\nD. shifted prices');
eq(shiftedPrice(102, 2), 100, 'D1 raw 102 at lender-paid 2 shows 100 — par, the owner’s first row');
eq(shiftedPrice(103, 2), 101, 'D2 raw 103 shows 101');
eq(shiftedPrice(101, 2), 99, 'D3 raw 101 shows 99');
eq(shiftedPrice(100.25, 0.25), 100, 'D4 raw 100.25 at YSP 0.25 shows 100 — the owner’s YSP row');
ok(shiftedPrice(null, 2) === null, 'D5 no price stays no price');
ok(shiftedPrice(102, null) === null, 'D6 no shift yields no price — never raw-passed by accident');
eq(shiftedPrice(99.876, 0.001), 99.875, 'D7 rounded to a thousandth, the rate-sheet convention');

console.log('\nE. lender-paid charges — the owner’s three rows');
{
  const c = quoteCharges('lenderPaid', PLAN, 102, LOAN, false);
  eq(c.displayPrice, 100, 'E1 raw 102 → par');
  ok(!lineOf(c, 'origination'), 'E2 no origination line in lender-paid — the investor pays the comp');
  ok(!lineOf(c, 'buydown') && !c.credit, 'E3 par: no buydown, no credit');
  eq(lineOf(c, 'applicationFee').dollars, 1595, 'E4 the $1,595 application fee');
  eq(lineOf(c, 'commitmentFee').dollars, 500, 'E5 the $500 commitment fee');
  eq(c.borrowerPaysDollars, 2095, 'E6 the borrower pays the two lender fees');
  eq(c.netDollars, 2095, 'E7 net: pays $2,095');
}
{
  const c = quoteCharges('lenderPaid', PLAN, 103, LOAN, false);
  eq(c.displayPrice, 101, 'E8 raw 103 → 101');
  eq(c.credit && c.credit.points, 1, 'E9 the borrower receives a 1.000 credit — the owner’s row');
  eq(c.credit && c.credit.dollars, 3500, 'E10 …which is $3,500 on a $350k loan');
  eq(c.netDollars, -1405, 'E11 net: $3,500 back minus $2,095 of fees = $1,405 to the borrower');
}
{
  const c = quoteCharges('lenderPaid', PLAN, 101, LOAN, false);
  eq(c.displayPrice, 99, 'E12 raw 101 → 99');
  eq(lineOf(c, 'buydown').points, 1, 'E13 a 1.000 buydown — the owner confirmed the "1.4" was a slip; 1.000 is the rule');
  eq(lineOf(c, 'buydown').dollars, 3500, 'E14 $3,500 of buydown on $350k');
  eq(c.borrowerPaysDollars, 5595, 'E15 buydown + the two fees');
}

console.log('\nF. the waive — cash off the credit, then onto the buydown');
{
  const c = quoteCharges('lenderPaid', PLAN, 103, LOAN, true);
  // ⛔ THIS ASSERTION WAS RE-POINTED, NOT LOOSENED (2026-08-30). It used to read
  // `!lineOf(c,'applicationFee')` — the line ABSENT. Its stated subject has always
  // been the owner's *"it should not populate as fees"*: the borrower must not be
  // CHARGED them. The owner then asked, on the term sheet, to *"list out the lender
  // fees, because the next one, you're waiving the lender fees — you need to be able
  // to see the difference"*, so the line is now LISTED at zero and marked waived.
  // Both instructions hold at once, and what is asserted here is strictly MORE than
  // before: the lines exist, they are marked waived, they carry $0, they carry what
  // they WOULD have been, and they contribute nothing to what the borrower pays.
  const appFee = lineOf(c, 'applicationFee');
  const commFee = lineOf(c, 'commitmentFee');
  ok(!!appFee && !!commFee,
    'F1 both fee lines are LISTED — a waived column with two fewer rows hides the saving');
  ok(appFee.waived === true && commFee.waived === true,
    'F1a …each marked waived, so no surface can read the 0 as "this program has no such fee"');
  eq(appFee.dollars, 0, 'F1b the application fee does not populate AS A FEE');
  eq(commFee.dollars, 0, 'F1c …nor does the commitment fee');
  eq(appFee.fullDollars, 1595, 'F1d …while carrying what it would have been, so the saving is visible');
  eq(commFee.fullDollars, 500, 'F1e …and the same for the commitment fee');
  eq(c.waivedDollars, 2095, 'F2 $2,095 waived');
  eq(c.credit && c.credit.dollars, 1405, 'F3 the credit absorbs it: $3,500 − $2,095 = $1,405');
  eq(c.netDollars, -1405, 'F4 net unchanged by the waive — the same money, said once');
}
{
  const c = quoteCharges('lenderPaid', PLAN, 102, LOAN, true);
  eq(lineOf(c, 'buydown').dollars, 2095, 'F5 at par the waive lands whole on the buydown — "it increases his buy-down with this 2095"');
  eq(lineOf(c, 'buydown').points, 0.599, 'F6 …with CASH-derived points, so points and dollars can never disagree');
}
{
  const c = quoteCharges('lenderPaid', PLAN, 102.3, LOAN, true);
  ok(!c.credit, 'F7 a credit smaller than the fees is used up…');
  eq(lineOf(c, 'buydown').dollars, 1045, 'F8 …and only the SHORTFALL lands on the buydown ($2,095 − $1,050)');
}
{
  const small = quoteCharges('lenderPaid', PLAN, 102, 100000, true);
  const big = quoteCharges('lenderPaid', PLAN, 102, 1000000, true);
  eq(lineOf(small, 'buydown').points, 2.095, 'F9 on a $100k loan the waive is MORE than two points — the owner’s scale check');
  eq(lineOf(big, 'buydown').points, 0.21, 'F10 on a $1M loan it is about a fifth of a point');
}
{
  const c = quoteCharges('borrowerPaid', PLAN, 103, LOAN, true);
  ok(!!lineOf(c, 'applicationFee'), 'F11 the waive flag is IGNORED in borrower-paid — no waive option there');
}

console.log('\nG. borrower-paid charges');
{
  const c = quoteCharges('borrowerPaid', PLAN, 99, LOAN, false);
  eq(c.displayPrice, 99, 'G1 the board keeps the raw price (no YSP)');
  eq(lineOf(c, 'origination').points, 2, 'G2 two points origination — the comp charged as a fee');
  eq(lineOf(c, 'origination').dollars, 7000, 'G3 $7,000 on $350k');
  eq(lineOf(c, 'buydown').points, 1, 'G4 …and one point buydown at 99 — the owner’s own sentence');
  eq(c.borrowerPaysDollars, 12595, 'G5 origination + buydown + the two fees');
}
{
  const c = quoteCharges('borrowerPaid', { ...PLAN, ysp: 0.25 }, 100.25, LOAN, false);
  eq(c.displayPrice, 100, 'G6 raw 100.25 with a 0.25 YSP shows 100');
  ok(!!lineOf(c, 'origination') && !lineOf(c, 'buydown') && !c.credit,
    'G7 the fee list carries the origination only');
  ok(!JSON.stringify(c).toLowerCase().includes('ysp'), 'G8 the YSP is INVISIBLE in the answer');
  ok(!JSON.stringify(c).toLowerCase().includes('compensation'), 'G9 …and so is the word compensation');
}

console.log('\nH. the overlay refuses rather than guesses');
ok(quoteCharges('raw', PLAN, 102, LOAN, false) === null, 'H1 raw mode has no charging story of ours');
ok(quoteCharges('lenderPaid', null, 102, LOAN, false) === null, 'H2 no plan → no fee list');
ok(quoteCharges('lenderPaid', PLAN, null, LOAN, false) === null, 'H3 no raw price → no fee list');
ok(quoteCharges('lenderPaid', PLAN, 102, null, false) === null, 'H4 no loan amount → no fee list — cash needs a loan');
ok(quoteCharges('lenderPaid', PLAN, 102, 0, false) === null, 'H5 a zero loan is not a loan');

console.log('\nI. the drill-down build shifts consistently');
{
  const b = { basePoints: -3, adjustmentPoints: 1, adjustedPoints: -2, price: 102, extra: 'kept' };
  const s2 = shiftBuild(b, 2);
  eq(s2.basePoints, -1, 'I1 the BASE moves by the shift — "they show the base price higher"');
  eq(s2.adjustedPoints, 0, 'I2 adjusted points move with it');
  eq(s2.price, 100, 'I3 the final price moves down by the same amount');
  eq(s2.adjustmentPoints, 1, 'I4 the LLPA total is UNTOUCHED — the lines still sum');
  ok(Math.abs((s2.adjustedPoints - s2.basePoints) - (b.adjustedPoints - b.basePoints)) < 1e-9,
    'I5 base→adjusted gap preserved, so the on-screen arithmetic still adds up');
  eq(s2.extra, 'kept', 'I6 everything else rides through untouched');
  ok(shiftBuild(b, 0) === b, 'I7 shift zero returns the build IDENTICALLY — raw is the identity');
  ok(shiftBuild(b, null) === b, 'I8 an unreadable shift changes nothing');
}

console.log('\nJ. the fallback plan constant mirrors the declared settings');
// DEFAULT_COMP_PLAN documents the seeded figures; the server suite (test-lt-comp-plan.mjs)
// compares it against the DECLARED settings defaults so the two can never drift. Here: shape.
ok(normalizePlan(DEFAULT_COMP_PLAN) !== null, 'J1 the documented default plan is itself valid');
eq(DEFAULT_COMP_PLAN.applicationFee, 1595, 'J2 $1,595 application fee');
eq(DEFAULT_COMP_PLAN.commitmentFee, 500, 'J3 $500 commitment fee');

console.log('\nK. the closing sheet — totals summed FROM the charge list (owner-directed 2026-08-23)');
// The spec is the owner's sentence: "Cash to close needs to include the down payment percentage
// down plus all the closing cost fees, origination fees, and lender fees." Every figure below is
// derived from that sentence and the charge rows already proven above — never from a failing run.
{
  // Borrower-paid at raw 99 on a $500k purchase with a $350k loan: origination $7,000 +
  // buydown $3,500 + fees $2,095 = $12,595 closing cost; down payment $150,000 (30% down);
  // cash to close $162,595.
  const c = quoteCharges('borrowerPaid', PLAN, 99, LOAN, false);
  const s = closingSheet(c, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN });
  eq(s.originationDollars, 7000, 'K1 total origination = the origination line');
  eq(s.lenderFeesDollars, 2095, 'K2 total lender fees = application + commitment');
  eq(s.buydownDollars, 3500, 'K3 the buydown is carried');
  eq(s.closingCostDollars, 12595, 'K4 final closing cost = every charge, totalled');
  eq(s.downPaymentDollars, 150000, 'K5 down payment = value − loan on a purchase');
  eq(s.downPaymentPct, 30, 'K6 …with the percentage-down the owner asked to see');
  eq(s.cashToCloseDollars, 162595, 'K7 cash to close = down payment + closing cost + origination + lender fees');
}
{
  // Lender-paid above par: the CREDIT reduces cash to close — that is what a credit is on
  // every closing statement. Raw 103 → credit $3,500, fees $2,095 → net −$1,405.
  const c = quoteCharges('lenderPaid', PLAN, 103, LOAN, false);
  const s = closingSheet(c, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN });
  eq(s.originationDollars, 0, 'K8 no origination in lender-paid — 0, not a phantom line');
  eq(s.closingCostDollars, -1405, 'K9 the credit nets the closing cost negative');
  eq(s.cashToCloseDollars, 148595, 'K10 …and reduces cash to close below the bare down payment');
}
{
  // A REFINANCE has no down payment — the row is null, never a fabricated $0, and cash to
  // close is simply the net closing cost.
  const c = quoteCharges('lenderPaid', PLAN, 102, LOAN, false);
  const s = closingSheet(c, { purpose: 'Refinance', propertyValue: 500000, loanAmount: LOAN });
  ok(s.downPaymentDollars === null, 'K11 no down payment on a refinance');
  eq(s.cashToCloseDollars, 2095, 'K12 cash to close = the closing cost alone');
}
{
  // The waive flows through: fees 0, and the sheet still reconciles with the charge list.
  const c = quoteCharges('lenderPaid', PLAN, 102, LOAN, true);
  const s = closingSheet(c, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN });
  eq(s.lenderFeesDollars, 0, 'K13 waived lender fees total 0');
  eq(s.closingCostDollars, c.netDollars, 'K14 the sheet total IS the charge list net — one source');
}
{
  // Unreadable inputs refuse rather than guess: no charges → no sheet; a loan bigger than the
  // value is a data problem, never a negative down payment.
  ok(closingSheet(null, { purpose: 'Purchase', propertyValue: 500000, loanAmount: LOAN }) === null,
    'K15 no charge list → no sheet');
  const c = quoteCharges('lenderPaid', PLAN, 102, LOAN, false);
  const s = closingSheet(c, { purpose: 'Purchase', propertyValue: 300000, loanAmount: LOAN });
  ok(s.downPaymentDollars === null, 'K16 loan over value → no down-payment row, never a negative');
  const s2 = closingSheet(c, { purpose: 'Purchase', propertyValue: null, loanAmount: LOAN });
  ok(s2.downPaymentDollars === null && s2.cashToCloseDollars === s2.closingCostDollars,
    'K17 no value → no down payment; cash to close falls back to the closing cost');
}

console.log('\nL. the board never prints a waived fee as a row of $0.00');
{
  // ⛔ NO UNIT TEST OF THE OVERLAY CAN SEE THE SCREEN. `quoteCharges` LISTS a waived
  // line at dollars:0 because the TERM SHEET must show it (the owner asked to see the
  // difference against the option beside it). The staff pricing board renders the same
  // array, and drawing that line raw prints "Application fee $0.00" — which reads as
  // "this program has no application fee", the opposite of the truth. That board
  // already answers the question better, with its "Lender fees waived — $X taken out
  // of the figures above in cash" note, so it FILTERS the waived rows rather than
  // drawing them. test-lt-pricer-screen-render R79 proves it in a real render; this
  // pins the filter at the source, where the reason lives.
  const src = readFileSync(new URL('../app-v2/src/longterm/LtPricer.jsx', import.meta.url), 'utf8')
    // Strip comments first: the note explaining this rule necessarily names the very
    // strings asserted below, so a guard that read comments would pass on prose alone.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const list = src.slice(src.indexOf('export function ChargeList'));
  const body = list.slice(0, list.indexOf('\nexport '));
  ok(/charges\.lines\.filter\(\(l\) => l\.waived !== true\)/.test(body),
    'L1 ChargeList draws only the lines that were actually charged');
  ok(/shownLines\.map/.test(body),
    'L2 …and maps THAT list, so no waived row can reach the screen');
  ok(/shownLines\.length === 0/.test(body),
    'L3 …and the "none" fallback keys off the drawn list, not the raw one');
  ok(/waivedDollars > 0/.test(body) && /Lender fees waived/.test(body),
    'L4 …with the waive summarised instead, so the saving is still on the screen');
}

if (bad) { console.error(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall passed');
