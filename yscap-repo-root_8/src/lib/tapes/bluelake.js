'use strict';
/**
 * BLUE LAKE CAPITAL data tape ("RTL Sample Tape" — the Bid Tape).
 *
 * Blue Lake buys our RTL (bridge/fix-&-flip/ground-up) loans and wants each loan
 * on THEIR "Bid Tape" spreadsheet. That workbook has:
 *   · "Bid Tape"        (visible tab) — the data grid we fill: headers on row 2,
 *     one loan per row starting at row 3 (a sample loan ships in row 3).
 *   · "Data Dictionary" (visible tab) — the field spec + valid values. Untouched.
 *   · "Settlement Statement" / "Pricing Confirm" / "Rate Sheet" (hidden) — calc
 *     engines that reference the Bid Tape row. Untouched (they recalc on open).
 * We ONLY write Bid Tape row 3 (or rows 3..N for bulk); the workbook's logo,
 * dropdowns, formats and hidden calc tabs are preserved byte-for-byte.
 *
 * Five Bid Tape columns are PER-ROW FORMULAS (Completion %, Total Project Costs,
 * LTAIV, LTC, LTARV) — we re-emit them as formulas (row-number substituted) so
 * they compute for our loan exactly like the sample. Every other column's cell
 * style is inherited from the sample row (inheritStyles), so the ~70-column sheet
 * keeps its currency/date/percent formatting without hardcoding each style.
 *
 * Valid-value lists (from the Data Dictionary tab):
 *   Loan Type (K)        Purchase | Rate/Term | Cashout
 *   Property Type (Q)    SFR | Condo | Duplex | Triplex | Fourplex | Land - Unentitled | Land - Entitled | PUD (Planned Urban Development)
 *   Interest Days (AY)   30/360 | Actual/360 | Actual/365
 *   Recourse (BH)        Full | Partial | No
 *   Exit Strategy (BJ)   Sell | DSCR (per the dictionary examples)
 *   Y/N flags            Y | N
 */
const path = require('path');
const reg = require('../conditions/field-registry');

// The originator/seller name as it appears on the MLPA (Blue Lake column E).
// Owner-directed: use our company name.
const SELLER_NAME = 'YS Capital Group';

const n = (v) => { if (v == null || v === '') return null; const x = Number(v); return isFinite(x) ? x : null; };
const toFraction = (v) => { const x = n(v); if (x == null) return null; return x > 1 ? x / 100 : x; };
const yn = (b) => (b ? 'Y' : 'N');
// Cached-value helpers for the Bid Tape's per-row FORMULA columns. The formula
// still ships (Excel recomputes it on open); the cached value we compute here from
// the SAME inputs the formula references makes the ratio/total DISPLAY in viewers
// that don't recalculate (Google Sheets/Quick Look/Numbers). `ratio` returns null
// when the denominator is missing/zero, so we never pre-cache a #DIV/0! — the cell
// keeps just its formula in that edge case.
const ratio = (num, den) => { const a = n(num); const b = n(den); return (a != null && b) ? a / b : null; };
const sum2 = (a, b) => { const x = n(a); const y = n(b); return (x == null && y == null) ? null : (x || 0) + (y || 0); };

function strategyOf(loan) { return reg.normStrategy([loan.app.program, loan.app.loan_type, loan.app.rehab_type].filter(Boolean).join(' ')); }
function isNewConstruction(loan) { return strategyOf(loan) === 'ground_up'; }

