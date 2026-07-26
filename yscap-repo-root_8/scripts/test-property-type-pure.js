'use strict';
/**
 * Pure test — src/lib/property-type.js, the JS half of the db/322 root fix for
 * the owner-reported 2026-07-26 "Property type: FNM1025 → Multi 2–4" re-register.
 *
 *   node scripts/test-property-type-pure.js
 *
 * Covers the two halves of the bug:
 *   1. An appraisal FORM number is recognized as NOT a property type and is
 *      refused at the doors (and never guessed into a category as INPUT).
 *   2. Every spelling of the same category compares EQUAL, so a re-spelling can
 *      never look like a pricing change — while genuinely different types, and
 *      genuinely unknown options, still compare as different.
 */
const R = require('path').resolve(__dirname, '..');
const PT = require(R + '/src/lib/property-type');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// ---- 1. an appraisal form number is not a property type -------------------
for (const code of ['FNM1025', 'FNM 1025', 'fnm-1025', 'FNMA1004', 'Form 1073', '1025', '1004', '1073', 'URAR', 'fnm1004d']) {
  ok(PT.isAppraisalFormCode(code) === true, `"${code}" is recognized as an appraisal form code`);
  ok(PT.propertyTypeKey(code) === null, `"${code}" never resolves to a property category as INPUT`);
  ok(PT.sanitizePropertyType(code) === null, `"${code}" is refused by the write doors`);
  ok(/appraisal form number/.test(PT.propertyTypeProblem(code) || ''), `"${code}" gets a plain-language refusal reason`);
}
// The refusal names the type the form is for, so staff know what to pick.
ok(/Multi 2–4/.test(PT.propertyTypeProblem('FNM1025') || ''), 'the FNM1025 refusal points staff at "Multi 2–4"');
ok(/SFR/.test(PT.propertyTypeProblem('FNM1004') || ''), 'the FNM1004 refusal points staff at the SFR type');

// Real property types are NEVER mistaken for a form code.
for (const good of ['SFR (1 unit)', 'Multi 2–4', 'Multi 2-4', 'multi_2_4', 'Multi 5+', 'Condo', 'Townhouse',
  'Mixed use', 'PUD', 'Duplex', 'New Construction', '2-4 Family', 'Single Family']) {
  ok(PT.isAppraisalFormCode(good) === false, `"${good}" is NOT flagged as a form code`);
  ok(PT.sanitizePropertyType(good) === good, `"${good}" passes the write doors unchanged`);
  ok(PT.propertyTypeProblem(good) === null, `"${good}" raises no refusal`);
}
ok(PT.sanitizePropertyType(null) === null && PT.sanitizePropertyType('') === null, 'blank is a no-write, not a refusal');
ok(PT.propertyTypeProblem('') === null && PT.propertyTypeProblem(null) === null, 'blank raises no error message');

// ---- 2. category resolution ------------------------------------------------
const KEY = [
  ['SFR (1 unit)', 'sfr'], ['sfr', 'sfr'], ['Single Family', 'sfr'], ['Detached', 'sfr'], ['1 unit', 'sfr'],
  ['Multi 2–4', 'multi_2_4'], ['Multi 2-4', 'multi_2_4'], ['multi_2_4', 'multi_2_4'], ['2-4 Family', 'multi_2_4'],
  ['Duplex', 'multi_2_4'], ['Triplex', 'multi_2_4'], ['Fourplex', 'multi_2_4'],
  ['Multi 5+', 'multi_5_plus'], ['multi_5_plus', 'multi_5_plus'], ['Multifamily 5+', 'multi_5_plus'],
  ['Condo', 'condo'], ['Warrantable condo', 'condo'], ['Co-Op', 'condo'],
  ['Townhouse', 'townhouse'], ['Townhome', 'townhouse'],
  ['PUD', 'pud'], ['Planned Unit Development', 'pud'],
  ['Mixed use', 'mixed_use'], ['Mixed Use', 'mixed_use'],
];
for (const [raw, key] of KEY) ok(PT.propertyTypeKey(raw) === key, `"${raw}" → ${key} (got ${PT.propertyTypeKey(raw)})`);

// An unknown-but-plausible option is NEVER guessed into a category…
ok(PT.propertyTypeKey('New Construction') === null, 'an unrecognized option is not guessed into a category');
// …but it still compares to ITSELF, so it can't look like a change either.
ok(PT.propertyTypesEquivalent('New Construction', 'new construction') === true, 'an unrecognized option compares to itself');
ok(PT.propertyTypesEquivalent('New Construction', 'Condo') === false, 'an unrecognized option is not equal to a real type');

