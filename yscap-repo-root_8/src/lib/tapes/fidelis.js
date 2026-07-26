'use strict';
/**
 * FIDELIS data tape definition.
 *
 * Fidelis Investors buy loans off us, and they want their file data on THEIR own
 * spreadsheet — the "Fidelis Pricing Matrix & Data Tape". That workbook has:
 *   · "Buy Rate"    (visible tab A) — auto-prices/eligibility from the input row. Untouched.
 *   · "Data Tape"   (visible tab B) — the input row we fill (row 2, columns A–AV).
 *   · "Definitions" (visible tab C) — the field dictionary. Untouched.
 *   · four hidden lookup engines (Pricing Matrix / Guideline Limits / Rate
 *     Assumptions / Rate Build-Up). Untouched.
 * We ONLY write Data Tape row 2 (or rows 2..N for a bulk tape) — the pricing tab
 * then recalculates itself when Fidelis opens the file.
 *
 * The column list below is the SINGLE source of truth for the Fidelis mapping:
 * each entry says which of our loan facts fills which sheet column, its Excel
 * cell type (number / string / date), and the style index the blank template
 * already uses for that column (currency / thousands / date / text), so the
 * output looks exactly like the template with our figures typed in. Valid-value
 * columns are coerced to the sheet's own dropdown values via the shared
 * normalizers (the same ones the conditions engine uses), so pricing tab A can
 * classify the loan.
 *
 * NOTE on Data Tape dropdown values (authoritative — from the sheet's own data
 * validations, tighter than the Definitions tab):
 *   AC Purchase/Refi   → "Purchase" | "Refinance"
 *   AL Property Type    → "Single Family" | "2-4 Unit" | "Multifamily" | "Condo" | "Townhouse"
 *   AM Loan Type        → "Fix and Flip" | "Bridge" | "New Construction"
 *   AO Citizenship      → "US Citizen" | "Permanent Resident" | "Non-Permanent Resident" | "Foreign National"
 */
const path = require('path');
const reg = require('../conditions/field-registry');

// Template cell-style indices (from the workbook's styles.xml cellXfs) — reused
// so injected cells carry the template's own formatting:
const S = {
  CURRENCY: 57, // $#,##0        (H..O, R, S money columns)
  THOUSANDS: 77, // #,##0        (T As-Is, U ARV)
  DATE: 78, //     m/d/yyyy      (X/Y/Z/AA/AV)
  PERCENT: 20, //  0.000%        (W note rate)
  TEXT: 82, //     @ text        (AH bed/baths — keep "3/2" as text, not a date)
};

const n = (v) => { if (v == null || v === '') return null; const x = Number(v); return isFinite(x) ? x : null; };
// A note rate may arrive as a fraction (0.105) or a percent (10.5). The sheet's
// cell is percent-formatted, which stores the FRACTION — normalize to that.
const toFraction = (v) => { const x = n(v); if (x == null) return null; return x > 1 ? x / 100 : x; };