function loanTypeK(loan) {
  const p = reg.normLoanPurpose(loan.app.loan_type);
  if (p === 'purchase') return 'Purchase';
  if (p === 'refinance_rate_term') return 'Rate/Term';
  if (p === 'refinance_cash_out') return 'Cashout';
  return '';
}
function propertyTypeQ(loan) {
  const t = reg.normPropertyType(loan.app.property_type);
  const units = n(loan.app.units) || (loan.appraisal && n(loan.appraisal.units)) || 0;
  if (t === 'sfr') return 'SFR';
  if (t === 'condo') return 'Condo';
  if (t === 'pud' || t === 'townhouse') return 'PUD (Planned Urban Development)';
  // A 2-4 unit property maps to Duplex/Triplex/Fourplex — by unit count when we
  // have it, otherwise by the subtype named in the type text (so a "Fourplex"
  // with a missing unit count isn't mislabeled a Duplex).
  if (t === 'multi_2_4' || (units >= 2 && units <= 4)) {
    const raw = String(loan.app.property_type || '').toLowerCase();
    if (units >= 4 || /four|quad/.test(raw)) return 'Fourplex';
    if (units === 3 || /\btri/.test(raw)) return 'Triplex';
    return 'Duplex';
  }
  return ''; // multi_5_plus / mixed_use / land / other — not a Blue Lake finished type
}
function exitStrategyBJ(loan) {
  const s = strategyOf(loan);
  if (s === 'fix_hold' || s === 'rental_dscr') return 'DSCR';
  return 'Sell'; // flip / bridge / ground-up build-to-sell
}
function dutch(loan) { return String(loan.app.accrual_type || '').toLowerCase() === 'dutch'; }
function nonCashflowingI(loan) {
  // "N for tenant occupied properties" — cashflowing (N) if there's rental income;
  // otherwise the collateral isn't producing income yet (Y).
  return yn(!(n(loan.app.rental_income) > 0));
}
function foreignNationalBF(loan) { return yn(reg.normCitizenship(loan.borrower && loan.borrower.citizenship) === 'foreign_national'); }

function termMonths(loan) {
  const m = String(loan.app.term == null ? '' : loan.app.term).match(/\d+/);
  if (m) return Number(m[0]);
  const fund = loan.app.est_closing_date || loan.app.actual_closing || loan.app.expected_closing;
  const mat = loan.app.maturity_date;
  if (fund && mat) { const d = (new Date(mat) - new Date(fund)) / (1000 * 60 * 60 * 24 * 30.4375); if (isFinite(d) && d > 0) return Math.round(d); }
  return null;
}
function guarantorNameBQ(loan) { const b = loan.borrower || {}; return [b.first, b.last].filter(Boolean).join(' ').trim(); }

// ---- derived economics / disbursement snapshot (at origination) ------------
function economics(loan) {
  const q = loan.quote || {};
  const s = q.sizing || {};
  const a = loan.app;
  const totalLoan = n(s.totalLoan) != null ? n(s.totalLoan)
    : (loan.registration && n(loan.registration.total_loan) != null ? n(loan.registration.total_loan) : n(a.loan_amount));
  const holdback = n(s.rehabHoldback) != null ? n(s.rehabHoldback) : n(a.rehab_budget);
  const ir = n(s.financedReserve) != null ? n(s.financedReserve) : (n(a.requested_ir_amount) != null ? n(a.requested_ir_amount) : 0);
  let day1 = n(s.initialAdvance);
  if (day1 == null && totalLoan != null) day1 = totalLoan - (holdback || 0) - (ir || 0);
  const isDutch = dutch(loan);
  return {
    totalLoan, holdback, ir,
    day1,
    disbursedHoldback: 0,
    undisbursedHoldback: holdback,
    disbursedIR: 0,
    undisbursedIR: ir,
    totalDisbursed: day1,                                   // at origination = day-1 advance
    interestBearing: isDutch ? totalLoan : day1,            // Dutch accrues on the full note
    upb: day1,
    holdbackInEscrow: isDutch ? (holdback || 0) : 0,        // Dutch holdback is interest-bearing
    purchasePrice: n(a.purchase_price) != null ? n(a.purchase_price)
      : (n(a.original_purchase_price) != null ? n(a.original_purchase_price) : n(a.underlying_contract_price)),
    rehabBudget: n(a.rehab_budget),
    costIncurred: n(a.costs_already_paid) != null ? n(a.costs_already_paid) : 0,
    aiv: n(a.as_is_value) != null ? n(a.as_is_value)
      : (loan.appraisal && (n(loan.appraisal.as_is_value) != null ? n(loan.appraisal.as_is_value) : n(loan.appraisal.appraised_value))),
    arv: n(a.arv) != null ? n(a.arv) : (loan.appraisal && n(loan.appraisal.arv_value)),
    interestRate: q.noteRate != null ? toFraction(q.noteRate) : toFraction(a.rate_pct),
    // Total Points = the origination fee %, as a fraction (the registered quote's
    // origination percentage the borrower is charged at close).
    origPct: n(q.origPct),
  };
}

