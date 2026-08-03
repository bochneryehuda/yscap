/**
 * THE PROPERTY IDENTITY KEY (src/lib/research/property-key.js) — the rule that
 * decides two address lines on two different appraisals are the same house.
 *
 * This is the single highest-consequence pure function in the research warehouse
 * (db/409): fold two properties together and every price-per-foot read is
 * corrupted; split one property in two and the sale history disappears. So the
 * test is written as the dedupe DECISIONS, not as string comparisons — each case
 * says what a real report wrote and whether it is the same house.
 *
 * Pure. No database, no network.
 */
const K = require('../src/lib/research/property-key');
const ID = require('../src/lib/research/identity');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const same = (a, b, m) => ok(K.propertyKey(a) && K.propertyKey(a) === K.propertyKey(b), m);
const diff = (a, b, m) => ok(K.propertyKey(a) && K.propertyKey(b) && K.propertyKey(a) !== K.propertyKey(b), m);

// ---- the same house, written differently -----------------------------------
same({ street: '26 South 10th Street', city: 'Piscataway', state: 'New Jersey', zip: '08854' },
  { street: '26 S 10th St', city: 'Piscataway', state: 'NJ' },
  'spelled-out street type and state fold together');
same({ street: '26 S. 10th St.', city: 'PISCATAWAY', state: 'nj', zip: '08854-1234' },
  { street: '26 s 10th st', city: 'piscataway', state: 'NJ', zip: '08854' },
  'case, punctuation and ZIP+4 do not split a property');
same({ street: '148 Plymouth St', city: 'New Haven', state: 'CT', zip: '06519' },
  { street: '148 Plymouth Street', city: 'New Haven', state: 'CT' },
  'a MISSING zip does not split a property — the ZIP is never part of the key when a city is present');
same({ street: '12 Maple Ave', city: 'Village of Spring Valley', state: 'NY' },
  { street: '12 Maple Avenue', city: 'Spring Valley', state: 'NY' },
  '"Village of X" and "X" are one town');
same('123 Main Street, Newark, NJ 07103', { street: '123 Main St', city: 'Newark', state: 'NJ' },
  'a whole address packed into one string parses to the same key as its parts');
same({ street: '26 S 10th St Apt 2', city: 'Piscataway', state: 'NJ' },
  { street: '26 S 10th St', unit: 'Unit 2', city: 'Piscataway', state: 'NJ' },
  'a unit inside the street line and a unit in its own field are the same unit');
same({ street: '26 S 10th St', unit: '#2', city: 'Piscataway', state: 'NJ' },
  { street: '26 S 10th St', unit: 'APT 2', city: 'Piscataway', state: 'NJ' },
  'unit prefixes (#, Apt, Unit) are noise');

// ---- DIFFERENT houses that must never fold ---------------------------------
diff({ street: '26 S 10th St', unit: '2', city: 'Piscataway', state: 'NJ' },
  { street: '26 S 10th St', unit: '5', city: 'Piscataway', state: 'NJ' },
  'TWO UNITS OF ONE BUILDING ARE TWO PROPERTIES — they sell for different prices');
diff({ street: '26 S 10th St', city: 'Piscataway', state: 'NJ' },
  { street: '26 S 10th St', unit: '2', city: 'Piscataway', state: 'NJ' },
  'the whole building is not the same thing as unit 2 of it');
diff({ street: '26 S 10th St', city: 'Piscataway', state: 'NJ' },
  { street: '28 S 10th St', city: 'Piscataway', state: 'NJ' },
  'the house number matters');
diff({ street: '12 Maple Ave', city: 'Newark', state: 'NJ' },
  { street: '12 Maple Ave', city: 'Edison', state: 'NJ' },
  'same street name in two towns is two properties');
diff({ street: '12 Maple Ave', city: 'Springfield', state: 'NJ' },
  { street: '12 Maple Ave', city: 'Springfield', state: 'MA' },
  'same town name in two states is two properties');
diff({ street: '26 S 10th St', city: 'Piscataway', state: 'NJ' },
  { street: '26 N 10th St', city: 'Piscataway', state: 'NJ' },
  'the directional is part of the street');

// ---- refuse rather than guess ----------------------------------------------
ok(K.propertyKey({ street: 'Main St', city: 'Newark', state: 'NJ' }) === null,
  'a street with NO house number is a road, not a property — no key');
ok(K.propertyKey({ street: '123 Main St', city: 'Newark' }) === null,
  'no state — no key');
ok(K.propertyKey({ street: '123 Main St', state: 'NJ' }) === null,
  'no city AND no ZIP — no key');
ok(K.propertyKey({ street: '123 Main St', state: 'NJ', zip: '07103' }) !== null,
  'a ZIP stands in as the locality when the report gave no city');
ok(K.propertyKey('') === null && K.propertyKey(null) === null && K.propertyKey({}) === null,
  'empty input never produces a key');

// ---- display -----------------------------------------------------------------
ok(/^26 S 10th St 2, Piscataway, NJ 08854$/.test(
  K.displayAddress({ street: '26 South 10th Street', unit: '2', city: 'PISCATAWAY', state: 'New Jersey', zip: '08854' })),
'the display address is normalized and the shouted town is title-cased');

// ---- sale dates ---------------------------------------------------------------
ok(K.saleDate('s07/25;c06/25') === '2025-07-01', 'the UAD grid date prefers the SETTLED month, not the contract month');
ok(K.saleDate('06/20/2025') === '2025-06-20', 'a full MM/DD/YYYY date keeps its day');
ok(K.saleDate('2025-06-14') === '2025-06-14', 'an ISO date passes straight through');
ok(K.saleDate('06/25') === '2025-06-01', 'a bare MM/YY expands to a month');
ok(K.saleDate('') === null && K.saleDate('n/a') === null && K.saleDate('13/25') === null,
  'nonsense and an impossible month yield no date');
