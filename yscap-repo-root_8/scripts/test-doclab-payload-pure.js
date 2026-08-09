#!/usr/bin/env node
'use strict';
/**
 * DOCLAB PAYLOAD BUILDER — pure. No database, no network.
 *
 * Two things are being guarded here, and both are about what ends up PRINTED on a
 * recorded document:
 *
 *  1. FORMATTING IS CORRECTNESS. DocLab merges these strings straight into a Word
 *     template, so `$487500`, `2026-09-15` or `11.25%` appearing on a note is a
 *     defect, not a cosmetic issue. The date helpers are also where the classic
 *     timezone bug lives — `new Date('2026-09-15')` renders as the 14th anywhere
 *     west of Greenwich, and this repo has already been bitten by exactly that.
 *
 *  2. NOTHING IS EVER FABRICATED. A value PILOT does not have must be absent from
 *     the payload AND named in `missing`. DocLab requires only three fields and
 *     accepts everything else as optional, so an invented or silently-omitted value
 *     does not bounce — it produces a mortgage with a blank in it.
 */

const assert = require('assert');
const payload = require('../src/doclab/payload');
const { money, pct, longDate, lastDayOfMonth, plusOneYear, ymd, addressLine } = payload._internals;

let pass = 0;
function ok(what) { pass++; console.log('  ✓', what); }

/** A realistic bridge-rehab file, complete enough to submit. */
function file(over = {}) {
  return Object.assign({
    entityName: 'MW Trading LLC',
    entityState: 'New York',
    vestsIndividually: false,
    borrowerAddress: { line1: '12 Main St', city: 'Brooklyn', state: 'NY', zip: '11219' },
    entityMembers: [{ name: 'Moses Weil' }],
    guarantors: [{ name: 'Moses Weil', address: { line1: '12 Main St', city: 'Brooklyn', state: 'NY', zip: '11219' } }],
    pledgors: [{ name: 'Moses Weil', address: { line1: '12 Main St', city: 'Brooklyn', state: 'NY', zip: '11219' } }],
    propertyAddress: { line1: '117 Brook Ave', city: 'Passaic', state: 'NJ', zip: '07055' },
    propertyCounty: 'Passaic',
    loanNumber: 'YSCAP258134629',
    noteRate: 11.25,
    closingDate: '2026-09-15',
    firstPaymentDate: '2026-11-01',
    maturityDate: '2027-10-01',
    quote: {
      sizing: { totalLoan: 487500, initialAdvance: 337500, rehabHoldback: 150000, financedReserve: 0, monthlyPayment: 4570.31 },
      cashToClose: 112000,
      closingCosts: { origination: 9750 },
    },
    fees: [],
  }, over);
}
const LENDER = { name: 'YS Capital Group LLC', templateLenderName: 'YS Capital', address: '1 Main St, Lakewood, NJ 08701' };
const OPTS = { loanCategory: '12 Month with Holdback' };

console.log('\nA. formatting — what the document will actually say');
{
  assert.strictEqual(money(487500), '$487,500', 'a whole amount carries no cents');
  assert.strictEqual(money(4570.31), '$4,570.31', 'a fractional amount keeps both digits');
  assert.strictEqual(money(4570.3), '$4,570.30', 'and pads to two, never one');
  assert.strictEqual(money(0), '$0', 'a real zero is a value, not a gap');
  assert.strictEqual(money(null), null);
  assert.strictEqual(money(''), null);
  assert.strictEqual(money('not a number'), null, 'junk is never printed as $NaN');
  ok('money prints the way a loan document prints it');

  assert.strictEqual(pct(11.25), '11.25', 'no percent sign — their own comment says so');
  assert.strictEqual(pct(6), '6');
  assert.strictEqual(pct(null), null);
  ok('a rate is a bare number');

  assert.strictEqual(longDate('2026-09-15'), 'September 15, 2026');
  assert.strictEqual(longDate('2026-01-01'), 'January 1, 2026', 'the first of January must not slip to December');
  assert.strictEqual(longDate('2026-12-31'), 'December 31, 2026', 'and the last of December must not slip to January');
  assert.strictEqual(longDate(null), null);
  assert.strictEqual(longDate('nonsense'), null);
  assert.strictEqual(longDate('2026-13-01'), null, 'an impossible month is refused, not wrapped');
  ok('a calendar date never shifts by a day and never wraps a year');

  assert.strictEqual(lastDayOfMonth('2026-02-10'), 'February 28, 2026');
  assert.strictEqual(lastDayOfMonth('2028-02-10'), 'February 29, 2028', 'a leap year is a real February 29');
  assert.strictEqual(lastDayOfMonth('2026-09-01'), 'September 30, 2026');
  ok('the per-diem accrual date is the real last day of that month');

  assert.strictEqual(plusOneYear('2026-11-01'), 'November 1, 2027');
  assert.strictEqual(plusOneYear('2028-02-29'), 'February 28, 2029',
    'a leap day one year on has to land on a day that exists');
  ok('a year on lands on a date that exists');

  assert.strictEqual(addressLine({ line1: '12 Main St', city: 'Brooklyn', state: 'NY', zip: '11219' }),
    '12 Main St, Brooklyn, NY 11219');
  assert.strictEqual(addressLine({ city: 'Brooklyn', state: 'NY' }), null,
    'a partial address must be refused, never flattened into ", Brooklyn, NY"');
  assert.strictEqual(addressLine('12 Main St, Brooklyn, NY 11219'), '12 Main St, Brooklyn, NY 11219');
  assert.strictEqual(addressLine(null), null);
  ok('a half-known address is reported missing rather than printed');

  assert.deepStrictEqual(ymd('2026-09-15'), { y: 2026, m: 9, d: 15 });
  assert.strictEqual(ymd('15/09/2026'), null, 'only the calendar-string form is accepted');
  ok('dates are parsed by hand, never through the Date constructor');
}

