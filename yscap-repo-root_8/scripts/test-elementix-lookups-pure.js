'use strict';
/**
 * READING THE PUBLIC RECORDS — the guards, offline.
 *
 * §1 IS THE OWNER'S OWN CONSTRAINT AND IT IS THE REASON THIS FILE EXISTS:
 *   "you should never skip trace contacts, which means you should never display
 *    contact phone numbers because you never retrieve contact phone numbers that
 *    were not yet skip traced. If it's already skip traced, then you can look at
 *    it if you want to, but if you didn't, I don't want to do this to cost me
 *    money because I have only 1,000 per month."
 *
 * Three independent things have to hold, and each is asserted separately,
 * because relying on any ONE of them is how a credit gets spent by accident:
 * the paid tool is not reachable from the research module at all; a contact is
 * read only after the vendor says the person is ALREADY unlocked; and the
 * client refuses a paid call that cannot say who asked, about whom, and why.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const path = require('path');
const fs = require('fs');

/* Stub the network BEFORE the module under test loads, so nothing here can
   reach a real endpoint even if a switch were on. */
const clientPath = require.resolve('../src/elementix/client.js');
const calls = [];
let reply = () => ({ ok: true, data: {} });
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true, exports: {
    callTool: async (name, args, opts) => { calls.push({ name, args, opts }); return reply(name, args); },
    listTools: async () => ({ ok: true, tools: [] }),
    PAID_TOOLS: new Set(['submit_contact_enrichment']),
  },
};

const L = require('../src/lib/elementix/lookups');
const NO_DB = { db: { query: async () => ({ rows: [] }) } };   // the ledger, stubbed
const reset = () => { calls.length = 0; reply = () => ({ ok: true, data: {} }); };

