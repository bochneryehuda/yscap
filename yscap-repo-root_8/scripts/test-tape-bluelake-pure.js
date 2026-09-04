'use strict';
/**
 * Pure (no-DB) test for the Blue Lake Bid Tape:
 *   · column mapping / valid-value coercion + the derived disbursement snapshot,
 *   · per-row FORMULA cells (Completion %, Total Project Costs, LTAIV/LTC/LTARV)
 *     with the row number substituted, and row-adjusted formulas in bulk,
 *   · style INHERITANCE from the sample row (no hardcoded styles),
 *   · byte-for-byte fidelity (only the Bid Tape sheet + the calc flag change),
 *   · the capital-provider rule.
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { unzip } = require('../src/lib/zip');
const { fillXlsxTemplate } = require('../src/lib/tapes/xlsx-template');
const bluelake = require('../src/lib/tapes/bluelake');
const registry = require('../src/lib/tapes/registry');
const buyerRule = require('../src/lib/tapes/buyer-rule');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tapes', 'templates', 'bluelake.xlsx'));
const SHEET = 'xl/worksheets/sheet1.xml';
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

function synthLoan(overrides = {}) {
  return Object.assign({
    found: true,
    app: {
      ys_loan_number: 'YSCAP258134727', investor_loan_number: null,
      program: 'Fix & Flip', loan_type: 'Purchase', rehab_type: 'heavy',
      property_type: 'SFR', property_address: {}, units: 1,
      purchase_price: 350000, as_is_value: 350000, arv: 500000, rehab_budget: 75000,
      loan_amount: 350000, rate_pct: 10.29, term: '6 months', requested_ir_amount: 0,
      accrual_type: 'non_dutch', rental_income: 0, costs_already_paid: 0,
      sqft_pre: 2867, sqft_post: 2867, acquisition_date: '2025-12-31',
      actual_closing: '2025-12-31', est_closing_date: '2025-12-31',
      first_payment_date: '2026-02-01', maturity_date: '2027-01-01',
    },
    fico: 764,
    address: { line1: '123 Main St', city: 'Midland', state: 'Texas', zip: '07104' },
    borrower: { first: 'John', last: 'Doe', citizenship: 'US Citizen', fico: 764 },
    coBorrower: null,
    vesting: { llc: '123 LLC' },
    registration: { total_loan: 350000 },
    quote: { noteRate: 0.1029, origPct: 0.025, sizing: { totalLoan: 350000, initialAdvance: 275000, rehabHoldback: 75000, financedReserve: 0 } },
    appraisal: { effective_date: '2025-12-15', as_is_value: 350000, arv_value: 500000, units: 1 },
    exp: { verifiedTotal: 2, total: 2 },
    repeatBorrower: true,
    noteBuyerRaw: 'Blue Lake',
    supplemental: {},
  }, overrides);
}
const cellOf = (loan, col) => bluelake.buildRow(loan).find((c) => c.col === col);

// ---- 1. mapping / coercion -------------------------------------------------
const loan = synthLoan();
ok(bluelake.buildRow(loan).length === 70, 'maps 70 Bid Tape columns (B..BS)');
ok(cellOf(loan, 'D').value === 'YSCAP258134727', 'D loan id = our loan number');
ok(cellOf(loan, 'F').value === '123 LLC', 'F borrowing entity = vesting llc');
ok(cellOf(loan, 'K').value === 'Purchase', 'K loan type coerced');
ok(cellOf(loan, 'L').value === 'N', 'L new-construction flag N for a flip');
ok(cellOf(loan, 'O').value === 'TX', 'O state normalized Texas → TX');
ok(cellOf(loan, 'P').value === '07104' && cellOf(loan, 'P').type === 's', 'P zip kept as text (leading zero safe)');
ok(cellOf(loan, 'Q').value === 'SFR', 'Q property type coerced');
ok(cellOf(loan, 'T').value === 275000, 'T day-1 = initial advance');
ok(cellOf(loan, 'U').value === 75000, 'U holdback');
ok(cellOf(loan, 'V').value === 0, 'V interest reserve');
ok(cellOf(loan, 'W').value === 350000, 'W total loan');
ok(cellOf(loan, 'X').value === 0 && cellOf(loan, 'Y').value === 75000, 'X disbursed=0, Y undisbursed=holdback at origination');
ok(cellOf(loan, 'AB').value === 275000 && cellOf(loan, 'AD').value === 275000, 'AB disbursed / AD UPB = day-1 at origination');
ok(cellOf(loan, 'AC').value === 275000, 'AC interest-bearing = disbursed for non-Dutch');
ok(cellOf(loan, 'J').value === 0, 'J holdback-in-escrow = 0 for non-Dutch');

// ---- 1b. Seasoned loan: draws + reserve move X/Y/Z/AA/AC/AD/AW --------------
const seasoning = require('../src/lib/tapes/seasoning');
const bs = synthLoan();
bs.app.rate_pct = 12; bs.app.actual_closing = '2026-01-01'; bs.app.first_payment_date = '2026-03-01';
bs.registration = { total_loan: 370000 };
bs.quote = { noteRate: 0.12, origPct: 0.025, sizing: { totalLoan: 370000, initialAdvance: 275000, rehabHoldback: 75000, financedReserve: 20000 } };
bs.fundingDate = '2026-01-01';
bs.releases = [{ date: '2026-04-01', amount: 25000 }];
bs.seasoning = seasoning.computeSeasoning(seasoning.seasoningInputs(bs, '2026-07-01'));
ok(cellOf(bs, 'T').value === 275000, 'seasoned: T day-1 stays at origination');
ok(cellOf(bs, 'U').value === 75000, 'seasoned: U holdback stays at origination');
ok(cellOf(bs, 'V').value === 20000, 'seasoned: V interest reserve stays at origination');
ok(cellOf(bs, 'X').value === 25000, 'seasoned: X disbursed holdback = released draws');
ok(cellOf(bs, 'Y').value === 50000, 'seasoned: Y undisbursed holdback = 75k − 25k');
ok(cellOf(bs, 'Z').value > 0 && cellOf(bs, 'Z').value < 20000, 'seasoned: Z disbursed reserve between 0 and the financed reserve');
ok(cellOf(bs, 'AA').value < 20000 && cellOf(bs, 'AA').value > 0, 'seasoned: AA undisbursed reserve dropped');
ok(cellOf(bs, 'AD').value > 275000, 'seasoned: AD UPB rose above the day-1 advance');
ok(cellOf(bs, 'AC').value === cellOf(bs, 'AD').value, 'seasoned non-Dutch: AC interest-bearing = UPB');
ok(cellOf(bs, 'AW').value === '2026-07-01', 'seasoned: AW next due advanced to the current payment');
ok(cellOf(bs, 'AT').value === '2026-03-01', 'seasoned: AT first payment date unchanged');
// Dutch: interest-bearing = whole note; escrow holdback = undisbursed holdback.
const bd = synthLoan();
bd.app.rate_pct = 12; bd.app.accrual_type = 'dutch'; bd.app.actual_closing = '2026-01-01'; bd.app.first_payment_date = '2026-03-01';
bd.registration = { total_loan: 370000 };
bd.quote = { noteRate: 0.12, origPct: 0.025, sizing: { totalLoan: 370000, initialAdvance: 275000, rehabHoldback: 75000, financedReserve: 20000 } };
bd.fundingDate = '2026-01-01'; bd.releases = [{ date: '2026-04-01', amount: 25000 }];
bd.seasoning = seasoning.computeSeasoning(seasoning.seasoningInputs(bd, '2026-07-01'));
ok(cellOf(bd, 'AC').value === 370000, 'seasoned Dutch: AC interest-bearing = whole note');
ok(cellOf(bd, 'J').value === 50000, 'seasoned Dutch: J holdback-in-escrow = undisbursed holdback');
ok(cellOf(loan, 'AX').value === 'N', 'AX dutch flag N');
ok(cellOf(loan, 'AZ').value === 0.1029, 'AZ interest rate as fraction');
ok(cellOf(loan, 'BE').value === 764, 'BE fico');
ok(cellOf(loan, 'BG').value === 2, 'BG guarantor track record = verified exits');
ok(cellOf(loan, 'BH').value === 'Full', 'BH recourse default Full');
ok(cellOf(loan, 'AY').value === '30/360', 'AY interest days method default 30/360');
ok(cellOf(loan, 'BJ').value === 'Sell', 'BJ exit strategy Sell for a flip');
ok(cellOf(loan, 'BF').value === 'N', 'BF foreign national N for US citizen');
ok(cellOf(loan, 'BQ').value === 'John Doe', 'BQ guarantor name');
ok(cellOf(loan, 'AM').value === '2025-12-15', 'AM appraisal date = effective date');

// coercion variants
const dutchRefi = synthLoan({ app: Object.assign({}, synthLoan().app, { accrual_type: 'dutch', loan_type: 'Refinance Cash-Out', program: 'Ground-Up Construction', rental_income: 1500 }) });
ok(cellOf(dutchRefi, 'AX').value === 'Y', 'dutch flag Y');
ok(cellOf(dutchRefi, 'K').value === 'Cashout', 'cash-out refi → Cashout');
ok(cellOf(dutchRefi, 'L').value === 'Y', 'ground-up → new construction flag Y');
ok(cellOf(dutchRefi, 'I').value === 'N', 'tenant income → non-cashflowing flag N');
ok(cellOf(dutchRefi, 'J').value === 75000, 'dutch → holdback funded in escrow = holdback');
ok(cellOf(dutchRefi, 'AC').value === 350000, 'dutch → interest-bearing = total loan');
ok(cellOf(dutchRefi, 'BJ').value === 'Sell', 'ground-up exit Sell');
const tri = synthLoan({ app: Object.assign({}, synthLoan().app, { property_type: '3 unit', units: 3 }) });
ok(cellOf(tri, 'Q').value === 'Triplex', '3-unit → Triplex');
const fourNoUnits = synthLoan({ app: Object.assign({}, synthLoan().app, { property_type: 'Fourplex', units: null }) });
ok(cellOf(fourNoUnits, 'Q').value === 'Fourplex', 'Fourplex with missing units stays Fourplex (not Duplex)');
// FICO = the PRIMARY guarantor's score, not the pricing GREATEST-of-both.
const primaryFico = synthLoan(); primaryFico.borrower.fico = 712; primaryFico.fico = 800;
ok(cellOf(primaryFico, 'BE').value === 712, 'BE = primary guarantor FICO (not GREATEST)');

// formula cells carry a {r} template formula AND a cached computed value (so the
// ratio/total DISPLAYS in a viewer that doesn't recalculate — the actual initial
// LTV / LTC / final (after-repair) LTV). value is now { f, v }.
ok(cellOf(loan, 'AE').type === 'f' && cellOf(loan, 'AE').value.f === 'IFERROR(X{r}/U{r},"")', 'AE completion % is a formula');
ok(cellOf(loan, 'AE').value.v === 0, 'AE cached completion % = 0 at origination (0 of 75k holdback disbursed)');
ok(cellOf(loan, 'AJ').type === 'f' && cellOf(loan, 'AJ').value.f === 'AF{r}+AH{r}', 'AJ total project costs is a formula');
ok(cellOf(loan, 'AJ').value.v === 425000, 'AJ cached total project costs = 350k purchase + 75k rehab');
ok(cellOf(loan, 'AN').type === 'f' && cellOf(loan, 'AO').type === 'f' && cellOf(loan, 'AP').type === 'f', 'AN/AO/AP ratios are formulas');
// The three underwriting ratios now carry the ACTUAL cached value (owner-directed).
ok(Math.abs(cellOf(loan, 'AN').value.v - 275000 / 350000) < 1e-12, 'AN cached Initial LTV = day-1 275k ÷ AIV 350k');
ok(Math.abs(cellOf(loan, 'AO').value.v - 350000 / 425000) < 1e-12, 'AO cached LTC = total 350k ÷ cost 425k');
ok(cellOf(loan, 'AP').value.v === 0.7, 'AP cached Final LTV = total 350k ÷ ARV 500k = 0.7');
// A missing denominator (no ARV) → no cached value (cell keeps just its formula).
const noArv = synthLoan(); noArv.app.arv = null; noArv.appraisal = { arv_value: null };
ok(cellOf(noArv, 'AP').value.v == null, 'AP cached value omitted when ARV is missing (no pre-cached #DIV/0!)');

// Blue-Lake-completes columns are blank; Borrower Liquidity intentionally blank
ok(cellOf(loan, 'BA').value === '' && cellOf(loan, 'BB').value === '', 'Purchase Rate / Lender Spread left for Blue Lake');
ok(cellOf(loan, 'BD').value === '', 'Borrower Liquidity left blank (owner-directed)');
ok(cellOf(loan, 'BC').value === 0.025 && cellOf(loan, 'BC').type === 'n', 'BC Total Points = origination fee % (from quote.origPct)');

/* THE PROGRAM MINIMUM ORIGINATION FEE (owner-directed 2026-09-04, db/696). Column BC is a
   PERCENTAGE, so on a loan the floor binds on the stated rate is not what the borrower paid — the
   owner, asked directly: *"Send them a higher percentage, according to how much this is the real
   percentage for $2,500."* The effective figure comes from the quote's own explain block, never
   recomputed here, so the tape and the term sheet can never disagree about one fee. */
{
  const minLoan = synthLoan();
  minLoan.quote = {
    noteRate: 0.1029, origPct: 0.0125,
    sizing: { totalLoan: 144000, initialAdvance: 110000, rehabHoldback: 34000, financedReserve: 0 },
    closingCosts: {
      origination: 2500,
      originationMinimum: { amount: 2500, pctAmount: 1800, pct: 0.0125, minimum: 2500, shortfall: 700, effectivePct: 2500 / 144000 },
    },
  };
  ok(Math.abs(cellOf(minLoan, 'BC').value - 2500 / 144000) < 1e-12,
    'BC sends the REAL percentage when the program minimum bound, not the stated 1.25%');
  ok(cellOf(minLoan, 'BC').value > 0.0125, '  …and it is HIGHER than the stated rate, which is the point');

  /* BYTE-IDENTICAL where the floor never reached — and asserted on a quote that CARRIES the block
     unbound as well as on one that lacks it entirely, because those are two different code paths
     and only one of them is exercised by every existing file. */
  const plain = synthLoan();
  plain.quote = { ...minLoan.quote, closingCosts: { origination: 1800 } };
  ok(cellOf(plain, 'BC').value === 0.0125, 'BC is unchanged on a loan the minimum never reaches');
}
ok(cellOf(loan, 'E').value === 'YS Capital Group', 'E Seller = our company name');
ok(cellOf(loan, 'C').value === 'Y', 'C Pre-Approval Flag always flagged (owner-directed)');
ok(cellOf(loan, 'AI').value === null, 'AI Cost Incurred to Date blank for now (owner-directed)');