// ---- the Bid Tape column map (B..BS) ---------------------------------------
// [column, type, styleOverride|null, getter]. type 'f' = per-row formula ({r}
// becomes the row number). style is null → inherited from the sample row.
const COLUMNS = [
  ['B', 'd', null, (l) => l.asOf || new Date()],                                   // As-of Date (export date)
  ['C', 's', null, () => 'Y'],                                                     // Pre-Approval Flag — always flagged (owner-directed)
  ['D', 's', null, (l) => l.app.ys_loan_number || l.app.investor_loan_number || ''], // Loan ID (our loan #)
  ['E', 's', null, () => SELLER_NAME],                                             // Seller (lender per MLPA)
  ['F', 's', null, (l) => l.vesting.llc || ''],                                    // Borrowing Entity
  ['G', 's', null, (l) => l.vesting.llc || guarantorNameBQ(l)],                    // Mortgagor
  ['H', 'd', null, (l) => l.app.actual_closing || l.app.est_closing_date || l.app.expected_closing], // Origination/Note Date
  ['I', 's', null, (l) => nonCashflowingI(l)],                                     // Non-Cashflowing Flag
  // Holdback still funded in escrow — Dutch only; drops as draws are released.
  ['J', 'n', null, (l, e) => (l.seasoning ? (dutch(l) ? l.seasoning.undisbursedHoldback : 0) : e.holdbackInEscrow)],
  ['K', 's', null, (l) => loanTypeK(l)],                                           // Loan Type
  ['L', 's', null, (l) => yn(isNewConstruction(l))],                               // New Construction Flag
  ['M', 's', null, (l) => l.address.line1 || ''],                                  // Street
  ['N', 's', null, (l) => l.address.city || ''],                                   // City
  ['O', 's', null, (l) => reg.normState(l.address.state) || l.address.state || ''],// State
  ['P', 's', null, (l) => l.address.zip || ''],                                    // Zip (text: leading-zero safe)
  ['Q', 's', null, (l) => propertyTypeQ(l)],                                       // Property Type
  ['R', 'n', null, () => 1],                                                       // Number of Properties
  ['S', 'n', null, (l) => (n(l.app.units) != null ? n(l.app.units) : (l.appraisal && n(l.appraisal.units))) || 1], // Number of Units
  ['T', 'n', null, (l, e) => e.day1],                                             // Day 1 Loan Amount
  ['U', 'n', null, (l, e) => e.holdback],                                         // Holdback Loan Amount
  ['V', 'n', null, (l, e) => e.ir],                                               // Interest Reserve
  ['W', 'n', null, (l, e) => e.totalLoan],                                        // Total Loan Amount
  // Disbursement snapshot — SEASONING: draws released + interest reserve used to
  // date. For a fresh loan the snapshot equals origination (disbursed 0, UPB =
  // day-1). A direct buildRow with no snapshot falls back to the origination econ.
  ['X', 'n', null, (l, e) => (l.seasoning ? l.seasoning.disbursedHoldback : e.disbursedHoldback)],   // Disbursed Holdback
  ['Y', 'n', null, (l, e) => (l.seasoning ? l.seasoning.undisbursedHoldback : e.undisbursedHoldback)], // Undisbursed Holdback
  ['Z', 'n', null, (l, e) => (l.seasoning ? l.seasoning.disbursedReserve : e.disbursedIR)],          // Disbursed Interest Reserve
  ['AA', 'n', null, (l, e) => (l.seasoning ? l.seasoning.undisbursedReserve : e.undisbursedIR)],     // Undisbursed Interest Reserve
  ['AB', 'n', null, (l, e) => (l.seasoning ? l.seasoning.currentBalance : e.totalDisbursed)],        // Total Loan Amount Disbursed
  ['AC', 'n', null, (l, e) => (l.seasoning ? l.seasoning.interestBearing : e.interestBearing)],      // Interest Bearing Balance
  ['AD', 'n', null, (l, e) => (l.seasoning ? l.seasoning.currentBalance : e.upb)],                   // UPB (current balance)
  ['AE', 'f', null, (l, e) => ({ f: 'IFERROR(X{r}/U{r},"")', v: ratio(l.seasoning ? l.seasoning.disbursedHoldback : e.disbursedHoldback, e.holdback) })], // Completion % (disbursed ÷ total holdback)
  ['AF', 'n', null, (l, e) => e.purchasePrice],                                   // Purchase Price
  ['AG', 'd', null, (l) => l.app.acquisition_date || l.app.actual_closing || l.app.est_closing_date], // Purchase Date
  ['AH', 'n', null, (l, e) => e.rehabBudget],                                     // Rehab Budget
  ['AI', 'n', null, () => null],                                                  // Cost Incurred to Date — blank for now (owner-directed). This is for REFINANCES where renovation is already partly complete; we don't populate it yet.
  ['AJ', 'f', null, (l, e) => ({ f: 'AF{r}+AH{r}', v: sum2(e.purchasePrice, e.rehabBudget) })],   // Total Project Costs (purchase + rehab)
  ['AK', 'n', null, (l, e) => e.aiv],                                             // AIV
  ['AL', 'n', null, (l, e) => e.arv],                                             // ARV
  ['AM', 'd', null, (l) => (l.appraisal && (l.appraisal.effective_date || l.appraisal.report_signed_date)) || null], // Appraisal Date
  // The three underwriting ratios — Blue Lake's own formulas, now WITH a cached
  // value so the actual Initial LTV / LTC / Final (after-repair) LTV show even in a
  // viewer that doesn't recalculate (owner-reported 2026-07-26 "missing the actual
  // initial LTV, LTC, final LTC"). Excel still recomputes them on open.
  ['AN', 'f', null, (l, e) => ({ f: 'T{r}/AK{r}', v: ratio(e.day1, e.aiv) })],            // LTAIV — Initial LTV (day-1 loan ÷ As-Is Value)
  ['AO', 'f', null, (l, e) => ({ f: 'W{r}/AJ{r}', v: ratio(e.totalLoan, sum2(e.purchasePrice, e.rehabBudget)) })], // LTC (total loan ÷ total cost)
  ['AP', 'f', null, (l, e) => ({ f: 'W{r}/AL{r}', v: ratio(e.totalLoan, e.arv) })],        // LTARV — Final LTV (total loan ÷ ARV)
  ['AQ', 'n', null, (l) => (n(l.app.sqft_pre) != null ? n(l.app.sqft_pre) : (l.appraisal && n(l.appraisal.gla)))], // Pre-Rehab Sqft
  ['AR', 'n', null, (l) => n(l.app.sqft_post)],                                   // Post-Rehab Sqft
  ['AS', 'n', null, (l) => termMonths(l)],                                        // Term (months)
  ['AT', 'd', null, (l) => l.app.first_payment_date],                            // First Payment Date
  ['AU', 'd', null, (l) => l.app.maturity_date],                                 // Original Maturity Date
  ['AV', 'd', null, (l) => l.app.maturity_date],                                 // Current Maturity Date
  ['AW', 'd', null, (l) => ((l.seasoning && l.seasoning.nextDue) || l.app.first_payment_date)], // Next Due Date (advances for a seasoned loan)
  ['AX', 's', null, (l) => yn(dutch(l))],                                         // Dutch Flag
  ['AY', 's', null, () => '30/360'],                                              // Interest Days Method
  ['AZ', 'n', null, (l, e) => e.interestRate],                                    // Interest Rate
  ['BA', 's', null, () => ''],                                                     // Purchase Rate — Blue Lake completes
  ['BB', 's', null, () => ''],                                                     // Lender Retained Spread — Blue Lake completes
  ['BC', 'n', null, (l, e) => e.origPct],                                          // Total Points = origination fee % (fraction)
  ['BD', 's', null, () => ''],                                                     // Borrower Liquidity — left blank (owner-directed)
  // FICO — the PRIMARY guarantor's score (per the dictionary), which is the named
  // guarantor (BQ); falls back to the pricing FICO if the primary's isn't stored.
  ['BE', 'n', null, (l) => ((l.borrower && l.borrower.fico) != null ? l.borrower.fico : l.fico)],
  ['BF', 's', null, (l) => foreignNationalBF(l)],                                 // Foreign National Flag
  ['BG', 'n', null, (l) => (l.exp && l.exp.verifiedTotal)],                       // Guarantor Track Record (verified exits)
  ['BH', 's', null, () => 'Full'],                                                // Recourse
  ['BI', 's', null, () => 'N'],                                                    // Pre-Sold Flag
  ['BJ', 's', null, (l) => exitStrategyBJ(l)],                                    // Exit Strategy
  ['BK', 's', null, () => 'N'],                                                    // Cross Collateralization Flag
  ['BL', 's', null, () => 'N'],                                                    // Mid Construction Flag
  ['BM', 's', null, () => 'N'],                                                    // Property Conversion Flag
  ['BN', 's', null, () => 'N'],                                                    // Extension Flag
  ['BO', 's', null, () => ''],                                                     // Extension Fee $
  ['BP', 's', null, () => ''],                                                     // Extension Fee %
  ['BQ', 's', null, (l) => guarantorNameBQ(l)],                                   // Guarantor Name
  ['BR', 's', null, () => ''],                                                     // Notes
  ['BS', 's', null, () => ''],                                                     // Collateral Tracking #
];

