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

// ── Money: whole-dollar figures absorb cents-rounding; input fields stay exact ──
assert.strictEqual(m.compareField('loan_amount', 450000, '450000.0000').status, 'match');
assert.strictEqual(m.compareField('loan_amount', '$450,000.00', 450000).status, 'match');
// loan_amount is a whole-dollar figure (Encompass rounds off cents), so a cents gap is
// a MATCH — owner-directed 2026-08-06, superseding the old "one cent is a mismatch" here.
assert.strictEqual(m.compareField('loan_amount', 450000, '450000.01').status, 'match', 'a cents gap on a whole-dollar figure is Encompass rounding, not a mismatch');
assert.strictEqual(m.compareField('loan_amount', 450000, null).status, 'incomparable');
// An INPUT money field (NOT whole-dollar) still catches a one-cent gap.
assert.strictEqual(m.compareField('purchase_price', 450000, '450000.01').status, 'mismatch', 'a cent still mismatches on an exact-penny money field');
ok('money: whole-dollar figures absorb cents-rounding; input money fields stay exact-to-the-penny; null → incomparable');

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
assert.strictEqual(m.compareField('rehab_type', 'Cosmetic', 'Cosmetic Rehab').status, 'match', 'Cosmetic ≡ Cosmetic Rehab');
assert.strictEqual(m.compareField('rehab_type', 'Moderate', 'Light Rehab').status, 'match', 'Moderate ≡ Light Rehab');
assert.strictEqual(m.compareField('rehab_type', 'Ground-up construction', 'New construction').status, 'match', 'ground-up ≡ New construction');
// Owner-directed 2026-07-27: Cosmetic ≡ Light Rehab is the SAME tier — a Cosmetic file
// against Encompass "Light Rehab" must MATCH (it wrongly read "Doesn't match" before).
assert.strictEqual(m.compareField('rehab_type', 'Cosmetic', 'Light Rehab').status, 'match', 'Cosmetic ≡ Light Rehab (owner 2026-07-27)');
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

// ── Exit plan is now a REAL match (owner-directed 2026-07-26) ───────────────
// fix & flip ≡ Sale; fix & hold / rental ≡ Rental/Refinance.
assert.strictEqual(m.compareField('exit_plan', 'sell', 'Sale').status, 'match', 'flip → Sale matches');
assert.strictEqual(m.compareField('exit_plan', 'hold', 'Refinance: Rental').status, 'match', 'hold → Rental matches');
assert.strictEqual(m.compareField('exit_plan', 'sell', 'Refinance: Rental').status, 'mismatch', 'a real exit disagreement still mismatches');
ok('exit plan is matched (flip→Sale, hold→Rental), no longer reference-only');

// ── Empty ↔ zero is a MATCH on a numeric field (owner-directed 2026-07-26) ──
assert.strictEqual(m.compareField('assignment_fee', null, 0).status, 'match', 'our blank vs Encompass 0 is a match');
assert.strictEqual(m.compareField('assignment_fee', 0, null).status, 'match', 'our 0 vs Encompass blank is a match');
assert.strictEqual(m.compareField('financed_interest_reserve', null, 0).status, 'match', 'blank vs 0 reserve matches');
assert.strictEqual(m.compareField('assignment_fee', null, 25500).status, 'incomparable', 'blank vs a REAL number is still "no data"');
// The empty==zero rule is SCOPED to fields where 0 legitimately means "none".
// On a block-gated number where 0 is nonsense, a placeholder 0 must NOT read as a match.
for (const k of ['loan_amount', 'purchase_price', 'as_is_value', 'arv', 'units', 'rehab_budget']) {
  assert.strictEqual(m.compareField(k, null, 0).status, 'incomparable', `${k}: blank vs a placeholder 0 is NOT a match`);
}
assert.strictEqual(m.compareField('assignment_fee', null, null).status, 'incomparable', 'blank on both sides stays "no data"');
ok('an empty value equals zero on money fields; blank-vs-a-real-number still defers');

