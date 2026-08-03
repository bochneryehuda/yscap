'use strict';
/**
 * EMCAP data tape ("Format Submission Tape").
 *
 * EMCAP is a capital provider that buys our RTL loans and wants each loan on THEIR
 * one-sheet submission tape. The workbook has a SINGLE sheet — row 1 is 38 column
 * headers (A..AL), row 2 is where one loan's data goes (rows 2..N for bulk). There
 * is NO definitions tab and no pricing/calc tabs, so we only ever write the data
 * row(s); every other part round-trips byte-for-byte.
 *
 * EMCAP is a rental-focused buyer: the tape carries a "Proj. Rental" column (the
 * loan's estimated MONTHLY rental income), and for a fix-and-hold EMCAP loan that
 * estimated rent is a completeness requirement (see src/routes/staff.js
 * applicationCompleteness) and is cross-checked against the appraisal's market
 * rent after the appraisal comes in (see investor-guideline-review.js).
 *
 * Most columns are the same facts the Fidelis tape maps; the current-state columns
 * (L Current Rehab, O Current Balance) use the SEASONING snapshot exactly like the
 * other tapes. Owner-directed field decisions (2026-07-26):
 *   • Acquisition Loan (N) = the purchase-money portion = the day-1 acquisition
 *     advance (loan − rehab holdback − interest reserve).
 *   • Interest Reserve (M) = the original financed interest reserve.
 *   • Proj. Rental (U) = the loan's estimated MONTHLY rental income.
 *   • County (E) = blank for now (we don't store the property's county).
 *   • Strategy (I) = our own labels (Fix and Flip / Fix and Hold / Bridge / …).
 *
 * Per-column Excel style indices are taken from the template's own row-2 cells
 * (currency $#,##0, date mm-dd-yy, percent 0.00%, text, integer) so the output
 * looks exactly like the blank template with our figures typed in.
 */
const path = require('path');
const reg = require('../conditions/field-registry');
// One wording for "what does this file vest in" across every tape + screen.
const { vestingCell } = require('../vesting-label');

// Template cell-style indices (from the EMCAP workbook's row-2 cells / styles.xml):
const S = {
  CUR2: 2,   // $#,##0   — Total Loan, Original/Current Rehab, Purchase Price, As-Is, ARV
  CUR4: 4,   // $#,##0   — Interest Reserve, Proj. Rental
  CUR5: 5,   // $#,##0   — Acquisition Loan, Current Balance
  DATE: 6,   // mm-dd-yy — Funding Date, Maturity Date, Lot Purchase Date
  PCT: 7,    // 0.00%    — Note Rate
  INT: 8,    // 0        — Term
  THOUS: 9,  // #,##0    — SqFt
  ZIP: 10,   // @ text   — Zip
  STRAT: 3,  // (template styles this cell as %) — Strategy label (a string; format ignored)
};

const n = (v) => { if (v == null || v === '') return null; const x = Number(v); return isFinite(x) ? x : null; };
// A note rate may arrive as a fraction (0.105) or a percent (10.5). The sheet's
// cell is percent-formatted, which stores the FRACTION — normalize to that.
const toFraction = (v) => { const x = n(v); if (x == null) return null; return x > 1 ? x / 100 : x; };