ok(K.saleDate('06/20/2199') === null, 'a date far in the future is refused');

// ---- lot size ------------------------------------------------------------------
ok(K.lotSqft('0.17 ac') === 7405, 'acres convert to square feet');
ok(K.lotSqft('7,405 sf') === 7405, 'a square-foot figure with a comma reads straight');
ok(K.lotSqft('50x100') === 5000, 'lot dimensions multiply out');
ok(K.lotSqft('10890 Sq.Ft.') === 10890, '"Sq.Ft." is understood');
ok(K.lotSqft('0.25') === 10890, 'a bare number under 10 is acres, not square feet');
ok(K.lotSqft('7500') === 7500, 'a bare number over 10 is square feet');
ok(K.lotSqft('irregular') === null && K.lotSqft('') === null,
  'an unparseable lot description yields nothing rather than a guess');
ok(K.lotSqft('0.0001 ac') === null, 'an impossibly small lot is refused');

// ---- baths ----------------------------------------------------------------------
ok(K.bathsNumeric({ bathsText: '2.1' }) === 2.5, 'UAD "2.1" is two full and ONE HALF = 2.5, not 2.1');
ok(K.bathsNumeric({ bathsFull: 3, bathsHalf: 1 }) === 3.5, 'full + half counts add up');
ok(K.bathsNumeric({ bathsFull: 2, bathsHalf: 0 }) === 2, 'no half bath is a whole number');
ok(K.bathsNumeric({}) === null, 'nothing stated is null, never 0');

// ---- appraiser identity -----------------------------------------------------------
const lic = (n, c, id, st) => ID.appraiserIdentity({ name: n, company: c, licenseId: id, licenseState: st });
ok(lic('John Q. Appraiser, SRA', 'Acme Appraisal LLC', '42RG00123400', 'NJ').key
  === lic('JOHN APPRAISER', 'Bravo Valuation Inc', '42RG-0012-3400', 'New Jersey').key,
'THE LICENCE IS THE IDENTITY — the same number is the same person even after a name spelling and a firm change');
ok(lic('John Q Kessler', 'Acme Appraisal LLC', null, null).key
  === lic('john q. kessler', 'Acme Appraisal, L.L.C.', null, null).key,
'with no licence, name + firm folds through punctuation and the firm-type suffix');
ok(ID.companyKey('Acme Appraisal LLC') === ID.companyKey('Acme Appraisal, L.L.C.')
  && ID.companyKey('Acme Appraisal LLC') === ID.companyKey('Acme Appraisal Inc.'),
'"LLC" / "L.L.C." / "Inc." are firm-type noise, not part of the firm\'s identity');
ok(ID.nameKey('John Q Kessler, SRA, MAI') === 'john q kessler',
  'professional designations are peeled off a name');
ok(ID.nameKey('John A Smith') !== ID.nameKey('John B Smith'),
  'a middle initial is part of the name — two people, not one');
ok(lic('J Smith', 'Acme', null, null).key !== lic('J Smith', 'Bravo', null, null).key,
  'two "J Smith"s at two different firms stay two people — a wrong merge is worse than a duplicate');
ok(lic('Appraiser', null, null, null) === null, 'a single-word name is too weak to be an identity');
ok(lic(null, 'Acme Appraisal', null, null) === null, 'a firm with no person is not an appraiser');
ok(lic('John Q Appraiser', null, '42RG00123400', 'NJ').tier === 'license'
  && lic('John Q Appraiser', 'Acme', null, null).tier === 'name',
'the identity says which tier it used, so a soft grouping is visible');
ok(ID.contactKey('phone', '(973) 555-1212') === ID.contactKey('phone', '+1 973-555-1212'),
  'the same phone written two ways is one contact');
ok(ID.contactKey('email', 'John@Acme.Test') === ID.contactKey('email', 'john@acme.test'),
  'email case does not create a second contact');

/* THE INHERITED TOWN IS A FALLBACK, NEVER THE CITY ITSELF.
   A comparable that named no city inherits the subject's, gated on the ZIPs
   matching — but a town the comparable WROTE inside its own packed address line
   must always win, or the house is filed under the wrong town and the split the
   inheritance exists to close is created instead. */
const PACKED = '12 Oak St, Newark, NJ 07103';
ok(K.propertyKey({ street: PACKED, city: null, fallbackCity: 'Irvington', state: 'NJ', zip: '07103' })
   === '12 oak st||newark|nj',
'a town written inside the comparable\'s own address line BEATS the inherited one');
ok(K.propertyKey({ street: '12 Oak St', city: null, fallbackCity: 'Irvington', state: 'NJ', zip: '07103' })
   === '12 oak st||irvington|nj',
'with no town of its own, the inherited town is still used — the split stays closed');
ok(K.propertyKey({ street: PACKED, city: 'Harrison', fallbackCity: 'Irvington', state: 'NJ', zip: '07103' })
   === '12 oak st||harrison|nj',
'an explicitly stated city beats both the packed line and the inherited town');
ok(K.propertyKey({ street: '12 Oak St', city: null, state: 'NJ', zip: '07103' })
   === '12 oak st||z07103|nj',
'and with no inheritance offered at all, nothing changes — it still keys on the ZIP');


console.log(`test-research-property-key: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