// ── Owner-directed 2026-07-27: Cosmetic and Light are the SAME (one 'light' tier) ───
assert.strictEqual(m.compareField('rehab_type', 'Cosmetic', 'Cosmetic Rehab').status, 'match');
assert.strictEqual(m.compareField('rehab_type', 'Cosmetic', 'Light Rehab').status, 'match', 'Cosmetic ≡ Light Rehab — same tier, however Encompass labels it');
assert.strictEqual(m.compareField('rehab_type', 'Moderate', 'Light Rehab').status, 'match', 'moderate collapses onto Encompass Light');
assert.strictEqual(m.compareField('rehab_type', 'Heavy', 'Heavy Rehab').status, 'match');
assert.strictEqual(m.compareField('rehab_type', 'expansion', 'Expansion').status, 'match');
assert.strictEqual(m.compareField('rehab_type', 'Heavy', 'Light Rehab').status, 'mismatch');
assert.strictEqual(m.compareField('rehab_type', 'Heavy', 'Cosmetic Rehab').status, 'mismatch', 'Heavy is still NOT the light tier');
// The app's REAL dropdown values (EditFileDetails REHAB_TYPES) must all resolve —
// 'Heavy / gut rehab' and 'Ground-up construction' previously mapped to NOTHING, so
// every heavy / ground-up file read "no data to compare" forever.
assert.strictEqual(m.compareField('rehab_type', 'Heavy / gut rehab', 'Heavy Rehab').status, 'match');

assert.strictEqual(m.compareField('rehab_type', 'Adding square footage', 'Expansion').status, 'match');
assert.strictEqual(m.compareField('rehab_type', 'Heavy / gut rehab', 'Light Rehab').status, 'mismatch');
ok('every real rehab-type dropdown value resolves (heavy/gut + ground-up construction no longer dark)');

// LIVE-VERIFIED 2026-07-26 against the tenant instance (loan YSCAP258134629 / 117 Brook):
// the AUTHORITATIVE source for vesting (1859) + origination (388) is the fieldReader —
// values read BY NUMBER, stashed on `_fieldValues`. The SAME field lives at a DIFFERENT
// JSON path from loan to loan, so a number we were GIVEN always beats a path we GUESSED.
{
  // Authoritative `_fieldValues` win — and the wrong GFE origination path (=2) is IGNORED
  // in favor of the real field 388 (=1). This is exactly the owner-reported case.
  const auth = m.extractFields({
    _fieldValues: { '1859': 'MW TRADING LLC', '388': '1.000' },
    closingDocument: { borrowerUnparsedName1: 'MW TRADING LLC' },
    closingCost: { gfe2010: { loanOriginationPercentage: 2 } }, // a DIFFERENT fee — must not win
  });
  assert.strictEqual(auth.vesting_llc, 'MW TRADING LLC', 'vesting reads the authoritative field 1859');
  assert.strictEqual(auth.origination_pct, 1, 'origination reads the authoritative field 388 (1%), NOT the GFE path (2%)');

  // FALLBACK when the fieldReader is unavailable: vesting still resolves from the loan
  // JSON — on 117 Brook the name lives at closingDocument.borrowerUnparsedName1, and the
  // classic finalVestingDescription path still works on loans that carry it.
  assert.strictEqual(m.extractFields({ closingDocument: { borrowerUnparsedName1: 'MW TRADING LLC' } }).vesting_llc, 'MW TRADING LLC', 'vesting falls back to borrowerUnparsedName1 (117 Brook shape)');
  assert.strictEqual(m.extractFields({ closingDocument: { finalVestingDescription: 'LAYBACK LLC, A LIMITED LIABILITY COMPANY' } }).vesting_llc, 'LAYBACK LLC, A LIMITED LIABILITY COMPANY', 'vesting still reads finalVestingDescription when present');

  // The wrong GFE origination path is NEVER read as field 388 — without the authoritative
  // value the field HONESTLY reads "no data" rather than the wrong 2%.
  assert.strictEqual(m.extractFields({ closingCost: { gfe2010: { loanOriginationPercentage: 2 } } }).origination_pct, undefined, 'the GFE loanOriginationPercentage (a different fee) is never read as field 388');

  // A full loan with NO customFields[] must still resolve its standard fields.
  assert.strictEqual(m.extractFields({ loanNumber: 'YS-1' }).ys_loan_number, 'YS-1');
  // …and a flat {fields:{}} envelope is still read as-is (back-compat).
  assert.strictEqual(m.extractFields({ fields: { '1109': { value: '450000' } } }).loan_amount, 450000);
}
// The appended legal description must not defeat the name match.
assert.strictEqual(m.compareField('vesting_llc', 'Layback LLC', 'LAYBACK LLC, A LIMITED LIABILITY COMPANY').status, 'match');
assert.strictEqual(m.compareField('vesting_llc', 'ABC Holdings LLC', 'ABC HOLDINGS LLC, A NEW YORK LIMITED LIABILITY COMPANY').status, 'match');
assert.strictEqual(m.compareField('vesting_llc', 'Layback LLC', 'OTHER HOLDINGS LLC, A LIMITED LIABILITY COMPANY').status, 'mismatch', 'a genuinely different entity still mismatches');
// MW Trading LLC (117 Brook) matches regardless of case/formatting.
assert.strictEqual(m.compareField('vesting_llc', 'MW Trading LLC', 'MW TRADING LLC').status, 'match');
ok('vesting (1859) + origination (388) read authoritatively by number; the GFE fee never masquerades as 388; the legal description never defeats the match');