// ---- valid-value / label coercers -----------------------------------------
function strategyLabel(loan) {
  const s = reg.normStrategy([loan.app.program, loan.app.loan_type, loan.app.rehab_type].filter(Boolean).join(' '));
  switch (s) {
    case 'fix_flip': return 'Fix and Flip';
    case 'fix_hold': return 'Fix and Hold';
    case 'bridge': return 'Bridge';
    case 'ground_up': return 'New Construction';
    case 'rental_dscr': return 'DSCR Rental';
    default: return '';
  }
}
function purchaseRefi(loan) {
  const p = reg.normLoanPurpose(loan.app.loan_type);
  if (p === 'purchase') return 'Purchase';
  if (p === 'refinance_rate_term' || p === 'refinance_cash_out') return 'Refinance';
  return '';
}
function accrualLabel(loan) {
  const a = String(loan.app.accrual_type || '').toLowerCase();
  if (a === 'dutch') return 'Note';
  if (a === 'non_dutch') return 'Drawn';
  return ''; // unknown — leave blank rather than guess
}
function guarantor(loan) {
  const b = loan.borrower || {};
  const name = [b.first, b.last].filter(Boolean).join(' ').trim();
  const cb = loan.coBorrower;
  const coName = cb ? [cb.first, cb.last].filter(Boolean).join(' ').trim() : '';
  return [name, coName].filter(Boolean).join(' & ');
}
function beds(loan) { return loan.appraisal ? n(loan.appraisal.beds) : null; }
function baths(loan) {
  const ap = loan.appraisal;
  if (!ap) return null;
  const full = n(ap.baths_full) || 0;
  const half = n(ap.baths_half) || 0;
  return half > 0 ? full + 0.5 * half : (full || null);
}
function sqft(loan) {
  return n(loan.app.sqft_post) != null ? n(loan.app.sqft_post)
    : (n(loan.app.sqft_pre) != null ? n(loan.app.sqft_pre) : (loan.appraisal && n(loan.appraisal.gla)));
}
function units(loan) { return n(loan.app.units) != null ? n(loan.app.units) : (loan.appraisal && n(loan.appraisal.units)); }
function termMonths(loan) {
  const m = String(loan.app.term == null ? '' : loan.app.term).match(/\d+/);
  if (m) return Number(m[0]);
  const fund = loan.app.actual_closing || loan.app.est_closing_date || loan.app.expected_closing;
  const mat = loan.app.maturity_date;
  if (fund && mat) { const d = (new Date(mat) - new Date(fund)) / (1000 * 60 * 60 * 24 * 30.4375); if (isFinite(d) && d > 0) return Math.round(d); }
  return null;
}

// ---- New-Construction-only supplemental fields (asked at export time) -------
// EMCAP's tape carries the same ground-up-only descriptors as Fidelis (minus the
// lot purchase PRICE, which EMCAP's sheet doesn't have). We reuse the SAME
// supplemental keys so a loan's answers are shared across tapes.
const SUPPLEMENTAL_FIELDS = [
  { key: 'asset_purchased', column: 'R', label: 'Asset purchased', type: 'select',
    options: ['Land', 'Finished Lot', 'Entitled Land', 'Unentitled Land', 'Teardown'] },
  { key: 'entitlement_status', column: 'AA', label: 'Entitlement status', type: 'select',
    options: ['Fully Entitled', 'Partially Entitled', 'Entitlements In Process', 'Not Entitled'] },
  { key: 'build_status', column: 'AB', label: 'Build status', type: 'select',
    options: ['Not Started', 'Pre-Construction', 'Foundation', 'Framing', 'Under Construction', 'Finishing', 'Completed'] },
  { key: 'lot_purchase_date', column: 'Q', label: 'Lot purchase date', type: 'date' },
];

function isNewConstruction(loan) { return strategyLabel(loan) === 'New Construction'; }
function supplementalFieldsFor(loan) { return isNewConstruction(loan) ? SUPPLEMENTAL_FIELDS : []; }
function missingSupplemental(loan) {
  const s = (loan && loan.supplemental) || {};
  return supplementalFieldsFor(loan).filter((f) => s[f.key] == null || s[f.key] === '');
}
function sanitizeSupplemental(answers) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const f of SUPPLEMENTAL_FIELDS) {
    const v = answers[f.key];
    if (v == null || v === '') continue;
    if (f.type === 'select') { if (f.options.includes(String(v))) out[f.key] = String(v); }
    else if (f.type === 'number') { const num = Number(v); if (isFinite(num)) out[f.key] = num; }
    else if (f.type === 'date') {
      const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (m) {
        const y = +m[1], mo = +m[2], d = +m[3];
        const dt = new Date(Date.UTC(y, mo - 1, d));
        if (dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d) out[f.key] = `${m[1]}-${m[2]}-${m[3]}`;
      }
    } else out[f.key] = String(v);
  }
  return out;
}
function sup(loan, key) { const s = (loan && loan.supplemental) || {}; return s[key] == null ? '' : s[key]; }
function ncSup(loan, key) { return isNewConstruction(loan) ? sup(loan, key) : ''; }

