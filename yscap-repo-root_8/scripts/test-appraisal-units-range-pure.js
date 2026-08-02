'use strict';
/**
 * Pure test for the property-type / unit-count comparison fix (owner-reported 2026-07-24).
 *
 * Our file's property_type is a RANGE CATEGORY (sfr = 1 unit, multi_2_4, multi_5_plus,
 * condo = 1), while the appraisal reports a SPECIFIC unit count. The old code string-
 * compared the range category to the appraisal's specific type/form, so EVERY multi-family
 * file falsely fired a fatal "property type disagrees — appraisal 2 unit, file 2-4". The fix
 * judges by the appraisal's real UNIT COUNT against the range the property_type implies.
 *
 * No DB, no XML fixture — drives computeFindings + propertyTypeUnitRange directly.
 * Run: node scripts/test-appraisal-units-range-pure.js
 */
const assert = require('assert');
const { computeFindings } = require('../src/lib/appraisal/findings');
const { propertyTypeUnitRange } = require('../src/lib/mismo/enums');

let n = 0; const ok = (c, m) => { n++; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) { failures++; } };
let failures = 0;

// Minimal appraisal object: address matches the file (so no address_mismatch), a form type
// + a parsed subject unit count. `values` empty so no arv/comp findings interfere.
// `propertyCategory` is derived the SAME way extract() derives it (from the form + the unit count),
// rather than hard-coded — so this fixture cannot claim a category the real parser would not
// produce (owner-reported 2026-08-02: the appraisal's property type is a CATEGORY, never the
// Detached / Attached attachment style).
const { derivePropertyCategory } = require('../src/lib/appraisal/property-category');
const A = (formType, units, extra = {}) => {
  const cat = derivePropertyCategory({ formType, units });
  return Object.assign({
    ok: true, formType, values: {},
    subject: { address: '10 Main St', city: 'Town', state: 'NY', units, propertyCategory: cat ? cat.key : null },
  }, extra);
};
const F = (property_type, units) => ({ property_type, units, property_address: { line: '10 Main St', city: 'Town', state: 'NY' } });
const codes = (finds) => finds.map((f) => f.code);
const byCode = (finds, code) => finds.find((f) => f.code === code) || null;

// ── propertyTypeUnitRange ──────────────────────────────────────────────
assert.deepStrictEqual(propertyTypeUnitRange('sfr'), { min: 1, max: 1 });
ok(true, 'range(sfr) = 1–1');
assert.deepStrictEqual(propertyTypeUnitRange('multi_2_4'), { min: 2, max: 4 });
ok(true, 'range(multi_2_4) = 2–4');
assert.deepStrictEqual(propertyTypeUnitRange('condo'), { min: 1, max: 1 });
ok(true, 'range(condo) = 1–1');
const m5 = propertyTypeUnitRange('multi_5_plus');
ok(m5.min === 5 && m5.max === Infinity, 'range(multi_5_plus) = 5–∞');
ok(propertyTypeUnitRange('mixed_use') === null, 'range(mixed) = null (no unit constraint)');
ok(propertyTypeUnitRange('') === null && propertyTypeUnitRange(null) === null, 'range(blank/null) = null (never guess)');
// tolerant of the dash/label spellings the app stores
assert.deepStrictEqual(propertyTypeUnitRange('Multi 2–4'), { min: 2, max: 4 });
ok(true, 'range("Multi 2–4" label) = 2–4 (norm-tolerant)');

// ── THE BUG: a 2-unit appraisal on a Multi 2–4 file must NOT fatal ──────
let f = computeFindings(A('FNM1025', 2), F('multi_2_4', 2));
ok(!byCode(f, 'property_type_mismatch'), 'multi_2_4 file + 2-unit (1025) appraisal → NO property_type_mismatch (2 is within 2–4) [the reported false fatal]');
ok(!byCode(f, 'units_mismatch'), 'multi_2_4 file + matching 2 units → NO units_mismatch');

// a 3-unit appraisal on a Multi 2–4 file, file units also 3 → still consistent (3 in 2–4)
f = computeFindings(A('FNM1025', 3), F('multi_2_4', 3));
ok(!byCode(f, 'property_type_mismatch'), 'multi_2_4 file + 3-unit appraisal → consistent (3 within 2–4)');