// ── fieldReader response normalization (BOTH wire shapes → one { id: value } map) ──
// LIVE-VERIFIED 2026-07-26: this tenant's v3 returns an OBJECT map, v1 returns an ARRAY
// of { fieldId, value } pairs (ICE's own SDK types it as an array). The OLD reader
// accepted only the object and DISCARDED an array as `{}` — the failure that blanked
// _fieldValues and hid the LLC + origination fee. fieldReaderToMap accepts BOTH.
{
  const F = m.fieldReaderToMap;
  const objShape = { '1859': 'MW TRADING LLC', '388': '1.000', '364': 'YSCAP258134629' };
  const arrShape = [
    { fieldId: '1859', value: 'MW TRADING LLC' },
    { fieldId: '388', value: '1.000' },
    { fieldId: '364', value: 'YSCAP258134629' },
  ];
  assert.deepStrictEqual(F(objShape), objShape, 'object map (v3) passes through unchanged');
  assert.deepStrictEqual(F(arrShape), objShape, 'array of {fieldId,value} (v1) normalizes to the SAME map (was discarded as {} before)');
  assert.strictEqual(F([{ id: '388', value: '1.000' }])['388'], '1.000', 'accepts {id,value}');
  assert.strictEqual(F([{ fieldName: '1859', value: 'X' }])['1859'], 'X', 'accepts {fieldName,value}');
  assert.strictEqual(F({ '388': { value: '1.000' } })['388'], '1.000', 'unwraps a nested {value} cell');
  assert.deepStrictEqual(F(null), {}, 'null → {}');
  assert.deepStrictEqual(F('nope'), {}, 'a scalar → {} (never throws)');
  // End-to-end: the normalized array feeds flattenLoan authoritatively.
  const viaArray = m.extractFields({ _fieldValues: F(arrShape) });
  assert.strictEqual(viaArray.vesting_llc, 'MW TRADING LLC');
  assert.strictEqual(viaArray.origination_pct, 1);
}
ok('fieldReader response normalizes from BOTH the object map (v3) and the array (v1) into one field map');

// A BLANK customFields cell must not shadow a good standard-field loanPath —
// that is precisely how vesting (1859) / origination (388) read as "no data".
{
  const withBlank = m.extractFields({
    customFields: [{ fieldName: '1859', value: '' }, { fieldName: '388', value: '' }],
    vesting: { entityName: 'ABC Holdings LLC' }, originationFeePercent: 1.25,
  });
  assert.strictEqual(withBlank.vesting_llc, 'ABC Holdings LLC', 'blank custom cell falls through to the loanPath');
  assert.strictEqual(withBlank.origination_pct, 1.25);
  // A REAL custom value still wins over the loanPath.
  const withReal = m.extractFields({
    customFields: [{ fieldName: '388', value: '2.5' }], originationFeePercent: 1.25,
  });
  assert.strictEqual(withReal.origination_pct, 2.5, 'a real custom-field value is never overridden by a loanPath');
}
ok('rehab type maps onto Encompass Light / Heavy / Expansion');

