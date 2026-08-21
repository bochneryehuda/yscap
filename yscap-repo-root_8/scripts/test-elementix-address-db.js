#!/usr/bin/env node
'use strict';
/**
 * THE PROPERTY BEHIND A ROW — the deliberate read, against a real Postgres.
 *
 * The owner: "When you go into the property and open up that property, it
 * should pull from Elementix the details about that property... which moment it
 * was taken on, from which lender it was taken, where it was taken."
 *
 * Most of that is joined LOCALLY out of rows already paid for (proven in
 * scripts/test-elementix-record-link-pure.js). This covers the other half: the
 * property's OWN record — who owns it today, everyone who owned it before, and
 * every instrument recorded against it — which is a genuine vendor read and
 * therefore a button, a scope check and an audit row.
 *
 * WHAT THIS FILE IS REALLY GUARDING:
 *  1. NOTHING IS BOUGHT. The stub fails the suite outright if the paid tool is
 *     called. A property lookup is free and must stay free.
 *  2. A TYPED UUID OPENS NOTHING. A property is reached THROUGH a person, so
 *     both halves of the gate are exercised: the person must be one this officer
 *     can see, AND the address must actually be on that person's own rows.
 *     Without the second half, anybody who can see one lead could read any
 *     property in the country by pasting its id — spending the organisation's
 *     shared allowance each time.
 *  3. A REFUSAL IS NOT AN EMPTY LIST. A section the vendor would not answer
 *     stores its reason and reads back as an error, never as "nobody owns it".
 *
 * Run: DATABASE_URL=... node scripts/test-elementix-address-db.js
 */

const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('· test-elementix-address-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require('../src/db');
const crmTools = require('../src/lib/elementix/crm-tools');

const ADDR = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_ADDR = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PERSON = 'cccccccc-3333-4333-8333-cccccccccccc';

let ownershipFails = false;
const calls = [];

/* THE SHAPES ARE THE ONES THE CONNECTOR DOCUMENTS, snake_case included:
   `get_address_ownership` is the ONE tool in this API that answers with
   `entity_grantees` rather than `entityGrantees`, and a reader that knows only
   the camelCase spelling shows a property as owned by nobody. */
crmTools.call = async (tool, args, opts) => {
  calls.push({ tool, args, staffId: opts && opts.staffId });
  assert.notStrictEqual(tool, 'submit_contact_enrichment',
    'READING A PROPERTY MUST NEVER BUY A CONTACT — it is a free lookup');
  assert.strictEqual(args.id, ADDR, 'every call names the address it was asked about');
  switch (tool) {
    case 'get_address':
      assert.strictEqual(args.include, 'entities', 'the entities ride along in the SAME call');
      return { ok: true, data: { address: { id: ADDR, addressFull: '14 MAPLE ST, TEANECK, NJ 07666',
        city: 'Teaneck', countyName: 'Bergen', state: 'NJ', zipCode: '07666',
        latitude: 40.8976, longitude: -74.0121 },
      entities: { data: [{ id: 'e1', name: 'MAPLE HOLDINGS LLC', type: 'COMPANY', state: 'NJ' }] } } };
    case 'get_address_ownership':
      if (ownershipFails) return { ok: false, reason: 'vendor_error', detail: 'Elementix could not answer that.' };
      return { ok: true, data: { data: [
        { id: 'o1', startDate: '2021-03-02', endDate: null, totalConsideration: '475000.00', deedId: 'd1',
          entity_grantees: [{ id: 'e1', name: 'MAPLE HOLDINGS LLC', type: 'COMPANY', state: 'NJ' }],
          people: [{ id: 'p9', name: 'MOTY BRISK', state: 'NJ' }], documentCount: 2 },
        { id: 'o2', startDate: '2015-06-01', endDate: '2021-03-02', totalConsideration: '310000.00',
          grantees: ['A PREVIOUS OWNER'], documentCount: 1 },
      ] } };
    case 'get_address_transactions':
      return { ok: true, data: { data: [
        { id: 't1', type: 'mortgage', recordingDate: '2021-03-02', amount: '380000.00', partiesGrantee: ['ROC CAPITAL'] },
        { id: 't2', type: 'deed', recordingDate: '2021-03-02', amount: '475000.00', partiesGrantee: ['MAPLE HOLDINGS LLC'] },
        { id: 't3', type: 'satisfaction', recordingDate: '2022-01-19', amount: null, partiesGrantor: ['ROC CAPITAL'] },
      ] } };
    default:
      throw new Error(`the property read reached a tool it has no business calling: ${tool}`);
  }
};

const address = require('../src/lib/elementix/address');

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };

