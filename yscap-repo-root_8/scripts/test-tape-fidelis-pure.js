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
/* A carries OUR loan number, even though this fixture also has the investor's
   (owner-directed 2026-08-24: "we always prefer our loan number, not the
   investor's"). Fidelis was the only tape that led with the investor number;
   test-tape-loan-number-pure guards the rule across every tape and module. */
ok(cellOf(loan, 'A').value === 'YSCAP-2201', 'A loan number is OURS, not the investor’s');
ok(cellOf(loan, 'C').value === "Jane O'Brien & John Smith", 'C guarantor joins co-borrower');
ok(cellOf(loan, 'F').value === 'IL', 'F state normalized Illinois → IL');
ok(cellOf(loan, 'G').value === '02108' && cellOf(loan, 'G').type === 's', 'G zip is a string (leading zero safe)');
ok(cellOf(loan, 'H').value === 480000 && cellOf(loan, 'H').style === 57, 'H loan amount currency-styled');
ok(cellOf(loan, 'I').value === 120000, 'I financed rehab');
ok(cellOf(loan, 'N').value === null, 'N OOP rehab BLANK when whole rehab is financed (total 120k = financed 120k → nothing out of pocket)');
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
// A 1025 (2-4 unit income property) is its OWN label — NOT folded into 2055
// (owner-directed 2026-07-26). Each form maps to its own value.
ok(cellOf(synthLoan({ appraisal: { form_type: 'FNM 1025' } }), 'V').value === '1025 Appraisal', 'V: a 1025 says "1025 Appraisal" (not 2055)');
ok(cellOf(synthLoan({ appraisal: { form_type: '2055' } }), 'V').value === '2055 Appraisal', 'V: a 2055 still says "2055 Appraisal"');
ok(cellOf(synthLoan({ appraisal: { form_type: '1073' } }), 'V').value === '1073 Appraisal', 'V: a 1073 says "1073 Appraisal"');
ok(cellOf(synthLoan({ appraisal: null }), 'V').value === '', 'V: no appraisal → blank (not a default)');
ok(fidelis.buildRow(loan).length === 48, 'exactly 48 columns mapped (A..AV)');

// note-rate already a fraction stays a fraction; a percent value is divided
const fracLoan = synthLoan({ quote: {}, registration: {}, app: Object.assign({}, synthLoan().app, { rate_pct: 9.5 }) });
ok(cellOf(fracLoan, 'W').value === 0.095, 'note rate 9.5 (percent) → 0.095 fraction');

// refinance + strategy coercion
const refi = synthLoan({ app: Object.assign({}, synthLoan().app, { loan_type: 'Refinance Cash-Out', program: 'Bridge' }) });
ok(cellOf(refi, 'AC').value === 'Refinance', 'cash-out refi → Refinance');
ok(cellOf(refi, 'AM').value === 'Bridge', 'bridge program → Bridge');

// ---- 2b. Seasoned loan: released draws + reserve used move J/K/M/Y ----------
// A fresh loan (no snapshot attached) reports origination values; once a seasoning
// snapshot is attached (released draws + interest reserve used), the CURRENT
// columns move while the ORIGINATION columns (I financed rehab, L financed IR, Z
// first payment) stay put.
const seasoning = require('../src/lib/tapes/seasoning');
const sloan = synthLoan();
sloan.app.actual_closing = '2026-01-01';
sloan.app.first_payment_date = '2026-03-01';
sloan.fundingDate = '2026-01-01';
sloan.releases = [{ date: '2026-04-01', amount: 30000 }];
sloan.seasoning = seasoning.computeSeasoning(seasoning.seasoningInputs(sloan, '2026-07-01'));
ok(cellOf(sloan, 'I').value === 120000, 'seasoned: I financed rehab stays at origination');
ok(cellOf(sloan, 'J').value === 90000, 'seasoned: J current rehab = 120k − 30k released');
ok(cellOf(sloan, 'K').value > 360000, 'seasoned: K current balance rose above the day-1 advance');
ok(cellOf(sloan, 'L').value === 24000, 'seasoned: L financed IR stays at origination');
ok(cellOf(sloan, 'M').value < 24000 && cellOf(sloan, 'M').value > 0, 'seasoned: M current IR dropped below the financed reserve');
ok(cellOf(sloan, 'Y').value === '2026-07-01', 'seasoned: Y next due advanced to the current payment');
ok(cellOf(sloan, 'Z').value === '2026-03-01', 'seasoned: Z first payment date unchanged');
// A confirmed override wins over the computed value.
const oloan = synthLoan();
oloan.app.actual_closing = '2026-01-01'; oloan.app.first_payment_date = '2026-03-01';
oloan.fundingDate = '2026-01-01'; oloan.releases = [{ date: '2026-04-01', amount: 30000 }];
oloan.seasoning = seasoning.applySeasonedOverrides(
  seasoning.computeSeasoning(seasoning.seasoningInputs(oloan, '2026-07-01')),
  { current_balance: 401234, next_due: '2026-08-01' });
