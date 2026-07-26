'use strict';
/**
 * WO-A — pure tests for the expanded Encompass field registry + compare helpers.
 *
 * Locks the read-only reconciliation data map for the per-file Encompass sync:
 *   - the frozen read-only invariants (every entry pull / pilot / non-blocking);
 *   - the live-verified/owner-corrected field IDs (as-is = CX.ASISVALUE, ARV$ =
 *     356, subject-LLC vesting = std 1859);
 *   - value maps that compare MEANING not strings (deal type, rehab type,
 *     accrual, vesting);
 *   - money exact-to-the-penny, percent tolerance, date-to-the-day;
 *   - reference fields are surfaced but never compared;
 *   - flattenLoan turning a full loan (customFields[] + standard paths) into the
 *     extract shape;
 *   - PII governance: no credit/SSN/partner fields in the economics registry;
 *     SSN/DOB flagged sensitive in the identity map.
 *
 * Pure: no DB, no network, no Encompass calls.
 */
const assert = require('assert');
const m = require('../src/lib/integrations/encompass-field-map');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// ── Read-only invariants (the doctrine, structurally enforced) ──────────────
assert.ok(m.REGISTRY.length >= 30, 'registry expanded to the full field set');
assert.ok(m.REGISTRY.every((e) => e.direction === 'pull'), 'every field is pull-only (read-only)');
assert.ok(m.REGISTRY.every((e) => e.authoritative === 'pilot'), 'PILOT stays authoritative');
assert.ok(m.REGISTRY.every((e) => !e.blocksCtc && !e.blocksFunding), 'an Encompass mismatch never blocks CTC/funding');
assert.ok(m.REGISTRY.every((e) => Object.isFrozen(e)), 'entries are frozen');
ok('the registry is read-only, PILOT-authoritative, and non-blocking by policy');

// ── Field-id contract (test contract from R6.11 + WO-A corrections) ─────────
assert.strictEqual(m.BY_KEY.loan_amount.encompassFieldId, '1109', 'canonical loan-amount id is 1109');
assert.strictEqual(m.BY_KEY.note_rate.encompassFieldId, '3');
assert.strictEqual(m.BY_KEY.purchase_price.encompassFieldId, '136');
assert.strictEqual(m.BY_KEY.property_type.encompassFieldId, '1041');
assert.strictEqual(m.BY_KEY.ys_loan_number.encompassFieldId, '364');
assert.strictEqual(m.BY_KEY.as_is_value.encompassFieldId, 'CX.ASISVALUE', 'as-is corrected off std 356');
assert.strictEqual(m.BY_KEY.arv.encompassFieldId, '356', 'ARV dollars is std 356 (propertyAppraisedValueAmount)');
assert.strictEqual(m.BY_KEY.rehab_budget.encompassFieldId, 'CX.REHABBUDGET');
assert.strictEqual(m.BY_KEY.vesting_llc.encompassFieldId, '1859', 'subject-LLC vesting is owner-confirmed std 1859');
const ids = m.REGISTRY.map((e) => e.encompassFieldId);
assert.strictEqual(new Set(ids).size, ids.length, 'field ids are unique (no BY_FIELD_ID clobber)');
ok('field ids match the live-verified / owner-corrected map and are unique');

// ── extractFields keeps the original flat-envelope contract ─────────────────
const encLoan = { fields: { '1109': { value: '450000' }, '3': { value: '0.1099' }, '136': { value: 400000 }, '1041': { value: 'SFR' } } };
const extracted = m.extractFields(encLoan);
assert.strictEqual(extracted.loan_amount, 450000);
assert.strictEqual(extracted.note_rate, 0.1099);
assert.strictEqual(extracted.purchase_price, 400000);
assert.strictEqual(extracted.property_type, 'SFR');
ok('extractFields still reads the flat {fields:{id:{value}}} envelope');

// ── flattenLoan: full loan (customFields[] + standard loanPath) → extract ───
const rawLoan = {
  baseLoanAmount: '525450.0000',
  purchasePriceAmount: '450500.0000',
  propertyAppraisedValueAmount: '750000.0000',
  loanAmortizationTermMonths: 12,
  requestedInterestRatePercent: '8.0',
  maturityDate: '2027-06-22',
  loanNumber: 'YS-1234',
  property: { propertyType: '2-4 Family' },
  customFields: [
    { fieldName: 'CX.REHABBUDGET', value: '120000.0000', format: 'DECIMAL_2' },
    { fieldName: 'CX.ASISVALUE', value: '500000.0000', format: 'DECIMAL_2' },
    { fieldName: 'CX.MAXTOTALLOAN', value: '525450.0000', format: 'DECIMAL_2' },
    { fieldName: 'CX.DEALPROJECTTYPE', value: 'Fix and Flip', format: 'DROPDOWNLIST' },
    { fieldName: 'CX.ACCRUALTYPE', value: 'Drawn', format: 'DROPDOWNLIST' },
    { fieldName: 'CX.ACTAULLTC', value: '92.1034', format: 'DECIMAL_4' },
  ],
};
const flat = m.flattenLoan(rawLoan);
assert.ok(flat.fields && flat.fields['1109'] && String(flat.fields['1109'].value) === '525450.0000', 'std baseLoanAmount → field 1109');
assert.ok(flat.fields['CX.REHABBUDGET'], 'custom field carried through');
const ex = m.extractFields(rawLoan); // full loan flattened internally
assert.strictEqual(ex.loan_amount, 525450);
assert.strictEqual(ex.arv, 750000, 'propertyAppraisedValueAmount → arv');
assert.strictEqual(ex.as_is_value, 500000, 'CX.ASISVALUE → as_is_value');
assert.strictEqual(ex.rehab_budget, 120000);
assert.strictEqual(ex.max_total_loan, 525450);
assert.strictEqual(ex.term_months, 12);
assert.strictEqual(ex.maturity_date, '2027-06-22');
assert.strictEqual(ex.note_rate, 8.0);
assert.strictEqual(ex.property_type, '2-4 Family');
ok('flattenLoan + extractFields read a full loan (customFields[] + standard paths)');