function buildRow(loan) {
  const econ = economics(loan);
  return COLUMNS.map(([col, type, style, get]) => ({ col, type, style, value: get(loan, econ) }));
}

function filename(loan) {
  const ln = (loan.app.ys_loan_number || loan.app.investor_loan_number || 'loan').replace(/[^A-Za-z0-9._-]+/g, '-');
  const last = (loan.borrower && loan.borrower.last) ? '-' + String(loan.borrower.last).replace(/[^A-Za-z0-9]+/g, '') : '';
  return `BlueLake-BidTape-${ln}${last}.xlsx`;
}
function bulkFilename() { return `BlueLake-BidTape-Bulk-${new Date().toISOString().slice(0, 10)}.xlsx`; }

module.exports = {
  key: 'bluelake',
  buyerKey: 'bluelake',
  name: 'Blue Lake',
  fullName: 'Blue Lake Capital',
  description: 'Blue Lake Capital RTL Bid Tape — the loan filled into Blue Lake’s own workbook (per-row ratios auto-recalculate).',
  kind: 'xlsx-template',
  templateFile: path.join(__dirname, 'templates', 'bluelake.xlsx'),
  sheetPart: 'xl/worksheets/sheet1.xml', // "Bid Tape"
  sheetName: 'Bid Tape',
  firstRow: 3,
  lastCol: 'BS',
  inheritStyles: true,
  contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  buildRow,
  filename,
  bulkFilename,
  COLUMNS,
};
