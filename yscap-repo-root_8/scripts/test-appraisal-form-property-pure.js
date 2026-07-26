'use strict';
/**
 * THE APPRAISAL FORM IS EVIDENCE (owner-directed 2026-07-26).
 *
 * The owner's instruction, verbatim: *"if it's a 1025 appraisal form it must match with property
 * type 2-4. If it's a 1073 then it must match with property type condo. If it's a 1004 then it must
 * match with single family … we should also make sure that our file not only matches with the
 * property type, it matches also with the exact unit count. And this 'detached' — it's a phrase and
 * it's nothing."*
 *
 * WHY THE FORM AND NOT THE STYLE WORD. An appraiser cannot report a duplex on a 1004 or a condo on
 * a 1025: the forms are written for a category and the agencies will not accept them otherwise.
 * That makes the form number a HARD statement about the property. "Detached" is a STYLE word that
 * says nothing about how many units there are, which is exactly why comparing it to the file's
 * range category ("Multi 2–4") produced a mismatch on every multi-family file. It is now compared
 * against nothing at all.
 *
 * THE DANGEROUS HALF of a check like this is a FALSE mismatch on a good file — the owner has
 * already lived through one. So the correct-pairing and never-guess assertions below outnumber the
 * mismatch ones.
 *
 * Pure: no DB, no AI, no network.
 */
const R = require('path').resolve(__dirname, '..');
const { underwriteAppraisal } = require(R + '/src/lib/underwriting/appraisal-underwriter');
const { appraisalFormExpectation } = require(R + '/src/lib/property-type');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// The appraisal always carries a value, so the value checks stay silent and only the
// property/units/form findings are under test.
const run = (fileValues, appraisal) => {
  const r = underwriteAppraisal({
    appraisal: Object.assign({ as_is_value: 100000, appraised_value: 100000 }, appraisal),
    context: { values: fileValues },
  }) || {};
  return (r.findings || []).map((f) => f.code);
};
const has = (codes, c) => codes.indexOf(c) !== -1;

// ─────────────────── the three form → property type contracts ───────────────────
const FORM_MAP = [
  { form: 'FNM1004', type: 'SFR',       units: 1, label: 'single family' },
  { form: 'FNM1025', type: 'Multi 2–4', units: 3, label: '2–4 family' },
  { form: 'FNM1073', type: 'Condo',     units: 1, label: 'condominium' },
];
for (const m of FORM_MAP) {
  const exp = appraisalFormExpectation(m.form);
  ok(!!exp, `${m.form} maps to an expectation`);
  const codes = run({ property_type: m.type, units: m.units }, { form_type: m.form, units: m.units });
  ok(!has(codes, 'appraisal_form_property_type_mismatch'),
    `${m.form} on a ${m.type} file (${m.label}) raises nothing (got ${JSON.stringify(codes)})`);
  ok(!has(codes, 'appraisal_form_units_mismatch'),
    `${m.form} reporting ${m.units} unit(s) is internally consistent`);
}
// The form is recognized however it is written — bare number, FNMA prefix, spaces, "Form 1025".
for (const spelling of ['1025', 'FNM1025', 'FNMA-1025', 'Form 1025', 'fnm 1025']) {
  const e = appraisalFormExpectation(spelling);
  ok(e && e.propertyKey === 'multi_2_4', `"${spelling}" is recognized as the 2–4 family form`);
}

// ─────────────────── a WRONG form for the file's type is caught ───────────────────
const wrongPairs = [
  ['FNM1004', 'Multi 2–4'], ['FNM1025', 'SFR'], ['FNM1073', 'Multi 2–4'], ['FNM1004', 'Condo'],
];
for (const [form, type] of wrongPairs) {
  ok(has(run({ property_type: type, units: 1 }, { form_type: form, units: 1 }), 'appraisal_form_property_type_mismatch'),
    `a ${form} against a ${type} file is raised`);
}

// ─────────────────── a form that contradicts its OWN unit count ───────────────────
// One document disagreeing with itself: either the count was misread or the wrong form was used.
ok(has(run({ property_type: 'SFR', units: 3 }, { form_type: 'FNM1004', units: 3 }), 'appraisal_form_units_mismatch'),
  'a 1004 reporting 3 units contradicts itself');
