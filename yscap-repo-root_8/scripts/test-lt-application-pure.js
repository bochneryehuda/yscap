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
  propertyAppraisedValueAmount: 725000,
  propertyEstimatedValueAmount: 700000,
  purchasePriceAmount: 640000,
  subjectPropertyOccupancyPercent: 100,
  subjectPropertyGrossRentalIncomeAmount: 4200,
  loanProductData: { gsePropertyType: 'Detached' },
  applications: [{ propertyUsageType: 'Investor' }],
  property: {
    streetAddress: '11 Maple Ave',
    city: 'NEWARK',
    county: 'Essex',
    state: 'NJ',
    postalCode: '07103',
    financedNumberOfUnits: 2,
    refinancePropertyOriginalCostAmount: 300000,
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
check(mapper.readSubjectProperty({ propertyAppraisedValueAmount: 0 }).appraisedValue === 0,
  'a REAL zero is kept — it is an answer, and refusing it would be the same mistake in the other direction');
check(mapper.readSubjectProperty({ ltv: 'n/a' }).ltvPct === null,
  'a figure that is not a number at all is refused rather than stored as NaN');
// An EMPTY STRING is the shape this actually arrives in — a cleared box in
// Encompass, or a field the tenant returns as "". `Number('')` is 0, and a 0%
// LTV or a $0 appraised value on a screen is a decision, not a blank.
check(mapper.readSubjectProperty({ ltv: '', propertyAppraisedValueAmount: '' }).ltvPct === null,
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
check(p._found === 16 && p._fields === 16,
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

// THE PATHS, AGAINST THE MEASURED ONES — this is the assertion that matters.
//
// An id can be right while the PATH beside it is wrong, and a wrong path is the
// worst failure this mapper has: the column reads null on every loan, which is
// indistinguishable from a tenant that does not populate the field. Three of these
// were wrong on the first pass and every test still passed, because the fixture
// had been written from the same wrong guess. So they are pinned to the field
// dictionary's own `jsonPath`, recorded across 772 real loans.
const DICT = require('../src/longterm/encompass/dictionary/field-dictionary.json');
const dictFields = DICT.fields || DICT;
const jsonPathOf = (id) => {
  const f = dictFields[String(id)];
  return f && f.jsonPath ? String(f.jsonPath).replace(/^\$\./, '') : null;
};

const pathMismatch = [];
for (const [key, spec] of Object.entries(mapper.SUBJECT_FIELDS)) {
  const measured = jsonPathOf(spec.id);
  if (!measured) { pathMismatch.push(`${key}: id ${spec.id} is not in the dictionary`); continue; }
  // `applications[0].x` in the dictionary is `applications.0.x` to a dotted reader.
  const want = measured.replace(/\[(\d+)\]/g, '.$1');
  if (spec.paths[0] !== want) pathMismatch.push(`${key}: reads ${spec.paths[0]}, measured at ${want}`);
}
check(pathMismatch.length === 0,
  `every subject-property path is the one the dictionary measured${pathMismatch.length ? ` — ${pathMismatch.join('; ')}` : ''}`);

const partyMismatch = [];
for (const [key, spec] of Object.entries(mapper.PARTY_FIELDS)) {
  if (!spec.id) continue; // no measured id: the path is the probe's §1a list
  const measured = jsonPathOf(spec.id);
  if (measured !== `applications[0].borrower.${spec.path}`) {
    partyMismatch.push(`${key}: reads borrower.${spec.path}, measured at ${measured}`);
  }
}
check(partyMismatch.length === 0,
  `and every party path with a measured id agrees with it${partyMismatch.length ? ` — ${partyMismatch.join('; ')}` : ''}`);

console.log('\nthe people on the file');

const PAIRS_LOAN = {
  applications: [
    {
      id: 'app-1', legacyId: '_borrower1', propertyUsageType: 'Investor',
      borrower: {
        firstName: 'Ann', middleName: 'B', lastName: 'Lee', suffixToName: 'Jr',
        birthDate: '1980-04-02', taxIdentificationIdentifier: '123-45-6789',
        emailAddressText: 'ann@example.com', homePhoneNumber: '201-555-0100',
        maritalStatusType: 'Unmarried', dependentCount: 2,
        urla2020CitizenshipResidencyType: 'USCitizen',
        experianCreditScore: '756', transUnionScore: '760', equifaxScore: '752',
        middleCreditScore: '756',
      },
      // Encompass returns this object on files that have NO co-borrower.
      coborrower: { firstName: null, lastName: null, taxIdentificationIdentifier: null },
    },
    {
      // DELIBERATELY _borrower3 at array position 2: a pair deleted in Encompass
      // leaves a gap, so the label and the position genuinely diverge — and a
      // fixture where they agree cannot notice which one is being read.
      id: 'app-2', legacyId: '_borrower3',
      borrower: { firstName: 'Cal', lastName: 'Ortiz' },
    },
  ],
};

const pairs = mapper.readBorrowerPairs(PAIRS_LOAN);
check(pairs.length === 2 && pairs[0].pairNumber === 1 && pairs[1].pairNumber === 3,
  'one pair per application, numbered by ENCOMPASS\'s own _borrowerN label — that is the number its eFolder files documents under, so taking the array position instead would file a document against the wrong person');
check(pairs[0].parties.length === 1 && pairs[0].parties[0].role === 'borrower',
  'an EMPTY co-borrower object is not a second person — Encompass sends one on every single-borrower file, and a nameless second borrower reads as a data problem on a perfectly ordinary loan');
check(pairs[0].parties[0].firstName === 'Ann' && pairs[0].parties[0].nameSuffix === 'Jr'
  && pairs[0].parties[0].dependentCount === 2 && pairs[0].parties[0].citizenship === 'USCitizen',
  'the person is read whole — name, suffix, dependants and citizenship');
check(pairs[0].parties[0].ficoExperian === 756 && pairs[0].parties[0].ficoRepresentative === 756,
  'the credit scores arrive as STRINGS in this schema and land as numbers');

console.log('\nwhat a borrower DECLARED, and what they were never asked');

const DECL = mapper.readDeclarations({
  intentToOccupyIndicator: false,
  outstandingJudgementsIndicator: true,
  bankruptcyIndicator: true,
  bankruptcyIndicatorChapterSeven: true,
  bankruptcyIndicatorChapterThirteen: true,
  priorPropertyUsageType: 'Investment',
});
check(DECL.willOccupyAsPrimary === false && DECL.hasOutstandingJudgments === true,
  'a NO is recorded as a no and a YES as a yes');
check(DECL.familyRelationshipToSeller === null && DECL.isPartyToLawsuit === null,
  'and a question nobody answered is UNANSWERED — `Boolean(undefined)` is false, which would have every borrower on this book swearing to things they were never asked');
check(DECL.bankruptcyChapters === 'Chapter 7, Chapter 13',
  'the chapters come from the chapter flags, in the borrower\'s own file\'s order');
check(mapper.readDeclarations({ bankruptcyIndicator: true }).bankruptcyChapters === null,
  '…and a bankruptcy with NO chapter flag names no chapter: the indicator says one happened, not which, and guessing "7" is putting words in somebody\'s mouth');
check(DECL.hadOwnershipLast3Years === null,
  'a prior property USAGE type is not an answer to whether they held an ownership interest — answering the second from the first puts a "yes" on the file the borrower never gave');
check(mapper.readDeclarations({}) === null && mapper.readDeclarations(null) === null,
  'and a borrower who answered NOTHING has made no declaration — an all-null row would put an "answered" tick on their §5 on every screen that asks');

console.log('\nwhere a person works');

const EMP = mapper.readEmployments({
  employment: [
    { id: 'e1', employerName: 'Acme', currentEmploymentIndicator: true, selfEmployedIndicator: true, businessOwnedPercent: 100 },
    { id: 'e2', employerName: 'Old Co', currentEmploymentIndicator: false },
    { id: 'e3', employerName: 'Unstated Co' },
    { id: 'e4', positionDescription: 'no employer named' },
  ],
});
check(EMP.length === 3, 'a row with no employer at all is not a job');
check(EMP[0].employmentType === 'current' && EMP[0].isSelfEmployed === true && EMP[0].ownershipPct === 100,
  'a current job is current, with its self-employment and its ownership share');
check(EMP[1].employmentType === 'previous',
  'and a job Encompass marks as NOT current is PREVIOUS — filing it as current would put a job the borrower has left on the front of their file');
check(EMP[2].employmentType === 'current',
  'an UNANSWERED indicator reads as current: the enum\'s default, and the reading that keeps a job on the screen rather than in a history nobody opens');
check(!EMP.some((e) => e.employmentType === 'additional'),
  'and `additional` is never assigned — this tenant marks a second current job the same way as the first, so choosing between them would be our guess rather than its answer');

console.log('\nthe Social Security number never leaves');

check(pairs[0].parties[0].ssnLast4 === '6789',
  'only the last four are returned — the identifier a person reads back on a phone call');
const partyJson = JSON.stringify(pairs);
check(!/123-45-6789|123456789/.test(partyJson),
  'and the number itself appears NOWHERE in what this returns: once it is in a returned object it is one log line and one JSON response away from leaving the building');
check(mapper._internals.ssnLast4('1234') === '1234' && mapper._internals.ssnLast4('***-**-4321') === '4321',
  'a masked or partial number still yields the four digits it can see');
check(mapper._internals.ssnLast4('12') === null && mapper._internals.ssnLast4('') === null
  && mapper._internals.ssnLast4(null) === null,
  '…and FEWER than four digits yields nothing — a two-digit "last four" read back on a phone call is worse than a blank one');

// A field id here would name the FIRST application's PRIMARY borrower, so using
// one on a co-borrower or a second pair writes one person's details onto another.
check(mapper.readParty({ firstName: 'Real' }, 'coborrower', { 4000: 'Wrong' }).firstName === 'Real',
  'a party is read by PATH and never by field number — every id measured for these names applications[0].borrower, so a value read by number is the FIRST borrower\'s and would be written onto whoever is being read');
check(mapper.PARTY_FIELDS.dependentCount.id === null,
  'and the dependant COUNT has no id: field 54 is the dependants\' AGES, a different question with a different answer');

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
