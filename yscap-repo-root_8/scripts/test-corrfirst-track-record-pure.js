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
const soldDeal = {
  id: 'aaaaaaaa-0000-0000-0000-000000000001',
  property_address: { line1: '112 N Main St', unit: '', city: 'Windsor', state: 'NJ', zip: '08561' },
  property_type: 'Condo / townhome',
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
ok(cf.corrfirstPropertyType({ property_type: '2-4 unit residential' }).proven === true,
  '2-4 Units is PROVEN now — one of their own files carries it');
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
  // The invariant CorrFirst's own sample shows: Y ⇒ both sold cells empty.
  const cells = cf.corrfirstCells(retainedDeal);
  ok(cells[8] === 'Y' && cells[9] === '' && cells[10] === '',
    'retained (Y) ⇒ Sold Date and Sold Price are empty');
  const soldCells = cf.corrfirstCells(soldDeal);
  ok(soldCells[8] === 'N' && soldCells[9] === '02/05/2024' && soldCells[10] === '200,000',
    'sold (N) ⇒ Sold Date and Sold Price are filled');
  // A rental that was LATER sold reports the sale — that is what happened.
  const rentedThenSold = { ...retainedDeal, sale_date: '2025-06-01', sale_price: 300000 };
  const c = cf.corrfirstCells(rentedThenSold);
  ok(c[8] === 'N' && c[9] === '06/01/2025', 'a rental that was later sold is reported as sold');
}

// ── 5) Property Type — proven values vs. our reading of their convention ─────
ok(cf.corrfirstPropertyType({ property_type: 'Single-family' }).value === 'SFR-Detached', 'single-family → SFR-Detached');
ok(cf.corrfirstPropertyType({ property_type: 'Condo / townhome' }).value === 'SFR-Attached', 'condo/townhome → SFR-Attached');
ok(cf.corrfirstPropertyType({ property_type: 'Single-family' }).proven === true, 'that value is one the sample proves');
ok(cf.corrfirstPropertyType({ property_type: 'Condo / townhome' }).proven === true, 'so is that one');
ok(cf.corrfirstPropertyType({ property_type: '5+ unit multifamily' }).proven === false,
  'a 5+ multifamily uses a value CorrFirst has not confirmed — flagged, never shipped silently');
ok(cf.corrfirstPropertyType({ property_type: '5+ unit multifamily' }).value === '5+ Units',
  '…and it follows the convention their own "2-4 Units" proves, not a different word');
ok(cf.corrfirstPropertyType({ property_type: 'Mixed-use' }).proven === false, 'same for mixed-use');
ok(cf.corrfirstPropertyType({ property_type: 'Land / lot' }).proven === false, 'same for land');
{
  const none = cf.corrfirstPropertyType({ property_type: '' });
  ok(none.missing === true && none.value === '',
    'no property type on the line → blank cell; a property fact is never invented');
}
// THE MEANING OF `proven`, enforced: a mapping may only claim it when one of
// CorrFirst's OWN files carries that exact value. Marking something proven
// without the evidence fails right here.
const CORRFIRST_EVIDENCE = cf.CORRFIRST_SAMPLE_CSV + '\n' + cf.CORRFIRST_REAL_FILE_CSV;
for (const [k, v] of Object.entries(cf.CORRFIRST_PROPERTY_TYPES)) {
  if (v.proven) ok(CORRFIRST_EVIDENCE.includes(`"${v.value}"`), `${k} → "${v.value}" appears in a file CorrFirst sent us`);
  else ok(!CORRFIRST_EVIDENCE.includes(`"${v.value}"`), `${k} → "${v.value}" is honestly marked unproven (no file of theirs shows it)`);
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
    { id: '2', property_address: { line1: '2 B St' }, property_type: '5+ unit multifamily', owned_personally: false, entity_name: 'X LLC', entity_ownership_pct: null, purchase_date: null, purchase_price: null },
    { id: '3', property_address: { line1: '3 C St' }, property_type: '2-4 unit residential', owned_personally: true, purchase_date: '2021-01-01', purchase_price: 100000, borrower_name: 'Jane Roe' },
  ]);
  ok(w.missingPropertyType.length === 1 && w.missingPropertyType[0] === '1 A St', 'the line with no property type is named');
  ok(w.unprovenPropertyType.length === 1 && w.unprovenPropertyType[0].property === '2 B St'
     && w.unprovenPropertyType[0].value === '5+ Units', 'the unconfirmed property-type value is named with its value');
  ok(!w.unprovenPropertyType.some((u) => u.property === '3 C St'),
     'a 2-4 unit is NOT flagged any more — their own file proved that value');
  ok(w.missingOwnership.length === 1 && w.missingOwnership[0] === '2 B St', 'the line with no ownership share is named');
  ok(w.missingPurchase.length === 1 && w.missingPurchase[0] === '2 B St', 'the line missing purchase facts is named');
  ok(w.noTitleName.length === 0, 'a line that does have a title name is not flagged');
}

// ── 10) The file name follows CorrFirst's own ("Track Record_ 32856.csv") ────
ok(cf.corrfirstFilename({ investor_loan_number: '32856' }) === 'Track Record_32856.csv',
  'named after the investor loan number, like the file they sent');
ok(cf.corrfirstFilename({ ys_loan_number: 'YS-1001' }) === 'Track Record_YS-1001.csv', 'falls back to our loan number');
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