// ---- 3. THE BUG: a re-spelling is not a change ----------------------------
ok(PT.propertyTypesEquivalent('Multi 2-4', 'Multi 2–4') === true, 'hyphen vs en-dash is the SAME type (ClickUp vs portal)');
ok(PT.propertyTypesEquivalent('multi_2_4', 'Multi 2–4') === true, 'the rule KEY is the same type as the portal LABEL');
ok(PT.propertyTypesEquivalent('MULTI 2-4', 'multi 2-4') === true, 'case-only re-spelling is the same type');
ok(PT.propertyTypesEquivalent(' Condo ', 'Condo') === true, 'whitespace-only re-spelling is the same type');
ok(PT.propertyTypesEquivalent(null, '') === true, 'both-blank counts as the same');
// …and a REAL change is still a change.
ok(PT.propertyTypesEquivalent('SFR (1 unit)', 'Multi 2–4') === false, 'SFR → Multi 2–4 is a REAL change');
ok(PT.propertyTypesEquivalent('Condo', 'Townhouse') === false, 'Condo → Townhouse is a REAL change');
ok(PT.propertyTypesEquivalent(null, 'Multi 2–4') === false, 'filling a BLANK type is still a real change');
// A form code compares as "no type", so replacing it is a repair, not a change.
ok(PT.propertyTypeCompareKey('FNM1025') === null, 'a form code carries no comparable type');

// ---- 4. canonical labels + the repair mapping ------------------------------
ok(PT.canonicalPropertyTypeLabel('multi_2_4') === 'Multi 2–4', 'the key canonicalizes to the portal label');
ok(PT.canonicalPropertyTypeLabel('Multi 2-4') === 'Multi 2–4', 'the ClickUp spelling canonicalizes to the portal label');
ok(PT.canonicalPropertyTypeLabel('New Construction') === null, 'an unrecognized option has no canonical label');
// guessFromFormCode exists ONLY to repair files that already store a form code.
ok(PT.guessFromFormCode('FNM1025') === 'multi_2_4', '1025 is the 2–4 unit form');
ok(PT.guessFromFormCode('FNM1004') === 'sfr', '1004 is the single-family form');
ok(PT.guessFromFormCode('FNM1073') === 'condo', '1073 is the condo form');
ok(PT.guessFromFormCode('2055') === null, 'a form with no definite category is never guessed');
ok(PT.guessFromFormCode('Multi 2–4') === null, 'a real property type is not treated as a form');

// ---- 5. the detectors that consume this ------------------------------------
const { detectStale } = require(R + '/src/lib/underwriting/stale-detector');
ok(detectStale({ property_type: 'Multi 2–4' }, { property_type: 'Multi 2-4' }).stale === false,
  'stale-detector: a property-type re-spelling is NOT stale drift');
ok(detectStale({ property_type: 'Multi 2–4' }, { property_type: 'multi_2_4' }).stale === false,
  'stale-detector: the rule key vs the portal label is NOT stale drift');
ok(detectStale({ property_type: 'Multi 2–4' }, { property_type: 'FNM1025' }).stale === false,
  'stale-detector: correcting a stored form code is a repair, not stale drift');
ok(detectStale({ property_type: 'Multi 2–4' }, { property_type: 'SFR (1 unit)' }).stale === true,
  'stale-detector: a REAL property-type change is still stale');
// `term` is not one of the detector's PRICING_INPUT_KEYS, but a caller may pass it
// explicitly — when it does, it must compare by meaning too (the db/288 twin).
ok(detectStale({ term: '12 Months' }, { term: '12' }, ['term']).stale === false,
  'stale-detector: a term re-spelling is NOT stale drift (db/288 twin)');
ok(detectStale({ term: '18 Months' }, { term: '12' }, ['term']).stale === true,
  'stale-detector: a REAL term change is still stale');

const FZ = require(R + '/src/lib/inbound-economics-freeze');
ok(FZ.changedFrozenFields({ property_type: 'Multi 2-4' }, { property_type: 'Multi 2–4' }).length === 0,
  'freeze: a ClickUp re-spelling of the property type is not a frozen-economics conflict');
ok(FZ.changedFrozenFields({ property_type: 'Multi 2–4' }, { property_type: 'FNM1025' }).length === 0,
  'freeze: correcting a stored form code is not a frozen-economics conflict');
ok(FZ.changedFrozenFields({ property_type: 'Condo' }, { property_type: 'Multi 2–4' }).length === 1,
  'freeze: a REAL property-type change is still held');

console.log(`  property-type pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