// ── Reference fields: surfaced, never compared; PITIA removed ───────────────
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
assert.strictEqual(m.BY_KEY.exit_plan.gate, m.GATE.ADVISORY, 'exit plan is now matched (advisory gate), no longer reference-only');
assert.strictEqual(m.BY_KEY.exit_plan.compare, 'enum', 'exit plan is a real enum compare');
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
assert.ok(!m.REGISTRY.some((e) => /MIDDLESCORE|\bFICO\b|SSN|TAXIDENT|WHICHINVESTOR/i.test(e.encompassFieldId)),
  'no credit / SSN / capital-partner fields in the economics registry');
const ssn = m.IDENTITY_MAP.find((e) => e.key === 'ssn');
const dob = m.IDENTITY_MAP.find((e) => e.key === 'date_of_birth');
assert.ok(ssn && ssn.sensitive === true && ssn.match === 'ssnHash', 'SSN identity is hash-only + sensitive');
assert.ok(dob && dob.sensitive === true, 'DOB identity is flagged sensitive');
assert.ok(m.IDENTITY_MAP.find((e) => e.key === 'vesting_llc'), 'identity map includes the 1859 vesting match');
// Capital provider IS in the registry now (owner-directed 2026-07-26) — a
// deliberate STAFF-ONLY comparison so the note buyer can't silently disagree with
// Encompass. Credit score / SSN / tax id stay excluded.
assert.ok(m.BY_KEY.capital_provider, 'note buyer / capital provider is compared');
assert.strictEqual(m.BY_KEY.capital_provider.gate, m.GATE.ADVISORY, 'capital provider is advisory (our side is free text)');
// Encompass dropdown read LIVE 2026-07-26 — every option must resolve.
for (const [ours, theirs] of [['Fidelis', 'Fidelis Investors'], ['Blue Lake', 'BlueLake'], ['CorrFirst', 'CorrFirst'],
  ['EMCAP', 'EMCAP'], ['RCN', 'RCN'], ['Roc Capital', 'Roc Capital'], ['Temple View Capital', 'Temple View Capital']]) {
  assert.strictEqual(m.compareField('capital_provider', ours, theirs).status, 'match', `${ours} should match ${theirs}`);
}
assert.strictEqual(m.compareField('capital_provider', 'Fidelis', 'BlueLake').status, 'mismatch', 'a genuinely different buyer still flags');
ok('note buyer maps onto the live Encompass capital-provider dropdown (Fidelis ≡ Fidelis Investors, EMCAP, …)');

