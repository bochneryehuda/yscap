'use strict';
/**
 * Pure (no-DB) test for the Fidelis data-tape foundation:
 *   · the generic xlsx template filler keeps every OTHER sheet byte-for-byte
 *     identical (only the Data Tape sheet + the workbook calc flag change),
 *   · the Fidelis column map coerces our fields to the sheet's valid values and
 *     types, and computes the derived economics (OOP rehab, note-rate fraction…),
 *   · the capital-provider rule matches on the normalized note-buyer key,
 *   · a bulk tape writes one row per loan and widens the dropdown ranges.
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { unzip } = require('../src/lib/zip');
const { fillXlsxTemplate, toExcelSerial } = require('../src/lib/tapes/xlsx-template');
const fidelis = require('../src/lib/tapes/fidelis');
const registry = require('../src/lib/tapes/registry');
const buyerRule = require('../src/lib/tapes/buyer-rule');

const TEMPLATE = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'tapes', 'templates', 'fidelis.xlsx'));
const SHEET = 'xl/worksheets/sheet5.xml';
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

function synthLoan(overrides = {}) {
  return Object.assign({
    found: true,
    app: {
      ys_loan_number: 'YSCAP-2201', investor_loan_number: 'FID-90',
      program: 'Fix & Flip w/ Construction', loan_type: 'Purchase', rehab_type: 'heavy',
      property_type: '2-4 Family', property_address: {}, units: 2,
      purchase_price: 400000, as_is_value: 410000, arv: 650000, rehab_budget: 120000,
      loan_amount: 480000, rate_pct: 10.75, term: '12 months',
      requested_ir_amount: 24000, is_assignment: true, assignment_fee: 15000,
      accrual_type: 'non_dutch', sqft_pre: 1800, sqft_post: 2200,
      est_closing_date: '2026-08-15', first_payment_date: '2026-10-01', maturity_date: '2027-08-15',
    },
    fico: 738,
    address: { line1: '742 Evergreen Terrace', city: 'Springfield', state: 'Illinois', zip: '02108', oneLine: '' },
    borrower: { first: 'Jane', last: "O'Brien", citizenship: 'US Citizen', fico: 738 },
    coBorrower: { first: 'John', last: 'Smith', fico: 700, citizenship: 'permanent resident' },
    vesting: { llc: '742 Evergreen LLC' },
    officer: { name: 'LO' },
    registration: { total_loan: 480000, note_rate: 0.1075 },
    quote: { noteRate: 0.1075, sizing: { totalLoan: 480000, initialAdvance: 360000, rehabHoldback: 120000, financedReserve: 24000 } },
    appraisal: { form_type: 'FNM1004', as_is_value: 410000, arv_value: 650000, units: 2, gla: 1850, beds: 4, baths_full: 2, baths_half: 1 },
    exp: { flips: 3, holds: 1, ground: 0, total: 4, verified: { flips: 3, holds: 1, ground: 0 }, verifiedTotal: 4 },
    repeatBorrower: true,
    noteBuyerRaw: 'Fidelis',
  }, overrides);
}

function cellOf(loan, col) {
  return fidelis.buildRow(loan).find((c) => c.col === col);
}

// ---- 1. Excel date serial math --------------------------------------------
ok(toExcelSerial('2026-08-15') === 46249, `date serial 2026-08-15 = ${toExcelSerial('2026-08-15')}`);
ok(toExcelSerial('1899-12-31') === 1, 'date serial day 1 correct');
ok(toExcelSerial('bad-date') === null, 'garbage date → null');

// ---- 2. Fidelis column mapping / coercion ----------------------------------
const loan = synthLoan();
ok(cellOf(loan, 'A').value === 'FID-90', 'A loan number prefers investor number');
ok(cellOf(loan, 'C').value === "Jane O'Brien & John Smith", 'C guarantor joins co-borrower');
ok(cellOf(loan, 'F').value === 'IL', 'F state normalized Illinois → IL');
ok(cellOf(loan, 'G').value === '02108' && cellOf(loan, 'G').type === 's', 'G zip is a string (leading zero safe)');
ok(cellOf(loan, 'H').value === 480000 && cellOf(loan, 'H').style === 57, 'H loan amount currency-styled');
ok(cellOf(loan, 'I').value === 120000, 'I financed rehab');
ok(cellOf(loan, 'N').value === 0, 'N OOP rehab = total(120k) - financed(120k) = 0');
ok(cellOf(loan, 'O').value === 120000, 'O total rehab');
ok(cellOf(loan, 'K').value === 360000, 'K current balance = initial advance');
ok(cellOf(loan, 'Q').value === 738, 'Q fico');
ok(cellOf(loan, 'P').value === 4, 'P projects completed = experience total');
ok(cellOf(loan, 'W').value === 0.1075 && cellOf(loan, 'W').style === 20, 'W note rate as fraction, percent style');
ok(cellOf(loan, 'AB').value === 12, 'AB term months parsed from "12 months"');
ok(cellOf(loan, 'AC').value === 'Purchase', 'AC purchase/refi coerced');
ok(cellOf(loan, 'AD').value === 'Drawn (aka Non-Dutch)', 'AD accrual coerced');
ok(cellOf(loan, 'AG').value === 'Yes', 'AG repeat borrower');
ok(cellOf(loan, 'AH').value === '4/2.5' && cellOf(loan, 'AH').style === 82, 'AH bed/baths text-styled');
ok(cellOf(loan, 'AL').value === '2-4 Unit', 'AL property type coerced to dropdown value');
ok(cellOf(loan, 'AM').value === 'Fix and Flip', 'AM loan type coerced');
ok(cellOf(loan, 'AN').value === 'Sale', 'AN exit strategy for flip');
ok(cellOf(loan, 'AO').value === 'US Citizen', 'AO citizenship coerced');
ok(cellOf(loan, 'V').value === '1004 Appraisal', 'V appraisal type from FNM1004');
ok(fidelis.buildRow(loan).length === 48, 'exactly 48 columns mapped (A..AV)');

// note-rate already a fraction stays a fraction; a percent value is divided
const fracLoan = synthLoan({ quote: {}, registration: {}, app: Object.assign({}, synthLoan().app, { rate_pct: 9.5 }) });
ok(cellOf(fracLoan, 'W').value === 0.095, 'note rate 9.5 (percent) → 0.095 fraction');

// refinance + strategy coercion
const refi = synthLoan({ app: Object.assign({}, synthLoan().app, { loan_type: 'Refinance Cash-Out', program: 'Bridge' }) });
ok(cellOf(refi, 'AC').value === 'Refinance', 'cash-out refi → Refinance');
ok(cellOf(refi, 'AM').value === 'Bridge', 'bridge program → Bridge');

// ---- 3. Template fidelity: only Data Tape + workbook calc flag change -------
const single = fillXlsxTemplate(TEMPLATE, { sheetPart: SHEET, firstRow: 2, rows: [fidelis.buildRow(loan)], lastCol: 'AV' });
const origParts = unzip(TEMPLATE);
const outParts = unzip(single);
ok(origParts.length === outParts.length, 'part count unchanged after fill');
const changed = [];
for (const op of origParts) {
  const np = outParts.find((x) => x.name === op.name);
  ok(np, `part present: ${op.name}`);
  if (!np.data.equals(op.data)) changed.push(op.name);
}
changed.sort();
assert.deepStrictEqual(changed, ['xl/workbook.xml', SHEET], `ONLY Data Tape + workbook changed, got: ${changed.join(', ')}`);
passed++;

const sheetXml = outParts.find((p) => p.name === SHEET).data.toString('utf8');
ok(/<c r="H2" s="57"><v>480000<\/v><\/c>/.test(sheetXml), 'H2 currency number injected');
ok(/<c r="F2"[^>]*t="inlineStr"><is><t[^>]*>IL<\/t>/.test(sheetXml), 'F2 state string injected');
ok(/<c r="W2" s="20"><v>0.1075<\/v><\/c>/.test(sheetXml), 'W2 note-rate fraction injected');
ok(new RegExp(`<c r="X2" s="78"><v>${toExcelSerial('2026-08-15')}</v></c>`).test(sheetXml), 'X2 funding date serial injected');
ok(/dropdown|sqref="AC2"/.test(sheetXml) || sheetXml.indexOf('sqref="AC2"') > -1, 'AC2 dropdown preserved');
const wbXml = outParts.find((p) => p.name === 'xl/workbook.xml').data.toString('utf8');
ok(wbXml.indexOf('fullCalcOnLoad="1"') > -1, 'workbook fullCalcOnLoad set');

// ---- 4. Capital-provider rule ---------------------------------------------
ok(buyerRule.buyerMatches(loan, fidelis) === true, 'Fidelis loan matches Fidelis tape');
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Blue Lake' }), fidelis) === false, 'Blue Lake loan does NOT match');
// Match is casing/spacing tolerant (same normalization the rest of the system
// uses), so 'FIDELIS', 'fidelis', '  Fidelis ' all resolve to the 'fidelis' key.
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: '  FIDELIS ' }), fidelis) === true, 'buyer match is casing/spacing tolerant');
// But a different word is a different key — exactly like the note-buyer engine,
// which keys Fidelis conditions on the 'fidelis' label, not 'Fidelis Investors'.
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Fidelis Investors' }), fidelis) === false, 'a different label is a different key (system-consistent)');
let threw = null;
try { buyerRule.assertBuyer(synthLoan({ noteBuyerRaw: 'Blue Lake' }), fidelis); } catch (e) { threw = e; }
ok(threw && threw.code === 'buyer_mismatch' && /Blue Lake/.test(threw.message) && /Fidelis/.test(threw.message), 'mismatch error carries a plain-language message');
let threwNone = null;
try { buyerRule.assertBuyer(synthLoan({ noteBuyerRaw: null }), fidelis); } catch (e) { threwNone = e; }
ok(threwNone && /no capital provider set/i.test(threwNone.message), 'no-buyer error explains what to set');
const avail = buyerRule.tapeAvailability('bluelake', 'Blue Lake');
const availFidelis = avail.find((t) => t.key === 'fidelis');
ok(availFidelis && availFidelis.available === false && /switch it to Fidelis/i.test(availFidelis.reason), 'availability blocks the Fidelis tape for a non-Fidelis buyer with a reason');
ok(buyerRule.tapeAvailability('fidelis', 'Fidelis').find((t) => t.key === 'fidelis').available === true, 'availability allows matching buyer');

// ---- 5. Registry ----------------------------------------------------------
ok(registry.getTape('fidelis') === fidelis, 'registry resolves fidelis');
ok(registry.getTape('nope') === null, 'registry returns null for unknown');
ok(registry.tapesForBuyer('fidelis').length === 1, 'tapesForBuyer(fidelis) = 1');
ok(registry.listTapes().every((t) => !t.buildRow && t.key), 'listTapes is function-free (browser-safe)');

// ---- 6. Bulk: one row per loan, widened dropdowns --------------------------
const loans = [synthLoan({ app: Object.assign({}, synthLoan().app, { investor_loan_number: 'FID-1' }) }),
  synthLoan({ app: Object.assign({}, synthLoan().app, { investor_loan_number: 'FID-2' }) }),
  synthLoan({ app: Object.assign({}, synthLoan().app, { investor_loan_number: 'FID-3' }) })];
const bulk = fillXlsxTemplate(TEMPLATE, { sheetPart: SHEET, firstRow: 2, rows: loans.map((l) => fidelis.buildRow(l)), lastCol: 'AV', extendValidations: true });
const bulkXml = unzip(bulk).find((p) => p.name === SHEET).data.toString('utf8');
ok(/<row r="2"[^>]*>/.test(bulkXml) && /<row r="3"[^>]*>/.test(bulkXml) && /<row r="4"[^>]*>/.test(bulkXml), 'bulk wrote rows 2,3,4');
ok(/<c r="A2"[^>]*>[\s\S]*?FID-1/.test(bulkXml) && /<c r="A4"[^>]*>[\s\S]*?FID-3/.test(bulkXml), 'bulk rows carry distinct loan numbers');
ok(bulkXml.indexOf('sqref="AC2:AC4"') > -1, 'bulk widened AC dropdown to all rows');
ok(/<dimension ref="A1:AV4"\/>/.test(bulkXml), 'bulk dimension covers all rows');

// ---- 7. Engine handles a SELF-CLOSING template data row without corruption ---
// (A future investor template might leave the input row un-preformatted, e.g.
// <row r="2"/>, with rows below it. The filler must replace only row 2 and keep
// the rows after it intact — not swallow them.)
{
  const { zip } = require('../src/lib/zip');
  const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<dimension ref="A1:A3"/><sheetData>'
    + '<row r="1"><c r="A1" t="inlineStr"><is><t>Header</t></is></c></row>'
    + '<row r="2" s="5" customFormat="1"/>'                       // self-closing input row
    + '<row r="3"><c r="A3" t="inlineStr"><is><t>KEEPME</t></is></c></row>'
    + '</sheetData></worksheet>';
  const mini = zip([{ name: 'xl/worksheets/test.xml', data: Buffer.from(sheet, 'utf8') }]);
  const out = fillXlsxTemplate(mini, { sheetPart: 'xl/worksheets/test.xml', firstRow: 2, rows: [[{ col: 'A', value: 'FILLED', type: 's' }]], lastCol: 'A', forceFullCalc: false });
  const sx = unzip(out).find((p) => p.name === 'xl/worksheets/test.xml').data.toString('utf8');
  ok(/<row r="2"[^>]*>[\s\S]*?FILLED[\s\S]*?<\/row>/.test(sx), 'self-closing row 2 replaced with a proper open/close row');
  ok(!/<row r="2"[^>]*\/>/.test(sx), 'row 2 is no longer self-closing');
  ok(sx.indexOf('KEEPME') > -1, 'row 3 after a self-closing row 2 is NOT swallowed');
  ok((sx.match(/<\/row>/g) || []).length === 3, 'all three rows well-formed (no swallowed close tags)');
}

// ---- 8. New-Construction supplemental (questionnaire) fields ---------------
{
  // A non-new-construction loan: AR..AV blank, no questions.
  ok(fidelis.isNewConstruction(loan) === false, 'fix&flip loan is not new construction');
  ok(fidelis.missingSupplemental(loan).length === 0, 'no supplemental questions for a non-NC loan');
  ok(cellOf(loan, 'AR').value === '' && cellOf(loan, 'AU').value == null, 'NC-only columns blank on a non-NC loan');

  // A ground-up loan with NO answers yet: all 5 fields are asked.
  const ncBare = synthLoan();
  ncBare.app.program = 'Ground-Up Construction'; ncBare.app.rehab_type = 'ground'; ncBare.supplemental = {};
  ok(fidelis.isNewConstruction(ncBare) === true, 'ground-up loan is new construction');
  ok(cellOf(ncBare, 'AM').value === 'New Construction', 'AM coerces ground-up → New Construction');
  const miss = fidelis.missingSupplemental(ncBare);
  ok(miss.length === 5, `all 5 NC fields asked when unanswered (got ${miss.length})`);
  ok(miss.every((f) => f.label && f.type), 'each question carries a label + type');
  ok(miss.find((f) => f.key === 'build_status').type === 'select' && Array.isArray(miss.find((f) => f.key === 'build_status').options), 'build_status is a dropdown with options');
  ok(miss.find((f) => f.key === 'lot_purchase_price').type === 'number', 'lot_purchase_price is a number field');
  ok(miss.find((f) => f.key === 'lot_purchase_date').type === 'date', 'lot_purchase_date is a date field');

  // sanitize: keep valid, drop out-of-list selects and unknown keys, coerce types.
  const clean = fidelis.sanitizeSupplemental({ asset_purchased: 'Finished Lot', entitlement_status: 'NOPE', build_status: 'Framing', lot_purchase_price: '120000', lot_purchase_date: '2026-03-01T00:00:00Z', junk: 'x' });
  assert.deepStrictEqual(clean, { asset_purchased: 'Finished Lot', build_status: 'Framing', lot_purchase_price: 120000, lot_purchase_date: '2026-03-01' }, 'sanitize keeps valid, drops invalid/unknown');
  passed++;

  // Once answered, the fields fill the tape and no questions remain.
  const ncFilled = synthLoan();
  ncFilled.app.program = 'Ground-Up Construction'; ncFilled.app.rehab_type = 'ground';
  ncFilled.supplemental = { asset_purchased: 'Land', entitlement_status: 'Fully Entitled', build_status: 'Framing', lot_purchase_price: 120000, lot_purchase_date: '2026-03-01' };
  ok(fidelis.missingSupplemental(ncFilled).length === 0, 'no questions once all answered');
  ok(cellOf(ncFilled, 'AR').value === 'Land', 'AR filled from supplemental');
  ok(cellOf(ncFilled, 'AS').value === 'Fully Entitled', 'AS filled from supplemental');
  ok(cellOf(ncFilled, 'AT').value === 'Framing', 'AT filled from supplemental');
  ok(cellOf(ncFilled, 'AU').value === 120000, 'AU lot price filled from supplemental');
  ok(cellOf(ncFilled, 'AV').value === '2026-03-01', 'AV lot date filled from supplemental');

  // Getter gating: a NON-new-construction loan with stray supplemental stored
  // (e.g. it was ground-up when answered, then reclassified) still leaves AR–AV
  // blank — the fill is gated on new construction, not just on empty storage.
  const ffWithSupp = synthLoan(); // fix & flip
  ffWithSupp.supplemental = { asset_purchased: 'Land', entitlement_status: 'Fully Entitled', build_status: 'Framing', lot_purchase_price: 99999, lot_purchase_date: '2026-01-01' };
  ok(fidelis.isNewConstruction(ffWithSupp) === false, 'reclassified loan is not new construction');
  ok(cellOf(ffWithSupp, 'AR').value === '' && cellOf(ffWithSupp, 'AT').value === '', 'AR/AT blank on non-NC loan despite stored supplemental');
  ok(cellOf(ffWithSupp, 'AU').value == null && cellOf(ffWithSupp, 'AV').value == null, 'AU/AV blank on non-NC loan despite stored supplemental');

  // Date validation rejects an impossible calendar day (would else roll over).
  ok(!('lot_purchase_date' in fidelis.sanitizeSupplemental({ lot_purchase_date: '2026-13-45' })), 'impossible calendar date is rejected');
  ok(fidelis.sanitizeSupplemental({ lot_purchase_date: '2026-02-28' }).lot_purchase_date === '2026-02-28', 'a valid calendar date is kept');

  // Partial answers → only the remaining ones are still asked.
  const ncPartial = synthLoan();
  ncPartial.app.program = 'Ground-Up Construction'; ncPartial.app.rehab_type = 'ground';
  ncPartial.supplemental = { build_status: 'Foundation' };
  const miss2 = fidelis.missingSupplemental(ncPartial).map((f) => f.key);
  ok(!miss2.includes('build_status') && miss2.length === 4, 'answered field drops out of the questionnaire');
}

console.log(`test-tape-fidelis-pure: OK (${passed} assertions)`);