ok(cellOf(oloan, 'K').value === 401234, 'seasoned override: K uses the confirmed current balance');
ok(cellOf(oloan, 'Y').value === '2026-08-01', 'seasoned override: Y uses the confirmed next due date');
// A FRESH loan with a snapshot attached (the production path) must fill the
// current columns IDENTICALLY to origination — including the no-registered-quote
// path (economics falls back to the application's own loan amount / rehab / IR).
for (const q of [undefined, { quote: {}, registration: {} }]) {
  const freshNo = q ? synthLoan(q) : synthLoan();
  const freshYes = q ? synthLoan(q) : synthLoan();
  freshYes.app.actual_closing = '2026-08-15'; freshYes.app.first_payment_date = '2026-10-01';
  freshYes.fundingDate = '2026-08-15'; freshYes.releases = [];
  freshYes.seasoning = seasoning.computeSeasoning(seasoning.seasoningInputs(freshYes, '2026-08-20')); // before first payment
  ok(freshYes.seasoning.isSeasoned === false, `fresh loan not seasoned (${q ? 'no-quote' : 'quote'})`);
  for (const col of ['H', 'I', 'J', 'K', 'L', 'M', 'O']) {
    ok(cellOf(freshYes, col).value === cellOf(freshNo, col).value,
      `fresh loan ${col}: attached snapshot == origination (${q ? 'no-quote' : 'quote'})`);
  }
}

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
// styles.xml joins the changed set since the display-precision fix (2026-08-24):
// the note-rate cell declares FMT.RATE, which APPENDS a cloned style — every
// pre-existing style survives byte-identical (pinned by test-tape-rate-precision).
assert.deepStrictEqual(changed, ['xl/styles.xml', 'xl/workbook.xml', SHEET], `ONLY Data Tape + workbook + appended styles changed, got: ${changed.join(', ')}`);
passed++;

