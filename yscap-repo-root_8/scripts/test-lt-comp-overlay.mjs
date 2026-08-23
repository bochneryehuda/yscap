// LONG-TERM PRICING ENGINE — the compensation overlay's money rules (owner-directed 2026-08-23).
//
// The spec is the owner's own worked rows, spoken in the message that ordered the build, so the
// expected figures below are DERIVED from those sentences — never copied from a failing run:
//
//   · lender-paid 2.0: raw 102 shows 100 (par, no origination); raw 103 shows 101 and the
//     borrower receives a 1.000 credit; raw 101 shows 99 and the borrower pays a buydown.
//     (The dictation said "1.4" on that last row; the rule as stated — subtract the comp,
//     then measure from 100 — gives 1.000, and the flag is with the owner.)
//   · borrower-paid 2.0 at raw 99: "two points borrower paid origination and one point buydown".
//   · YSP 0.25 at raw 100.25: shows 100, the fee list carries the origination only, and the
//     YSP itself is invisible.
//   · the waive takes the $1,595 + $500 out in CASH: "if it's a $100[k] loan, then this
//     deduction is more than two points, but if it's a $1 million loan, then the deduction is
//     less than [about] 0.2 points".
//
// Runs with no bundler and no browser: compOverlay.js is plain ESM.

import {
  COMP_MODES, DEFAULT_COMP_MODE, DEFAULT_COMP_PLAN,
  normalizePlan, compShiftPoints, shiftedPrice, shiftBuild, quoteCharges,
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
  eq(lineOf(c, 'buydown').points, 1, 'E13 a 1.000 buydown — the stated rule’s own arithmetic (the "1.4" was flagged)');
  eq(lineOf(c, 'buydown').dollars, 3500, 'E14 $3,500 of buydown on $350k');
  eq(c.borrowerPaysDollars, 5595, 'E15 buydown + the two fees');
}

console.log('\nF. the waive — cash off the credit, then onto the buydown');
{
  const c = quoteCharges('lenderPaid', PLAN, 103, LOAN, true);
  ok(!lineOf(c, 'applicationFee') && !lineOf(c, 'commitmentFee'),
    'F1 the two fee lines do not populate — "it should not populate as fees"');
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

if (bad) { console.error(`\n${bad} FAILED`); process.exit(1); }
console.log('\nall passed');
