'use strict';
/**
 * LT test — reading the subject property out of the loan, with no tenant.
 *
 * The mirror it fills is what the file's Property section, the workspace summary
 * rail and the pipeline's own address and LTV columns all read, so the questions
 * here are the ones those screens ask:
 *
 *   · does a value read BY NUMBER beat the path? (the same field id sits at a
 *     different path from loan to loan — that is a live bug on the RTL side)
 *   · is a missing figure NULL rather than 0? ("no appraised value" and "an
 *     appraised value of nothing" are different loans)
 *   · is anything INVENTED when the tenant does not populate it?
 */

const fs = require('fs');
const path = require('path');
const mapper = require('../src/longterm/application/mapper');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/** A loan shaped the way this tenant sends one (ENCOMPASS-LIVE-API-PROBE §5). */
const LOAN = {
  ltv: 65.5,
  combinedLtv: 65.5,
  subjectPropertyGrossRentalIncomeAmount: 4200,
  loanProductData: { gsePropertyType: 'Detached' },
  property: {
    streetAddress: '11 Maple Ave',
    city: 'NEWARK',
    county: 'Essex',
    state: 'NJ',
    postalCode: '07103',
    financedNumberOfUnits: 2,
    propertyUsageType: 'Investor',
    propertyAppraisedValueAmount: 725000,
    propertyEstimatedValueAmount: 700000,
    purchasePriceAmount: 640000,
  },
};

console.log('the subject property comes off the loan we already hold');

const p = mapper.readSubjectProperty(LOAN);
check(p.street === '11 Maple Ave' && p.city === 'NEWARK' && p.state === 'NJ' && p.zip === '07103',
  'the address is read from the property entity');
check(p.unitCount === 2 && p.gsePropertyType === 'Detached' && p.occupancyType === 'Investor',
  'so are the unit count, the property type and the occupancy — the three that decide what a long-term file even is');
check(p.appraisedValue === 725000 && p.estimatedValue === 700000 && p.purchasePrice === 640000,
  'and the values, each from its own field rather than one standing in for another');
check(p.grossMonthlyRent === 4200 && p.ltvPct === 65.5,
  'the rent and the LTV come off the loan root, where this tenant keeps them');

console.log('\na value read BY NUMBER wins');

// The same field id sits at a DIFFERENT path from loan to loan — reading the path
// and trusting it is what put a 2% origination fee on a 1% loan on the RTL side.
const byNumber = mapper.readSubjectProperty(LOAN, { 356: 999000, 14: 'NY' });
check(byNumber.appraisedValue === 999000 && byNumber.state === 'NY',
  'a field the caller already read by id beats the path it usually sits at');
check(byNumber.city === 'NEWARK',
  '…and a field the caller did NOT read still comes from the path — it is a preference, not a replacement');
check(mapper.readSubjectProperty(LOAN, { '356': 888000 }).appraisedValue === 888000,
  'the id is found under a string key as well as a numeric one — a silent lookup miss here would quietly hand the guess back');
check(mapper.readSubjectProperty(LOAN, { 356: '' }).appraisedValue === 725000,
  'and a BLANK read-by-number is not an answer: it falls through to the path rather than blanking a value we can see');

console.log('\na missing figure is null, never zero');

const bare = mapper.readSubjectProperty({ property: {} });
check(bare.appraisedValue === null && bare.ltvPct === null && bare.grossMonthlyRent === null,
  'nothing on the payload reads as nothing — `Number(null)` and `Number("")` are both a perfectly finite 0, which is a different loan');
check(bare.street === null && bare.unitCount === null,
  'and so does the text and the count');
check(mapper.readSubjectProperty({ property: { propertyAppraisedValueAmount: 0 } }).appraisedValue === 0,
  'a REAL zero is kept — it is an answer, and refusing it would be the same mistake in the other direction');
check(mapper.readSubjectProperty({ ltv: 'n/a' }).ltvPct === null,
  'a figure that is not a number at all is refused rather than stored as NaN');
// An EMPTY STRING is the shape this actually arrives in — a cleared box in
// Encompass, or a field the tenant returns as "". `Number('')` is 0, and a 0%
// LTV or a $0 appraised value on a screen is a decision, not a blank.
check(mapper.readSubjectProperty({ ltv: '', property: { propertyAppraisedValueAmount: '' } }).ltvPct === null,
  'an EMPTY value is not a figure — it reads as absent, never as zero');
check(mapper._internals.num('') === null && mapper._internals.num(null) === null
  && mapper._internals.num(false) === null && mapper._internals.num([]) === null,
  '…and the helper that decides it refuses every shape `Number()` would happily hand back a 0 for');