// ---- valid-value coercers → the Data Tape's own dropdown values ------------
function loanTypeAM(loan) {
  const strat = reg.normStrategy([loan.app.program, loan.app.loan_type, loan.app.rehab_type].filter(Boolean).join(' '));
  if (strat === 'ground_up') return 'New Construction';
  if (strat === 'fix_flip' || strat === 'fix_hold') return 'Fix and Flip';
  if (strat === 'bridge') return 'Bridge';
  if (strat === 'rental_dscr') return 'Bridge';
  return ''; // unclassified — leave blank rather than misprice
}
function purchaseRefiAC(loan) {
  const p = reg.normLoanPurpose(loan.app.loan_type);
  if (p === 'purchase') return 'Purchase';
  if (p === 'refinance_rate_term' || p === 'refinance_cash_out') return 'Refinance';
  return '';
}
function propertyTypeAL(loan) {
  const t = reg.normPropertyType(loan.app.property_type);
  switch (t) {
    case 'sfr': case 'pud': return 'Single Family';
    case 'multi_2_4': return '2-4 Unit';
    case 'multi_5_plus': return 'Multifamily';
    case 'condo': return 'Condo';
    case 'townhouse': return 'Townhouse';
    case 'mixed_use': return 'Multifamily'; // closest in-sheet value
    default: return '';
  }
}
function citizenshipAO(loan) {
  const c = reg.normCitizenship(loan.borrower && loan.borrower.citizenship);
  if (c === 'us_citizen') return 'US Citizen';
  if (c === 'permanent_resident') return 'Permanent Resident';
  if (c === 'foreign_national') return 'Foreign National';
  return '';
}
function accrualAD(loan) {
  const a = String(loan.app.accrual_type || '').toLowerCase();
  if (a === 'dutch') return 'Note (aka Dutch)';
  if (a === 'non_dutch') return 'Drawn (aka Non-Dutch)';
  return '';
}
function exitStrategyAN(loan) {
  const strat = reg.normStrategy([loan.app.program, loan.app.loan_type, loan.app.rehab_type].filter(Boolean).join(' '));
  if (strat === 'fix_flip' || strat === 'ground_up') return 'Sale';
  if (strat === 'fix_hold' || strat === 'rental_dscr') return 'Refinance: Rental';
  if (strat === 'bridge') return 'Refinance: Bridge';
  return '';
}
function appraisalTypeV(loan) {
  const f = String((loan.appraisal && loan.appraisal.form_type) || '').toLowerCase();
  if (!f) return '';
  if (f.indexOf('1004') > -1) return '1004 Appraisal';
  if (f.indexOf('1073') > -1) return '1073 Appraisal';
  if (f.indexOf('2055') > -1 || f.indexOf('1025') > -1) return '2055 Appraisal';
  if (f.indexOf('bpo') > -1) return 'BPO';
  return loan.appraisal.form_type;
}
function termMonths(loan) {
  const t = loan.app.term;
  const m = String(t == null ? '' : t).match(/\d+/);
  if (m) return Number(m[0]);
  // fall back to maturity − funding, in whole months
  const fund = loan.app.est_closing_date || loan.app.actual_closing || loan.app.expected_closing;
  const mat = loan.app.maturity_date;
  if (fund && mat) {
    const d = (new Date(mat) - new Date(fund)) / (1000 * 60 * 60 * 24 * 30.4375);
    if (isFinite(d) && d > 0) return Math.round(d);
  }
  return null;
}
function bedBathAH(loan) {
  const ap = loan.appraisal;
  if (!ap || ap.beds == null) return '';
  const full = n(ap.baths_full) || 0;
  const half = n(ap.baths_half) || 0;
  const baths = half > 0 ? `${full}.5` : `${full}`;
  return `${ap.beds}/${baths}`;
}
function guarantorC(loan) {
  const b = loan.borrower || {};
  const name = [b.first, b.last].filter(Boolean).join(' ').trim();
  const cb = loan.coBorrower;
  const coName = cb ? [cb.first, cb.last].filter(Boolean).join(' ').trim() : '';
  return [name, coName].filter(Boolean).join(' & ');
}

// ---- derived economics -----------------------------------------------------
function economics(loan) {
  const q = loan.quote || {};
  const s = q.sizing || {};
  const a = loan.app;
  const loanAmount = n(s.totalLoan) != null ? n(s.totalLoan)
    : (loan.registration && n(loan.registration.total_loan) != null ? n(loan.registration.total_loan) : n(a.loan_amount));
  const financedRehab = n(s.rehabHoldback) != null ? n(s.rehabHoldback) : n(a.rehab_budget);
  const totalRehab = n(a.rehab_budget) != null ? n(a.rehab_budget) : financedRehab;
  let oopRehab = null;
  if (totalRehab != null && financedRehab != null) oopRehab = Math.max(0, totalRehab - financedRehab);
  else if (totalRehab != null && financedRehab == null) oopRehab = totalRehab;
  const financedIR = n(s.financedReserve) != null ? n(s.financedReserve) : n(a.requested_ir_amount);
  const initialAdvance = n(s.initialAdvance);
  return {
    loanAmount,
    financedRehab,
    totalRehab,
    oopRehab,
    financedIR,
    currentBalance: initialAdvance != null ? initialAdvance : loanAmount,
    purchasePrice: n(a.purchase_price) != null ? n(a.purchase_price)
      : (n(a.original_purchase_price) != null ? n(a.original_purchase_price) : n(a.underlying_contract_price)),
    asIs: n(a.as_is_value) != null ? n(a.as_is_value)
      : (loan.appraisal && (n(loan.appraisal.as_is_value) != null ? n(loan.appraisal.as_is_value) : n(loan.appraisal.appraised_value))),
    arv: n(a.arv) != null ? n(a.arv) : (loan.appraisal && n(loan.appraisal.arv_value)),
    noteRate: q.noteRate != null ? toFraction(q.noteRate)
      : (n(a.rate_pct) != null ? toFraction(a.rate_pct) : toFraction(loan.registration && loan.registration.note_rate)),
    assignmentFee: a.is_assignment ? n(a.assignment_fee) : null,
  };
}

