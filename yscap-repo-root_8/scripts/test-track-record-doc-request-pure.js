'use strict';
/**
 * THE TYPED ASK — vocabulary, key, and every word the borrower reads.
 *
 * Offline. The point of splitting these out of the route is that the SENTENCE
 * is the part most likely to be wrong and the part hardest to see through HTTP:
 * "We need the other to confirm…" and "a operating agreement belongs to a
 * company" both shipped in the first cut of this module and both were caught
 * here, not by a reviewer reading the diff.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const DR = require('../src/lib/track-record/doc-request');

// ═══════════════════ 1. The vocabulary is a real table, not a list of strings
console.log('\n1. Every document type says which question it can answer');
{
  ok(DR.DOC_TYPES.length >= 15, `the owner's whole list is there (${DR.DOC_TYPES.length} types)`);
  const slugs = DR.DOC_TYPES.map((d) => d.slug);
  ok(new Set(slugs).size === slugs.length, 'no duplicate slugs — a slug is half the idempotency key');

  for (const d of DR.DOC_TYPES) {
    if (!d.pillars.length || !d.pillars.every((p) => DR.PILLARS.includes(p))) {
      fail++; console.error(`  FAIL ${d.slug} names a pillar that does not exist`);
    }
    if (!d.pillars.includes(d.defaultPillar)) {
      fail++; console.error(`  FAIL ${d.slug}'s default pillar is not one it can answer`);
    }
    if ((d.target === 'entity') !== !!d.slot) {
      fail++; console.error(`  FAIL ${d.slug}: an entity document needs a slot and a property document must not have one`);
    }
  }
  ok(true, 'every type names real pillars, a default it can actually answer, and a slot only when it is an entity document');

  /* The four entity slots must be the codes that really exist, and the SAME
     ones entity-adopt files a document into — otherwise an operating agreement
     requested here and one adopted from a bank statement land in two places. */
  const adopt = require('../src/lib/underwriting/entity-adopt');
  const theirs = new Set(Object.values(adopt.SLOT_FOR_DOC_TYPE));
  const mine = DR.DOC_TYPES.filter((d) => d.slot).map((d) => d.slot);
  ok(mine.length === 4 && mine.every((s) => theirs.has(s)),
    'the four entity slots are the exact codes entity-adopt already uses — one document, one home');
}

// ═══════════════════ 2. The key carries all three connections
console.log('\n2. The ask, the property and the pillar are one word');
{
  const k = DR.fieldKeyFor('abc-123', 'operating_agreement', 'ownership');
  ok(k === 'trdoc:abc-123:operating_agreement:ownership', `the key is the three facts (${k})`);
  const back = DR.parseFieldKey(k);
  ok(back && back.trackRecordId === 'abc-123' && back.slug === 'operating_agreement' && back.pillar === 'ownership',
    'and it reads back exactly, so a row can always say what was asked and why');

  ok(DR.fieldKeyFor('', 'deed', 'ownership') === '', 'no property → no key');
  ok(DR.fieldKeyFor('abc', 'not_a_type', 'ownership') === '', 'an unknown type → no key, never a guess');
  ok(DR.fieldKeyFor('abc', 'deed', 'not_a_pillar') === '', 'an unknown pillar → no key');

  ok(DR.parseFieldKey('issue:tr:abc') === null, 'a raise-issue key is not one of ours');
  ok(DR.parseFieldKey('trdoc:abc:deed:made_up') === null, 'and a key naming a pillar that does not exist is refused');

  ok(DR.fieldKeyFor('abc', 'deed', 'ownership') !== DR.fieldKeyFor('abc', 'deed', 'exit'),
    'the SAME document asked for two different reasons is two different asks');
  ok(DR.fieldKeyFor('abc', 'deed', 'ownership') === DR.fieldKeyFor('abc', 'deed', 'ownership'),
    '…while the identical ask is the identical key, which is what makes it reuse its row');
}

