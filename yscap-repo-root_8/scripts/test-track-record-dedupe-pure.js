'use strict';
/**
 * The track-record duplicate: the ONE key, and the rules that decide a merge.
 *
 * Owner-reported 2026-08-02: "one track record has twice the same address …
 * there is an issue why we have two addresses on the same."
 *
 * These are the cases that ACTUALLY produced two lines for one house — the same
 * property written the way ClickUp writes it and the way Encompass writes it.
 * Each was a different string to the four old normalizers.
 */

const TRK = require('../src/lib/track-record-key');
const TRF = require('../src/lib/track-record-findings');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok  ${m}`); } else { fail++; console.error(`  FAIL ${m}`); } };

console.log('1. the same house always groups, however it is written');
/* Each pair is one property. The LEFT is the shape one writer stored, the RIGHT
   another — these are the exact differences the old keys could not see. */
const SAME = [
  ['26 S 10th St, Brooklyn, NY 11249', '26 South 10th Street, Brooklyn, NY 11249, USA'],
  ['5701 15 Ave, Brooklyn, NY 11219', '5701 15th Ave, Brooklyn, NY 11219'],
  ['12 Churchill Ln, Lakewood, NJ 08701', '12 Churchill Lane, Lakewood, NJ 08701-1234'],
  ['1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2ND STREET, PISCATAWAY, NJ 08854'],
];
for (const [a, b] of SAME) {
  ok(TRK.trackRecordKey(a) && TRK.trackRecordKey(a) === TRK.trackRecordKey(b),
    `same key: "${a}" == "${b}"`);
  ok(TRK.sameProperty(a, b), `and confirmed the same property`);
}

/* THE KEY IS A HINT, NOT THE ANSWER — and a house-number RANGE is where that
   distinction is load-bearing. "27-29 Tuscany Ter" and "27 Tuscany Ter" are one
   building written two ways (sameAddress covers a range's endpoints), but the
   key is built from the house number verbatim, so they do NOT share one. That is
   fine and must stay fine: matchTrackRecord falls back to a full sameProperty
   scan of the borrower's rows, and the merge groups on sameProperty directly —
   neither depends on the key agreeing. Widening the key to normalize ranges
   would collapse "27" and "29 Tuscany Ter" if they were ever separate lots. */
const RANGE = ['27-29 Tuscany Ter, Monroe, NY 10950', '27 Tuscany Terrace, Monroe, NY 10950'];
ok(TRK.sameProperty(RANGE[0], RANGE[1]), 'a house-number range IS the same property as its endpoint');
ok(TRK.trackRecordKey(RANGE[0]) !== TRK.trackRecordKey(RANGE[1]),
  '…even though the grouping key differs — the key is a hint, sameProperty is the verdict');
ok(TRK.matchTrackRecord([{ id: 'rng', property_address: RANGE[0], address_key: TRK.trackRecordKey(RANGE[0]) }], RANGE[1]) !== null,
  '…and the match still finds it, because the fallback reads the ADDRESS');

console.log('\n2. two different houses never group');
const DIFFERENT = [
  ['26 S 10th St, Brooklyn, NY 11249', '28 S 10th St, Brooklyn, NY 11249'],           // house number
  ['26 S 10th St, Brooklyn, NY 11249', '26 N 10th St, Brooklyn, NY 11249'],           // directional
  ['1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Plainfield, NJ 07063'],     // the municipal-line case
  ['12 Oak Ave, Lakewood, NJ 08701', '12 Oak Rd, Lakewood, NJ 08701'],                // street
];
for (const [a, b] of DIFFERENT) {
  ok(!TRK.sameProperty(a, b), `different property: "${a}" vs "${b}"`);
}

console.log('\n3. a UNIT is the verdict\'s job, never the key\'s');
/* addressCompareKey is unit-free so one side omitting the unit still groups —
   that is what makes it a good net. It would be a terrible verdict, because two
   condo units share it, which is why sameProperty decides. */
const U1 = '80 Bedford Ave Apt 3A, Brooklyn, NY 11249';
const U2 = '80 Bedford Ave Apt 5B, Brooklyn, NY 11249';
const U0 = '80 Bedford Ave, Brooklyn, NY 11249';
ok(TRK.trackRecordKey(U1) === TRK.trackRecordKey(U2), 'two units in one building share the grouping key');
ok(!TRK.sameProperty(U1, U2), '…and are NOT the same property (two different units)');
ok(TRK.sameProperty(U1, U0), 'the same address written without the unit IS the same property');

console.log('\n4. an unreadable address can never claim a match');
for (const bad of ['', null, undefined, 'PO Box 42', 'Brooklyn, NY', {}, 42]) {
  ok(TRK.trackRecordKey(bad) === '', `no key for ${JSON.stringify(bad)}`);
  ok(TRK.matchTrackRecord([{ id: 'x', property_address: bad, address_key: '' }], bad) === null,
    `and never matches another unreadable row`);
}

console.log('\n5. a stale stored key is still matched — the ADDRESS is the truth');
/* The whole reason a row can be a duplicate is that its stored key was written
   by a normalizer that is gone. Matching must not depend on the key. */
const rows = [{ id: 'r1', property_address: '26 South 10th Street, Brooklyn, NY 11249, USA', address_key: '26south10thstreetbrooklynny11249usa' }];
const hit = TRK.matchTrackRecord(rows, '26 S 10th St, Brooklyn, NY 11249');
ok(hit && hit.id === 'r1', 'a row carrying an OLD ClickUp-style key still matches the same house');

console.log('\n6. WHAT THE TRACK-RECORD DESK FINDS — detection lives in ONE place now');
/* Detection moved out of the boot pass and into track-record-findings
   (owner-directed 2026-08-02: "we should NOT send it to the regular manual
   review queue … we should have findings ON the track record"). The boot pass
   only re-keys and delegates, so these are the tests that matter. */
const D = TRF._internals;
const at = (line1) => ({ line1, city: 'Lakewood', state: 'NJ', zip: '08701' });
const row = (id, line1, extra) => Object.assign({ id, property_address: at(line1) }, extra || {});

ok(D.duplicateFindings([]).length === 0, 'no lines → nothing found');
ok(D.duplicateFindings([row('a', '5 Main St')]).length === 0, 'one line alone is never a duplicate');
{
  const f = D.duplicateFindings([
    { id: 'x', property_address: '26 South 10th Street, Brooklyn, NY 11249, USA' },
    { id: 'y', property_address: '26 S 10th St, Brooklyn, NY 11249' },
  ]);
  ok(f.length === 1, 'the same house spelled two ways IS found');
  ok(f[0].code === 'duplicate_line', '…as a duplicate_line finding');
  ok(/26 S(outh)? 10th/.test(f[0].detail), '…quoting the addresses so a person can judge');
}
ok(D.duplicateFindings([
  { id: 'a', property_address: '5 Main St, Lakewood, NJ 08701' },
  { id: 'b', property_address: '99 Elm St, Monsey, NY 10952' },
]).length === 0, 'two different houses are never paired');
ok(D.duplicateFindings([
  { id: 'a', property_address: 'PO Box 42' }, { id: 'b', property_address: 'PO Box 42' },
]).length === 0, 'an address nothing can read is NEVER called a duplicate — silence is the safe answer');

console.log('\n6b. sameAddress IS NOT TRANSITIVE — so every pair is confirmed on its own');
/* A bare row matches EVERY unit in a building and a house-number RANGE matches
   every number it spans, so a group of three can hold two genuinely different
   properties. The desk reports PAIRS it directly confirmed, which is what makes
   that impossible to get wrong — the two addresses on the card are always the
   two the action will act on. */
{
  const three = [row('bare', '5 Main St'), row('u1', '5 Main St Apt 1'), row('u2', '5 Main St Apt 2')];
  const pairs = D.duplicateFindings(three).map((f) => [f.trackRecordId, f.otherId].sort().join('|')).sort();
  ok(!pairs.includes('u1|u2'), 'Apt 1 and Apt 2 are never offered as a pair');
  ok(pairs.length === 2, 'only the two pairs the address check actually confirmed');
}
{
  const three = [row('span', '27-29 Oak Ave'), row('n27', '27 Oak Ave'), row('n29', '29 Oak Ave')];
  const pairs = D.duplicateFindings(three).map((f) => [f.trackRecordId, f.otherId].sort().join('|')).sort();
  ok(!pairs.includes('n27|n29'), '27 and 29 are never offered as a pair, though a range covers both');
}
ok(D.pairKey('a', 'b') === D.pairKey('b', 'a'),
  'a pair has ONE identity whichever way round — a dismissal can never be bypassed by re-ordering');

console.log('\n7. the line the merge would KEEP is the one carrying the most');
const better = (a, b) => (D.rank(a) >= D.rank(b));
ok(better({ is_verified: true }, { purchase_price: 1 }), 'verified outranks a figure');
ok(better({ has_documents: true }, { purchase_price: 1, sale_price: 1 }), 'documents outrank figures');
ok(better({ purchase_price: 1, sale_price: 1 }, { purchase_price: 1 }), 'more figures outrank fewer');
{
  const f = D.duplicateFindings([row('bare', '5 Main St'), row('rich', '5 Main Street', { purchase_price: 1, has_documents: true })]);
  ok(f[0].trackRecordId === 'rich' && f[0].otherId === 'bare',
    'so the card names the richer line as the keeper — the card reads the way the action behaves');
}

console.log('\n8. THE FILE\u2019S OWN SUBJECT PROPERTY on the track record');
const subj = '12 Churchill Lane, Lakewood, NJ 08701';
{
  const f = D.subjectPropertyFindings(
    [{ id: 'l1', property_address: '12 Churchill Ln, Lakewood, NJ 08701, USA' },
     { id: 'l2', property_address: '99 Elm St, Monsey, NY 10952' }], subj, 'app1');
  ok(f.length === 1 && f[0].trackRecordId === 'l1', 'the line that IS this deal is found, and only it');
  ok(f[0].code === 'subject_property_on_record', '…as its own kind of finding');
  ok(f[0].applicationId === 'app1', '…tied to the deal it is about');
}
ok(D.subjectPropertyFindings([{ id: 'l1', property_address: subj }], null, 'app1').length === 0,
  'a file with no subject property raises nothing');
ok(D.subjectPropertyFindings([{ id: 'l1', property_address: subj }], 'PO Box 3', 'app1').length === 0,
  'an unreadable subject property raises nothing — never a guess');
ok(D.subjectPropertyFindings([{ id: 'l1', property_address: subj }], subj, null).length === 0,
  'and without the file id there is nothing to raise it against');

console.log('\n9. every finding offers a few options, and dismiss is always one');
ok(TRF.actionsFor('duplicate_line').join(',') === 'merge,keep_both,dismiss',
  'a duplicate: merge, keep both, or dismiss');
ok(TRF.actionsFor('subject_property_on_record').join(',') === 'remove_line,not_our_property,dismiss',
  'the subject property: take it off, say they really owned it, or dismiss');
ok(TRF.isActionAllowed('duplicate_line', 'remove_line') === false,
  'an option belonging to another finding is refused');
ok(TRF.actionsFor('something_new').join(',') === 'dismiss',
  'an unknown code degrades to dismiss rather than offering something dangerous');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record: one key, one verdict, and every duplicate goes to a person as a finding');
process.exit(fail ? 1 : 0);