// ---- the 48-column map (A..AV) --------------------------------------------
// Each entry: [column, type, styleIndex|null, getter(loan, econ)]
const COLUMNS = [
  ['A', 's', null, (l) => l.app.investor_loan_number || l.app.ys_loan_number || ''],
  ['B', 's', null, (l) => l.vesting.llc || ''],
  ['C', 's', null, (l) => guarantorC(l)],
  ['D', 's', null, (l) => l.address.line1 || ''],
  ['E', 's', null, (l) => l.address.city || ''],
  ['F', 's', null, (l) => reg.normState(l.address.state) || l.address.state || ''],
  ['G', 's', null, (l) => l.address.zip || ''], // text: leading-zero-safe
  ['H', 'n', S.CURRENCY, (l, e) => e.loanAmount],
  ['I', 'n', S.CURRENCY, (l, e) => e.financedRehab],
  ['J', 'n', S.CURRENCY, (l, e) => e.financedRehab], // current rehab = original at origination
  ['K', 'n', S.CURRENCY, (l, e) => e.currentBalance],
  ['L', 'n', S.CURRENCY, (l, e) => e.financedIR],
  ['M', 'n', S.CURRENCY, (l, e) => e.financedIR], // current IR = original at origination
  ['N', 'n', S.CURRENCY, (l, e) => e.oopRehab],
  ['O', 'n', S.CURRENCY, (l, e) => e.totalRehab],
  ['P', 'n', null, (l) => l.exp.total],
  ['Q', 'n', null, (l) => l.fico],
  ['R', 'n', S.CURRENCY, (l, e) => e.purchasePrice],
  ['S', 'n', S.CURRENCY, (l, e) => e.assignmentFee],
  ['T', 'n', S.THOUSANDS, (l, e) => e.asIs],
  ['U', 'n', S.THOUSANDS, (l, e) => e.arv],
  ['V', 's', null, (l) => appraisalTypeV(l)],
  ['W', 'n', S.PERCENT, (l, e) => e.noteRate],
  ['X', 'd', S.DATE, (l) => l.app.actual_closing || l.app.est_closing_date || l.app.expected_closing],
  ['Y', 'd', S.DATE, (l) => l.app.first_payment_date],       // next due = first due at origination
  ['Z', 'd', S.DATE, (l) => l.app.first_payment_date],
  ['AA', 'd', S.DATE, (l) => l.app.maturity_date],
  ['AB', 'n', null, (l) => termMonths(l)],
  ['AC', 's', null, (l) => purchaseRefiAC(l)],
  ['AD', 's', null, (l) => accrualAD(l)],
  ['AE', 'n', null, () => null],                              // internal projects exited — not tracked
  ['AF', 'n', null, () => null],                              // years experience — not tracked
  ['AG', 's', null, (l) => (l.repeatBorrower ? 'Yes' : 'No')],
  ['AH', 's', S.TEXT, (l) => bedBathAH(l)],
  ['AI', 'n', null, (l) => (n(l.app.sqft_pre) != null ? n(l.app.sqft_pre) : (l.appraisal && n(l.appraisal.gla)))],
  ['AJ', 'n', null, (l) => n(l.app.sqft_post)],
  ['AK', 'n', null, (l) => (n(l.app.units) != null ? n(l.app.units) : (l.appraisal && n(l.appraisal.units)))],
  ['AL', 's', null, (l) => propertyTypeAL(l)],
  ['AM', 's', null, (l) => loanTypeAM(l)],
  ['AN', 's', null, (l) => exitStrategyAN(l)],
  ['AO', 's', null, (l) => citizenshipAO(l)],
  ['AP', 's', null, () => ''],                                // multi-property flag — not tracked
  ['AQ', 's', null, () => ''],                                // cross-collateralized flag — not tracked
  ['AR', 's', null, () => ''],                                // asset purchased — new construction only
  ['AS', 's', null, () => ''],                                // entitlement status — new construction only
  ['AT', 's', null, () => ''],                                // build status — new construction only
  ['AU', 'n', S.CURRENCY, () => null],                        // lot purchase price — new construction only
  ['AV', 'd', S.DATE, () => null],                            // lot purchase date — new construction only
];

function buildRow(loan) {
  const econ = economics(loan);
  return COLUMNS.map(([col, type, style, get]) => ({ col, type, style, value: get(loan, econ) }));
}

function filename(loan) {
  const ln = (loan.app.investor_loan_number || loan.app.ys_loan_number || 'loan').replace(/[^A-Za-z0-9._-]+/g, '-');
  const last = (loan.borrower && loan.borrower.last) ? '-' + String(loan.borrower.last).replace(/[^A-Za-z0-9]+/g, '') : '';
  return `Fidelis-Tape-${ln}${last}.xlsx`;
}
function bulkFilename() {
  return `Fidelis-Tape-Bulk-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

module.exports = {
  key: 'fidelis',
  buyerKey: 'fidelis',
  name: 'Fidelis',
  fullName: 'Fidelis Investors',
  description: 'Fidelis Pricing Matrix & Data Tape — the loan filled into Fidelis’s own Excel workbook (pricing tab auto-recalculates).',
  kind: 'xlsx-template',
  templateFile: path.join(__dirname, 'templates', 'fidelis.xlsx'),
  sheetPart: 'xl/worksheets/sheet5.xml', // "Data Tape"
  sheetName: 'Data Tape',
  firstRow: 2,
  lastCol: 'AV',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buildRow,
  filename,
  bulkFilename,
  COLUMNS,
};