console.log('\nB. a complete file builds a submittable request');
{
  const r = payload.buildPayload(file(), LENDER, OPTS);
  assert.strictEqual(r.canSubmit, true);
  assert.strictEqual(r.payload.template.lender_name, 'YS Capital');
  assert.strictEqual(r.payload.template.loan_category, '12 Month with Holdback');
  assert.strictEqual(r.payload.template.state, 'NJ', 'the template state is the PROPERTY state');
  assert.strictEqual(r.payload.prepayment_option_code, 'RTL-No');
  const v = r.payload.variables;
  assert.strictEqual(v.loan_amount, '$487,500');
  assert.strictEqual(v.construction_holdback, '$150,000');
  assert.strictEqual(v.interest_rate, '11.25');
  assert.strictEqual(v.date_of_closing, 'September 15, 2026');
  assert.strictEqual(v.last_day_of_the_month, 'September 30, 2026');
  assert.strictEqual(v.maturity_date, 'October 1, 2027');
  assert.strictEqual(v.maturity_date_of_loan, 'October 1, 2027', 'both spellings carry the same date');
  ok('the money, the rate and every date land in DocLab’s own format');

  assert.strictEqual(v.borrowers.length, 1);
  assert.strictEqual(v.borrowers[0].borrower_name, 'MW Trading LLC', 'the BORROWER is the entity, not the person');
  assert.strictEqual(v.borrowers[0].borrower_state, 'New York', 'and its state is where it was FORMED');
  assert.strictEqual(v.borrowers[0].signatories[0].signatory_name, 'Moses Weil');
  assert.strictEqual(v.guarantors[0].guarantor_name, 'Moses Weil', 'the human guarantees it');
  assert.strictEqual(v.collateral_properties[0].collateral_property_state, 'NJ');
  ok('the entity borrows, the person guarantees, and the property is in its own state');

  // Their Template Selection page insists on these inside `variables` too, and their
  // own master payload sends a single space.
  assert.strictEqual(v.state, ' ');
  assert.strictEqual(v.loan_category, ' ');
  assert.ok(Array.isArray(v.pre_payment_penalty) && v.pre_payment_penalty.length === 1,
    'the array is required even when the option does not use it — their words');
  ok('the quirks of their payload are reproduced exactly, not tidied up');
}

console.log('\nC. a personal-name purchase');
{
  const r = payload.buildPayload(file({
    vestsIndividually: true, entityName: null, entityState: null, borrowerName: 'Moses Weil',
  }), LENDER, OPTS);
  assert.strictEqual(r.payload.variables.borrowers[0].borrower_name, 'Moses Weil');
  ok('with no entity, the person is the borrower');
}

console.log('\nD. nothing is ever fabricated');
{
  const r = payload.buildPayload(file({
    propertyCounty: null, loanNumber: null, closingDate: null,
    quote: { sizing: {}, closingCosts: {} },
  }), LENDER, OPTS);
  const v = r.payload.variables;
  for (const k of ['collateral_property_county', 'loan_id', 'date_of_closing', 'loan_amount',
    'month_of_closing', 'year_for_notary_block', 'last_day_of_the_month']) {
    assert.ok(!(k in v), `${k} must be ABSENT when unknown, not blank or invented`);
  }
  const named = new Set(r.missing.map((m) => m.key));
  for (const k of ['collateral_property_county', 'loan_id', 'date_of_closing', 'loan_amount']) {
    assert.ok(named.has(k), `${k} is missing and must be reported as missing`);
  }
  for (const m of r.missing) {
    assert.ok(m.reason && m.reason.length > 10, `${m.key} is reported missing with no explanation`);
  }
  ok('an unknown value is absent from the payload and named, with a reason, in `missing`');

  // A derived value must not appear out of an absent source.
  assert.ok(!('first_day_of_month_plus_1_year' in payload.buildPayload(
    file({ firstPaymentDate: null }), LENDER, OPTS).payload.variables),
    'a derived date must not be invented from a missing one');
  ok('a derived value disappears with its source');

  // The lender's own facts are configuration; without them they are missing too.
  const bare = payload.buildPayload(file(), { templateLenderName: 'YS Capital' }, OPTS);
  assert.ok(bare.missing.some((m) => m.key === 'lender_name'),
    'the lending entity name is not guessed from anywhere');
  ok('the lender name is never guessed');
}

