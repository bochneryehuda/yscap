'use strict';
/**
 * Pure (no-DB) test for the EMCAP data tape:
 *   · the 38-column A..AL map (values + Excel types + template style indices),
 *   · the estimated-rental-income + acquisition-loan (purchase-money) columns,
 *   · the SEASONING current-rehab / current-balance columns,
 *   · byte-for-byte template fidelity (only the data sheet + workbook calc flag),
 *   · the capital-provider (buyer) rule keyed on normNoteBuyer('EMCAP').
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { unzip } = require('../src/lib/zip');
const { fillXlsxTemplate } = require('../src/lib/tapes/xlsx-template');
const emcap = require('../src/lib/tapes/emcap');
const seasoning = require('../src/lib/tapes/seasoning');
const registry = require('../src/lib/tapes/registry');
const buyerRule = require('../src/lib/tapes/buyer-rule');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tapes', 'templates', 'emcap.xlsx'));
const SHEET = 'xl/worksheets/sheet1.xml';
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

function synthLoan(overrides = {}) {
  return Object.assign({
    found: true,
    app: {
      ys_loan_number: 'YSCAP-EM-1', investor_loan_number: null,
      program: 'Fix & Hold', loan_type: 'Purchase', rehab_type: 'moderate',
      property_type: 'SFR', property_address: {}, units: 1,
      purchase_price: 300000, as_is_value: 310000, arv: 450000, rehab_budget: 80000,
      loan_amount: 360000, rate_pct: 10.5, term: '12 months',
      requested_ir_amount: 12000, accrual_type: 'non_dutch',
      estimated_rental_income: 2500, sqft_post: 1800,
      actual_closing: '2026-01-01', first_payment_date: '2026-03-01', maturity_date: '2027-02-01',
    },
    fico: 720,
    address: { line1: '5 Rental Rd', city: 'Dayton', state: 'Ohio', zip: '45402' },
    borrower: { first: 'Rhonda', last: 'Renter', fico: 720 },
    coBorrower: null,
    vesting: { llc: '5 Rental LLC' },
    registration: { total_loan: 360000, note_rate: 0.105 },
    quote: { noteRate: 0.105, sizing: { totalLoan: 360000, initialAdvance: 268000, rehabHoldback: 80000, financedReserve: 12000 } },
    appraisal: { form_type: 'FNM1025', beds: 3, baths_full: 2, baths_half: 1, gla: 1750, units: 1, as_is_value: 310000, arv_value: 450000 },
    exp: { total: 5, verifiedTotal: 3 },
    repeatBorrower: false,
    noteBuyerRaw: 'EMCAP',
    supplemental: {},
  }, overrides);
}
const cellOf = (loan, col) => emcap.buildRow(loan).find((c) => c.col === col);

// ---- 1. column mapping / types / styles ------------------------------------
const loan = synthLoan();
ok(emcap.buildRow(loan).length === 38, 'maps 38 columns (A..AL)');
ok(cellOf(loan, 'A').value === 'YSCAP-EM-1', 'A loan number');
ok(cellOf(loan, 'B').value === '5 Rental LLC', 'B borrowing entity = vesting llc');
ok(cellOf(loan, 'C').value === 'Rhonda Renter', 'C guarantor');
ok(cellOf(loan, 'E').value === '', 'E county left blank (owner-directed)');
ok(cellOf(loan, 'G').value === 'OH', 'G state normalized Ohio → OH');
ok(cellOf(loan, 'H').value === '45402' && cellOf(loan, 'H').type === 's' && cellOf(loan, 'H').style === 10, 'H zip is text, style 10');
ok(cellOf(loan, 'I').value === 'Fix and Hold', 'I strategy label');
ok(cellOf(loan, 'J').value === 360000 && cellOf(loan, 'J').style === 2, 'J total loan, currency style 2');
ok(cellOf(loan, 'K').value === 80000, 'K original rehab');
ok(cellOf(loan, 'M').value === 12000 && cellOf(loan, 'M').style === 4, 'M interest reserve (original), style 4');
ok(cellOf(loan, 'N').value === 268000 && cellOf(loan, 'N').style === 5, 'N acquisition loan = purchase-money portion (day-1 advance), style 5');
ok(cellOf(loan, 'P').value === 300000, 'P purchase price');
ok(cellOf(loan, 'S').value === 310000 && cellOf(loan, 'T').value === 450000, 'S as-is / T ARV');
ok(cellOf(loan, 'U').value === 2500 && cellOf(loan, 'U').style === 4, 'U Proj. Rental = estimated monthly rent, style 4');
ok(cellOf(loan, 'V').value === 0.105 && cellOf(loan, 'V').type === 'n' && cellOf(loan, 'V').style === 7, 'V note rate as fraction, percent style 7');
ok(cellOf(loan, 'W').value === '2026-01-01' && cellOf(loan, 'W').type === 'd' && cellOf(loan, 'W').style === 6, 'W funding date, date style 6');
ok(cellOf(loan, 'X').value === '2027-02-01' && cellOf(loan, 'X').style === 6, 'X maturity date');
ok(cellOf(loan, 'Y').value === 12 && cellOf(loan, 'Y').style === 8, 'Y term months, integer style 8');
ok(cellOf(loan, 'Z').value === 'Purchase', 'Z purchase/refinance');
ok(cellOf(loan, 'AC').value === 'Drawn', 'AC accrual (non-Dutch → Drawn)');
ok(cellOf(loan, 'AD').value === 5, 'AD borrower total projects completed');
ok(cellOf(loan, 'AE').value === null && cellOf(loan, 'AF').value === null, 'AE/AF not tracked → blank');
ok(cellOf(loan, 'AG').value === 'N', 'AG repeat borrower N');
ok(cellOf(loan, 'AH').value === 720, 'AH FICO');
ok(cellOf(loan, 'AI').value === 3 && cellOf(loan, 'AJ').value === 2.5, 'AI beds / AJ baths (2 full + 1 half = 2.5)');
ok(cellOf(loan, 'AK').value === 1800 && cellOf(loan, 'AK').style === 9, 'AK sqft, style 9');
ok(cellOf(loan, 'AL').value === 1, 'AL units');

// Dutch accrual label + refinance coercion.
const dutchRefi = synthLoan({ app: Object.assign({}, synthLoan().app, { accrual_type: 'dutch', loan_type: 'Refinance Cash-Out' }) });
ok(cellOf(dutchRefi, 'AC').value === 'Note', 'AC accrual (Dutch → Note)');
ok(cellOf(dutchRefi, 'Z').value === 'Refinance', 'Z cash-out refi → Refinance');

// Note rate given as a percent (10.5) → fraction.
const pctRate = synthLoan({ quote: {}, registration: {}, app: Object.assign({}, synthLoan().app, { rate_pct: 9.5 }) });
ok(cellOf(pctRate, 'V').value === 0.095, 'V note rate 9.5 → 0.095 fraction');

// ---- 2. Seasoning: current rehab (L) + current balance (O) move -------------
const s2 = synthLoan();
s2.fundingDate = '2026-01-01';
s2.releases = [{ date: '2026-04-01', amount: 20000 }];
s2.seasoning = seasoning.computeSeasoning(seasoning.seasoningInputs(s2, '2026-07-01'));
ok(cellOf(s2, 'K').value === 80000, 'seasoned: K original rehab stays');
ok(cellOf(s2, 'L').value === 60000, 'seasoned: L current rehab = 80k − 20k released');
ok(cellOf(s2, 'O').value > 268000, 'seasoned: O current balance rose above the day-1 advance');
// A fresh loan (no snapshot) reports origination values.
ok(cellOf(loan, 'L').value === 80000 && cellOf(loan, 'O').value === 268000, 'fresh loan: L=holdback, O=day-1 advance');

// ---- 3. Template fidelity: only the data sheet + workbook calc flag change ---
const out = fillXlsxTemplate(TEMPLATE, { sheetPart: SHEET, firstRow: 2, rows: [emcap.buildRow(loan)], lastCol: 'AL' });
const oParts = unzip(TEMPLATE);
const nParts = unzip(out);
ok(oParts.length === nParts.length, 'same number of zip parts');
const changed = [];
for (const op of oParts) {
  const np = nParts.find((p) => p.name === op.name);
  if (!np || Buffer.compare(op.data, np.data) !== 0) changed.push(op.name);
}
ok(changed.includes(SHEET), 'the data sheet changed');
ok(changed.includes('xl/workbook.xml'), 'workbook.xml changed (calc flag)');
// styles.xml joins the changed set since the display-precision fix (2026-08-24):
// the note-rate cell declares FMT.RATE, which APPENDS a cloned style — every
// pre-existing style survives byte-identical (pinned by test-tape-rate-precision).
ok(changed.includes('xl/styles.xml'), 'styles.xml changed (appended display format)');
ok(changed.length === 3, `ONLY the data sheet + workbook + appended styles changed (got: ${changed.join(', ')})`);
const wb = nParts.find((p) => p.name === 'xl/workbook.xml').data.toString('utf8');
ok(wb.indexOf('fullCalcOnLoad="1"') > -1, 'workbook recalculates on open');
const sheet = nParts.find((p) => p.name === SHEET).data.toString('utf8');
ok(sheet.indexOf('YSCAP-EM-1') > -1, 'data row carries the loan number');
ok(/<c r="J2"[^>]*><v>360000<\/v><\/c>/.test(sheet), 'J2 total loan filled');
ok(/<c r="U2"[^>]*><v>2500<\/v><\/c>/.test(sheet), 'U2 Proj. Rental filled');
ok(/<c r="N2"[^>]*><v>268000<\/v><\/c>/.test(sheet), 'N2 acquisition loan filled');
// Row 1 headers are untouched.
ok(/<row r="1"/.test(sheet), 'header row 1 preserved');

// ---- 4. Capital-provider (buyer) rule --------------------------------------
ok(buyerRule.buyerMatches(synthLoan(), emcap) === true, 'an EMCAP loan matches the EMCAP tape');
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Fidelis' }), emcap) === false, 'a Fidelis loan does not match the EMCAP tape');
let mm = null;
try { buyerRule.assertBuyer(synthLoan({ noteBuyerRaw: 'Blue Lake' }), emcap); } catch (e) { mm = e; }
ok(mm && mm.code === 'buyer_mismatch', 'assertBuyer throws buyer_mismatch for a non-EMCAP loan');

// ---- 5. Registry ------------------------------------------------------------
ok(registry.getTape('emcap') === emcap, 'registry resolves the emcap tape');
ok(registry.listTapes().some((t) => t.key === 'emcap' && t.name === 'EMCAP'), 'emcap appears in the public tape list');
ok(registry.tapesForBuyer('emcap').length === 1, 'one tape for the emcap buyer key');

// ---- 6. New-construction supplemental (ground-up) --------------------------
const gu = synthLoan({ app: Object.assign({}, synthLoan().app, { program: 'Ground-Up Construction', rehab_type: 'ground' }) });
ok(emcap.isNewConstruction(gu) === true, 'ground-up loan flagged new construction');
ok(emcap.missingSupplemental(gu).length === 4, 'ground-up asks the 4 supplemental fields');
ok(emcap.missingSupplemental(loan).length === 0, 'a fix-and-hold loan asks nothing');
gu.supplemental = { build_status: 'Framing', asset_purchased: 'Finished Lot', entitlement_status: 'Fully Entitled', lot_purchase_date: '2026-01-15' };
ok(cellOf(gu, 'AB').value === 'Framing' && cellOf(gu, 'R').value === 'Finished Lot', 'NC fields fill AB / R for a ground-up loan');
ok(cellOf(loan, 'AB').value === '' && cellOf(loan, 'R').value === '', 'NC fields blank on a non-NC loan');
const cleaned = emcap.sanitizeSupplemental({ build_status: 'BOGUS', asset_purchased: 'Land', lot_purchase_date: '2026-13-40' });
ok(!('build_status' in cleaned) && cleaned.asset_purchased === 'Land' && !('lot_purchase_date' in cleaned), 'sanitize drops invalid select + impossible date');

console.log(`test-tape-emcap-pure: OK (${passed} assertions)`);
