'use strict';
/**
 * THE APPRAISAL'S PROPERTY TYPE IS A CATEGORY, NOT AN ATTACHMENT STYLE.
 *
 * Owner-reported 2026-08-02, quoting the data-comparison row verbatim:
 *
 *     Property type      Detached      Multi 2–4
 *
 * *"You're taking the property type from the wrong place … we're not interested in the detached or
 * if it's attached. We need you to find if on the appraisal, if it's a single family, or if it's a
 * 2–4, or if it's a condo, or any other property type."*
 *
 * `PROPERTY/STRUCTURE/@AttachmentType`'s ENTIRE controlled value list is Detached / Attached. It
 * says whether the building touches its neighbour — a detached building is as easily a duplex as a
 * single-family house — so it can never answer "what is this property". The category is derived
 * instead from the appraisal's own evidence: the FORM (a 1025 cannot describe a condo), the
 * authoritative unit count, and the ownership signals.
 *
 * THE DANGEROUS HALF of a check like this is stating a category the appraisal never said, so the
 * never-guess and no-false-mismatch assertions below outnumber the positive ones.
 *
 * Pure: no DB, no AI, no network.
 */
const R = require('path').resolve(__dirname, '..');
const PC = require(R + '/src/lib/appraisal/property-category');
const { derivePropertyCategory, fromAppraisalRow, categoryLabelFor, applyPropertyType, isAttachmentStyle } = PC;
const { LABEL_OF, PROPERTY_TYPES } = require(R + '/src/lib/property-type');
const facts = require(R + '/src/lib/underwriting/facts');
const { computeFindings } = require(R + '/src/lib/appraisal/findings');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const key = (sig) => { const r = derivePropertyCategory(sig); return r ? r.key : null; };

console.log('— the style is never a category —');
// Every spelling of the style, alone, decides nothing.
for (const style of ['Detached', 'detached', 'Attached', 'ATTACHED', 'Semi-Detached', 'End Unit', 'Det', 'Att']) {
  ok(isAttachmentStyle(style), `"${style}" is recognized as an attachment style`);
  ok(key({ attachmentType: style }) === null, `"${style}" alone yields NO category (it is not one)`);
}
// A phrase that carries a real category word is NOT a bare style — the category word is the answer.
ok(!isAttachmentStyle('Single Family Detached'), '"Single Family Detached" is not a bare style');
ok(!isAttachmentStyle(''), 'blank is not a style');
ok(!isAttachmentStyle(null), 'null is not a style');
ok(!isAttachmentStyle('Condo'), 'a real category is not a style');
// The style never changes the answer — the same appraisal reads the same either way. This is the
// owner's exact case: a DETACHED 2–4 must still be a 2–4.
for (const style of ['Detached', 'Attached', null]) {
  ok(key({ formType: 'FNM1025', units: 3, attachmentType: style }) === 'multi_2_4',
    `a 3-unit 1025 is Multi 2–4 whether it is ${style || 'unstated'}`);
  ok(key({ formType: 'FNM1004', units: 1, attachmentType: style }) === 'sfr',
    `a 1-unit 1004 is SFR whether it is ${style || 'unstated'}`);
}
// …and the style is carried through rather than thrown away.
ok(derivePropertyCategory({ formType: 'FNM1004', units: 1, attachmentType: 'Detached' }).attachmentType === 'Detached',
  'the style is preserved on the result as its own fact');

console.log('— the form is the hard statement —');
// The three forms are written for a category and the agencies accept them for nothing else.
ok(key({ formType: 'FNM1004', units: 1 }) === 'sfr', '1004 URAR → single family');
ok(key({ formType: 'FNM1025', units: 2 }) === 'multi_2_4', '1025 Small Residential Income → 2–4');
ok(key({ formType: 'FNM1073', units: 1 }) === 'condo', '1073 → condominium');
// The form alone answers when the unit count is missing (a 1025 leaves it blank on some vendors).
ok(key({ formType: 'FNM1025' }) === 'multi_2_4', 'a 1025 with no unit count is still 2–4');
ok(key({ formType: 'FNM1073' }) === 'condo', 'a 1073 with no unit count is still a condo');
// Every spelling the shared form matcher accepts.
for (const spelling of ['1025', 'FNM1025', 'FNMA-1025', 'Form 1025', 'fnm 1025']) {
  ok(key({ formType: spelling }) === 'multi_2_4', `"${spelling}" is recognized as the 2–4 form`);
}

