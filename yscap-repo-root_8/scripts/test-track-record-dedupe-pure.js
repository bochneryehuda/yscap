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

const assert = require('assert');
const TRK = require('../src/lib/track-record-key');
const HEAL = require('../src/lib/track-record-heal')._internals;

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

console.log('\n6. what may be folded away, and what may never be');
const keeper = { id: 'k', is_verified: true, origin: 'portal', purchase_price: 400000, sale_price: null };
const refuse = (row) => HEAL.refuseReason(row, keeper);
ok(refuse({ id: 'a', is_verified: true, origin: 'clickup_backfill' }) === 'verified',
  'a VERIFIED line is locked evidence — never folded away');
ok(refuse({ id: 'b', origin: 'portal' }) === 'human_authored',
  'a line a HUMAN typed is theirs — never folded away');
ok(refuse({ id: 'c', origin: 'clickup_backfill', has_documents: true }) === 'has_documents',
  'a line holding closing documents is never folded away');
ok(refuse({ id: 'd', origin: 'clickup_backfill', has_conditions: true }) === 'has_conditions',
  'a line a condition points at is never folded away');
ok(refuse({ id: 'e', origin: 'encompass', notes: 'Seller financed — check with Yidi' }) === 'has_note',
  'a line somebody wrote a real note on is never folded away');
ok(refuse({ id: 'f', origin: 'clickup_backfill', purchase_price: 425000 }) === 'conflict:purchase_price',
  'a line that DISAGREES on a figure is left for a human');
ok(refuse({ id: 'g', origin: 'clickup_backfill', notes: 'Auto-derived from ClickUp; unverified' }) === null,
  'a machine-written line with the machine\'s own note IS safe to fold away');
ok(refuse({ id: 'h', origin: 'clickup_backfill', purchase_price: 400000 }) === null,
  '…and one that AGREES on a figure is safe too');
ok(refuse({ id: 'i', inferred: true, origin: 'something_new', sale_price: 500000 }) === null,
  'an INFERRED line adding a figure the keeper lacks is safe (it will be carried over)');

console.log('\n7. the line that survives is the one carrying the most');
const pick = (rows2) => HEAL.pickKeeper(rows2).id;
ok(pick([
  { id: 'plain', origin: 'clickup_backfill', created_at: '2026-01-01' },
  { id: 'verified', origin: 'clickup_backfill', is_verified: true, created_at: '2026-02-01' },
]) === 'verified', 'verified beats unverified');
ok(pick([
  { id: 'plain', origin: 'clickup_backfill', created_at: '2026-01-01' },
  { id: 'withdocs', origin: 'clickup_backfill', has_documents: true, created_at: '2026-02-01' },
]) === 'withdocs', 'a line with documents beats a bare one');
ok(pick([
  { id: 'machine', origin: 'clickup_backfill', created_at: '2026-01-01' },
  { id: 'human', origin: 'portal', created_at: '2026-02-01' },
]) === 'human', "a human's line beats a machine's");
ok(pick([
  { id: 'first', origin: 'clickup_backfill', created_at: '2026-01-01' },
  { id: 'second', origin: 'clickup_backfill', created_at: '2026-02-01' },
]) === 'first', 'all else equal, the ORIGINAL survives');

console.log('\n8. grouping is by property, and a single line is never a "group"');
const g = HEAL.groupByProperty([
  { id: '1', property_address: '26 S 10th St, Brooklyn, NY 11249' },
  { id: '2', property_address: '26 South 10th Street, Brooklyn, NY 11249, USA' },
  { id: '3', property_address: '99 Elm St, Lakewood, NJ 08701' },
]);
ok(g.length === 1 && g[0].length === 2, 'the two spellings group; the unrelated house does not');
ok(HEAL.groupByProperty([{ id: '1', property_address: '99 Elm St, Lakewood, NJ 08701' }]).length === 0,
  'one line alone is never offered for merging');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  track-record dedupe: one key, one verdict, and a merge that can only ever fold away an untouched machine-written copy');
process.exit(fail ? 1 : 0);