const sheetXml = outParts.find((p) => p.name === SHEET).data.toString('utf8');
ok(/<c r="H2" s="57"><v>480000<\/v><\/c>/.test(sheetXml), 'H2 currency number injected');
ok(/<c r="F2"[^>]*t="inlineStr"><is><t[^>]*>IL<\/t>/.test(sheetXml), 'F2 state string injected');
// W2 carries a RESOLVED style since the display-precision fix — a clone of the
// template's s=20 (0.000%) with FMT.RATE ('0.00#%'), appended past the
// template's own 92 styles so nothing pre-existing moves.
const w2 = /<c r="W2" s="(\d+)"><v>0.1075<\/v><\/c>/.exec(sheetXml);
ok(w2 && Number(w2[1]) >= 92, 'W2 note-rate fraction injected with the resolved display style');
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
// The buyer's REAL labels ("Fidelis Investors", the owner's own "Fidelis Investors
// LLC") are ENUMERATED tape aliases (fidelis.js buyerAliases), so a correctly-labeled
// file matches — normNoteBuyer is EXACT, so these longer labels never resolve to the
// bare 'fidelis' key on their own, and without the aliases a Fidelis file could
// neither export its tape (non-admin) nor persist its New-Construction answers (which
// re-asked on every export). A CLOSED list, never a prefix/fuzzy match: the title
// insurer "Fidelity National" still does not match.
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Fidelis Investors' }), fidelis) === true, 'the real "Fidelis Investors" label matches (enumerated alias)');
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Fidelis Investors LLC' }), fidelis) === true, "the owner's real 'Fidelis Investors LLC' label matches (enumerated alias)");
ok(buyerRule.buyerMatches(synthLoan({ noteBuyerRaw: 'Fidelity National' }), fidelis) === false, 'a genuinely different buyer ("Fidelity National") does NOT match');
let threw = null;
try { buyerRule.assertBuyer(synthLoan({ noteBuyerRaw: 'Blue Lake' }), fidelis); } catch (e) { threw = e; }
ok(threw && threw.code === 'buyer_mismatch' && /Blue Lake/.test(threw.message) && /Fidelis/.test(threw.message), 'mismatch error carries a plain-language message');
let threwNone = null;
try { buyerRule.assertBuyer(synthLoan({ noteBuyerRaw: null }), fidelis); } catch (e) { threwNone = e; }
ok(threwNone && /no capital provider set/i.test(threwNone.message), 'no-buyer error explains what to set');
// A registered Blue Lake (gold) loan: the Fidelis tape is blocked (wrong provider).
const avail = buyerRule.tapeAvailability('bluelake', 'Blue Lake', { isAdmin: false, registeredProgram: 'gold' });
const availFidelis = avail.find((t) => t.key === 'fidelis');
ok(availFidelis && availFidelis.available === false && /switch it to Fidelis/i.test(availFidelis.reason), 'availability blocks the Fidelis tape for a non-Fidelis buyer with a reason');
// A registered Standard (fidelis) loan: the Fidelis tape is available.
ok(buyerRule.tapeAvailability('fidelis', 'Fidelis', { isAdmin: false, registeredProgram: 'standard' }).find((t) => t.key === 'fidelis').available === true, 'availability allows a matching buyer + program');

// ---- 5. Registry ----------------------------------------------------------
ok(registry.getTape('fidelis') === fidelis, 'registry resolves fidelis');
ok(registry.getTape('nope') === null, 'registry returns null for unknown');
ok(registry.tapesForBuyer('fidelis').length === 1, 'tapesForBuyer(fidelis) = 1');
ok(registry.listTapes().every((t) => !t.buildRow && t.key), 'listTapes is function-free (browser-safe)');

// ---- 6. Bulk: one row per loan, widened dropdowns --------------------------
/* Distinct by OUR loan number — column A carries `ys_loan_number` now, so making
   the rows differ by the investor's number would leave all three rows reading
   the same value and the "one row per loan" assertion below would prove nothing. */
const loans = [synthLoan({ app: Object.assign({}, synthLoan().app, { ys_loan_number: 'YSCAP-B1' }) }),
  synthLoan({ app: Object.assign({}, synthLoan().app, { ys_loan_number: 'YSCAP-B2' }) }),
  synthLoan({ app: Object.assign({}, synthLoan().app, { ys_loan_number: 'YSCAP-B3' }) })];
const bulk = fillXlsxTemplate(TEMPLATE, { sheetPart: SHEET, firstRow: 2, rows: loans.map((l) => fidelis.buildRow(l)), lastCol: 'AV', extendValidations: true });
const bulkXml = unzip(bulk).find((p) => p.name === SHEET).data.toString('utf8');
ok(/<row r="2"[^>]*>/.test(bulkXml) && /<row r="3"[^>]*>/.test(bulkXml) && /<row r="4"[^>]*>/.test(bulkXml), 'bulk wrote rows 2,3,4');
ok(/<c r="A2"[^>]*>[\s\S]*?YSCAP-B1/.test(bulkXml) && /<c r="A4"[^>]*>[\s\S]*?YSCAP-B3/.test(bulkXml), 'bulk rows carry distinct loan numbers');
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