(async () => {

// ═══════ 1. THE OWNER'S CONSTRAINT — three separate guards
console.log('\n1. A skip trace can never happen by accident');
{
  const src = fs.readFileSync(path.join(__dirname, '../src/lib/elementix/lookups.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok(!L.TOOLS.has('submit_contact_enrichment'),
    'the paid enrichment tool is NOT in the closed set this module may call');
  ok(L.FORBIDDEN.includes('submit_contact_enrichment'), '…it is named as forbidden');
  /* Comments stripped first — the module's header QUOTES the owner and names the
     tool, so a naive grep matches the explanation. Same trap this rebuild has
     now hit four times. */
  const mentions = (code.match(/submit_contact_enrichment/g) || []).length;
  ok(mentions === 1, `…and the only place the name appears in the CODE is that refusal list (${mentions})`);
  ok(!/allowPaid|paidActor/.test(code),
    'nothing here can even ASK to spend money — there is no argument for it');

  reset();
  const r = await (L.call('submit_contact_enrichment', {}, NO_DB));
  ok(r.reason === 'paid_tool_refused', 'and calling it by name is refused before any network call');
  ok(calls.length === 0, '…with nothing sent');

  reset();
  /* PARENTHESES MATTER: `await (p).reason` reads `.reason` off the PROMISE and
     then awaits undefined, so the assertion silently compares undefined. Bind
     the awaited value first. */
  const heavy = await L.call('list_people', {}, NO_DB);
  ok(heavy.reason === 'unknown_tool',
    'list_people is refused too — 145,873 characters for 5 rows, and no argument makes it affordable');
  ok(calls.length === 0, '…also without sending anything');
}

// ═══════ 2. A phone number is shown only when it was ALREADY paid for
console.log('\n2. A contact is read only when the person is already unlocked');
{
  const PERSON = '11111111-2222-3333-4444-555555555555';

  reset();
  reply = (name) => (name === 'get_contact_status' ? { ok: true, data: { unlocked: false } } : { ok: true, data: { phone: '555-0100' } });
  const locked = await (L.contactFor(PERSON, NO_DB));
  ok(locked.ok === true && locked.unlocked === false && locked.contact === null,
    'a person who has NOT been skip traced returns no contact at all');
  ok(calls.length === 1 && calls[0].name === 'get_contact_status',
    '…and get_contact_info was NEVER called — the status is asked FIRST, in code');
  ok(/never spends one on its own/.test(locked.why),
    '…with a plain sentence saying why, not an error somebody would try to fix');

  reset();
  reply = (name) => (name === 'get_contact_status' ? { ok: true, data: { unlocked: true } } : { ok: true, data: { phone: '555-0100' } });
  const unlocked = await (L.contactFor(PERSON, NO_DB));
  ok(unlocked.unlocked === true && unlocked.contact && unlocked.contact.phone === '555-0100',
    'a person ALREADY skip traced returns what we already paid for — the owner\'s "you can look at it if you want to"');

  /* FAILS CLOSED. Every shape it cannot read confidently is "not unlocked",
     which costs a phone number nobody sees and never costs a credit. */
  for (const shape of [null, undefined, {}, { status: 'locked' }, { status: 'pending' }, 'nonsense', 42, { unlocked: 'yes' }]) {
    if (L.isUnlocked(shape)) { fail++; console.error(`  FAIL isUnlocked(${JSON.stringify(shape)}) read as unlocked`); }
  }
  ok(true, 'and every unreadable status reads as NOT unlocked — the cheap direction');
  ok(L.isUnlocked({ status: 'unlocked' }) && L.isUnlocked([{ enriched: true }]) && L.isUnlocked({ data: { unlocked: true } }),
    'while the real shapes are recognised');

  reset();
  const bad = await (L.contactFor('not-a-uuid', NO_DB));
  ok(bad.ok === false && bad.reason === 'bad_args' && calls.length === 0,
    'a junk person id is refused before anything is sent');
}

// ═══════ 3. The two vendor shapes that are easy to get wrong
console.log('\n3. entity vs company, and a money string that is not a number');
{
  reset();
  await (L.searchEntity('MW Trading LLC', 'nj', NO_DB));
  /* `entityFilter` BELONGS TO `search`, NOT TO `match_entity`. The old assertion
     pinned a parameter the tool does not have — a guess about the vendor,
     written down as a requirement, and then guarded by a test, which is how a
     wrong belief survives review. Confirmed against the live schema. The
     entity-vs-company distinction is real and still matters on `search`; here
     the tool only ever matches entities. */
  ok(calls[0].args.entityFilter === undefined,
    'match_entity is NOT sent entityFilter — that parameter belongs to `search`, and this tool only matches entities');
  ok(calls[0].args.state === 'NJ', '…and the state is upper-cased for the filter');

  reset();
  await (L.searchEntity('MW Trading LLC', 'New Jersey', NO_DB));
  ok(calls[0].args.state === undefined,
    'a full state NAME is dropped rather than guessed — a wrong filter value returns nothing, silently');

  ok(L.money('$1,240,000') === 1240000, 'currentExposure parses out of a display string');
  ok(L.money('1.2M') === 1200000 && L.money('750k') === 750000, '…including the short forms');
  ok(L.money('—') === null && L.money('') === null && L.money(undefined) === null,
    'and an unreadable one is NULL, never NaN — NaN > threshold is false, so a NaN makes an exposed borrower read as unexposed');
  ok(L.money(0) === 0, 'a real zero survives');
}

// ═══════ 4. A common name cannot identify a person
console.log('\n4. The common-name gate is read at the source');
{
  ok(L.NAME_COMMONNESS_REFUSE_AT === 85, 'the gate is the same number the scoring ladder refuses at');
  const S = require('../src/lib/track-record/scoring');
  ok(L.NAME_COMMONNESS_REFUSE_AT === S.COMMON_NAME_REFUSE_AT,
    '…literally the same, asserted, so the lookup and the ladder can never drift');
  ok(L.nameTooCommon({ nameCommonnessScore: 92 }) === true, 'a very common name is flagged');
  ok(L.nameTooCommon({ nameCommonnessScore: 10 }) === false, 'an unusual one is not');
  ok(L.nameTooCommon({}) === false && L.nameCommonness({}) === null,
    'and an ABSENT score is not a flag — absent is never a negative finding');
}

// ═══════ 5. Ids are checked before anything is sent
console.log('\n5. Every id is validated before a call goes out');
{
  const UUID = '11111111-2222-3333-4444-555555555555';
  for (const [fn, label] of [[L.entityDeeds, 'entityDeeds'], [L.entityMortgages, 'entityMortgages'],
    [L.entityPeople, 'entityPeople'], [L.addressTransactions, 'addressTransactions'], [L.document, 'document']]) {
    reset();
    const r = await (fn('12345', NO_DB));
    if (r.ok !== false || calls.length !== 0) { fail++; console.error(`  FAIL ${label} sent a call for a junk id`); }
  }
  ok(true, 'a junk id is refused with nothing sent, on every wrapper');

  reset();
  await (L.document(UUID, NO_DB));
  ok(calls[0].args.include === 'signers',
    'a document is fetched with include:signers — a tenth the size, and the signers are what the identity gate reads');

  reset();
  await (L.entityDeeds(UUID, { ...NO_DB, countOnly: true }));
  ok(calls[0].args.scope === 'count', 'and a result can be SIZED before it is paged');
}

// ═══════ 6. The whole sequence, and what it does when it cannot read
console.log('\n6. The entity-first sequence degrades instead of lying');
{
  reset();
  reply = () => ({ ok: false, reason: 'disabled', detail: 'switched off' });
  const off = await (L.researchProperty({ entityName: 'MW Trading LLC', state: 'NJ', address: '1 A St, Lakewood, NJ 08701', ...NO_DB }));
  ok(off.searched === false, 'with the service off, NOTHING is reported as searched');
  ok(off.errors.length > 0, '…and what could not be reached is named');
  ok(off.deeds.length === 0 && off.currentOwner === null, '…and no evidence is invented');

  reset();
  let step = 0;
  reply = (name) => {
    step += 1;
    if (name === 'match_entity') return { ok: true, data: { results: [{ id: '11111111-2222-3333-4444-555555555555', name: 'MW TRADING LLC' }] } };
    if (name === 'get_entity_deeds') return { ok: true, data: { results: [{ address: '1 A St, Lakewood, NJ 08701', grantees: ['MW TRADING LLC'] }] } };
    return { ok: true, data: { results: [] } };
  };
  const found = await (L.researchProperty({ entityName: 'MW Trading LLC', state: 'NJ', address: '1 A St, Lakewood, NJ 08701', ...NO_DB }));
  ok(found.searched === true && found.deeds.length === 1, 'a real answer comes back shaped for the checks engine');
  ok(!calls.some((c) => c.name === 'match_address'),
    '…and the address round trip is SKIPPED when the entity route already found the property — that is the saving');
  ok(step > 0, 'and it made calls to get there');

  reset();
  reply = (name) => (name === 'match_entity'
    ? { ok: true, data: { results: [{ id: 'a', name: 'MW TRADING LLC' }, { id: 'b', name: 'MW TRADING LLC' }] } }
    : { ok: true, data: { results: [] } });
  const amb = await (L.researchProperty({ entityName: 'MW Trading LLC', state: 'NJ', ...NO_DB }));
  ok(amb.ambiguousEntity === true && amb.entity === null,
    'TWO equally good companies is a human question — neither is picked, which is how somebody else\'s deeds stay off this record');

// ═══════ DRY-RUN IS A REFUSAL, NEVER AN EMPTY COUNTY (owner-reported 2026-08-09)
console.log('\n5. A dry run never reads as "the county has nothing"');
  reset();
  reply = () => ({ ok: true, dryRun: true, data: null });
  const dr = await L.researchProperty({ entityName: 'MW Trading LLC', state: 'NJ', ...NO_DB });
  ok(dr.searched === false, 'a dry run never counts as having searched');
  ok((dr.errors || []).some((e) => e.reason === 'dry_run'),
    'the dry run is RECORDED as the reason — with the switch on, the screen said "the county does not publish online" about a search that never left the building');
  ok((dr.errors || []).every((e) => /dry-run/i.test(e.detail || '')),
    '…and the message tells the person which switch to flip');

// ═══════ THE PERSON ROUTE — exact name or nothing
console.log('\n6. A person is matched by their EXACT name, never a near one');
  reset();
  reply = (name) => {
    if (name === 'match_person') return { ok: true, data: { status: 'none', match: null } };
    if (name === 'search') return { ok: true, data: { results: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'FRANKY PEREIRA', entityType: 'person' },
    ] } };
    return { ok: true, data: { data: [] } };
  };
  const near = await L.researchPerson({ personName: 'Frank Pereira', state: 'NJ', ...NO_DB });
  ok(near.person === null && near.searched === false,
    'FRANKY is not FRANK — a near-name is refused, verified against the live vendor returning exactly this shape');

  reset();
  reply = (name) => {
    if (name === 'match_person') return { ok: true, data: { status: 'none', match: null } };
    if (name === 'search') return { ok: true, data: { results: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'KAMARA PATRICK', entityType: 'person' },
    ] } };
    if (name === 'get_person_deeds') return { ok: true, data: { data: [
      { id: 'd1', recordingDate: '2025-01-10', totalConsideration: 300000, isGrantee: true,
        grantees: ['PATRICK KAMARA'], grantors: ['A SELLER'],
        addresses: [{ id: 'x', addressFull: '1 PERSONAL WAY, LAKEWOOD, NJ 08701' }] },
    ], nextPage: 2 } };
    if (name === 'get_person_mortgages') return { ok: true, data: { data: [
      { id: 'm1', recordingDate: '2025-06-02', mortgageAmount: '210000.00', isRefinance: true,
        borrowerNames: ['PATRICK KAMARA'],
        propertyAddresses: [{ id: 'x', addressFull: '1 PERSONAL WAY, LAKEWOOD, NJ 08701' }] },
    ] } };
    return { ok: true, data: { data: [] } };
  };
  const person = await L.researchPerson({ personName: 'Patrick Kamara', state: 'NJ', ...NO_DB });
  ok(!!person.person, 'the county\'s reversed spelling ("KAMARA PATRICK") still matches — word-for-word, order-blind');
  ok(person.deeds.length === 1 && person.deeds[0].date === '2025-01-10',
    'their personal-name deed comes back normalised');
  ok(person.mortgages.length === 1 && person.mortgages[0].isRefinance === true
      && person.mortgages[0].addresses[0] === '1 PERSONAL WAY, LAKEWOOD, NJ 08701',
    'a person-route mortgage reads its propertyAddresses spelling — the live person tools\' field name');
  ok(person.truncated.some((t) => t.list === 'deeds'),
    'a vendor "nextPage" is REPORTED — a short answer must never pass as a complete one');
}

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  no skip trace is reachable, a phone number is shown only when already paid for, and nothing is guessed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
