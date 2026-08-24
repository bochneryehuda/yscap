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
// One wording for "what does this file vest in" across every tape + screen.
const { vestingCell } = require('../vesting-label');
// The shared display formats — a rate cell must never DISPLAY rounded (the
// lib/rate-format rule, owner-directed 2026-08-04, reaching the tapes 2026-08-24).
const { FMT } = require('./xlsx-template');

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
  // A 1025 (Small Residential Income Property — 2-4 units) is its OWN type: label
  // it "1025 Appraisal" (owner-directed 2026-07-26). Fidelis's own dropdown lists
  // 1004/1073/2055/BPO, so this writes a value beyond that list — intended.
  if (f.indexOf('1025') > -1) return '1025 Appraisal';
  if (f.indexOf('2055') > -1) return '2055 Appraisal';
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

// ---- New-Construction-only supplemental fields (asked at export time) -------
// These columns can't be derived from what we already store. For a ground-up
// (New Construction) loan we ask staff a short questionnaire ONCE, persist the
// answers on the loan (applications.tape_supplemental), and fill from them —
// including on later exports, so we never ask twice. For any other loan type
// these columns stay blank (no questions).
const SUPPLEMENTAL_FIELDS = [
  { key: 'asset_purchased', column: 'AR', label: 'Asset purchased', type: 'select',
    options: ['Land', 'Finished Lot', 'Entitled Land', 'Unentitled Land', 'Teardown'] },
  { key: 'entitlement_status', column: 'AS', label: 'Entitlement status', type: 'select',
    options: ['Fully Entitled', 'Partially Entitled', 'Entitlements In Process', 'Not Entitled'] },
  { key: 'build_status', column: 'AT', label: 'Build status', type: 'select',
    options: ['Not Started', 'Pre-Construction', 'Foundation', 'Framing', 'Under Construction', 'Finishing', 'Completed'] },
  { key: 'lot_purchase_price', column: 'AU', label: 'Lot purchase price ($)', type: 'number' },
  { key: 'lot_purchase_date', column: 'AV', label: 'Lot purchase date', type: 'date' },
];

function isNewConstruction(loan) { return loanTypeAM(loan) === 'New Construction'; }

// The supplemental fields that APPLY to this loan — all of them for a new
// construction, none otherwise.
function supplementalFieldsFor(loan) { return isNewConstruction(loan) ? SUPPLEMENTAL_FIELDS : []; }

// The subset still UNANSWERED — exactly what the export questionnaire asks for.
function missingSupplemental(loan) {
  const s = (loan && loan.supplemental) || {};
  return supplementalFieldsFor(loan).filter((f) => s[f.key] == null || s[f.key] === '');
}