// Owner-reported 2026-07-27: "Fidelis Investors LLC" (ours) vs "Fidelis Investors"
// (Encompass) read "No data to compare" while plainly showing data — it must be an
// EXACT MATCH. A trailing corporate form (LLC/Inc/…) and stray punctuation are stripped
// before the value-map lookup; every Fidelis variant lands on one token.
for (const [ours, theirs] of [
  ['Fidelis Investors LLC', 'Fidelis Investors'],
  ['Fidelis Investors, LLC', 'Fidelis Investors'],
  ['Fidelis Investors L.L.C.', 'Fidelis'],
  ['Blue Lake Capital LLC', 'BlueLake'],
]) {
  assert.strictEqual(m.compareField('capital_provider', ours, theirs).status, 'match', `${ours} should MATCH ${theirs} (corporate form ignored)`);
}
// NAME FALLBACK: a note buyer NOT in the value map still compares by name when both
// sides carry one — a variant of the SAME buyer matches, a different buyer mismatches,
// and ONLY a genuinely empty side reads "no data to compare".
assert.strictEqual(m.compareField('capital_provider', 'Acme Bridge Capital LLC', 'Acme Bridge Capital').status, 'match', 'unmapped buyer, same name (corp form) → match via name fallback');
assert.strictEqual(m.compareField('capital_provider', 'Acme Bridge Capital', 'Zenith Funding').status, 'mismatch', 'unmapped buyers, different names → mismatch (not "no data")');
assert.strictEqual(m.compareField('capital_provider', 'Fidelis Investors LLC', null).status, 'incomparable', 'ONLY a truly empty side is "no data to compare"');
assert.strictEqual(m.compareField('capital_provider', '', 'Fidelis Investors').status, 'incomparable', 'blank our side is "no data to compare"');
// The helpers behave as documented.
assert.strictEqual(m._internals.stripCorpForm('fidelis investors llc'), 'fidelis investors', 'stripCorpForm removes a trailing LLC');
assert.strictEqual(m._internals.normPartnerName('Fidelis Investors, L.L.C.'), 'fidelis investors', 'normPartnerName normalizes punctuation + corporate form');
ok('capital provider: LLC/Inc/spelling variants of the SAME buyer MATCH; unmapped buyers compare by name; "no data" only when a side is truly empty');

// Owner-reported 2026-08-06: our side reads "EMCAP Financial", Encompass reads "EMCAP"
// — the same note buyer. "Financial" is a descriptive word (NOT a corporate form the
// name-fallback strips), so both spellings are enumerated onto the one 'emcap' token.
for (const [ours, theirs] of [
  ['EMCAP Financial', 'EMCAP'],
  ['EMCAP', 'EMCAP Financial'],
  ['EMCAP Financial LLC', 'EMCAP'],
  ['Em Cap Financial', 'EMCAP'],
]) {
  assert.strictEqual(m.compareField('capital_provider', ours, theirs).status, 'match', `${ours} should MATCH ${theirs} (EMCAP alias)`);
}
assert.strictEqual(m.compareField('capital_provider', 'EMCAP', 'Fidelis').status, 'mismatch', 'EMCAP vs a different buyer still flags');
ok('note buyer: "EMCAP Financial" ≡ "EMCAP" match');

// Owner-reported 2026-08-06: Encompass stores the computed loan/cost figures as WHOLE
// DOLLARS (no cents), so PILOT's cent-precise figure vs Encompass's rounded one is a
// MATCH, not a mismatch — e.g. total cost $2,598,093.72 vs $2,598,094.
assert.strictEqual(m._internals.WHOLE_DOLLAR_TOL, 1, 'whole-dollar tolerance is $1 (inclusive)');
assert.strictEqual(m.compareField('total_cost', 2598093.72, 2598094).status, 'match', 'total cost: cents vs whole-dollar rounding is a MATCH');
assert.strictEqual(m.compareField('loan_amount', 2598093, 2598094).status, 'match', 'loan amount: floor vs round ($1 apart) is a MATCH');
assert.strictEqual(m.compareField('final_initial_loan', 174921.4, 174921).status, 'match', 'initial advance: sub-dollar gap is a MATCH');
assert.strictEqual(m.compareField('financed_interest_reserve', 12000.5, 12000).status, 'match', 'financed reserve: sub-dollar gap is a MATCH');
assert.strictEqual(m.compareField('loan_amount', 500000, 500001).status, 'match', 'a $1 loan-amount gap is rounding — a MATCH (owner 2026-08-06)');
// A genuine >$1 disagreement on a whole-dollar figure STILL flags.
assert.strictEqual(m.compareField('total_cost', 2598093, 2599100).status, 'mismatch', 'a real (>$1) total-cost gap still flags');
assert.strictEqual(m.compareField('loan_amount', 500000, 500002).status, 'mismatch', 'a $2 loan-amount gap is beyond rounding — still flags');
// The tolerance is SCOPED to the whole-dollar figures — an ordinary money field
// (purchase price, an input) stays exact-to-the-penny, so a $1 gap there still flags.
assert.strictEqual(m.compareField('purchase_price', 500000, 500001).status, 'mismatch', 'a $1 purchase-price gap still flags (not a whole-dollar field)');
assert.strictEqual(m.compareField('purchase_price', 500000, 500000.004).status, 'match', 'purchase price keeps the half-cent float tolerance');
ok('whole-dollar figures (loan/cost/sizing) tolerate Encompass cents-rounding; input money fields stay exact-to-the-penny');

