'use strict';
/**
 * R5.53 (title/lien half) — pure tests for the title/public-records normalizer.
 * Proves it (1) extracts the recorded owner + categorizes encumbrances from a raw
 * title payload, (2) de-dupes repeated liens and drops released ones, (3) flags an
 * ADVERSE encumbrance (judgment/tax/mechanic) vs a benign payoff mortgage, (4)
 * pairs the recorded owner into a name reconcile against the contract seller, and
 * (5) never throws on hostile input.
 */
const assert = require('assert');
const tl = require('../src/lib/underwriting/title-lien-normalize');
const { reconcile } = require('../src/lib/verification/reconciler');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- a realistic title search: owner + a mortgage + a tax lien + a released one ---
let t = tl.normalizeTitleRecord({
  provider: 'datatree',
  owner: 'Oak Street Holdings LLC',
  vesting: 'sole ownership',
  liens: [
    { type: 'First Deed of Trust', amount: 320000, holder: 'Big Bank', recorded_date: '2021-05-01' },
    { description: 'Delinquent property tax lien', amount: 8500, holder: 'County' },
    { type: 'Mortgage', amount: 15000, status: 'reconveyed' }, // released → dropped
  ],
});
assert.strictEqual(t.available, true);
assert.strictEqual(t.ownerOfRecord, 'Oak Street Holdings LLC');
assert.strictEqual(t.liens.length, 2, 'the released lien is dropped');
assert.ok(t.liens.some((l) => l.kind === 'mortgage' && l.amount === 320000));
assert.ok(t.liens.some((l) => l.kind === 'tax' && l.amount === 8500));
assert.strictEqual(t.openLienTotal, 328500);
assert.strictEqual(t.hasAdverseEncumbrance, true, 'a tax lien is adverse (not benign at payoff)');
ok('extracts owner + categorizes liens, drops a released lien, sums open balances, flags adverse');

// --- a clean record: owner + only a payoff mortgage → no adverse encumbrance ---
t = tl.normalizeTitleRecord({ owner: 'Jane Buyer', encumbrances: [{ type: 'first mortgage', amount: 200000 }] });
assert.strictEqual(t.hasAdverseEncumbrance, false, 'a plain first mortgage is benign at payoff');
assert.strictEqual(t.counts.mortgage, 1);
ok('a record with only a payoff mortgage has no adverse encumbrance');

// --- duplicate liens are de-duped ---
t = tl.normalizeTitleRecord({ owner: 'X', liens: [
  { type: 'judgment', amount: 5000, holder: 'ACME' },
  { type: 'Judgment', amount: 5000, holder: 'acme' }, // same lien, different case
] });
assert.strictEqual(t.liens.length, 1, 'the duplicate judgment collapses to one');
assert.strictEqual(t.liens[0].kind, 'judgment');
assert.strictEqual(t.hasAdverseEncumbrance, true);
ok('repeated liens (same kind/amount/holder) de-dupe to one');

// --- lien classification covers the material kinds ---
assert.strictEqual(tl.classifyLien('IRS tax lien'), 'tax');
assert.strictEqual(tl.classifyLien('Abstract of Judgment'), 'judgment');
assert.strictEqual(tl.classifyLien("mechanic's lien"), 'mechanic');
assert.strictEqual(tl.classifyLien('Lis Pendens - foreclosure'), 'lis_pendens');
assert.strictEqual(tl.classifyLien('HOA assessment'), 'hoa');
assert.strictEqual(tl.classifyLien('some weird encumbrance'), 'other');
ok('lien text classifies into tax / judgment / mechanic / lis_pendens / hoa / other');

// --- owner-of-record reconciles against the contract seller (name check) ---
let rc = tl.toOwnerClaim({ owner: 'Oak Street Holdings, LLC' }, { value: 'Oak Street Holdings LLC' });
assert.strictEqual(rc.claim.type, 'name');
assert.strictEqual(reconcile(rc.claim, rc.source).status, 'confirmed', 'recorded owner matches the seller (suffix tolerant)');
const bad = tl.toOwnerClaim({ owner: 'Someone Else LLC' }, { value: 'Oak Street Holdings LLC' });
const badR = reconcile(bad.claim, bad.source);
assert.strictEqual(badR.status, 'conflict', 'a different recorded owner is a conflict');
assert.strictEqual(badR.finding.severity, 'fatal', 'an owner-of-record mismatch is fatal (chain of title)');
assert.strictEqual(tl.toOwnerClaim({}, { value: 'X' }), null, 'no recorded owner → null (nothing to reconcile)');
ok('the recorded owner reconciles against the contract seller — a match confirms, a mismatch is a fatal conflict');

// --- string-only lien entries and snake/camel field variants ---
t = tl.normalizeTitleRecord({ ownerName: 'Y', open_liens: ['UCC financing statement', 'mechanic lien on unit 2'] });
assert.strictEqual(t.ownerOfRecord, 'Y');
assert.ok(t.liens.some((l) => l.kind === 'ucc') && t.liens.some((l) => l.kind === 'mechanic'));
ok('string-only lien entries and ownerName/open_liens aliases resolve');

// --- empty / junk / hostile input is safe ---
assert.doesNotThrow(() => tl.normalizeTitleRecord(null));
assert.strictEqual(tl.normalizeTitleRecord(null).available, false);
assert.doesNotThrow(() => tl.normalizeTitleRecord('junk'));
assert.doesNotThrow(() => tl.normalizeTitleRecord({ liens: 'notarray', owner: {} }));
assert.doesNotThrow(() => tl.normalizeTitleRecord({ liens: [null, 42, {}, 'x'] }));
assert.doesNotThrow(() => tl.normalizeTitleRecord({ get owner() { throw new Error('boom'); } }));
assert.strictEqual(tl.normalizeTitleRecord({ get liens() { throw new Error('boom'); } }).available, false);
assert.doesNotThrow(() => tl.toOwnerClaim(null, null));
assert.strictEqual(tl.toOwnerClaim(null, null), null);
ok('empty / null / junk / throwing-getter input is safe (never throws)');

console.log(`\nR5.53 title-lien-normalize pure — ${passed} checks passed`);