// Clean a raw answers object to known fields, coerced/validated by type (a
// select must be one of its options; a number must be finite; a date is an ISO
// calendar day). Unknown keys and invalid values are dropped.
function sanitizeSupplemental(answers) {
  const out = {};
  if (!answers || typeof answers !== 'object') return out;
  for (const f of SUPPLEMENTAL_FIELDS) {
    const v = answers[f.key];
    if (v == null || v === '') continue;
    if (f.type === 'select') { if (f.options.includes(String(v))) out[f.key] = String(v); }
    else if (f.type === 'number') { const num = Number(v); if (isFinite(num)) out[f.key] = num; }
    else if (f.type === 'date') {
      // Real calendar day only — reject a well-formed-but-impossible date like
      // 2026-13-45 (which would otherwise silently roll over to a wrong serial).
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

// Read a stored supplemental value (blank string when unset) for a getter.
function sup(loan, key) { const s = (loan && loan.supplemental) || {}; return s[key] == null ? '' : s[key]; }
// New-Construction-gated read: the NC-only columns fill ONLY for a new
// construction loan, so a loan later reclassified away from ground-up (or any
// stale/crafted supplemental) never leaks NC columns onto a non-NC tape.
function ncSup(loan, key) { return isNewConstruction(loan) ? sup(loan, key) : ''; }

// ---- derived economics -----------------------------------------------------
function economics(loan) {
  const q = loan.quote || {};
  const s = q.sizing || {};
  const a = loan.app;
  const loanAmount = n(s.totalLoan) != null ? n(s.totalLoan)
    : (loan.registration && n(loan.registration.total_loan) != null ? n(loan.registration.total_loan) : n(a.loan_amount));
  const financedRehab = n(s.rehabHoldback) != null ? n(s.rehabHoldback) : n(a.rehab_budget);
  const totalRehab = n(a.rehab_budget) != null ? n(a.rehab_budget) : financedRehab;
  // Out-of-pocket rehab = the slice of the rehab budget we do NOT finance (the
  // OOP-rehab exception, owner-authorized 2026-07-31). Prefer the exact priced
  // amount (sizing.oopRehab — the SAME value the draw ledger enforces as its
  // out-of-pocket-first floor) so the tape and the draws can never disagree; fall
  // back to (total rehab − financed rehab) for a registration that predates the
  // field. $0/absent → the column stays BLANK (we never print $0), so a loan with
  // no exception is byte-identical. Only a genuine positive unfinanced amount fills it.
  let oopRehab = null;
  const oopPriced = n(s.oopRehab);
  if (oopPriced != null && oopPriced > 0) oopRehab = oopPriced;
  else if (totalRehab != null && financedRehab != null && totalRehab - financedRehab > 0) oopRehab = totalRehab - financedRehab;
  const financedIR = n(s.financedReserve) != null ? n(s.financedReserve) : n(a.requested_ir_amount);
  const initialAdvance = n(s.initialAdvance);
  // Day-1 advance = the amount actually funded at closing (loan − holdback −
  // reserve), NOT the whole loan; the holdback and reserve are advanced later.
  // Matches seasoning.seasoningInputs so a fresh loan's current balance is the
  // same whether or not a seasoning snapshot is attached.
  const day1Fallback = loanAmount != null ? loanAmount - (financedRehab || 0) - (financedIR || 0) : null;
  return {
    loanAmount,
    financedRehab,
    totalRehab,
    oopRehab,
    financedIR,
    currentBalance: initialAdvance != null ? initialAdvance : day1Fallback,
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
// Each entry: [column, type, styleIndex|null, getter(loan, econ), displayFmt?]
// The optional 5th element is an Excel number-format code the written cell must
// DISPLAY with (resolved at fill time against the template's own styles — see
// xlsx-template.makeFormatResolver). The template's W style is 0.000%, which
// never rounds a real rate; FMT.RATE additionally makes the tape read exactly
// like every PILOT screen (10.25 → "10.25%", 10.625 → "10.625%").
const COLUMNS = [
  /* OUR loan number, ALWAYS (owner-directed 2026-08-24: "we always prefer our
     loan number and keep the investor's loan number somewhere else in the back").
     This column led with `investor_loan_number` and was the ONLY tape that did —
     EMCAP and Blue Lake have always sent `ys_loan_number`. That mattered once the
     bulk tape let any loan go on any provider's tape (owner-directed 2026-08-23):
     `investor_loan_number` is a SINGLE column that records no WHICH-investor, so a
     loan carrying CorrFirst's number would have shipped that number to Fidelis as
     the loan number — a stranger's identifier on their sheet, and one that could
     collide with a real Fidelis loan. Fidelis's own Definitions tab asks only for
     "Loan Number / Text"; it does not ask for THEIR number. */
  ['A', 's', null, (l) => l.app.ys_loan_number || l.app.investor_loan_number || ''],
  ['B', 's', null, (l) => vestingCell(l.vesting)],   // Borrowing Entity ("Individual" when there is no entity)
  ['C', 's', null, (l) => guarantorC(l)],
  ['D', 's', null, (l) => l.address.line1 || ''],
  ['E', 's', null, (l) => l.address.city || ''],
  ['F', 's', null, (l) => reg.normState(l.address.state) || l.address.state || ''],
  ['G', 's', null, (l) => l.address.zip || ''], // text: leading-zero-safe
  ['H', 'n', S.CURRENCY, (l, e) => e.loanAmount],
  ['I', 'n', S.CURRENCY, (l, e) => e.financedRehab],
  // Current rehab / balance / interest reserve reflect SEASONING (released draws +
  // interest reserve used); for a fresh loan the snapshot equals origination. When
  // no snapshot is attached (e.g. a direct buildRow in a unit test) we fall back
  // to the origination figures.
  ['J', 'n', S.CURRENCY, (l, e) => (l.seasoning ? l.seasoning.currentRehab : e.financedRehab)],
  ['K', 'n', S.CURRENCY, (l, e) => (l.seasoning ? l.seasoning.currentBalance : e.currentBalance)],
  ['L', 'n', S.CURRENCY, (l, e) => e.financedIR],
  ['M', 'n', S.CURRENCY, (l, e) => (l.seasoning ? (n(l.seasoning.financedReserve) > 0 ? l.seasoning.currentReserve : null) : e.financedIR)],
  ['N', 'n', S.CURRENCY, (l, e) => e.oopRehab],
  ['O', 'n', S.CURRENCY, (l, e) => e.totalRehab],
  ['P', 'n', null, (l) => l.exp.total],
  ['Q', 'n', null, (l) => l.fico],
  ['R', 'n', S.CURRENCY, (l, e) => e.purchasePrice],
  ['S', 'n', S.CURRENCY, (l, e) => e.assignmentFee],
  ['T', 'n', S.THOUSANDS, (l, e) => e.asIs],
  ['U', 'n', S.THOUSANDS, (l, e) => e.arv],
  ['V', 's', null, (l) => appraisalTypeV(l)],
  ['W', 'n', S.PERCENT, (l, e) => e.noteRate, FMT.RATE],
  ['X', 'd', S.DATE, (l) => l.app.actual_closing || l.app.est_closing_date || l.app.expected_closing],
  // Next payment due — the next scheduled payment for a SEASONED loan; equals the
  // first payment date at origination. Z is the (unchanging) first payment date.
  ['Y', 'd', S.DATE, (l) => ((l.seasoning && l.seasoning.nextDue) || l.app.first_payment_date)],
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
  // New-Construction-only — filled from the staff questionnaire answers stored
  // on the loan, and ONLY for a new-construction loan (blank otherwise).
  ['AR', 's', null, (l) => ncSup(l, 'asset_purchased')],
  ['AS', 's', null, (l) => ncSup(l, 'entitlement_status')],
  ['AT', 's', null, (l) => ncSup(l, 'build_status')],
  ['AU', 'n', S.CURRENCY, (l) => (isNewConstruction(l) ? n(sup(l, 'lot_purchase_price')) : null)],
  ['AV', 'd', S.DATE, (l) => (isNewConstruction(l) ? sup(l, 'lot_purchase_date') : '') || null],
];

function buildRow(loan) {
  const econ = economics(loan);
  return COLUMNS.map(([col, type, style, get, fmt]) => ({ col, type, style, value: get(loan, econ), fmt }));
}

function filename(loan) {
  // Named by OUR loan number, like every other tape (see column A above).
  const ln = (loan.app.ys_loan_number || loan.app.investor_loan_number || 'loan').replace(/[^A-Za-z0-9._-]+/g, '-');
  const last = (loan.borrower && loan.borrower.last) ? '-' + String(loan.borrower.last).replace(/[^A-Za-z0-9]+/g, '') : '';
  return `Fidelis-Tape-${ln}${last}.xlsx`;
}
function bulkFilename() {
  return `Fidelis-Tape-Bulk-${new Date().toISOString().slice(0, 10)}.xlsx`;
}

module.exports = {
  key: 'fidelis',
  buyerKey: 'fidelis',
  // The buyer's REAL note-buyer labels (applications.lender / the ClickUp dropdown),
  // enumerated so the closed-list export gate (buyer-rule.keyNamesTapeBuyer) matches
  // them. normNoteBuyer is EXACT (strips only casing/spacing/punctuation), so the
  // owner's own label "Fidelis Investors LLC" normalizes to 'fidelisinvestorsllc' —
  // NOT the bare 'fidelis' key — and without these a Fidelis file could neither export
  // its tape (non-admin) nor persist its New-Construction answers (they were silently
  // dropped, so every re-export re-asked). SAME shape as emcap.js buyerAliases; a
  // CLOSED list, never a prefix/fuzzy match — the export direction is the one where an
  // over-match ships a data tape to the WRONG buyer. Every spelling here is
  // unambiguously Fidelis (the plural/singular + Investors/Investments variants the
  // rest of the system already records — see field-registry.isFidelisNoteBuyer, db/151).
  buyerAliases: ['fidelisinvestors', 'fidelisinvestorsllc', 'fidelisinvestorllc', 'fidelisinvestments', 'fidelisinvestmentsllc'],
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
  // Supplemental (questionnaire) interface — used by the export flow:
  SUPPLEMENTAL_FIELDS,
  isNewConstruction,
  supplementalFieldsFor,
  missingSupplemental,
  sanitizeSupplemental,
};