// ── REAL conflicts still fire (unit count outside the range) ────────────
f = computeFindings(A('FNM1004', 3), F('sfr', null));   // SFR file, appraisal shows 3 units
const ptm = byCode(f, 'property_type_mismatch');
ok(ptm && ptm.severity === 'fatal', 'sfr file + 3-unit appraisal → property_type_mismatch FATAL (3 outside 1–1)');
ok(ptm && /3 units/.test(ptm.title) && /sfr/.test(ptm.title), 'the fatal reports the unit count, not a raw category string');

f = computeFindings(A('FNM1025', 2), F('multi_5_plus', null));   // 5+ file, appraisal 2 units
const m5f = byCode(f, 'property_type_mismatch');
ok(!!m5f, 'multi_5_plus file + 2-unit appraisal → fatal (2 < 5)');
// The property-type fatal must NOT offer replace/custom — the appraisal can't supply a
// valid property_type category, so writing it back would corrupt the enum (audit issue 1).
ok(m5f && !m5f.actions.includes('replace') && !m5f.actions.includes('custom'),
  'property_type_mismatch offers NO replace/custom (appraisal has no valid category to write back)');
ok(m5f && !m5f.reprices, 'property_type_mismatch is not a reprice action');

f = computeFindings(A('FNM1025', 5), F('multi_2_4', null));   // 2–4 file, appraisal 5 units
ok(byCode(f, 'property_type_mismatch'), 'multi_2_4 file + 5-unit appraisal → fatal (5 > 4)');

// ── the genuine count-vs-count units_mismatch still fires ───────────────
f = computeFindings(A('FNM1025', 2), F('multi_2_4', 3));   // both in-range, but counts differ
ok(byCode(f, 'units_mismatch'), 'file units 3 vs appraisal 2 → units_mismatch still fires (a real change)');
ok(!byCode(f, 'property_type_mismatch'), '…and it is NOT double-reported as a property_type_mismatch (2 is within 2–4)');

// ── same-unit-count STYLE difference → advisory, never a blocking fatal ──
f = computeFindings(A('FNM1073', 1), F('sfr', 1));   // condo form vs sfr file, both 1 unit
ok(!byCode(f, 'property_type_mismatch'), 'sfr file + condo(1073) form, both 1 unit → NO fatal (unit-count agrees)');
const style = byCode(f, 'property_style_note');
ok(style && style.severity === 'warning' && style.blocksCtc === false, 'sfr vs condo (same 1 unit) → non-blocking property_style_note advisory');
ok(style && !style.actions.includes('replace') && !style.actions.includes('custom'),
  'property_style_note offers NO replace/custom either (property_type is a pricing input — corrected on the application, never written back from a finding)');
// Both sides of the advisory are stated in the portal's own words — never a MISMO form code.
ok(style && style.appraisalValue === 'Condo' && !/FNM/.test(String(style.appraisalValue)),
  'property_style_note names the appraisal CATEGORY ("Condo"), not the form code');

// ── twin bucketing: appraisal's specific type agrees with the file's range category ──
const { canonPropertyType } = require('../src/lib/underwriting/facts');
ok(canonPropertyType('Two Family') === 'multi_2_4' && canonPropertyType('Multi 2-4') === 'multi_2_4',
  'canonPropertyType buckets "Two Family" and "Multi 2-4" to the same class (twin no longer disputes multi-family)');
ok(canonPropertyType('Duplex') === 'multi_2_4' && canonPropertyType('Single Family Detached') === 'sfr',
  'canonPropertyType buckets duplex→multi_2_4 and detached→sfr');

// ── never guesses: unknown property_type or missing appraisal count = silent ──
f = computeFindings(A('FNM1025', 2), F('mixed_use', null));   // mixed-use = no unit constraint
ok(!byCode(f, 'property_type_mismatch'), 'mixed-use file (no unit constraint) → no property_type_mismatch');
f = computeFindings(A(undefined, null), F('multi_2_4', null));   // no appraisal unit count / form
ok(!byCode(f, 'property_type_mismatch'), 'no appraisal unit count → silent (never guessed)');

console.log(failures ? `\n${failures} FAILURE(S)` : `\nOK  appraisal-units-range-pure: ${n} checks — property type judged by unit count, false multi-family fatal gone, real conflicts + count mismatch preserved`);
process.exit(failures ? 1 : 0);