// ── Money exact-to-the-penny ────────────────────────────────────────────────
assert.strictEqual(m.compareField('loan_amount', 450000, '450000.0000').status, 'match');
assert.strictEqual(m.compareField('loan_amount', '$450,000.00', 450000).status, 'match');
assert.strictEqual(m.compareField('loan_amount', 450000, '450000.01').status, 'mismatch', 'one cent is a mismatch');
assert.strictEqual(m.compareField('loan_amount', 450000, null).status, 'incomparable');
ok('money compares exact-to-the-penny (strips $/commas; a cent mismatches; null → incomparable)');

// ── Percent tolerance ───────────────────────────────────────────────────────
assert.strictEqual(m.compareField('actual_ltc', 92.1034, '92.1034').status, 'match');
assert.strictEqual(m.compareField('actual_ltc', 92.103, '92.1034').status, 'match', '3dp column vs 4dp Encompass within tolerance');
assert.strictEqual(m.compareField('actual_ltc', 90.0, '92.5').status, 'mismatch');
ok('percent compares within tolerance (absorbs 3dp/4dp rounding, catches real gaps)');

// ── Enum value maps (meaning, not strings) ──────────────────────────────────
assert.strictEqual(m.compareField('deal_type', 'flip', 'Fix and Flip').status, 'match');
assert.strictEqual(m.compareField('deal_type', 'flip', 'Rehab').status, 'match', 'Rehab → flip (owner)');
assert.strictEqual(m.compareField('deal_type', 'fix-and-hold', 'Fix and Hold').status, 'match');
assert.strictEqual(m.compareField('deal_type', 'flip', 'New Construction').status, 'mismatch');
assert.strictEqual(m.compareField('rehab_type', 'Cosmetic', 'Light Rehab').status, 'match', 'Cosmetic ≡ Light');
assert.strictEqual(m.compareField('rehab_type', 'Adding SF', 'Expansion').status, 'match', 'Adding SF ≡ Expansion');
assert.strictEqual(m.compareField('rehab_type', 'Heavy', 'Heavy Rehab').status, 'match');
assert.strictEqual(m.compareField('accrual_type', 'non_dutch', 'Drawn').status, 'match');
assert.strictEqual(m.compareField('accrual_type', 'dutch', 'Note').status, 'match', 'Note ≡ Dutch/full-boat (owner)');
assert.strictEqual(m.compareField('accrual_type', 'non_dutch', 'Note').status, 'mismatch');
assert.strictEqual(m.compareField('loan_to_be_vested', 'entity', 'Entity').status, 'match');
ok('enum value maps compare meaning: dealType / rehabType / accrual / vesting');

// ── Date to the day ─────────────────────────────────────────────────────────
assert.strictEqual(m.compareField('maturity_date', '2027-06-22', '2027-06-22T00:00:00Z').status, 'match');
assert.strictEqual(m.compareField('maturity_date', '2027-06-22', '2027-06-23').status, 'mismatch');
ok('date compares to the day (tolerates a time component)');

// ── Reference fields: surfaced, never compared; PITIA removed ───────────────
assert.strictEqual(m.compareField('exit_plan', 'sell', 'Refinance: Rental').status, 'reference');
assert.strictEqual(m.compareField('ref_cash_to_close', 1, 2).status, 'reference');
assert.ok(!m.BY_KEY.ref_pitia, 'PITIA was removed from the registry (owner-directed 2026-07-26 — wrong field)');
assert.ok(m.comparableKeys().every((k) => m.BY_KEY[k].compare !== 'reference'), 'comparableKeys excludes reference fields');
ok('reference fields are surfaced but never produce a finding; PITIA is gone');