console.log('\nE. the three template fields are the only fatal ones');
{
  const noCat = payload.buildPayload(file(), LENDER, { loanCategory: null });
  assert.strictEqual(noCat.canSubmit, false);
  ok('with no loan category the request is not submittable at all');

  const noState = payload.buildPayload(file({ propertyAddress: { line1: '1 A St', city: 'X' } }), LENDER, OPTS);
  assert.strictEqual(noState.canSubmit, false);
  assert.ok(noState.missing.some((m) => m.key === 'template.state' && m.fatal));
  ok('with no property state DocLab cannot pick an instrument, so it is fatal');

  // Everything else is incomplete, not fatal — that distinction is the point.
  const thin = payload.buildPayload(file({ propertyCounty: null, loanNumber: null }), LENDER, OPTS);
  assert.strictEqual(thin.canSubmit, true);
  assert.ok(thin.missing.length > 0);
  ok('an incomplete package is still submittable, and says what is missing');
}

console.log('\nF. the scope gate cannot be bypassed through the builder');
{
  assert.throws(() => payload.buildPayload(file(), LENDER, { loanCategory: 'DSCR SFR' }),
    /outside the RTL build/i);
  assert.throws(() => payload.buildPayload(file(), LENDER, { loanCategory: 'CEMA DSCR' }));
  ok('a DSCR category cannot be built into a payload at all');

  // And the code that goes out is always the no-penalty one.
  for (const state of [null, [{ optionCode: 'RTL-No' }, { optionCode: 'RTL-Yes' }]]) {
    const r = payload.buildPayload(file(), LENDER, Object.assign({}, OPTS, { prepaymentAllowed: state }));
    assert.strictEqual(r.payload.prepayment_option_code, 'RTL-No');
  }
  ok('an RTL package always asks for no prepayment penalty');

  // A state that does not offer RTL-No: no code is sent, and it is said out loud.
  const odd = payload.buildPayload(file(), LENDER,
    Object.assign({}, OPTS, { prepaymentAllowed: [{ optionCode: 'DSCR-3/2/1' }] }));
  assert.ok(!('prepayment_option_code' in odd.payload));
  assert.ok(odd.warnings.some((w) => w.code === 'prepayment_unresolved'));
  ok('a state without a no-penalty option warns rather than picking one');
}

console.log('\nG. the fees');
{
  const r = payload.buildPayload(file({
    fees: [
      { feeTemplate: 'Origination Fee', amount: 9750 },
      { feeTemplate: 'Legal Fee', amount: 1500 },
      { name: 'Radon Testing', amount: 2000 },
      { name: 'Finders Fee', amount: 10000 },
    ],
  }), LENDER, OPTS);
  const fees = r.payload.variables.fees;
  assert.strictEqual(fees.single_fee.length, 2, 'the two templated fees keep their own paragraphs');
  assert.strictEqual(fees.multiple_fees.length, 1, 'everything else rides ONE Standard Fee group');
  assert.strictEqual(fees.multiple_fees[0].fee.length, 2);

  // sort_order is ONE sequence across BOTH arrays — their master payload numbers
  // seven single fees 1-7 and the multiple-fee group 8. Getting this wrong reorders
  // the fee paragraphs in the loan agreement.
  const orders = fees.single_fee.map((f) => f.sort_order).concat(fees.multiple_fees.map((f) => f.sort_order));
  assert.deepStrictEqual(orders, [1, 2, 3], 'sort_order runs across both arrays, not per array');
  ok('templated fees stay single, everything else groups, and sort_order is one sequence');

  assert.strictEqual(payload.buildFees({ fees: [] }), null, 'no fees is silence, not an empty structure');
  assert.strictEqual(payload.buildFees({ fees: [{ name: 'X', amount: null }] }), null,
    'a fee with no amount is not a fee');
  ok('nothing is claimed about fees the file does not have');
}

console.log('\nH. readiness reports the template’s own gaps');
{
  const r = payload.buildPayload(file(), LENDER, OPTS);
  assert.strictEqual(r.readiness.matrixKnown, true);
  assert.ok(r.readiness.blocked.length > 0);

  const gu = payload.buildPayload(file(), LENDER, { loanCategory: 'Ground Up Construction' });
  assert.strictEqual(gu.readiness.matrixKnown, false);
  assert.ok(gu.warnings.some((w) => w.code === 'matrix_unknown'),
    'a template we have no field list for must say so, not pass quietly');
  ok('a template with no published field list warns instead of looking complete');
}

console.log(`\nAll ${pass} DocLab payload checks passed.\n`);