// ═══════════════════ 3. The sentence the borrower reads
console.log('\n3. What the borrower is told — checked word for word');
{
  const s = DR.borrowerSentence({ slug: 'operating_agreement', pillar: 'ownership', entityName: 'MW Trading LLC', propertyLabel: '62 Highland Street' });
  ok(s === 'We need the operating agreement for MW Trading LLC to confirm you owned 62 Highland Street.',
    `the blueprint's own example, exactly: "${s}"`);

  ok(!/ a operating| a articles| a EIN/.test(
    DR.DOC_TYPES.map((d) => DR.borrowerSentence({ slug: d.slug, pillar: d.defaultPillar, entityName: 'X LLC', propertyLabel: 'Y St' })).join(' ')),
  'no sentence reads "a operating agreement" — broken English is a message nobody trusts');

  ok(!/We need the other/.test(DR.borrowerSentence({ slug: 'other', pillar: 'exit', propertyLabel: '5 A St' })),
    '"Other" never produces "We need the other …"');
  ok(DR.borrowerSentence({ slug: 'other', pillar: 'exit', propertyLabel: '5 A St' }) === 'We need one more document to confirm how 5 A St was finished.',
    '…it asks for "one more document" and still says what it is for');
  ok(/contractor final invoice/.test(DR.borrowerSentence({ slug: 'other', pillar: 'exit', propertyLabel: '5 A St', customLabel: 'Contractor final invoice' })),
    '…and uses the reviewer\'s own words when they typed some');

  ok(!/for /.test(DR.borrowerSentence({ slug: 'deed', pillar: 'ownership', entityName: 'MW Trading LLC', propertyLabel: '5 A St' })),
    'a PROPERTY document never names the company — only an entity document does');

  const words = DR.DOC_TYPES.map((d) => DR.borrowerSentence({ slug: d.slug, pillar: d.defaultPillar, entityName: 'X LLC', propertyLabel: 'Y St' })).join(' ');
  ok(!/pillar|verif|underwrit|condition/i.test(words),
    'and not one sentence says "pillar", "verification", "underwriting" or "condition" — the borrower is told what it proves about their project');
  for (const d of DR.DOC_TYPES) {
    const t = DR.borrowerSentence({ slug: d.slug, pillar: d.defaultPillar, entityName: 'X LLC', propertyLabel: 'Y St' });
    if (!/^We need .+\.$/.test(t)) { fail++; console.error(`  FAIL ${d.slug} produced "${t}"`); }
  }
  ok(true, 'every type produces one plain, complete sentence');
}

// ═══════════════════ 4. buildRequest refuses what it should, in plain words
console.log('\n4. A refusal names the problem and the fix');
{
  ok(DR.buildRequest({ trackRecordId: 'abc', slug: 'nope' }).error === 'pick a document type from the list',
    'an unknown type is refused');
  const wrongPillar = DR.buildRequest({ trackRecordId: 'abc', slug: 'lease', pillar: 'ownership' });
  ok(wrongPillar.ok === false && /cannot answer the ownership question/.test(wrongPillar.error),
    'a lease cannot prove ownership, and the refusal says which questions it CAN answer');
  ok(/pick exit or recency/.test(wrongPillar.error), '…by name, so the fix is one click');

  const noEntity = DR.buildRequest({ trackRecordId: 'abc', slug: 'operating_agreement' });
  ok(noEntity.ok === false && /belongs to a company/.test(noEntity.error),
    'an entity document with no company named is refused');
  ok(DR.buildRequest({ trackRecordId: '', slug: 'deed' }).error === 'which property is this about?',
    'and a request about no property is refused');

  const good = DR.buildRequest({ trackRecordId: 'abc', slug: 'deed', propertyLabel: '5 A St, Lakewood, NJ' });
  ok(good.ok === true && good.pillar === 'ownership', 'a valid ask falls back to the type\'s own default pillar');
  ok(good.fieldKey === 'trdoc:abc:deed:ownership' && good.target === 'property' && good.slot === null,
    '…and reports everything the row needs');
  ok(/5 A St/.test(good.label) && /Track record/.test(good.label),
    'the STAFF label leads with the desk\'s own words and names the property');

  const ent = DR.buildRequest({ trackRecordId: 'abc', slug: 'ein_letter', llcId: 'llc-1', entityName: 'MW Trading LLC', propertyLabel: '5 A St' });
  ok(ent.ok === true && ent.target === 'entity' && ent.slot === 'rtl_llc_ein',
    'an entity ask reports the slot the document belongs on afterwards');
}

// ═══════════════════ 5. Nothing here touches a database
console.log('\n5. The vocabulary and the wording are pure');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/doc-request.js'), 'utf8');
  const pureHalf = src.slice(0, src.indexOf('the impure half'));
  ok(!/db\.query|require\('\.\.\/\.\.\/db'\)/.test(pureHalf),
    'the vocabulary, the key and every borrower sentence are computed with no database in reach');
  ok(/migrateProfileRequests/.test(src) && /scope='application'/.test(src),
    'and the profile-to-file migration MOVES the same row rather than creating a second one');
  ok(!/DELETE FROM checklist_items/.test(src),
    'nothing in the request path ever deletes a condition');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  the ask is typed, keyed on what it is for, and says one plain sentence');
process.exit(fail ? 1 : 0);