console.log('— the unit count decides the band —');
ok(key({ units: 1 }) === 'sfr', '1 unit → single family');
ok(key({ units: 2 }) === 'multi_2_4', '2 units → Multi 2–4');
ok(key({ units: 4 }) === 'multi_2_4', '4 units → Multi 2–4');
ok(key({ units: 5 }) === 'multi_5_plus', '5 units → Multi 5+');
ok(key({ units: 12 }) === 'multi_5_plus', '12 units → Multi 5+');
ok(key({ formType: '2055', units: 6 }) === 'multi_5_plus', 'a 6-unit on a non-standard form is still 5+');

console.log('— which KIND of one-unit dwelling —');
ok(key({ formType: 'FNM1004', units: 1, pudIndicator: 'Y' }) === 'pud', 'the UAD PUD indicator makes it a PUD');
ok(key({ formType: 'FNM1004', units: 1, pudIndicator: 'N' }) === 'sfr', 'PUD indicator "N" leaves it a single family');
ok(key({ formType: 'FNM1004', units: 1 }) === 'sfr', 'no PUD indicator at all leaves it a single family');
ok(key({ formType: 'FNM1004', units: 1, designDescription: 'Townhouse' }) === 'townhouse', 'a townhouse design reads as a townhouse');
ok(key({ formType: 'FNM1004', units: 1, designDescription: 'Row House' }) === 'townhouse', 'a rowhouse design reads as a townhouse');
ok(key({ formType: 'FNM1004', units: 1, propertyCategoryType: 'Condominium' }) === 'condo',
  "the appraiser's own category words are believed");
ok(key({ formType: 'FNM1004', units: 1, designDescription: 'Colonial' }) === 'sfr',
  'an ordinary architectural style (Colonial) is not a category and leaves it SFR');
ok(key({ formType: 'FNM1004', units: 1, propertyCategoryType: 'Mixed Use' }) === 'mixed_use', 'mixed use is read when stated');
// A CONDO IS NEVER GUESSED FROM AN HOA FEE OR A PROJECT NAME — a PUD carries both.
ok(key({ formType: 'FNM1004', units: 1, projectDesignType: 'GardenProject', hoaFeeAmount: 410, pudIndicator: 'Y' }) === 'pud',
  'a project + an HOA fee on a PUD-flagged 1004 is a PUD, NOT a condo');
ok(key({ formType: 'FNM1004', units: 1, projectDesignType: 'MidriseProject' }) === 'sfr',
  'a project design type alone never manufactures a condo');
// The condominium FORM outranks a rowhouse-style project — RowhouseProject is a condo design.
ok(key({ formType: 'FNM1073', units: 1, projectDesignType: 'RowhouseProject' }) === 'condo',
  'a RowhouseProject on the 1073 is a condo, not a townhouse');

console.log('— never guess —');
ok(derivePropertyCategory({}) === null, 'an empty appraisal yields no category');
ok(derivePropertyCategory(null) === null, 'null input yields no category');
ok(derivePropertyCategory(undefined) === null, 'undefined input yields no category');
ok(key({ formType: '2055' }) === null, 'a form that proves no category, with no unit count, yields nothing');
ok(key({ formType: 'FNM216', attachmentType: 'Detached', designDescription: 'Colonial' }) === null,
  'a style and an architectural style together still prove nothing');
ok(key({ units: 0 }) === null, 'a zero unit count is not a reading');
ok(key({ units: 'many' }) === null, 'an unparseable unit count is not a reading');

console.log('— contradictory evidence is never stated confidently —');
{
  // A 1025 reporting one unit contradicts itself. appraisal-underwriter raises that for a human;
  // here it only costs us our certainty — the form wins the band, flagged.
  const r = derivePropertyCategory({ formType: 'FNM1025', units: 1 });
  ok(r && r.key === 'multi_2_4', 'the form wins the band when the two disagree');
  ok(r && r.conflict === true, 'the disagreement is flagged');
  ok(r && r.confidence === 'likely', 'a contradicted reading is never "definite"');
  const clean = derivePropertyCategory({ formType: 'FNM1025', units: 3 });
  ok(clean && clean.conflict === false && clean.confidence === 'definite', 'an agreeing report IS definite');
}

