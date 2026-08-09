'use strict';
/**
 * THE REQUEST CONTRACT — our requests look the way the vendor's schemas say.
 *
 * `src/lib/elementix/request-contracts.json` is the live MCP connector's own
 * tool schemas, transcribed (owner-directed 2026-08-09: "bring all the
 * information you know into our system so that our systems should know exactly
 * how to pull the requests"). Two halves proven here, offline:
 *
 *   1. EVERY REQUEST A WRAPPER SENDS CONFORMS. Each wrapper is run with good
 *      input against a stubbed client, and every recorded call is judged by
 *      `contractProblem` — the same check `call()` runs live. A wrapper that
 *      drifts from the vendor's schema fails HERE, not as a raw "-32602" on
 *      an officer's screen.
 *
 *   2. THE SHAPES THAT ALREADY BIT ARE REFUSED BEFORE THE WIRE, each with
 *      nothing sent: a matcher with no state (the owner's real search — five
 *      raw refusals on screen, each spending a slot of the shared hourly
 *      allowance), {documentId}, a `county` filter coverage does not have, a
 *      string where the vendor takes an array, and `limit` — which the vendor
 *      IGNORES silently while serving its default page of five.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

/* Stub the network BEFORE the module under test loads. */
const clientPath = require.resolve('../src/elementix/client.js');
const calls = [];
let reply = () => ({ ok: true, data: { results: [] } });
require.cache[clientPath] = {
  id: clientPath, filename: clientPath, loaded: true, exports: {
    callTool: async (name, args, opts) => { calls.push({ name, args, opts }); return reply(name, args); },
    listTools: async () => ({ ok: true, tools: [] }),
    PAID_TOOLS: new Set(['submit_contact_enrichment']),
  },
};

const L = require('../src/lib/elementix/lookups');
const CONTRACTS = require('../src/lib/elementix/request-contracts.json');
const I = L._internals;
const NO_DB = { db: { query: async () => ({ rows: [] }) } };
const UUID = '11111111-2222-3333-4444-555555555555';
const reset = () => { calls.length = 0; reply = () => ({ ok: true, data: { results: [] } }); };