// ---- derived economics -----------------------------------------------------
function economics(loan) {
  const q = loan.quote || {};
  const s = q.sizing || {};
  const a = loan.app;
  const totalLoan = n(s.totalLoan) != null ? n(s.totalLoan)
    : (loan.registration && n(loan.registration.total_loan) != null ? n(loan.registration.total_loan) : n(a.loan_amount));
  const holdback = n(s.rehabHoldback) != null ? n(s.rehabHoldback) : n(a.rehab_budget);
  const financedReserve = n(s.financedReserve) != null ? n(s.financedReserve)
    : (n(a.requested_ir_amount) != null ? n(a.requested_ir_amount) : 0);
  // Out-of-pocket rehab exception (owner-authorized 2026-07-31), mirroring Fidelis:
  // totalRehab = the FULL construction budget; oopRehab = the slice we do NOT finance
  // (budget − financed holdback). $0 unless an approved exception lowered the holdback.
  // Exposed for a dedicated EMCAP out-of-pocket column once the owner confirms which
  // cell of the EMCAP workbook carries it (its rehab columns K/L are unchanged for now,
  // so no-exception loans are byte-identical).
  const totalRehab = n(a.rehab_budget) != null ? n(a.rehab_budget) : holdback;
  let oopRehab = null;
  const oopPriced = n(s.oopRehab); // exact priced OOP amount = the draw ledger's floor
  if (oopPriced != null && oopPriced > 0) oopRehab = oopPriced;
  else if (totalRehab != null && holdback != null && totalRehab - holdback > 0) oopRehab = totalRehab - holdback;
  let initialAdvance = n(s.initialAdvance);
  if (initialAdvance == null && totalLoan != null) initialAdvance = totalLoan - (holdback || 0) - (financedReserve || 0);
  return {
    totalLoan,
    holdback,
    totalRehab,
    oopRehab,
    financedReserve,
    // Acquisition Loan = the purchase-money portion (owner-directed): the day-1
    // acquisition advance, i.e. loan − rehab holdback − interest reserve.
    acquisitionLoan: initialAdvance,
    initialAdvance,
    purchasePrice: n(a.purchase_price) != null ? n(a.purchase_price)
      : (n(a.original_purchase_price) != null ? n(a.original_purchase_price) : n(a.underlying_contract_price)),
    asIs: n(a.as_is_value) != null ? n(a.as_is_value)
      : (loan.appraisal && (n(loan.appraisal.as_is_value) != null ? n(loan.appraisal.as_is_value) : n(loan.appraisal.appraised_value))),
    arv: n(a.arv) != null ? n(a.arv) : (loan.appraisal && n(loan.appraisal.arv_value)),
    noteRate: q.noteRate != null ? toFraction(q.noteRate)
      : (n(a.rate_pct) != null ? toFraction(a.rate_pct) : toFraction(loan.registration && loan.registration.note_rate)),
    estRent: n(a.estimated_rental_income), // estimated MONTHLY rental income (db/313)
  };
}