console.log('— the portal speaks one vocabulary —');
// Every category this module can return is a REAL portal property type, and every one of them is
// comparable by the tie-out. A label that no comparator understands would silently read as
// "uncomparable" in exactly the row this whole change exists to fix.
const KEYS = new Set(PROPERTY_TYPES.map((p) => p.key));
for (const k of ['sfr', 'multi_2_4', 'multi_5_plus', 'condo', 'townhouse', 'pud', 'mixed_use']) {
  ok(KEYS.has(k), `${k} is a real portal property type`);
  ok(!!LABEL_OF[k], `${k} has a portal label`);
  ok(!!facts.canonPropertyType(LABEL_OF[k]), `the tie-out can compare "${LABEL_OF[k]}"`);
}
// And the two the tie-out must NOT be able to compare.
ok(facts.canonPropertyType('Detached') === null, 'the tie-out still refuses to compare a bare style');
ok(facts.canonPropertyType('Attached') === null, 'the tie-out still refuses to compare "Attached"');

console.log('— the document desk never CLAIMS a style —');
{
  // The 2026-07-27 patch stopped a style false-mismatching; it still let it be claimed, so the
  // appraisal column printed "Detached" under "Property type". A style is now dropped at the claim,
  // which reads as "this document didn't state it" — the truth.
  const styled = facts.claimsFor('appraisal', { propertyType: 'Detached', units: 3 });
  ok(styled.property_type == null, 'a bare style is not claimed as a property type');
  ok(styled.units === 3, '…and the rest of the appraisal claim is untouched');
  const real = facts.claimsFor('appraisal', { propertyType: 'Multi 2–4', units: 3 });
  ok(real.property_type === 'Multi 2–4', 'a real category IS claimed');
  const aiRead = facts.claimsFor('appraisal', { propertyType: 'Single Family' });
  ok(aiRead.property_type === 'Single Family', 'an AI-read appraisal PDF that says "Single Family" still claims it');
}

console.log('— a stored row reads correctly, repaired or not —');
{
  // A LEGACY row: the style is sitting in the property-type column and nothing else has been set.
  const legacy = { form_type: 'FNM1025', units: 3, property_type: 'Detached', property_category: null, attachment_type: null, fields: {} };
  ok(categoryLabelFor(legacy) === 'Multi 2–4', 'a legacy row still answers Multi 2–4');
  const shown = applyPropertyType(Object.assign({}, legacy));
  ok(shown.property_type === 'Multi 2–4', 'the presented property type is the category');
  ok(shown.attachment_type === 'Detached', 'the style is moved to its own field, never destroyed');

  // A REPAIRED row: read straight off the stored key, no re-derivation needed.
  const repaired = { property_category: 'condo', property_type: 'Condo', attachment_type: 'Attached', form_type: 'FNM1073' };
  ok(categoryLabelFor(repaired) === 'Condo', 'a repaired row reads its stored category');

  // A row the appraisal genuinely does not answer: the style is still moved out, and the property
  // type reads as "not stated" rather than as a misleading word.
  const unknown = applyPropertyType({ form_type: '2055', units: null, property_type: 'Attached', attachment_type: null, fields: {} });
  ok(unknown.property_type === null, 'an unreadable appraisal says nothing rather than "Attached"');
  ok(unknown.attachment_type === 'Attached', '…and the style is still kept');

  // Real appraiser text we have nothing better than is LEFT ALONE, never blanked.
  const text = applyPropertyType({ form_type: '2055', units: null, property_type: 'Rural homestead', attachment_type: null, fields: {} });
  ok(text.property_type === 'Rural homestead', 'text that is not a style is never destroyed');

  // The extra signals are read out of the fields jsonb where buildFieldsJson puts them.
  const viaFields = fromAppraisalRow({
    form_type: 'FNM1004', units: 1, property_type: 'Attached', fields: { 'subject.pudIndicator': { value: 'Y' } },
  });
  ok(viaFields && viaFields.key === 'pud', 'the PUD indicator is read from the stored fields jsonb');
  ok(fromAppraisalRow(null) === null, 'a missing row yields nothing');
  ok(applyPropertyType(null) === null, 'presenting a missing row never throws');
}