// ---- 2. fill: fidelity + formulas + inherited styles -----------------------
const out = fillXlsxTemplate(TEMPLATE, { sheetPart: SHEET, firstRow: 3, rows: [bluelake.buildRow(loan)], lastCol: 'BS', inheritStyles: true });
const oParts = unzip(TEMPLATE); const nParts = unzip(out);
const changed = oParts.filter((op) => !nParts.find((x) => x.name === op.name).data.equals(op.data)).map((p) => p.name).sort();
// styles.xml joins the changed set since the display-precision fix (2026-08-24):
// the rate/points/ratio cells declare display formats, which APPEND cloned
// styles — every pre-existing style survives untouched (test-tape-rate-precision
// pins the append-only property; here we pin that nothing ELSE changed).
assert.deepStrictEqual(changed, ['xl/styles.xml', 'xl/workbook.xml', SHEET], `ONLY Bid Tape + workbook + appended styles changed, got: ${changed.join(', ')}`);
passed++;
const sx = nParts.find((p) => p.name === SHEET).data.toString('utf8');
ok(/<c r="T3" s="18"><v>275000<\/v><\/c>/.test(sx), 'T3 number injected WITH the sample row style (inherited)');
// AE3 carries a RESOLVED style now — a clone of the sample row's s=5 with the
// two-decimal ratio format (the sample's own 0% displayed whole percents).
const ae3 = /<c r="AE3" s="(\d+)"><f>IFERROR\(X3\/U3,""\)<\/f><v>0<\/v><\/c>/.exec(sx);
ok(ae3 && Number(ae3[1]) >= 64, 'AE3 formula + cached 0, {r}=3, resolved (appended) display style');
ok(/<c r="AJ3"[^>]*><f>AF3\+AH3<\/f><v>425000<\/v><\/c>/.test(sx), 'AJ3 total-project-costs formula + cached 425000');
// The actual underwriting ratios are emitted as cached values on the filled row so
// they display without a recalculation (the reported fix).
ok(/<c r="AN3"[^>]*><f>T3\/AK3<\/f><v>0\.785714285714/.test(sx), 'AN3 (Initial LTV) carries the actual cached ratio');
ok(/<c r="AO3"[^>]*><f>W3\/AJ3<\/f><v>0\.82352941176/.test(sx), 'AO3 (LTC) carries the actual cached ratio');
ok(/<c r="AP3"[^>]*><f>W3\/AL3<\/f><v>0\.7<\/v><\/c>/.test(sx), 'AP3 (Final LTV) carries the actual cached ratio');
ok(/<c r="P3"[^>]*t="inlineStr"><is><t[^>]*>07104<\/t>/.test(sx), 'P3 zip stays text (leading zero preserved)');
ok(nParts.find((p) => p.name === 'xl/workbook.xml').data.toString('utf8').indexOf('fullCalcOnLoad="1"') > -1, 'workbook recalcs on open');
ok(/<dimension ref="A1:CD99"\/>/.test(sx), 'dimension not shrunk — keeps the template end column CD (never-shrink on both axes)');
// the logo drawing + hidden calc tabs are untouched (not in the changed list)
ok(nParts.find((p) => p.name === 'xl/drawings/drawing1.xml') && nParts.find((p) => p.name === 'xl/media/image1.png'), 'logo drawing + image preserved');