// ── Loan number + units are now MATCHED (owner-directed 2026-07-26) ──────────
assert.strictEqual(m.BY_KEY.ys_loan_number.gate, m.GATE.BLOCK, 'loan number is now a matched (block) field, not reference');
assert.strictEqual(m.compareField('ys_loan_number', 'YSCAP1', 'YSCAP1').status, 'match', 'equal loan numbers match');
assert.strictEqual(m.compareField('ys_loan_number', 'YSCAP1', 'YSCAP2').status, 'mismatch', 'different loan numbers mismatch');
assert.ok(m.BY_KEY.units, 'units is now a registry field');
assert.strictEqual(m.BY_KEY.units.encompassFieldId, '16', 'units maps to Encompass field 16');
assert.strictEqual(m.compareField('units', 3, 3).status, 'match');
assert.strictEqual(m.compareField('units', 2, 4).status, 'mismatch');
ok('loan number + units (field 16) are matched fields now');

// ── Gate classification (WO-E) ──────────────────────────────────────────────
assert.strictEqual(m.BY_KEY.loan_amount.gate, m.GATE.BLOCK, 'money mismatch blocks the term sheet');
assert.strictEqual(m.BY_KEY.maturity_date.gate, m.GATE.BLOCK, 'a maturity-date disagreement blocks');
assert.strictEqual(m.BY_KEY.deal_type.gate, m.GATE.ADVISORY, 'deal type is advisory (derived heuristically from program/loan_type)');
assert.strictEqual(m.BY_KEY.accrual_type.gate, m.GATE.ADVISORY, 'accrual is advisory (owner)');
// every "actual" leverage percent is advisory (consistency — no odd one blocks)
for (const k of ['actual_ltc', 'actual_arv_ltv', 'actual_initial_ltv', 'max_ltc', 'max_arv_ltv', 'max_initial_ltv']) {
  assert.strictEqual(m.BY_KEY[k].gate, m.GATE.ADVISORY, `${k} is advisory`);
}
// lossy-vocabulary enums surface but never block
assert.strictEqual(m.BY_KEY.property_type.gate, m.GATE.ADVISORY, 'property type is advisory (lossy category)');
assert.strictEqual(m.BY_KEY.rehab_type.gate, m.GATE.ADVISORY, 'rehab type is advisory (5 buckets vs 3)');
assert.strictEqual(m.BY_KEY.exit_plan.gate, m.GATE.REFERENCE);
ok('gate classification: money/date block; all actual/cap percents + lossy/derived enums advisory; leftovers reference');

// ── property_type compares MEANING (value-mapped), not raw strings ──────────
assert.strictEqual(m.compareField('property_type', 'SFR', 'Single Family').status, 'match', 'SFR ≡ Single Family');
assert.strictEqual(m.compareField('property_type', 'Multi 2-4', '2-4 Family').status, 'match');
assert.strictEqual(m.compareField('property_type', 'Multi 2–4', '2-4 Units').status, 'match', 'en-dash normalized');
assert.strictEqual(m.compareField('property_type', 'SFR', '2-4 Family').status, 'mismatch');
assert.strictEqual(m.compareField('property_type', 'Condo', 'Manufactured').status, 'incomparable', 'unmapped Encompass wording → not comparable, never a false block');
ok('property_type value-maps our range category to Encompass wording (meaning, not strings)');

// ── vesting_llc name compare is punctuation-insensitive ─────────────────────
assert.strictEqual(m.compareField('vesting_llc', 'ABC Holdings LLC', 'ABC Holdings, LLC').status, 'match', 'comma-insensitive');
assert.strictEqual(m.compareField('vesting_llc', 'ABC LLC', 'ABC Inc').status, 'mismatch', 'suffixes NOT stripped — distinct entities differ');
ok('vesting_llc uses a punctuation-insensitive name compare (does not over-normalize suffixes)');

// ── flattenLoan drops unmapped custom fields (PII defense-in-depth) ─────────
const flatPII = m.flattenLoan({ customFields: [
  { fieldName: 'CX.MIDDLESCORE', value: '740' },
  { fieldName: 'CX.REHABBUDGET', value: '100000' },
] });
assert.ok(!('CX.MIDDLESCORE' in flatPII.fields), 'unmapped credit custom field is NOT surfaced by flattenLoan');
assert.ok('CX.REHABBUDGET' in flatPII.fields, 'a registry custom field IS surfaced');
ok('flattenLoan surfaces only registry fields (unmapped/PII custom fields dropped)');

// ── PII governance ──────────────────────────────────────────────────────────
assert.ok(!m.REGISTRY.some((e) => /MIDDLESCORE|\bFICO\b|SSN|TAXIDENT|CAPITALPROVIDER|WHICHINVESTOR/i.test(e.encompassFieldId)),
  'no credit / SSN / capital-partner fields in the economics registry');
const ssn = m.IDENTITY_MAP.find((e) => e.key === 'ssn');
const dob = m.IDENTITY_MAP.find((e) => e.key === 'date_of_birth');
assert.ok(ssn && ssn.sensitive === true && ssn.match === 'ssnHash', 'SSN identity is hash-only + sensitive');
assert.ok(dob && dob.sensitive === true, 'DOB identity is flagged sensitive');
assert.ok(m.IDENTITY_MAP.find((e) => e.key === 'vesting_llc'), 'identity map includes the 1859 vesting match');
ok('PII governance: economics registry is PII-free; SSN/DOB sensitive; 1859 vesting in identity map');

console.log(`\nWO-A Encompass field-map pure — ${passed} checks passed`);