// ---- the 38-column map (A..AL) --------------------------------------------
// Each entry: [column, type, styleIndex|null, getter(loan, econ)]. Current
// rehab / balance reflect SEASONING (with an origination fallback when no
// snapshot is attached — e.g. a direct buildRow in a unit test).
const COLUMNS = [
  ['A', 's', null, (l) => l.app.ys_loan_number || l.app.investor_loan_number || ''],   // Loan #
  ['B', 's', null, (l) => vestingCell(l.vesting)],                                       // Borrowing Entity ("Individual" when there is no entity)
  ['C', 's', null, (l) => guarantor(l)],                                                 // Guarantor
  ['D', 's', null, (l) => l.address.line1 || ''],                                        // Address
  ['E', 's', null, () => ''],                                                            // County — not stored (owner-directed blank)
  ['F', 's', null, (l) => l.address.city || ''],                                         // City
  ['G', 's', null, (l) => reg.normState(l.address.state) || l.address.state || ''],      // State
  ['H', 's', S.ZIP, (l) => l.address.zip || ''],                                         // Zip (text: leading-zero safe)
  ['I', 's', S.STRAT, (l) => strategyLabel(l)],                                          // Strategy
  ['J', 'n', S.CUR2, (l, e) => e.totalLoan],                                             // Total Loan Amount
  ['K', 'n', S.CUR2, (l, e) => e.holdback],                                              // Original Rehab Amount
  ['L', 'n', S.CUR2, (l, e) => (l.seasoning ? l.seasoning.currentRehab : e.holdback)],   // Current Rehab Amount (seasoned)
  ['M', 'n', S.CUR4, (l, e) => e.financedReserve],                                       // Interest Reserve (original)
  ['N', 'n', S.CUR5, (l, e) => e.acquisitionLoan],                                       // Acquisition Loan (purchase-money portion)
  ['O', 'n', S.CUR5, (l, e) => (l.seasoning ? l.seasoning.currentBalance : e.initialAdvance)], // Current Balance (seasoned)
  ['P', 'n', S.CUR2, (l, e) => e.purchasePrice],                                         // Purchase Price
  ['Q', 'd', S.DATE, (l) => (isNewConstruction(l) ? sup(l, 'lot_purchase_date') : '') || null], // Lot Purchase Date (NC only)
  ['R', 's', null, (l) => ncSup(l, 'asset_purchased')],                                  // Asset Purchased (NC only)
  ['S', 'n', S.CUR2, (l, e) => e.asIs],                                                  // As Is Value
  ['T', 'n', S.CUR2, (l, e) => e.arv],                                                   // ARV
  ['U', 'n', S.CUR4, (l, e) => e.estRent],                                               // Proj. Rental (estimated monthly rent)
  ['V', 'n', S.PCT, (l, e) => e.noteRate],                                               // Note Rate (fraction)
  ['W', 'd', S.DATE, (l) => l.app.actual_closing || l.app.est_closing_date || l.app.expected_closing], // Funding Date
  ['X', 'd', S.DATE, (l) => l.app.maturity_date],                                        // Maturity Date
  ['Y', 'n', S.INT, (l) => termMonths(l)],                                               // Term (months)
  ['Z', 's', null, (l) => purchaseRefi(l)],                                              // Purchase/Refinance
  ['AA', 's', null, (l) => ncSup(l, 'entitlement_status')],                              // Entitlement Status (NC only)
  ['AB', 's', null, (l) => ncSup(l, 'build_status')],                                    // Build Status (NC only)
  ['AC', 's', null, (l) => accrualLabel(l)],                                             // Accrual Type (Note vs. Drawn)
  ['AD', 'n', null, (l) => (l.exp && l.exp.total)],                                       // Borrower Total Projects Completed
  ['AE', 'n', null, () => null],                                                          // Borrower Internal Projects Exited — not tracked
  ['AF', 'n', null, () => null],                                                          // # of Years Experience — not tracked
  ['AG', 's', null, (l) => (l.repeatBorrower ? 'Y' : 'N')],                               // Repeat Borrower (Y/N)
  ['AH', 'n', null, (l) => l.fico],                                                       // FICO Score
  ['AI', 'n', null, (l) => beds(l)],                                                      // Beds
  ['AJ', 'n', null, (l) => baths(l)],                                                     // Baths
  ['AK', 'n', S.THOUS, (l) => sqft(l)],                                                   // SqFt
  ['AL', 'n', null, (l) => units(l)],                                                     // # of Units
];

function buildRow(loan) {
  const econ = economics(loan);
  return COLUMNS.map(([col, type, style, get]) => ({ col, type, style, value: get(loan, econ) }));
}

function filename(loan) {
  const ln = (loan.app.ys_loan_number || loan.app.investor_loan_number || 'loan').replace(/[^A-Za-z0-9._-]+/g, '-');
  const last = (loan.borrower && loan.borrower.last) ? '-' + String(loan.borrower.last).replace(/[^A-Za-z0-9]+/g, '') : '';
  return `EMCAP-Tape-${ln}${last}.xlsx`;
}
function bulkFilename() { return `EMCAP-Tape-Bulk-${new Date().toISOString().slice(0, 10)}.xlsx`; }

module.exports = {
  key: 'emcap',
  buyerKey: 'emcap',
  // ENUMERATED extra spellings of this buyer's label (normNoteBuyer form). The owner's
  // real ClickUp/Sitewire dropdown label is "EMCAP Financial" (owner-directed 2026-07-29),
  // which normalizes to 'emcapfinancial' — without this the tape gate would refuse the
  // export on every correctly-labeled file. DELIBERATELY a closed list, never a prefix/
  // fuzzy match: the export gate is the direction where an over-match ships a data tape
  // for the wrong buyer (the same reason normNoteBuyer itself stays exact). A new real
  // spelling is added HERE, in the owner's words — never by loosening the matcher.
  buyerAliases: ['emcapfinancial'],
  name: 'EMCAP',
  fullName: 'EMCAP',
  description: 'EMCAP Format Submission Tape — the loan filled into EMCAP’s own one-sheet workbook.',
  kind: 'xlsx-template',
  templateFile: path.join(__dirname, 'templates', 'emcap.xlsx'),
  sheetPart: 'xl/worksheets/sheet1.xml', // "Format Submission Tape"
  sheetName: 'Format Submission Tape',
  firstRow: 2,
  lastCol: 'AL',
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buildRow,
  filename,
  bulkFilename,
  COLUMNS,
  // Supplemental (questionnaire) interface — used by the export flow:
  SUPPLEMENTAL_FIELDS,
  isNewConstruction,
  supplementalFieldsFor,
  missingSupplemental,
  sanitizeSupplemental,
};
