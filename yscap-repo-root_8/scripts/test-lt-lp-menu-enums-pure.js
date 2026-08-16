#!/usr/bin/env node
'use strict';
/**
 * §33.2/§33.3/§33.4 — the confirmed MENU enums (pure, offline).
 *
 * Three fields the builder used to decide FOR the caller:
 *   • IncomeDocType was hard-coded "DSCR" — the other 24 confirmed menu values were unreachable.
 *   • PrePayment_Plan_Type was hard-coded "Standard" — the other 18 structures were unreachable, and
 *     structure could not be chosen independently of the term.
 *   • GLOBAL_BorrowerType accepted ANY string unvalidated — the one silent substitution left in the
 *     borrower block (every other advanced enum 422s an unknown value).
 * Plus the two CITIZENSHIP values whose real vendor spelling carries a trailing ")".
 *
 * NEVER-GUESS properties proven here:
 *   • The token is NEVER derived by formatting the label ("WVOE" -> "VOEOnly", "12 Mo Alt Doc" ->
 *     "AltDoc12Months", and the Mo/Month split inside the tax-vs-CPA P&L pairs).
 *   • The malformed citizenship tokens are transmitted VERBATIM, never "corrected".
 *   • An unrecognized value is REJECTED, never silently priced as the profile default.
 *
 * PROVEN TO FAIL: restore the hard-coded 'DSCR'/'Standard' literals and the OVERRIDE rows go red;
 * drop the BORROWER_TYPES check and BT-BAD goes red; "fix" a malformed citizenship token and CIT-2
 * goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const registry = require('../src/longterm/lenderprice/field-registry');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const loc = { state: 'NJ', countyFps: '34039' };
const scOf = (extra) => ({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, ...extra });
const dyn = (m, k) => (m.dynamicPropertiesMap[k] ? m.dynamicPropertiesMap[k].value : undefined);

console.log('§33.2/§33.3/§33.4 confirmed menu enums');

// ---- §33.2 INCOME DOCUMENTATION: the complete 25-value table -----------------
const INCOME_DOC = [
  ['Full Doc - 24M', 'Full Doc - 24M'], ['Full Doc - 12M', 'Full Doc - 12M'], ['DSCR', 'DSCR'],
  ['24Mo Personal Bank Statements', '24MoPersonalBankStatements'],
  ['24Mo Business Bank Statements', '24MoBusinessBankStatements'],
  ['12MoPersonalBankStatements', '12MoPersonalBankStatements'],
  ['12Mo Business Bank Statements', '12MoBusinessBankStatements'],
  ['Community - No income/No employment/No DTI', 'Community - No income/No employment/No DTI'],
  ['24Mo CPA Prepared PL', '24MoCPAPreparedPL'], ['24Mo Tax Prepared PL', '24MonthTaxPreparedPL'],
  ['24MoCPAPreparedPLwBKStmt', '24MoCPAPreparedPLwBKStmt'],
  ['24Mo Tax Prepared PLwBkStmt', '24MonthTaxPreparedPLwBkStmt'],
  ['12Mo CPA Prepared PL', '12MoCPAPreparedPL'], ['12Mo Tax Prepared PL', '12MonthTaxPreparedPL'],
  ['12Mo CPA Prepared PLwBKStmt', '12MoCPAPreparedPLwBKStmt'],
  ['12Mo Tax Prepared PLwBKStmt', '12MonthTaxPreparedPLwBKStmt'],
  ['1YrTaxReturn', '1YrTaxReturn'], ['12 Mo Alt Doc', 'AltDoc12Months'], ['24 Mo Alt Doc', 'AltDoc24Months'],
  ['Asset Utilization', 'Asset Utilization'], ['AssetQualifier', 'AssetQualifier'],
  ['AssetDepletion', 'AssetDepletion'], ['1099 - 24M', '1099 - 24M'], ['1099 - 12M', '1099 - 12M'],
  ['WVOE', 'VOEOnly'],
];
ok(INCOME_DOC.length === 25, `IDT-0 the table carries all 25 confirmed menu values (got ${INCOME_DOC.length})`);
for (const [label, token] of INCOME_DOC) {
  const m = sm.buildSearch(scOf({ incomeDocType: label }));
  ok(dyn(m, 'IncomeDocType') === token, `IDT label "${label}" → IncomeDocType "${token}"`);
  // the exact upstream TOKEN is accepted too (a caller replaying a captured request)
  const byToken = sm.buildSearch(scOf({ incomeDocType: token }));
  ok(dyn(byToken, 'IncomeDocType') === token, `IDT token "${token}" round-trips`);
}
// the label is NEVER a formatter for the token — these four would break a naive de-spacer
ok(registry.mapIncomeDocType('WVOE') === 'VOEOnly', 'IDT-NG1 "WVOE" maps to VOEOnly (not "WVOE")');
ok(registry.mapIncomeDocType('12 Mo Alt Doc') === 'AltDoc12Months', 'IDT-NG2 "12 Mo Alt Doc" is not de-spaced to "12MoAltDoc"');
ok(registry.mapIncomeDocType('24Mo Tax Prepared PL') === '24MonthTaxPreparedPL', 'IDT-NG3 the tax P&L uses Month, not Mo');
ok(registry.mapIncomeDocType('24Mo CPA Prepared PL') === '24MoCPAPreparedPL', 'IDT-NG4 the CPA P&L uses Mo, not Month (same row, different word)');
// omitted → the DSCR profile default
ok(dyn(sm.buildSearch(scOf({})), 'IncomeDocType') === 'DSCR', 'IDT-DEF omitted incomeDocType forces the DSCR profile default');
// unknown → 422, never DSCR
{
  const r = sm.validateScenario(scOf({ incomeDocType: 'Stated Income', ...loc }));
  ok(r.ok === false && r.status === 422 && r.error === 'invalid_income_doc_type',
    'IDT-BAD an unknown income doc type is rejected 422 (never priced as DSCR)');
}

// ---- §33.3 PREPAYMENT STRUCTURE: the complete 19-value table -----------------
const PREPAY = [
  ['Standard', 'Standard'], ['Fixed 5%', 'Fixed5'], ['Fixed 4%', 'Fixed4'], ['Fixed 3%', 'Fixed3'],
  ['Fixed 2%', 'Fixed2'], ['Fixed 1%', 'Fixed1'], ['5,4,3,3,3', '54333'], ['5,4,3,2,1', '54321'],
  ['5,4,3,3', '5433'], ['5,4,3,2', '5432'], ['4,3,2,1', '4321'], ['5,4,3', '543'], ['3,2,1', '321'],
  ['5,4', '54'], ['2,1', '21'], ['6 Months Interest', '6MosInt'], ['Step Down', 'StepDown'], ['Other', 'Other'],
];
ok(PREPAY.length + 1 === 19, `PPS-0 18 token structures + "No Prepay" = 19 confirmed values`);
for (const [label, token] of PREPAY) {
  const m = sm.buildSearch(scOf({ prepayMonths: 60, prepayStructure: label }));
  ok(dyn(m, 'PrePayment_Plan_Type') === token, `PPS label "${label}" → PrePayment_Plan_Type "${token}"`);
}
// "No Prepay" is a REAL choice whose token is null — distinct from "unrecognized"
{
  const m = sm.buildSearch(scOf({ prepayMonths: 60, prepayStructure: 'No Prepay' }));
  ok(dyn(m, 'PrePayment_Plan_Type') === null, 'PPS-NULL "No Prepay" transmits a null plan value');
  ok(dyn(m, 'PrepayTerm') === '60 Months', 'PPS-NULL2 …and does NOT change the term (structure and term are independent)');
}
// structure supplied ALONE writes only the plan, leaving the live default's term untouched
{
  const m = sm.buildSearch(scOf({ prepayStructure: 'Step Down' }));
  ok(dyn(m, 'PrePayment_Plan_Type') === 'StepDown', 'PPS-ALONE a structure with no term writes the plan');
  ok(dyn(m, 'PrepayTerm') === undefined || dyn(m, 'PrepayTerm') !== 'None',
    'PPS-ALONE2 …and does not invent a term (an omitted term still inherits)');
}
// a term alone still implies Standard (unchanged behavior)
ok(dyn(sm.buildSearch(scOf({ prepayMonths: 60 })), 'PrePayment_Plan_Type') === 'Standard',
  'PPS-DEF a term alone still implies the Standard structure');
// explicit no-prepay TERM still carries the null plan (unchanged)
ok(dyn(sm.buildSearch(scOf({ prepayMonths: 0 })), 'PrepayTerm') === 'None', 'PPS-TERM0 prepayMonths 0 → PrepayTerm "None"');
// unknown → 422
{
  const r = sm.validateScenario(scOf({ prepayStructure: '7,7,7', ...loc }));
  ok(r.ok === false && r.status === 422 && r.error === 'invalid_prepay_structure',
    'PPS-BAD an unknown prepay structure is rejected 422 (never priced as Standard)');
}

// ---- §33.4 BORROWER TYPE: the exact six-value enum, now validated -----------
for (const t of ['Individual', 'Corporation', 'Partnership', 'Trust', 'Non-Profit', 'LLC']) {
  const r = sm.validateScenario(scOf({ borrowerType: t, ...loc }));
  ok(r.ok === true, `BT "${t}" is accepted`);
  ok(dyn(sm.buildSearch(scOf({ borrowerType: t })), 'GLOBAL_BorrowerType') === t, `BT "${t}" transmits verbatim`);
}
ok(registry.BORROWER_TYPES.size === 6, 'BT-0 exactly the six confirmed vesting types');
ok(dyn(sm.buildSearch(scOf({})), 'GLOBAL_BorrowerType') === 'LLC', 'BT-DEF omitted borrowerType forces the LLC profile default');
{
  const r = sm.validateScenario(scOf({ borrowerType: 'Wizard', ...loc }));
  ok(r.ok === false && r.status === 422 && r.error === 'invalid_borrower_type',
    'BT-BAD an unknown vesting type is rejected 422 (was passed straight to the vendor before)');
}

// ---- §33.4 CITIZENSHIP: all seven, incl. the two malformed vendor spellings --
const CITIZENSHIP = ['US Citizen', 'Perm Resident', 'Non-Perm Resident', 'Foreign National',
  'ForeignNationalwithITIN)', 'ForeignNationalnoITIN)', 'ITIN'];
for (const c of CITIZENSHIP) {
  const r = sm.validateScenario(scOf({ citizenship: c, ...loc }));
  ok(r.ok === true, `CIT "${c}" is accepted`);
  ok(dyn(sm.buildSearch(scOf({ citizenship: c })), 'Citizenship') === c, `CIT "${c}" transmits VERBATIM`);
}
ok(registry._tokens.CITIZENSHIP.size === 7, 'CIT-0 exactly the seven confirmed citizenship values');
// the trailing ")" is a REAL vendor spelling and must never be "corrected"
ok(registry._tokens.CITIZENSHIP.has('ForeignNationalwithITIN)') && !registry._tokens.CITIZENSHIP.has('ForeignNationalwithITIN'),
  'CIT-2 the malformed trailing-paren token is kept exactly; the "clean" spelling is NOT accepted');
{
  const r = sm.validateScenario(scOf({ citizenship: 'Martian', ...loc }));
  ok(r.ok === false && r.status === 422, 'CIT-BAD an unknown citizenship is rejected 422');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