(async () => {

console.log('\n1. The contract file covers every tool this module may call');
{
  for (const t of L.TOOLS) {
    ok(!!(CONTRACTS.tools && CONTRACTS.tools[t]),
      `${t} has a recorded contract — adding a tool means recording how its requests look, in the same commit`);
  }
  const me = CONTRACTS.tools.match_entity; const mp = CONTRACTS.tools.match_person;
  ok(me.required.includes('name') && me.required.includes('state'),
    'match_entity requires name AND state — entities are keyed (name, state)');
  ok(mp.required.includes('name') && mp.required.includes('state'),
    'match_person requires name AND state — persons are keyed the same way');
  const gd = CONTRACTS.tools.get_document;
  ok(gd.required.includes('type') && gd.required.includes('id') && !gd.params.documentId,
    'get_document requires {type, id} and has NO documentId parameter');
  const gc = CONTRACTS.tools.get_coverage;
  ok(!gc.params.county && gc.params.state && gc.params.state.type === 'string[]',
    'get_coverage has NO county parameter and takes state as an ARRAY');
}

console.log('\n2. Every request a wrapper sends conforms to the contract');
{
  reset();
  /* Drive every wrapper the way production drives it; the replies steer the
     research flows down their long paths (entity found → deeds; nothing found
     → address branch). */
  reply = (name) => {
    if (name === 'match_entity') return { ok: true, data: { status: 'exact', match: { id: UUID, originalName: 'MW TRADING LLC', state: 'NJ' } } };
    if (name === 'match_person') return { ok: true, data: { status: 'none', match: null } };
    if (name === 'match_address') return { ok: true, data: { status: 'exact', match: { id: UUID } } };
    if (name === 'get_contact_status') return { ok: true, data: { unlocked: true } };
    return { ok: true, data: { results: [] } };
  };

  await L.searchEntity('MW Trading LLC', 'NJ', NO_DB);
  await L.searchEntity('MW Trading LLC', '', NO_DB);
  await L.searchPerson('Patrick Kamara', 'NJ', NO_DB);
  await L.searchPerson('Patrick Kamara', '', NO_DB);
  await L.entityDeeds(UUID, { ...NO_DB, perPage: 100 });
  await L.entityMortgages(UUID, { ...NO_DB, countOnly: true });
  await L.entityPeople(UUID, NO_DB);
  await L.personDeeds(UUID, { ...NO_DB, perPage: 100 });
  await L.personMortgages(UUID, NO_DB);
  await L.coOccurringEntities(UUID, NO_DB);
  await L.matchAddress('1 A St, Lakewood, NJ 08701', NO_DB);
  await L.addressOwnership(UUID, NO_DB);
  await L.addressTransactions(UUID, { ...NO_DB, perPage: 100 });
  await L.document(UUID, { ...NO_DB, type: 'deed' });
  await L.coverage({ state: 'NJ', county: 'Ocean' }, NO_DB);
  await L.contactFor(UUID, NO_DB);
  await L.researchProperty({ entityName: 'MW Trading LLC', state: 'NJ', address: '1 A St, Lakewood, NJ 08701', borrowerNames: ['P K'], ...NO_DB });
  await L.researchPerson({ personName: 'Patrick Kamara', state: 'NJ', ...NO_DB });

  ok(calls.length > 0, `the wrappers made ${calls.length} calls to judge`);
  let badCount = 0;
  for (const c of calls) {
    const p = I.contractProblem(c.name, c.args);
    if (p) { badCount++; console.error(`  FAIL ${c.name} sent a non-conforming request: ${p} — ${JSON.stringify(c.args)}`); }
  }
  fail += badCount;
  ok(badCount === 0, 'every single request conforms — nothing a wrapper sends can draw a -32602');
}

console.log('\n3. The shapes that already bit are refused before the wire');
{
  const cases = [
    ['match_entity', { name: 'MW Trading LLC' }, 'a no-state entity match (the owner\'s real failure, five times in one search)'],
    ['match_person', { name: 'Yehuda Bochner' }, 'a no-state person match (was silently swallowed AND spent allowance)'],
    ['match_entity', { name: 'MW Trading LLC', state: 'New Jersey' }, 'a full state name where the vendor takes a 2-letter code'],
    ['get_document', { documentId: UUID, include: 'signers' }, 'the old {documentId} shape — wrong name, missing type'],
    ['get_coverage', { county: 'Ocean' }, 'a county filter coverage does not have'],
    ['get_coverage', { state: 'NJ' }, 'a string state where coverage takes an array'],
    ['get_entity_deeds', { id: UUID, limit: 2 }, '`limit` — the vendor ignores it silently and serves its default page of five'],
    ['search', { query: 'ab' }, 'a query under the vendor\'s 3-character floor'],
  ];
  for (const [tool, args, why] of cases) {
    reset();
    const r = await L.call(tool, args, NO_DB);
    ok(r.ok === false && r.reason === 'bad_args' && calls.length === 0,
      `refused with nothing sent: ${why}`);
    if (r.detail) ok(!/-32602|Invalid arguments/i.test(r.detail),
      '…and the refusal is a plain sentence, never the vendor\'s raw validation error');
  }
}

console.log('\n4. A conforming request still goes out untouched');
{
  reset();
  await L.call('match_entity', { name: 'MW Trading LLC', state: 'NJ' }, NO_DB);
  ok(calls.length === 1 && calls[0].args.name === 'MW Trading LLC' && calls[0].args.state === 'NJ',
    'the preflight is a gate, not a rewriter — a good request is sent byte-for-byte');
}

  console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  every request we send is one the vendor accepts, and every shape that ever bit is refused before the wire');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