ok('PII governance: economics registry is PII-free; SSN/DOB sensitive; 1859 vesting in identity map');

// identityFieldIds() — every standard IDENTITY_MAP field id for BOTH parties, so the
// fieldReader can read borrower/co-borrower identity BY NUMBER (owner-directed 2026-08-02,
// YSCAP258134762). This is what recovers a co-borrower the stored applications[] subtree
// left out. Derived from IDENTITY_MAP.stdFieldId so it can never drift from the map.
{
  const ids = m.identityFieldIds();
  const set = new Set(ids);
  // Borrower + co-borrower name / DOB / email / phone / SSN std ids are all present.
  for (const id of ['4000', '4002', '4001', '1402', '1240', '66', '1490', '4533', '65',   // borrower
                    '4004', '4006', '4005', '1403', '1268', '98', '1480', '4534', '97']) { // co-borrower
    assert.ok(set.has(id), `identityFieldIds includes ${id}`);
  }
  // The SSN ids ARE fetched (65/97) — the raw value is hashed + stripped in the reader
  // layer before storage, never here.
  assert.ok(set.has('65') && set.has('97'), 'SSN ids fetched by number (hashed downstream, never stored raw)');
  // Deduped (a Set-clean list), and no empty entries.
  assert.strictEqual(ids.length, new Set(ids).size, 'identityFieldIds is deduped');
  assert.ok(ids.every((x) => typeof x === 'string' && x !== ''), 'every id is a non-empty string');
}
ok('identityFieldIds(): borrower + co-borrower name/DOB/email/phone/SSN std ids, derived from IDENTITY_MAP, deduped');

// flattenLoan stays REGISTRY-ONLY even though `_fieldValues` now also carries identity
// (name/DOB/email/phone) + the keyed-HMAC SSN keys + the `_idRead` marker for the
// co-borrower recovery (which reads `_fieldValues` directly). Those must NEVER leak into
// the economics extract or the super-admin raw diagnostic.
{
  const loan = { _fieldValues: {
    '1859': 'MW TRADING LLC',            // economics (registry) — kept
    '388': '1.000',                       // economics (registry) — kept
    '4004': 'Patrick', '4006': 'Kamara',  // identity name — dropped
    '1268': 'p@x.com', '1403': '1999-08-30', '98': '7322095023',  // identity — dropped
    '_ssn_cb_hash': 'deadbeef', '_ssn_cb_last4': '8028',           // hashed SSN — dropped
    '_idRead': 1,                         // marker — dropped
  } };
  const flat = m.flattenLoan(loan).fields;
  assert.ok(flat['1859'] && flat['1859'].value === 'MW TRADING LLC', 'economics 1859 kept');
  assert.ok(flat['388'] && flat['388'].value === '1.000', 'economics 388 kept');
  for (const k of ['4004', '4006', '1268', '1403', '98', '_ssn_cb_hash', '_ssn_cb_last4', '_idRead']) {
    assert.ok(!(k in flat), `flattenLoan drops non-registry key ${k} (identity/SSN/marker never leaks)`);
  }
  // extractFields surfaces ONLY registry keys — no identity ever bleeds into economics.
  const out = m.extractFields(loan);
  assert.ok(!('first_name' in out) && !('date_of_birth' in out) && !('email' in out), 'extractFields surfaces no identity key');
  assert.strictEqual(out.vesting_llc, 'MW TRADING LLC', 'extractFields still reads the registry vesting value by number');
}
ok('flattenLoan/extractFields stay registry-only: identity, hashed-SSN, and the _idRead marker never leak from _fieldValues');

console.log(`\nWO-A Encompass field-map pure — ${passed} checks passed`);