console.log('— the appraisal finding states a real category on both sides —');
{
  const appraisal = (subject, formType) => ({
    ok: true, formType, values: {}, subject: Object.assign({ address: null, units: 1 }, subject), comparables: [],
  });
  const codes = (A, file) => computeFindings(A, file, { today: '2026-08-02' }).map((f) => f.code);
  const find = (A, file, code) => computeFindings(A, file, { today: '2026-08-02' }).find((f) => f.code === code);

  // THE OWNER'S CASE: a detached 2–4 on a Multi 2–4 file is silent. This is the whole point.
  const twoToFour = appraisal({ units: 3, propertyCategory: 'multi_2_4', attachmentType: 'Detached' }, 'FNM1025');
  ok(codes(twoToFour, { property_type: 'Multi 2–4', units: 3 }).indexOf('property_style_note') === -1,
    'a detached 2–4 on a Multi 2–4 file raises NOTHING');
  ok(codes(twoToFour, { property_type: 'Multi 2–4', units: 3 }).indexOf('property_type_mismatch') === -1,
    '…and no unit-range fatal either');

  // A genuinely different KIND, same unit count, now surfaces with BOTH sides in plain words.
  const condo = appraisal({ units: 1, propertyCategory: 'condo' }, 'FNM1073');
  const note = find(condo, { property_type: 'SFR (1 unit)', units: 1 }, 'property_style_note');
  ok(!!note, 'a condo appraisal on an SFR file raises the property-type note');
  ok(note && note.appraisalValue === 'Condo', 'the appraisal value is the CATEGORY, not a form code');
  ok(note && String(note.appraisalValue).indexOf('FNM') === -1, 'a form code is never shown as the property type');
  ok(note && note.fileValue === 'SFR (1 unit)', 'the file value is the file value');
  ok(note && note.severity === 'warning' && note.blocksCtc === false, 'it stays advisory — never a blocker');
  ok(note && note.actions.indexOf('replace') === -1, 'property_type is never written back from a finding');

  // Coverage the old form-code comparison could not reach at all.
  const town = appraisal({ units: 1, propertyCategory: 'townhouse' }, 'FNM1004');
  ok(codes(town, { property_type: 'SFR (1 unit)', units: 1 }).indexOf('property_style_note') !== -1,
    'a townhouse vs an SFR file is now caught (the form-code check never could)');
  ok(codes(town, { property_type: 'Townhouse', units: 1 }).indexOf('property_style_note') === -1,
    'a townhouse on a Townhouse file is silent');
  // PUD and Townhouse are ONE bucket, exactly as the data comparison treats them.
  const pud = appraisal({ units: 1, propertyCategory: 'pud' }, 'FNM1004');
  ok(codes(pud, { property_type: 'Townhouse', units: 1 }).indexOf('property_style_note') === -1,
    'a PUD on a Townhouse file does not nag (the tie-out buckets them together)');
  ok(codes(pud, { property_type: 'Condo', units: 1 }).indexOf('property_style_note') !== -1,
    'a PUD on a Condo file IS a real difference');

  // NEVER GUESS on either side.
  const silent = appraisal({ units: 1, propertyCategory: null }, '2055');
  ok(codes(silent, { property_type: 'Condo', units: 1 }).indexOf('property_style_note') === -1,
    'an appraisal with no category raises nothing');
  ok(codes(condo, { property_type: 'Something else entirely', units: 1 }).indexOf('property_style_note') === -1,
    'a file property type outside the portal list raises nothing');
  ok(codes(condo, { property_type: null, units: 1 }).indexOf('property_style_note') === -1,
    'a file with no property type raises nothing');

  // The unit-range FATAL is untouched — it still owns the count-vs-category disagreement.
  const fat = find(appraisal({ units: 3, propertyCategory: 'multi_2_4' }, 'FNM1025'), { property_type: 'SFR (1 unit)', units: 3 }, 'property_type_mismatch');
  ok(!!fat && fat.severity === 'fatal', 'a 3-unit appraisal on a 1-unit file is still the fatal');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
