/**
 * CORRFIRST EXPORT — the Track Record Investor Export, pinned to CorrFirst's own
 * two files (owner-directed 2026-08-16).
 *
 * The whole point of this test: CorrFirst gave us an EMPTY csv (the header) and a
 * SAMPLE csv (two filled rows), and the file we hand them has to be importable
 * with no errors. So this proves, against those exact bytes:
 *   · the header we ship IS their empty file, byte-for-byte — never re-typed;
 *   · feeding the builder the sample's own two deals reproduces the sample file
 *     byte-for-byte — quoting, dates, money, the leading-zero ZIP, Y/N, the blank
 *     sold cells on a retained property, LF endings and NO trailing newline;
 *   · only VERIFIED lines are eligible, and nothing is invented for a gap.
 *
 * PURE — no DB, no network. In `npm test`.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const cf = require('../src/lib/corrfirst-track-record');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ── 1) The header IS CorrFirst's empty file, verbatim ────────────────────────
const templateBytes = fs.readFileSync(cf.TEMPLATE_FILE);
ok(templateBytes.toString('utf8') === 'Street,City,State,ZIP,Property Type,Purchase Date,Purchase Price,'
   + 'Renovation Budget,Rental Retained,Sold Date,Sold Price,Title Held in Name,% of Ownership,Additional Notes',
  'the checked-in template is CorrFirst\'s empty file, byte-for-byte');
ok(templateBytes[0] !== 0xEF, 'no UTF-8 BOM (their file has none)');
ok(!templateBytes.includes(0x0D), 'no CR — LF endings only');
ok(!templateBytes.includes(0x0A), 'the template carries no trailing newline');
ok(cf.corrfirstHeader() === templateBytes.toString('utf8'), 'corrfirstHeader() returns it unchanged');
ok(cf.corrfirstColumns().length === 14, '14 columns');
ok(cf.corrfirstColumns()[4] === 'Property Type' && cf.corrfirstColumns()[12] === '% of Ownership',
  'the columns are read FROM the template, in CorrFirst\'s order');
// An empty export is still their file, exactly as sent.
ok(cf.buildCorrfirstCsv([]) === templateBytes.toString('utf8'),
  'a zero-row export is exactly the empty file they sent');

// ── 2) The sample, rebuilt from our own row shape ────────────────────────────
// Sample row 1: SOLD (an attached one-unit home, flipped, held in an entity at 50%).
// Sample row 2: RETAINED as a rental (detached) — sold cells blank, flag Y.
// A TOWNHOUSE is what produces `SFR-Attached` now: CorrFirst's own form carries a
// separate `Condo` type, so a condo goes there and only a townhouse — which their
// list has no value for — lands on SFR-Attached.
const soldDeal = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  property_address: { line1: '112 N Main St', unit: '', city: 'Windsor', state: 'NJ', zip: '08561' },
  property_type: 'Townhouse',
  deal_type: 'flip',
  purchase_price: '100000.00', rehab_amount: '100000.00', sale_price: '200000.00',
  purchase_date: '2021-03-10', sale_date: '2024-02-05',
  owned_personally: false, entity_name: 'John Doe', entity_ownership_pct: '50.00',
  borrower_name: 'Somebody Else', notes: 'Additional Note',
};
const retainedDeal = {
  ...soldDeal,
  id: 'aaaaaaaa-0000-0000-0000-000000000002',
  property_type: 'Single-family',
  deal_type: 'rental',
  sale_price: null, sale_date: null,
  rent_date: '2024-02-05',
};

const built = cf.buildCorrfirstCsv([soldDeal, retainedDeal]);
ok(built === cf.CORRFIRST_SAMPLE_CSV, 'the builder reproduces CorrFirst\'s sample file byte-for-byte');
if (built !== cf.CORRFIRST_SAMPLE_CSV) {
  console.log('  built:    ' + JSON.stringify(built));
  console.log('  expected: ' + JSON.stringify(cf.CORRFIRST_SAMPLE_CSV));
}
ok(!built.endsWith('\n'), 'no trailing newline (the sample has none)');
ok(built.indexOf('\r') === -1, 'LF line endings only');
ok(built.split('\n').length === 3, 'header + one line per deal');

// ── 2b) A REAL filled file of theirs, rebuilt the same way ──────────────────
// Three multi-unit rentals held in the borrowers' own entities. This is what
// pins the PLURAL "2-4 Units", an ENTITY in Title Held in Name, a wholly-owned
// entity as "100", a blank note shipping as "", and a seven-figure price.
const realFileDeals = [
  {
    id: 'bbbbbbbb-0000-0000-0000-000000000001',
    property_address: { line1: '195 Lehigh Ave', city: 'Newark', state: 'NJ', zip: '07112' },
    property_type: '2-4 unit residential', deal_type: 'rental',
    purchase_price: '426000.00', rehab_amount: '65000.00',
    purchase_date: '2026-03-01', rent_date: '2026-06-01',
    owned_personally: false, entity_name: 'CBH Reno Home Tech LLC', entity_ownership_pct: '100.00',
    borrower_name: 'Test Borrower', notes: null,
  },
  {
    id: 'bbbbbbbb-0000-0000-0000-000000000002',
    property_address: { line1: '1048 Clay Ave', city: 'Bronx', state: 'NY', zip: '10456' },
    property_type: '2-4 unit residential', deal_type: 'rental',
    purchase_price: 865000, rehab_amount: 95000,
    purchase_date: '2025-03-01', rent_date: '2025-08-01',
    // Trailing space exactly as their own file carries it — we trim, they don't.
    owned_personally: false, entity_name: 'CLAYAVE LLC ', entity_ownership_pct: 100,
    borrower_name: 'Test Borrower', notes: '',
  },
  {
    id: 'bbbbbbbb-0000-0000-0000-000000000003',
    property_address: { line1: '248 E 93rd St', city: 'Brooklyn', state: 'NY', zip: '11212' },
    property_type: '2-4 unit residential', deal_type: 'rental',
    purchase_price: 1035000, rehab_amount: 120000,
    purchase_date: '2024-12-01', refi_date: '2025-05-01',
    owned_personally: false, entity_name: '248 e 93th LLC', entity_ownership_pct: '100',
    borrower_name: 'Test Borrower', notes: null,
  },
];
const builtReal = cf.buildCorrfirstCsv(realFileDeals);
ok(builtReal === cf.CORRFIRST_REAL_FILE_CSV, 'the builder reproduces a REAL CorrFirst file byte-for-byte');
if (builtReal !== cf.CORRFIRST_REAL_FILE_CSV) {
  console.log('  built:    ' + JSON.stringify(builtReal));
  console.log('  expected: ' + JSON.stringify(cf.CORRFIRST_REAL_FILE_CSV));
}
ok(cf.CORRFIRST_REAL_FILE_CSV.split('\n')[0] === templateBytes.toString('utf8'),
  'their real file carries the SAME header as the empty one they sent');
ok(!builtReal.endsWith('\n') && builtReal.indexOf('\r') === -1,
  'their real file is LF with no trailing newline too — same as the sample');
{
  // The three facts the two-row sample could not settle.
  const cells = cf.corrfirstCells(realFileDeals[2]);
  ok(cells[4] === '2-4 Units', 'a 2-4 unit is "2-4 Units" — PLURAL, as their own file writes it');
  ok(cells[6] === '1,035,000', 'a seven-figure price groups both thousands separators');
  ok(cells[11] === '248 e 93th LLC', 'Title Held in Name carries the ENTITY that held it');
  ok(cells[12] === '100', 'a wholly-owned entity is written "100", no % and no decimals');
  ok(cells[13] === '', 'a blank note ships as an empty cell, never omitted');
  ok(cf.corrfirstCells(realFileDeals[1])[11] === 'CLAYAVE LLC', 'a stray trailing space in the entity name is trimmed');
}
ok(cf.corrfirstPropertyType({ property_type: '2-4 unit residential' }).value === '2-4 Units',
  'a 2-4 unit is "2-4 Units" — the exact spelling on their own list');
ok(cf.CORRFIRST_REAL_FILE_CSV.includes('"2-4 Units"') && !cf.CORRFIRST_REAL_FILE_CSV.includes('"2-4 Unit"'),
  'and the fixture is the evidence for it');

// ── 3) Each formatting rule, on its own, read off the sample ─────────────────
ok(cf.csvField('') === '""', 'an empty cell still ships as ""');
ok(cf.csvField('John Doe') === '"John Doe"', 'every data cell is quoted');
ok(cf.csvField('He said "hi"') === '"He said ""hi"""', 'an embedded quote is doubled (RFC 4180)');
ok(cf.csvField('a,b') === '"a,b"', 'a comma inside a value cannot split the row');

ok(cf.mmddyyyy('2021-03-10') === '03/10/2021', 'dates are MM/DD/YYYY');
ok(cf.mmddyyyy('2021-03-10T00:00:00.000Z') === '03/10/2021', 'a timestamp reads the calendar date');
ok(cf.mmddyyyy(new Date(2024, 1, 5)) === '02/05/2024', 'a Date reads its LOCAL parts — never a day off');
ok(cf.mmddyyyy(null) === '' && cf.mmddyyyy('') === '' && cf.mmddyyyy('not a date') === '',
  'an unreadable date is blank, never a wrong date');

ok(cf.money(100000) === '100,000', 'money: thousands separators');
ok(cf.money('200000.00') === '200,000', 'money: no cents');
ok(cf.money(1234567.89) === '1,234,568', 'money: rounded to whole dollars');
ok(cf.money(null) === '' && cf.money('') === '', 'a missing figure is blank, never 0');
ok(cf.money(0) === '0', 'a real zero is still a zero');
ok(!/\$/.test(cf.money(100000)), 'no dollar sign (the sample has none)');

ok(cf.zip5('08561') === '08561', 'ZIP keeps its leading zero');
ok(cf.zip5('08561-1234') === '08561', 'ZIP+4 collapses to five');
ok(cf.zip5(8561) === '08561', 'a numeric ZIP is re-padded to five');
ok(cf.zip5('') === '', 'no ZIP stays blank');

ok(cf.pct(50) === '50' && cf.pct('50.00') === '50', 'ownership share has no trailing .00');
ok(cf.pct(33.33) === '33.33', 'a real fraction survives');
ok(cf.pct(null) === '', 'an unrecorded share is blank');
ok(!/%/.test(cf.pct(50)), 'no % sign (the sample has none)');

ok(cf.yn(true) === 'Y' && cf.yn(false) === 'N', 'flags are Y / N');

// ── 4) Rental Retained is read off the DATA, and matches the sample's invariant
ok(cf.wasSold({ sale_date: '2024-02-05' }) === true, 'a sale date means sold');
ok(cf.wasSold({ sale_price: 200000 }) === true, 'a sale price means sold');
ok(cf.wasSold({ rent_date: '2024-02-05' }) === false, 'a lease-up is not a sale');
ok(cf.wasSold({ refi_date: '2024-02-05', deal_type: 'flip' }) === false, 'a refinance is not a sale');
ok(cf.wasSold({}) === false, 'nothing recorded → not sold');
{
  // Y ⇒ both sold cells empty. Their own sample shows it, and their own SOFTWARE
  // enforces it: a network capture of a staffer entering a line in CorrFirst's
  // system (2026-08-16) shows `asRental:true` sending a payload with NO salesDate
  // and NO salesPrice keys at all. Their form cannot hold the other combination,
  // so this is structural — never "complete" a retained line with a sale date.
  const cells = cf.corrfirstCells(retainedDeal);
  ok(cells[8] === 'Y' && cells[9] === '' && cells[10] === '',
    'retained (Y) ⇒ Sold Date and Sold Price are empty');
  // Even when the row DOES carry a stale sale figure, the retained line ships clean.
  const staleRetained = cf.corrfirstCells({ ...retainedDeal, sale_price: null, sale_date: null, rent_date: '2024-02-05' });
  ok(staleRetained[8] === 'Y' && staleRetained[9] === '' && staleRetained[10] === '',
    'a retained line never carries a sold cell — the combination their form cannot hold');
  const soldCells = cf.corrfirstCells(soldDeal);
  ok(soldCells[8] === 'N' && soldCells[9] === '02/05/2024' && soldCells[10] === '200,000',
    'sold (N) ⇒ Sold Date and Sold Price are filled');
  // A rental that was LATER sold reports the sale — that is what happened.
  const rentedThenSold = { ...retainedDeal, sale_date: '2025-06-01', sale_price: 300000 };
  const c = cf.corrfirstCells(rentedThenSold);
  ok(c[8] === 'N' && c[9] === '06/01/2025', 'a rental that was later sold is reported as sold');
}

// ── 5) Property Type — CorrFirst's OWN list is the whole authority ───────────
// THE HARD RULE: every value this module can emit is on their list. A mapping
// edited to something their form cannot hold fails right here, not at the import.
ok(cf.verifyPropertyTypes().length === 0,
  `every mapping lands on a value CorrFirst's own form offers${cf.verifyPropertyTypes().length ? ' — offenders: ' + cf.verifyPropertyTypes().join(', ') : ''}`);
{
  // Nothing may emit an off-list value by ANY route, including the pass-through.
  const tried = ['Single-family', 'Condo / townhome', 'townhouse', 'PUD', '2-4 unit residential',
    '5+ unit multifamily', 'Mixed-use', 'Land / lot', 'Commercial', 'Office', 'self storage',
    'WAREHOUSE', 'Automotive', 'Manufactured', 'Modular', 'Industrial', 'Retail', '', 'nonsense'];
  const offList = tried
    .map((t) => cf.corrfirstPropertyType({ property_type: t }).value)
    .filter((v) => v !== '' && !cf.CORRFIRST_PROPERTY_TYPE_OPTIONS.includes(v));
  ok(offList.length === 0, `no input can produce a value off their list${offList.length ? ' — got ' + offList.join(', ') : ''}`);
}
// The four values our earlier reading got WRONG, each now their own spelling.
ok(cf.corrfirstPropertyType({ property_type: 'Condo' }).value === 'Condo',
  'a CONDO is "Condo" — their own type, not SFR-Attached');
ok(cf.corrfirstPropertyType({ property_type: 'PUD' }).value === 'PUD',
  'a PUD is "PUD" — their own type, not SFR-Detached');
ok(cf.corrfirstPropertyType({ property_type: 'Mixed-use' }).value === 'Mixed-Use',
  'mixed use is "Mixed-Use" WITH the hyphen');
ok(cf.corrfirstPropertyType({ property_type: '5+ unit multifamily' }).value === 'Multifamily 5+',
  '5+ units is "Multifamily 5+" — the unit-count naming stops at 2-4 and does not continue up');
ok(cf.corrfirstPropertyType({ property_type: 'Single-family' }).value === 'SFR-Detached', 'single-family → SFR-Detached');
for (const t of ['Single-family', 'Condo', 'PUD', 'Mixed-use', '5+ unit multifamily', '2-4 unit residential']) {
  ok(cf.corrfirstPropertyType({ property_type: t }).exact === true, `"${t}" is a one-for-one match with their list`);
}
// A TOWNHOUSE is the one shape their list has no value for. It goes out as the
// closest one they DO have, and is reported — never silently.
{
  const th = cf.corrfirstPropertyType({ property_type: 'Townhouse' });
  ok(th.value === 'SFR-Attached', 'a townhouse → SFR-Attached, the closest value on their list');
  ok(th.exact === false && th.noEquivalent === false, '…and is reported as a judgement, not as an exact match');
}
// THE PASS-THROUGH: our own vocabulary collapses every commercial shape to
// `other`, so a stored type that already IS one of their values must survive.
for (const [stored, expected] of [
  ['Office', 'Office'], ['Retail', 'Retail'], ['Industrial', 'Industrial'],
  ['Warehouse', 'Warehouse'], ['self storage', 'Self Storage'], ['SELF-STORAGE', 'Self Storage'],
  ['automotive', 'Automotive'], ['Manufactured', 'Manufactured'], ['Modular', 'Modular'],
]) {
  const got = cf.corrfirstPropertyType({ property_type: stored });
  ok(got.value === expected, `"${stored}" passes through as CorrFirst's own "${expected}"`);
  ok(got.exact === true && got.noEquivalent === false, `…and "${stored}" is not flagged`);
}
ok(cf.corrfirstOptionOf('Retail Strip Center') === null,
  'the pass-through is EXACT — "Retail Strip Center" never becomes "Retail"');
ok(cf.corrfirstOptionOf('sfr') === null, 'a bare "sfr" is not one of their values — it goes through the reader');
// A shape their list has NOTHING for ships BLANK and is reported. Their form has
// no land/lot value at all, and there is no "Other" to hide it in.
for (const t of ['Land / lot', 'Commercial', 'Vacant land']) {
  const got = cf.corrfirstPropertyType({ property_type: t });
  ok(got.value === '' && got.noEquivalent === true && got.missing === false,
    `"${t}" has no CorrFirst equivalent → blank cell, reported by name, never invented`);
}
ok(!cf.CORRFIRST_PROPERTY_TYPE_OPTIONS.includes('Other'),
  'their list has no "Other" — so nothing here may emit one');
// THE CROSS-SYSTEM CONTRACT: every property type PILOT's OWN governed vocabulary
// can hold reaches a value CorrFirst's form offers. `property-type.PROPERTY_TYPES`
// is what `sanitizePropertyType` lets into the column, so this is the real input
// set — and adding a type there without teaching this export about it now fails
// here instead of shipping a blank column to an investor. (`property-type.js` has
// no requires of its own, so the test stays pure.)
{
  const PT = require('../src/lib/property-type');
  const stranded = [];
  const judged = [];
  for (const p of PT.PROPERTY_TYPES) {
    const got = cf.corrfirstPropertyType({ property_type: p.label });
    if (got.value && !cf.CORRFIRST_PROPERTY_TYPE_OPTIONS.includes(got.value)) stranded.push(`${p.label} -> ${got.value} (off their list)`);
    else if (!got.value) stranded.push(`${p.label} -> blank`);
    else if (!got.exact) judged.push(p.label);
  }
  ok(stranded.length === 0,
    `every property type PILOT can store reaches a value CorrFirst's form offers${stranded.length ? ' — stranded: ' + stranded.join(', ') : ''}`);
  ok(judged.length === 1 && judged[0] === 'Townhouse',
    `Townhouse is the ONLY judgement call in our whole vocabulary${judged.length !== 1 ? ' — got: ' + judged.join(', ') : ''}`);
}
{
  const none = cf.corrfirstPropertyType({ property_type: '' });
  ok(none.missing === true && none.value === '' && none.noEquivalent === false,
    'no property type on the line → blank cell; a property fact is never invented');
}
// The values their own FILES carry must still be on the list we read off their
// form — the two sources of truth agreeing is what proves the list was read right.
const CORRFIRST_EVIDENCE = cf.CORRFIRST_SAMPLE_CSV + '\n' + cf.CORRFIRST_REAL_FILE_CSV;
for (const v of cf.CORRFIRST_PROPERTY_TYPE_OPTIONS) {
  if (CORRFIRST_EVIDENCE.includes(`"${v}"`)) ok(true, `"${v}" appears in a file CorrFirst sent us AND on their form`);
}
for (const seen of ['SFR-Attached', 'SFR-Detached', '2-4 Units']) {
  ok(CORRFIRST_EVIDENCE.includes(`"${seen}"`) && cf.CORRFIRST_PROPERTY_TYPE_OPTIONS.includes(seen),
    `"${seen}" — the value their own files carry — is on the list we read off their form`);
}

// ── 6) Title Held in Name / % of Ownership ───────────────────────────────────
ok(cf.titleHeldInName({ owned_personally: true, borrower_name: 'Jane Roe', entity_name: 'Stale LLC' }) === 'Jane Roe',
  'held personally → the borrower\'s name, and the stale entity never wins');
ok(cf.titleHeldInName({ owned_personally: false, entity_name: 'Main St Holdings LLC' }) === 'Main St Holdings LLC',
  'held in an entity → the entity name');
ok(cf.titleHeldInName({ owned_personally: false, entity_name: '', borrower_name: 'Jane Roe' }) === 'Jane Roe',
  'no entity named → the borrower, so the investor\'s title column is never blank for nothing');
ok(cf.ownershipPctOf({ owned_personally: true }) === 100, 'held personally → 100%');
ok(cf.ownershipPctOf({ owned_personally: false, entity_ownership_pct: '50.00' }) === 50, 'entity → the recorded stake');
ok(cf.ownershipPctOf({ owned_personally: false, entity_ownership_pct: null }) === null,
  'no recorded stake → null (blank + reported), never an assumed 100');

// ── 7) Addresses that are not the canonical object still export ──────────────
{
  const oneLine = cf.addressCellsOf('112 N Main St, Windsor, NJ 08561');
  ok(oneLine.street === '112 N Main St' && oneLine.city === 'Windsor' && oneLine.state === 'NJ' && oneLine.zip === '08561',
    'a bare one-line address (the public-records importer\'s shape) parses into the four cells');
  const gappy = cf.addressCellsOf({ line1: '44 Oak St', oneLine: '44 Oak St, Trenton, NJ 08611' });
  ok(gappy.city === 'Trenton' && gappy.state === 'NJ' && gappy.zip === '08611',
    'missing parts are filled from the one-line text');
  const stored = cf.addressCellsOf({ line1: '44 Oak St', city: 'Trenton', state: 'New Jersey', zip: '08611-1234' });
  ok(stored.state === 'NJ' && stored.zip === '08611', 'a spelled-out state is abbreviated; ZIP+4 collapses');
  const withUnit = cf.addressCellsOf({ line1: '44 Oak St', unit: 'Apt 2', city: 'Trenton', state: 'NJ', zip: '08611' });
  ok(withUnit.street === '44 Oak St Apt 2', 'the unit rides on the street line');
  ok(cf.addressCellsOf(null).street === '', 'a missing address does not throw');
}

// ── 8) A newline in the notes can never break the row ────────────────────────
{
  const row = cf.corrfirstRow({ ...soldDeal, notes: 'Line one\nLine two' });
  ok(row.indexOf('\n') === -1, 'a newline in the notes is flattened — one deal is always one line');
  ok(row.split('","').length === 14, 'the row still has exactly 14 cells');
}

// ── 9) The warnings name every gap, so nothing goes out silently short ───────
{
  const w = cf.corrfirstWarnings([
    { id: '1', property_address: { line1: '1 A St' }, property_type: '', owned_personally: true, purchase_date: '2021-01-01', purchase_price: 100000, borrower_name: 'Jane Roe' },
    { id: '2', property_address: { line1: '2 B St' }, property_type: 'Land / lot', owned_personally: false, entity_name: 'X LLC', entity_ownership_pct: null, purchase_date: null, purchase_price: null },
    { id: '3', property_address: { line1: '3 C St' }, property_type: '2-4 unit residential', owned_personally: true, purchase_date: '2021-01-01', purchase_price: 100000, borrower_name: 'Jane Roe' },
    { id: '4', property_address: { line1: '4 D St' }, property_type: 'Townhouse', owned_personally: true, purchase_date: '2021-01-01', purchase_price: 100000, borrower_name: 'Jane Roe' },
  ]);
  ok(w.missingPropertyType.length === 1 && w.missingPropertyType[0] === '1 A St', 'the line with no property type is named');
  ok(w.unmappedPropertyType.length === 1 && w.unmappedPropertyType[0].property === '2 B St'
     && w.unmappedPropertyType[0].ours === 'Land / lot',
     'the type CorrFirst has no value for is named, with what WE call it so staff can act on it');
  ok(w.judgedPropertyType.length === 1 && w.judgedPropertyType[0].property === '4 D St'
     && w.judgedPropertyType[0].value === 'SFR-Attached',
     'the one judgement call (townhouse) is named with the value being sent');
  ok(!w.unmappedPropertyType.some((u) => u.property === '3 C St')
     && !w.judgedPropertyType.some((u) => u.property === '3 C St'),
     'a 2-4 unit is not flagged at all — it is an exact match on their own list');
  ok(w.missingOwnership.length === 1 && w.missingOwnership[0] === '2 B St', 'the line with no ownership share is named');
  ok(w.missingPurchase.length === 1 && w.missingPurchase[0] === '2 B St', 'the line missing purchase facts is named');
  ok(w.noTitleName.length === 0, 'a line that does have a title name is not flagged');
}

// ── 10) The file name follows CorrFirst's own SHAPE ("Track Record_ 32856.csv"),
//        but is named by OUR loan number (owner-directed 2026-08-24: "we always
//        prefer our loan number, not the investor's … across the board").
ok(cf.corrfirstFilename({ ys_loan_number: 'YS-1001', investor_loan_number: '32856' }) === 'Track Record_YS-1001.csv',
  'named by OUR loan number even when the investor number is on the file');
ok(cf.corrfirstFilename({ investor_loan_number: '32856' }) === 'Track Record_32856.csv',
  'falls back to the investor number when we have none of our own');
ok(cf.corrfirstFilename({ ys_loan_number: 'YS-1001' }) === 'Track Record_YS-1001.csv', 'our loan number alone');
ok(cf.corrfirstFilename({ last_name: 'Doe' }) === 'Track Record_Doe.csv', 'then to the borrower');
ok(cf.corrfirstFilename({}) === 'Track Record_Export.csv', 'and always produces a name');

// ── 11) The verified-only gate is in the SQL, and says so ────────────────────
{
  const src = fs.readFileSync(require.resolve('../src/lib/corrfirst-track-record.js'), 'utf8');
  ok(/AND t\.is_verified = true/.test(src),
    'the loader gates on is_verified = true — the same definition the tier and the TPR package use');
  ok(!/is_verified\s*=\s*false/.test(src), 'nothing in here can widen that gate');
}

assert.strictEqual(failures, 0, `${failures} check(s) failed`);
console.log('\nAll CorrFirst track-record export checks passed.');