ok(has(run({ property_type: 'Multi 2–4', units: 1 }, { form_type: 'FNM1025', units: 1 }), 'appraisal_form_units_mismatch'),
  'a 1025 reporting 1 unit contradicts itself');
ok(has(run({ property_type: 'Condo', units: 4 }, { form_type: 'FNM1073', units: 4 }), 'appraisal_form_units_mismatch'),
  'a 1073 reporting 4 units contradicts itself');
ok(!has(run({ property_type: 'Multi 2–4', units: 4 }, { form_type: 'FNM1025', units: 4 }), 'appraisal_form_units_mismatch'),
  '4 units is the TOP of the 1025 range and is fine');
ok(!has(run({ property_type: 'Multi 2–4', units: 2 }, { form_type: 'FNM1025', units: 2 }), 'appraisal_form_units_mismatch'),
  '2 units is the BOTTOM of the 1025 range and is fine');

// ─────────────────── the EXACT unit count, file vs appraisal ───────────────────
// Being inside the right category is not enough: 2 units and 3 units are both "Multi 2–4" and are
// still a discrepancy the underwriter has to settle.
ok(has(run({ property_type: 'Multi 2–4', units: 2 }, { form_type: 'FNM1025', units: 3 }), 'appraisal_units_mismatch'),
  'file 2 units vs appraisal 3 is raised even though both are Multi 2–4');
ok(!has(run({ property_type: 'Multi 2–4', units: 3 }, { form_type: 'FNM1025', units: 3 }), 'appraisal_units_mismatch'),
  'an exact match raises nothing');

// ─────────────────── "Detached" is a phrase and it is nothing ───────────────────
// The owner's original defect. The style word must not be able to produce a finding on its own.
for (const style of ['Detached', 'Attached', 'Semi-Detached', 'Row/Townhouse', '']) {
  const codes = run({ property_type: 'Multi 2–4', units: 3 }, { form_type: 'FNM1025', units: 3, property_type: style });
  ok(codes.length === 0, `appraisal style "${style}" produces no finding by itself (got ${JSON.stringify(codes)})`);
}

// ─────────────────── never guess ───────────────────
// A form that says nothing definite about the category must stay silent, not be forced into one.
for (const form of ['FNM2055', 'FNM1007', 'FNM216', '', null, undefined, 'not a form']) {
  ok(appraisalFormExpectation(form) == null, `${JSON.stringify(form)} carries no property-type claim`);
  ok(!has(run({ property_type: 'SFR', units: 1 }, { form_type: form, units: 1 }), 'appraisal_form_property_type_mismatch'),
    `${JSON.stringify(form)} never produces a form mismatch`);
}
// Missing data on either side is silence, never an accusation.
ok(!has(run({ property_type: 'Multi 2–4' }, { form_type: 'FNM1025' }), 'appraisal_form_units_mismatch'),
  'no unit count read → no unit claim');
ok(!has(run({ units: 3 }, { form_type: 'FNM1025', units: 3 }), 'appraisal_form_property_type_mismatch'),
  'no property type on the file → no property-type claim');
ok(!has(run({ property_type: 'Mixed Use', units: 6 }, { form_type: 'FNM2055', units: 6 }), 'appraisal_property_type_mismatch'),
  'mixed use carries no unit-count constraint and stays silent');

// Nothing here may ever block on its own — these are advisory findings for a human to settle.
const blockers = (underwriteAppraisal({
  appraisal: { as_is_value: 100000, appraised_value: 100000, form_type: 'FNM1004', units: 3 },
  context: { values: { property_type: 'Multi 2–4', units: 3 } },
}).findings || []).filter((f) => /form/.test(f.code) && (f.blocks_ctc || f.blocks_funding || f.blocks_term_sheet));
ok(blockers.length === 0, `a form disagreement is advisory, never a block (got ${JSON.stringify(blockers.map((f) => f.code))})`);

console.log(`test-appraisal-form-property-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