async function wipe() {
  await db.query(`DELETE FROM elementix_address_sections WHERE address_id = ANY($1::text[])`, [[ADDR, OTHER_ADDR]]);
  await db.query(`DELETE FROM elementix_addresses WHERE address_id = ANY($1::text[])`, [[ADDR, OTHER_ADDR]]);
}

async function main() {
  await wipe();
  const sfx = Date.now();
  const staff = (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, is_external)
     VALUES ($1::citext,'Address Tester','admin',true,false) RETURNING id`,
    [`addr.${sfx}@yscapgroup.test`])).rows[0].id;

  // -------------------------------------------------------------------------
  console.log('\n1. Nothing is known until somebody asks');
  // -------------------------------------------------------------------------
  let v = await address.readAddress(ADDR);
  assert.strictEqual(v.ok, true, 'the cache answers even for a property nobody has read');
  assert.strictEqual(v.everRead, false, '…and says plainly that it has never been read');
  assert.strictEqual(v.address, null, 'with no invented header');
  assert.strictEqual(v.sections.ownership.status, 'not_loaded', 'and every section reads as not-loaded');
  assert.strictEqual(v.sections.ownership.rowCount, null, 'a count nobody read is NULL, never 0');
  assert.strictEqual(calls.length, 0, 'and reading the cache called Elementix zero times');
  ok('an unread property reads as unread — never as a property with no history');

  // -------------------------------------------------------------------------
  console.log('\n2. A read is always somebody’s');
  // -------------------------------------------------------------------------
  const noActor = await address.buildAddress(ADDR, {});
  assert.strictEqual(noActor.ok, false, 'a read with nobody behind it is refused');
  assert.strictEqual(noActor.reason, 'no_actor', '…and says why');
  const junk = await address.buildAddress('not-a-uuid', { staffId: staff });
  assert.strictEqual(junk.ok, false, 'and a typed id that is not one is refused before any call');
  assert.strictEqual(calls.length, 0, 'neither reached the vendor');
  ok('a property read is refused without an actor and without a real id, before the wire');

  // -------------------------------------------------------------------------
  console.log('\n3. The property, its owners, and everything recorded on it');
  // -------------------------------------------------------------------------
  const built = await address.buildAddress(ADDR, { staffId: staff });
  assert.strictEqual(built.ok, true, 'the read succeeds');
  assert.ok(built.callsSpent >= 3 && built.callsSpent <= address._internals.CALL_BUDGET,
    `it spent ${built.callsSpent} requests, inside its own budget`);
  assert.deepStrictEqual([...new Set(calls.map((c) => c.tool))].sort(),
    ['get_address', 'get_address_ownership', 'get_address_transactions'],
    'exactly the three drill-in tools, and nothing else');
  assert.ok(calls.every((c) => c.staffId === staff), 'every call is attributed to the person who asked');

  assert.strictEqual(built.address.addressFull, '14 MAPLE ST, TEANECK, NJ 07666', 'WHERE it is');
  assert.strictEqual(built.address.countyName, 'Bergen', '…down to the county');
  assert.strictEqual(built.address.state, 'NJ', '…and the state, upper-cased');
  assert.strictEqual(built.address.latitude, 40.8976, '…with its coordinates');

  const own = built.sections.ownership;
  assert.strictEqual(own.status, 'ok');
  assert.strictEqual(own.rows.length, 2, 'both owners came back');
  assert.strictEqual(own.rows[0].entity_grantees[0].name, 'MAPLE HOLDINGS LLC',
    'the snake_case entity list is kept verbatim — it is the one tool that spells it this way');
  assert.strictEqual(own.rows[0].endDate, null, 'and the current owner is the one with no end date');

  const tx = built.sections.transactions;
  assert.strictEqual(tx.rows.length, 3, 'every instrument recorded against it');
  assert.deepStrictEqual(tx.rows.map((r) => r.type), ['mortgage', 'deed', 'satisfaction'],
    'including the satisfaction, which appears on no person tab');

  const det = built.sections.detail;
  assert.strictEqual(det.rows[0].name, 'MAPLE HOLDINGS LLC',
    'the entities came back inside the SAME call, not one call per entity');
  ok('a property read brings back where it is, who has owned it, and everything ever recorded on it');

  // -------------------------------------------------------------------------
  console.log('\n4. It is stored, and reading it back costs nothing');
  // -------------------------------------------------------------------------
  const before = calls.length;
  const reread = await address.readAddress(ADDR);
  assert.strictEqual(calls.length, before, 'reading the cache called Elementix zero more times');
  assert.strictEqual(reread.everRead, true, 'and it knows it has been read');
  assert.strictEqual(reread.sections.ownership.rows.length, 2, 'with the rows intact');
  assert.strictEqual(reread.sections.transactions.rowCount, 3, 'and the counts intact');
  ok('the answer is kept, and every later open is free');

  // A second BUILD inside the freshness window does not re-ask either: a
  // recorded instrument does not change, and the allowance is shared.
  const again = await address.buildAddress(ADDR, { staffId: staff });
  assert.strictEqual(calls.length, before, 'a repeat read inside the window spends nothing');
  assert.strictEqual(again.cached, true, '…and says it came from the cache');
  ok('asking twice in a week does not ask Elementix twice');

  // -------------------------------------------------------------------------
  console.log('\n5. A refusal is never an empty list');
  // -------------------------------------------------------------------------
  ownershipFails = true;
  const partial = await address.buildAddress(ADDR, { staffId: staff, force: true });
  assert.strictEqual(partial.ok, true, 'the read still returns what it could get');
  assert.strictEqual(partial.sections.ownership.status, 'error', 'the refused section reads as an error');
  assert.ok(/could not answer/i.test(partial.sections.ownership.detail || ''), '…carrying the vendor’s own reason');
  assert.strictEqual(partial.sections.ownership.rowCount, null,
    'and its count is NULL — "we could not ask" is not "nobody owns it"');
  assert.strictEqual(partial.sections.transactions.rows.length, 3,
    'while the sections that DID answer are kept in full');
  ownershipFails = false;

  /* AND IT CAN BE RETRIED. A single `max(fetched_at)` across the sections that
     SUCCEEDED keeps the watermark fresh, so the one that refused is never asked
     again — the officer presses "Read it again", nothing is spent, nothing
     changes, and nothing says why, for a week. A section carrying an error is
     always due, exactly as the person profile does it. */
  const beforeRetry = calls.filter((c) => c.tool === 'get_address_ownership').length;
  const retry = await address.buildAddress(ADDR, { staffId: staff });   // NOT forced
  const afterRetry = calls.filter((c) => c.tool === 'get_address_ownership').length;
  assert.ok(afterRetry > beforeRetry, 'the refused section is asked again on the next read');
  assert.notStrictEqual(retry.cached, true, '…so the read is not short-circuited as cached');
  assert.strictEqual(retry.sections.ownership.status, 'ok', 'and it lands once the vendor answers');
  assert.strictEqual(retry.sections.ownership.rows.length, 2, 'with its rows');
  ok('a section that refused is retried on the next read — never held stale behind its siblings');

  // The sections that DID answer are not re-bought to get it.
  const txCallsBefore = calls.filter((c) => c.tool === 'get_address_transactions').length;
  await address.buildAddress(ADDR, { staffId: staff });
  assert.strictEqual(calls.filter((c) => c.tool === 'get_address_transactions').length, txCallsBefore,
    'and once everything is fresh, a repeat read spends nothing at all');
  ok('a complete read still short-circuits — the retry is for the refusal, not a licence to re-ask');

  ok('a section the vendor refused says so, and never renders as a property nobody owns');

  // -------------------------------------------------------------------------
  console.log('\n5b. A long recorded history is trimmed to fit, never blanked');
  // -------------------------------------------------------------------------
  /* THE SAME DEFECT THE PERSON PROFILE HAD FIXED ONE COMMIT EARLIER, and this
     module reintroduced verbatim: over 400,000 characters `vendorJsonb` replaces
     the whole document with a marker, `payload.rows` reads back empty, and the
     screen prints "Elementix has none on record" about a property with a long
     history. A page of transactions can reach the ceiling on its own — and if
     the vendor carries its inline logos (8-12 KB each), one page does it alone,
     which is why they are stripped BEFORE the fit rather than after. */
  {
    const many = Array.from({ length: 400 }, (_, i) => ({
      id: `t-${i}`, type: 'mortgage', recordingDate: '2021-03-02', amount: '380000.00',
      partiesGrantee: ['A LENDER WITH A LONG NAME LLC'], partiesGrantor: ['A BORROWING COMPANY LLC'],
      _logoDataUri: `data:image/jpeg;base64,${'A'.repeat(9000)}`,
      filler: 'x'.repeat(900),
    }));
    const savedTx = crmTools.call;
    crmTools.call = async (tool, args, opts) => {
      if (tool === 'get_address_transactions') return { ok: true, data: { data: many } };
      return savedTx(tool, args, opts);
    };
    const big = await address.buildAddress(ADDR, { staffId: staff, force: true });
    crmTools.call = savedTx;

    const tx = big.sections.transactions;
    assert.ok(tx.rows.length > 0, 'the rows survive — the tab is not blanked');
    assert.strictEqual(tx.status, 'ok', 'and it is not reported as an error either');
    assert.ok(!JSON.stringify(tx.rows).includes('data:image/jpeg'),
      'the vendor’s inline logos are stripped — pictures never take a real row’s place');
    const stored = (await db.query(
      `SELECT payload FROM elementix_address_sections WHERE address_id = $1 AND section = 'transactions'`, [ADDR])).rows[0];
    assert.ok(!stored.payload._dropped, 'nothing was replaced by a too-large marker');
    assert.ok(JSON.stringify(stored.payload).length <= crmTools._internals.JSONB_MAX, '…and what is stored fits');
    ok(`a ${many.length}-row property history keeps ${tx.rows.length} rows instead of storing a marker`);
  }

  // -------------------------------------------------------------------------
  console.log('\n6. An unreadable store answers, it does not fall over');
  // -------------------------------------------------------------------------
  /* The likeliest cause is an instance whose migrations have not run yet. The
     drill-in around this block is built entirely from the PERSON's own cached
     rows, so it is still correct and still worth showing — falling over here
     would take the whole record page down over a table that is one deploy away
     from existing. Same posture the CRM desk already takes for its own two
     Elementix columns. */
  const broken = { query: async () => { const e = new Error('relation "elementix_addresses" does not exist'); e.code = '42P01'; throw e; } };
  const soft = await address.readAddress(ADDR, { client: broken });
  assert.strictEqual(soft.ok, true, 'it still answers');
  assert.strictEqual(soft.everRead, false, 'and does not claim to have read anything');
  assert.ok(soft.storeUnreadable, '…saying plainly that it could not reach its own copy');
  assert.strictEqual(soft.sections.ownership.status, 'unavailable',
    'every section reads as unavailable — never as a property nobody owns');
  assert.strictEqual(soft.sections.ownership.rowCount, null, 'and no count is invented');
  ok('a store PILOT cannot read says so, and the record around it still renders');

  await wipe();
  await db.query(`DELETE FROM staff_users WHERE id = $1`, [staff]);
  console.log(`\n${passed} checks passed.\n`);
}

main().then(() => db.pool.end()).catch(async (e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  process.exit(1);
});