// ---- 3. bulk: row-adjusted formulas ---------------------------------------
const bulk = fillXlsxTemplate(TEMPLATE, { sheetPart: SHEET, firstRow: 3, rows: [bluelake.buildRow(synthLoan()), bluelake.buildRow(synthLoan())], lastCol: 'BS', inheritStyles: true });
const bx = unzip(bulk).find((p) => p.name === SHEET).data.toString('utf8');
ok(/<c r="AE3"[^>]*><f>IFERROR\(X3\/U3,""\)<\/f>/.test(bx) && /<c r="AE4"[^>]*><f>IFERROR\(X4\/U4,""\)<\/f>/.test(bx), 'bulk formulas reference each own row (row 3 and row 4)');
ok(/<c r="AN4"[^>]*><f>T4\/AK4<\/f>/.test(bx), 'row-4 LTAIV formula references row 4');
ok(/<row r="3"[^>]*>/.test(bx) && /<row r="4"[^>]*>/.test(bx), 'bulk wrote rows 3 and 4');

// ---- 4. registry + buyer rule ---------------------------------------------
ok(registry.getTape('bluelake') === bluelake, 'registry resolves bluelake');
ok(registry.listTapes().length >= 2 && registry.listTapes().some((t) => t.key === 'bluelake') && registry.listTapes().some((t) => t.key === 'fidelis'), 'both tapes registered');
ok(registry.tapesForBuyer('bluelake').length === 1 && registry.tapesForBuyer('bluelake')[0].key === 'bluelake', 'tapesForBuyer(bluelake)=bluelake');
ok(buyerRule.buyerMatches(loan, bluelake) === true, 'Blue Lake loan matches Blue Lake tape');
ok(buyerRule.buyerMatches(loan, registry.getTape('fidelis')) === false, 'Blue Lake loan does NOT match Fidelis tape');
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Fidelis' }), bluelake) === false, 'Fidelis loan does NOT match Blue Lake tape');
// A registered Gold (Blue Lake) loan: the Blue Lake tape is available, Fidelis isn't.
const avail = buyerRule.tapeAvailability('bluelake', 'Blue Lake', { isAdmin: false, registeredProgram: 'gold' });
ok(avail.find((t) => t.key === 'bluelake').available === true && avail.find((t) => t.key === 'fidelis').available === false, 'availability: bluelake yes, fidelis no');

console.log(`test-tape-bluelake-pure: OK (${passed} assertions)`);