check(mapper.readSubjectProperty({ property: { financedNumberOfUnits: 2.5 } }).unitCount === null,
  'and a fractional unit count is a misread, not half a flat');
check(mapper.readSubjectProperty({ property: { city: { entityId: '4' } } }).city === null,
  'an object where a word was expected is refused rather than rendered as "[object Object]" — which has shipped to a screen here before');

console.log('\nnothing is invented');

check(mapper.readSubjectProperty(null) === null && mapper.readSubjectProperty('x') === null,
  'a payload that is not a loan produces no row at all, so the caller writes nothing');
check(!('actualMonthlyRent' in p) && !('floodZone' in p) && !('inFloodZone' in p),
  'the three columns db/549 carries and this tenant has no measured field for are ABSENT — a guessed source is worse than an honest blank on a figure a decision is made on');
check(p._found > 0 && p._fields === 16 && p._found <= p._fields,
  'and the row says how much of itself was found: a mirror that fills two columns of sixteen looks exactly like one that is working');
check(mapper.readSubjectProperty({ property: {} })._found === 0,
  'a payload with nothing on it reports nothing found — which is what tells the writer not to file an empty property');

console.log('\nthe knowledge is the measured knowledge');

// Every id here was measured across 772 loans in encompass/loan-anatomy.js. A typo
// in one is a column that silently never fills, so they are checked against it.
const anatomy = require('../src/longterm/encompass/loan-anatomy');
const SP = anatomy.SUBJECT_PROPERTY;
check(mapper.SUBJECT_FIELDS.appraisedValue.id === SP.values.appraised.fieldId
  && mapper.SUBJECT_FIELDS.estimatedValue.id === SP.values.estimated.fieldId
  && mapper.SUBJECT_FIELDS.purchasePrice.id === SP.values.purchasePrice.fieldId
  && mapper.SUBJECT_FIELDS.originalCost.id === SP.values.originalCost.fieldId,
  'the four value fields carry the ids the live probe recorded');
check(mapper.SUBJECT_FIELDS.unitCount.id === SP.units.fieldId
  && mapper.SUBJECT_FIELDS.gsePropertyType.id === SP.type.gse.fieldId
  && mapper.SUBJECT_FIELDS.occupancyType.id === SP.occupancy.fieldId
  && mapper.SUBJECT_FIELDS.occupancyRatePct.id === SP.occupancyRate.fieldId
  && mapper.SUBJECT_FIELDS.grossMonthlyRent.id === SP.rent.fieldId
  && mapper.SUBJECT_FIELDS.ltvPct.id === SP.ltv.fieldId,
  '…and so do the unit count, both property-type reads, the occupancy pair, the rent and the LTV');
check(mapper.SUBJECT_FIELDS.street.id === SP.address.street
  && mapper.SUBJECT_FIELDS.city.id === SP.address.city
  && mapper.SUBJECT_FIELDS.county.id === SP.address.county
  && mapper.SUBJECT_FIELDS.state.id === SP.address.state
  && mapper.SUBJECT_FIELDS.zip.id === SP.address.zip,
  'and the five address fields');

console.log('\nit cannot reach Encompass, or a database');

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const src = (p2) => stripComments(fs.readFileSync(path.join(__dirname, '..', p2), 'utf8'));

const mapperSrc = src('src/longterm/application/mapper.js');
check(!/require\(/.test(mapperSrc),
  'the mapper requires nothing at all — it cannot reach a network or a database even by accident');

const syncSrc = src('src/longterm/application/sync.js');
check(!/apiGet|apiPost|apiPut|apiPatch|apiDelete|fetch\(/.test(syncSrc),
  'and the writer never calls Encompass — it is handed the payload its caller already fetched');
// Every table this module writes, by name. `SET` is excluded because `DO UPDATE
// SET` is not a target — matching it is how a guard like this reports a crossing
// that is not there and then gets loosened until it reports nothing at all.
const written = [...syncSrc.matchAll(/\b(?:INSERT\s+INTO|UPDATE)\s+(?!SET\b)([A-Za-z_][A-Za-z0-9_]*)/gi)]
  .map((m) => m[1]);
check(written.length > 0 && written.every((t) => /^lt_/.test(t)),
  `it writes lt_ tables and nothing else (writes: ${written.join(', ') || 'none'})`);
check(/COALESCE\(EXCLUDED\.appraised_value, lt_properties\.appraised_value\)/.test(syncSrc),
  'and every column is COALESCEd onto what we hold: this tenant OMITS an unpopulated field, so a plain overwrite would empty the Property tab a column at a time on any thinner read');

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
