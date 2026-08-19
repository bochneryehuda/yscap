'use strict';
/**
 * scripts/test-elementix-crm-db.js — a skip trace becomes a lead, for real.
 *
 * REAL POSTGRES, STUBBED VENDOR. The database work is the half that can be
 * wrong in ways a pure test cannot see (a phantom column, an ON CONFLICT that
 * cannot infer a partial index, a COALESCE that silently keeps the wrong side),
 * so it runs against a real schema. The VENDOR is stubbed because a unit test
 * must never call Elementix — and because `submit_contact_enrichment` SPENDS
 * REAL MONEY. A test that reached it would bill the owner on every push.
 *
 * DB-gated like the rest of the suite: no DATABASE_URL, no run.
 */

const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('· test-elementix-crm-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require('../src/db');
const crmTools = require('../src/lib/elementix/crm-tools');

// ---------------------------------------------------------------------------
// The stub. Installed BEFORE crm.js is required so it holds this object.
// ---------------------------------------------------------------------------
const calls = [];
let unlocked = new Set();
let contactPayload = null;
let failNext = null;

crmTools.call = async (tool, args, opts) => {
  calls.push({ tool, args, opts });
  if (failNext && failNext.tool === tool) { const f = failNext; failNext = null; return f.result; }
  switch (tool) {
    case 'get_contact_status':
      return { ok: true, data: { unlocked: unlocked.has(args.personId) } };
    case 'submit_contact_enrichment':
      // The real tool refuses without a paidActor; mirror that so the test
      // proves our callers pass one.
      if (!opts || !opts.paidActor) return { ok: false, reason: 'paid_tool_refused', detail: 'no actor' };
      unlocked.add(args.personId);
      return { ok: true, data: { status: 'complete' } };
    case 'get_contact_info':
      return { ok: true, data: contactPayload };
    default:
      return { ok: false, reason: 'not_stubbed', detail: tool };
  }
};

const crm = require('../src/lib/elementix/crm');
// Make the pending-poll instant so the suite does not sleep for real.
crm._internals.POLL_DELAY_MS = 1;

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };

const PID_A = '11111111-1111-4111-8111-111111111111';
const PID_B = '22222222-2222-4222-8222-222222222222';

async function staff(name, email) {
  const r = await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1::citext,$2,'loan_officer') RETURNING id`,
    [email, name]);
  return r.rows[0].id;
}

/* THE PAID LIST IS MAINTAINED TWICE ON PURPOSE — the transport's own copy is the
   one that gates the money, and the CRM door keeps a second so a widened door
   cannot quietly widen the spend. Defence in depth is only defence while the two
   agree, and nothing but this made them. */
function paidListsAgree(ok) {
  const client = require('../src/elementix/client');
  const crmTools = require('../src/lib/elementix/crm-tools');
  const a = [...(client.PAID_TOOLS || [])].sort();
  const b = [...(crmTools.PAID || [])].sort();
  assert.deepStrictEqual(b, a,
    'the CRM door and the transport must name the same paid tools, or one of them is wrong about the money');
  assert.deepStrictEqual(a, ['submit_contact_enrichment'],
    'exactly one tool spends, and it is the contact enrichment');
  ok('the two copies of the paid-tool list still agree');
}

async function main() {
  console.log('\nELEMENTIX CRM — skip trace to lead (real Postgres, stubbed vendor)\n');

  // Clean slate for the ids this test owns.
  await db.query(`DELETE FROM elementix_skip_traces WHERE person_id = ANY($1)`, [[PID_A, PID_B]]);
  await db.query(`DELETE FROM elementix_contacts WHERE person_id = ANY($1)`, [[PID_A, PID_B]]);
  await db.query(`DELETE FROM leads WHERE elementix_person_id = ANY($1)`, [[PID_A, PID_B]]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id = ANY($1)`, [[PID_A, PID_B]]);

  const suffix = Date.now();
  const officer1 = await staff('Officer One', `elx1.${suffix}@yscapgroup.com`);
  const officer2 = await staff('Officer Two', `elx2.${suffix}@yscapgroup.com`);

  contactPayload = {
    name: 'Moty Brisk',
    phones: [
      { number: '973-668-0766', type: 'Mobile', carrier: 'AT&T', location: 'SUCCASUNNA, NJ' },
      { number: '(973) 564-1000', type: 'Fixed' },
    ],
    emails: [
      { address: 'motybrisk@gmail.com', status: 'Deliverable' },
      { address: 'info@adar-capital.com', status: 'Risky' },
    ],
  };

  // -------------------------------------------------------------------------
  console.log('1. A paid skip trace creates the lead and records the spend');
  // -------------------------------------------------------------------------
  unlocked = new Set();
  calls.length = 0;
  const r1 = await crm.skipTrace({
    personId: PID_A, staffId: officer1, reason: 'Calling about a bridge loan',
    name: 'Moty Brisk', state: 'NJ' });

  assert.strictEqual(r1.ok, true, r1.detail || '');
  assert.strictEqual(r1.charged, true, 'a locked person costs a credit');
  assert.ok(r1.leadId, 'a lead was created');
  ok('an unlocked person is enriched and lands as a lead');

  // The FREE status check must come FIRST — that is the whole cost control.
  assert.strictEqual(calls[0].tool, 'get_contact_status',
    'the free check runs before anything is spent');
  const paidCall = calls.find((c) => c.tool === 'submit_contact_enrichment');
  assert.ok(paidCall.opts.paidActor && paidCall.opts.paidActor.staffId === officer1,
    'the spend names the officer who asked');
  assert.ok(paidCall.opts.paidActor.reason, 'and the reason they gave');
  ok('the free status check gates the paid one, and the spend is attributable');

  const lead1 = (await db.query(
    `SELECT * FROM leads WHERE id = $1`, [r1.leadId])).rows[0];
  assert.strictEqual(lead1.officer_id, officer1, 'the lead is assigned to that officer');
  assert.strictEqual(lead1.elementix_person_id, PID_A);
  assert.strictEqual(lead1.phone, '973-668-0766', 'the best number seeds the lead');
  assert.strictEqual(lead1.phone_alt, '(973) 564-1000');
  assert.strictEqual(String(lead1.email), 'motybrisk@gmail.com');
  assert.strictEqual(lead1.lead_source, 'elementix_skip_trace');
  assert.strictEqual(lead1.status, 'new');
  assert.strictEqual(lead1.first_name, 'Moty');
  assert.strictEqual(lead1.last_name, 'Brisk');
  ok('the lead carries the name, both numbers and the email, owned by the officer');

  const contact = (await db.query(`SELECT * FROM elementix_contacts WHERE person_id=$1`, [PID_A])).rows[0];
  assert.strictEqual(contact.phones.length, 2, 'every phone is kept, not just the first');
  assert.strictEqual(contact.emails.length, 2);
  assert.strictEqual(contact.phones[0].label, 'Mobile', "the vendor's own label is kept");
  assert.strictEqual(contact.phones[0].carrier, 'AT&T');
  assert.strictEqual(contact.unlocked_by, officer1);
  assert.strictEqual(contact.source, 'pilot_skip_trace');
  ok('all phones and emails are stored with the labels Elementix gave them');

  const trace = (await db.query(
    `SELECT * FROM elementix_skip_traces WHERE person_id=$1 AND staff_id=$2`, [PID_A, officer1])).rows[0];
  assert.strictEqual(trace.charged, true);
  assert.strictEqual(trace.status, 'complete');
  assert.strictEqual(trace.lead_id, r1.leadId);
  ok('the skip trace is recorded against the officer, with the lead it produced');

  const note = (await db.query(
    `SELECT * FROM notifications WHERE staff_id=$1 AND type='elementix_lead'`, [officer1])).rows;
  assert.strictEqual(note.length, 1, 'the officer is told once');
  ok('the officer gets one in-app notification');

  // -------------------------------------------------------------------------
  console.log('\n2. Re-tracing the same person does NOT spend again or duplicate');
  // -------------------------------------------------------------------------
  calls.length = 0;
  const r2 = await crm.skipTrace({
    personId: PID_A, staffId: officer1, reason: 'calling back', name: 'Moty Brisk', state: 'NJ' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.charged, false, 'already unlocked — nothing is spent');
  assert.strictEqual(r2.leadId, r1.leadId, 'the same lead, not a second one');
  assert.ok(!calls.some((c) => c.tool === 'submit_contact_enrichment'),
    'the paid tool is not even reached');
  const leadCount = (await db.query(
    `SELECT count(*)::int n FROM leads WHERE elementix_person_id=$1 AND officer_id=$2`,
    [PID_A, officer1])).rows[0].n;
  assert.strictEqual(leadCount, 1);
  ok('re-tracing is free and reuses the existing lead');

  const trace2 = (await db.query(
    `SELECT charged FROM elementix_skip_traces WHERE person_id=$1 AND staff_id=$2`,
    [PID_A, officer1])).rows[0];
  assert.strictEqual(trace2.charged, true,
    'and the record that a credit WAS spent survives the free re-read');
  ok('a free re-read never erases that the person was paid for');

  // -------------------------------------------------------------------------
  console.log('\n3. A second officer gets their OWN lead for the same person');
  // -------------------------------------------------------------------------
  const r3 = await crm.skipTrace({
    personId: PID_A, staffId: officer2, reason: 'my own prospect', name: 'Moty Brisk', state: 'NJ' });
  assert.strictEqual(r3.ok, true);
  assert.notStrictEqual(r3.leadId, r1.leadId, 'a different lead');
  const owner = (await db.query(`SELECT officer_id FROM leads WHERE id=$1`, [r3.leadId])).rows[0];
  assert.strictEqual(owner.officer_id, officer2);
  ok('two officers working one person get one lead each');

  const firstUnlocker = (await db.query(
    `SELECT unlocked_by FROM elementix_contacts WHERE person_id=$1`, [PID_A])).rows[0];
  assert.strictEqual(firstUnlocker.unlocked_by, officer1,
    'the contact still records who actually paid, not whoever read it last');
  ok('the credit stays attributed to the officer who spent it');

  // -------------------------------------------------------------------------
  console.log('\n4. An enrichment job that has not finished is left pending, then drained');
  // -------------------------------------------------------------------------
  // The vendor accepts the spend but does NOT flip to unlocked, so every poll
  // fails — the money is gone and the details are not here yet.
  const realCall = crmTools.call;
  crmTools.call = async (tool, args, opts) => {
    calls.push({ tool, args, opts });
    if (tool === 'get_contact_status') return { ok: true, data: { unlocked: false } };
    if (tool === 'submit_contact_enrichment') return { ok: true, data: { status: 'queued' } };
    return realCall(tool, args, opts);
  };

  const r4 = await crm.skipTrace({
    personId: PID_B, staffId: officer1, reason: 'slow job', name: 'Slow Person', state: 'NY' });
  assert.strictEqual(r4.ok, true);
  assert.strictEqual(r4.pending, true, 'reported as pending, not as a failure');
  assert.strictEqual(r4.charged, true, 'because the credit HAS been spent');
  const pend = (await db.query(
    `SELECT status, charged FROM elementix_skip_traces WHERE person_id=$1`, [PID_B])).rows[0];
  assert.strictEqual(pend.status, 'pending');
  assert.strictEqual(pend.charged, true);
  ok('a slow enrichment is held as pending with the spend recorded');

  // Now the job lands and the sweep finishes it.
  crmTools.call = realCall;
  unlocked.add(PID_B);
  contactPayload = { name: 'Slow Person', phones: [{ number: '212-555-0100', type: 'Mobile' }], emails: [] };
  const drained = await crm.drainPendingSkipTraces({ limit: 10 });
  assert.strictEqual(drained.completed, 1, 'the sweep completes it');
  const done = (await db.query(
    `SELECT status, lead_id FROM elementix_skip_traces WHERE person_id=$1`, [PID_B])).rows[0];
  assert.strictEqual(done.status, 'complete');
  assert.ok(done.lead_id, 'and the lead exists now');
  ok('the sweep settles it and the paid-for details are not lost');

  // -------------------------------------------------------------------------
  console.log('\n5. The refusals');
  // -------------------------------------------------------------------------
  const noReason = await crm.skipTrace({ personId: PID_A, staffId: officer1, reason: '' });
  assert.strictEqual(noReason.ok, false);
  assert.strictEqual(noReason.reason, 'no_reason');
  const noActor = await crm.skipTrace({ personId: PID_A, staffId: null, reason: 'x' });
  assert.strictEqual(noActor.ok, false);
  assert.strictEqual(noActor.reason, 'no_actor');
  const badId = await crm.skipTrace({ personId: 'not-a-uuid', staffId: officer1, reason: 'x' });
  assert.strictEqual(badId.ok, false);
  assert.strictEqual(badId.reason, 'bad_args');
  ok('no reason, no officer and a bad id are each refused before anything is spent');

  // A skip trace whose enrichment the vendor REFUSES must not create a lead and
  // must not claim a spend. This is the path a hit money-cap takes.
  crmTools.call = async (tool, args, opts) => {
    calls.push({ tool, args, opts });
    if (tool === 'get_contact_status') return { ok: true, data: { unlocked: false } };
    if (tool === 'submit_contact_enrichment') {
      return { ok: false, reason: 'paid_cap_reached', detail: 'The 1000 contact look-ups for this month are used up.' };
    }
    return realCall(tool, args, opts);
  };
  const PID_C = '33333333-3333-4333-8333-333333333333';
  const capped = await crm.skipTrace({
    personId: PID_C, staffId: officer1, reason: 'over the cap', name: 'Capped Person', state: 'NJ' });
  assert.strictEqual(capped.ok, false);
  assert.strictEqual(capped.reason, 'paid_cap_reached');
  const noLead = (await db.query(
    `SELECT count(*)::int n FROM leads WHERE elementix_person_id=$1`, [PID_C])).rows[0].n;
  assert.strictEqual(noLead, 0, 'a refused spend creates no lead');
  const noTrace = (await db.query(
    `SELECT count(*)::int n FROM elementix_skip_traces WHERE person_id=$1`, [PID_C])).rows[0].n;
  assert.strictEqual(noTrace, 0, 'and records no skip trace');
  crmTools.call = realCall;
  ok('a refused spend (money cap) leaves nothing behind — no lead, no record');

  // -------------------------------------------------------------------------
  console.log('\n6. A message about money says what actually happened');
  // -------------------------------------------------------------------------
  // finishSkipTrace is reached from the PAID path AND from the FREE one (a
  // person Elementix already had unlocked). It used to say "the lookup is paid
  // for" both ways — a plain untruth on the very screen where somebody decides
  // whether to spend again.
  const PID_D = '44444444-4444-4444-8444-444444444444';
  await db.query(`DELETE FROM elementix_skip_traces WHERE person_id=$1`, [PID_D]);
  await db.query(`DELETE FROM leads WHERE elementix_person_id=$1`, [PID_D]);
  await db.query(`DELETE FROM elementix_contacts WHERE person_id=$1`, [PID_D]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id=$1`, [PID_D]);

  failNext = { tool: 'get_contact_info', result: { ok: false, reason: 'unavailable', detail: 'not yet' } };
  const freePending = await crm.finishSkipTrace({
    personId: PID_D, staffId: officer1, reason: 'Adding a lead', name: 'Free Path', state: 'NJ',
    charged: false, source: 'already_unlocked' });
  assert.strictEqual(freePending.pending, true);
  assert.strictEqual(freePending.charged, false);
  assert.ok(!/paid for/i.test(freePending.detail),
    'the free path must never claim the lookup was paid for');
  assert.ok(/nothing was charged/i.test(freePending.detail));
  ok('a free lookup that has not landed says nothing was charged');

  failNext = { tool: 'get_contact_info', result: { ok: false, reason: 'unavailable', detail: 'not yet' } };
  const paidPending = await crm.finishSkipTrace({
    personId: PID_D, staffId: officer1, reason: 'Calling them', name: 'Free Path', state: 'NJ',
    charged: true, source: 'pilot_skip_trace' });
  assert.ok(/paid for/i.test(paidPending.detail), 'and the paid path still says the credit is spent');
  ok('a paid lookup that has not landed still says so');

  // -------------------------------------------------------------------------
  console.log('\n7. A vendor payload that Postgres would refuse');
  // -------------------------------------------------------------------------
  // A NUL byte is refused by jsonb (22P05) and the nul-strip middleware never
  // sees this — a vendor answer arrives over fetch, not through express.json.
  // Before the guard, the write raised AFTER the credit was spent.
  const NUL = String.fromCharCode(0);
  await crm.ensurePerson({ personId: PID_D, name: 'Free Path', state: 'NJ' });  // the contact row's FK
  await crm.storeContact({
    personId: PID_D,
    contact: { phones: [{ value: `732-555-01${NUL}01`, label: `Mobile${NUL}` }], emails: [], addresses: [] },
    raw: { note: `a payload with a ${NUL} in it`, nested: { deep: [`${NUL}x`] } },
    staffId: officer1, source: 'pilot_skip_trace',
  });
  const held = await db.query(`SELECT phones, raw FROM elementix_contacts WHERE person_id=$1`, [PID_D]);
  assert.strictEqual(held.rowCount, 1, 'the write landed instead of raising 22P05');
  assert.ok(!JSON.stringify(held.rows[0].phones).includes('\\u0000'));
  ok('a NUL byte anywhere in a vendor payload is stripped, and the row is stored');

  // ...and something far too big is REPLACED by a marker, never half-written:
  // slicing serialized JSON produces a document Postgres rejects outright.
  const huge = { blob: 'x'.repeat(600000) };
  await crm.storeContact({ personId: PID_D, contact: { phones: [], emails: [], addresses: [] },
    raw: huge, staffId: officer1, source: 'pilot_skip_trace' });
  const big = await db.query(`SELECT raw FROM elementix_contacts WHERE person_id=$1`, [PID_D]);
  assert.strictEqual(big.rows[0].raw._dropped, 'too_large', 'an over-large payload says so in the row');
  ok('an over-large vendor payload is replaced by a marker that says why, not truncated into junk');

  // -------------------------------------------------------------------------
  console.log('\n8. One writer of the person header');
  // -------------------------------------------------------------------------
  // Two copies of this upsert disagreed about whose name wins, so a person's
  // displayed name depended on which module touched them last.
  await db.query(`DELETE FROM elementix_persons WHERE person_id=$1`, [PID_D]);
  await crm.ensurePerson({ personId: PID_D, name: 'Picked Off A Search', state: 'NJ' });
  await crm.ensurePerson({ personId: PID_D, name: 'A Later Guess', state: 'NJ' });
  let nm = await db.query(`SELECT display_name FROM elementix_persons WHERE person_id=$1`, [PID_D]);
  assert.strictEqual(nm.rows[0].display_name, 'Picked Off A Search',
    'an ordinary write never overwrites a name somebody already saw on their lead');
  const profile = require('../src/lib/elementix/profile');
  await profile._internals.ensurePersonRow(PID_D, { name: 'The Vendor Record', state: 'NJ' });
  nm = await db.query(`SELECT display_name FROM elementix_persons WHERE person_id=$1`, [PID_D]);
  assert.strictEqual(nm.rows[0].display_name, 'The Vendor Record',
    'the profile build, which holds the vendor\'s own record, does replace it');
  ok('one writer, and only the vendor\'s own record may replace a stored name');

  await db.query(`DELETE FROM elementix_skip_traces WHERE person_id=$1`, [PID_D]);
  await db.query(`DELETE FROM leads WHERE elementix_person_id=$1`, [PID_D]);
  await db.query(`DELETE FROM elementix_contacts WHERE person_id=$1`, [PID_D]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id=$1`, [PID_D]);

  // -------------------------------------------------------------------------
  console.log('\n9. A spend is only recorded when a call is genuinely about to go out');
  // -------------------------------------------------------------------------
  // The REAL client, not the stub. `recordPaid` writes a row against the owner's
  // 1,000 a month, and it used to run BEFORE the "can this call go out at all?"
  // gates — so with Elementix switched off, rate-limited or in dry run, a paid
  // row was written and the call then returned "switched off". Nothing bought;
  // the cap shrank anyway. The REFUSALS about the caller still come first (a
  // paid call with no actor is refused whatever the environment says); only the
  // ledger write moved.
  const realElx = require('../src/elementix/client');
  const flags = require('../src/lib/flags');
  const fullActor = { paidActor: { staffId: officer1, personId: PID_A, reason: 'proving the ledger is not written' } };
  const countPaid = async () => (await db.query(
    `SELECT count(*)::int n FROM elementix_calls WHERE paid AND staff_id = $1::uuid`, [officer1])).rows[0].n;

  // A refusal about the CALLER still wins over anything about the environment.
  const bareCall = await realElx.callTool('submit_contact_enrichment', {}, {});
  assert.strictEqual(bareCall.reason, 'paid_tool_refused',
    'a paid call with no actor is refused before the environment is even read');

  const paidBefore = await countPaid();
  const off = await realElx.callTool('submit_contact_enrichment', {}, fullActor);
  assert.notStrictEqual(off.ok, true, 'the call did not go out');
  assert.ok(['not_configured', 'disabled', 'rate_limited'].includes(off.reason), `unexpected reason: ${off.reason}`);
  assert.strictEqual(await countPaid(), paidBefore,
    'and nothing was billed for a call that never left the building');
  ok('a call that cannot go out bills nothing — the cap is not shrunk by a switch being off');

  // The DRY RUN is the same class, and it is the one that used to look like a
  // success: it must also bill nothing, and must not read as an answer.
  await flags.setFlag('ELEMENTIX_ENABLED', true, officer1);
  await flags.setFlag('ELEMENTIX_DRYRUN', true, officer1);
  const dry = await realElx.callTool('submit_contact_enrichment', {}, fullActor);
  assert.strictEqual(await countPaid(), paidBefore, 'a dry run bills nothing either');
  assert.strictEqual(dry.dryRun, true, 'and the transport marks it as a dry run rather than a real answer');

  /* THE CRM PLANE TURNS THAT MARK INTO A REFUSAL, and that conversion is the
     half that matters on this plane: the transport's `{ok:true, dryRun:true,
     data:null}` reads to `rowsOf` as "nobody by that name", caches a profile
     section as a confident empty for a day, and — because `crm.skipTrace`
     treats an ok from the paid tool as proof the unlock happened — tells an
     officer their contact is on its way while nothing was sent. A fresh copy of
     the module is required here because this suite has stubbed the one it holds. */
  const cacheKey = require.resolve('../src/lib/elementix/crm-tools');
  const stubbed = require.cache[cacheKey];
  delete require.cache[cacheKey];
  const realTools = require('../src/lib/elementix/crm-tools');
  const viaPlane = await realTools.call('get_contact_status', { personId: PID_A }, { staffId: officer1 });
  require.cache[cacheKey] = stubbed;
  assert.strictEqual(viaPlane.ok, false, 'a dry run is a refusal on the CRM plane, never an empty success');
  assert.strictEqual(viaPlane.reason, 'dry_run');
  assert.ok(/dry-run/i.test(viaPlane.detail), 'and it says so in words somebody can act on');

  /* PUT THE SWITCHES BACK AS THEY WERE — REMOVED, not set to false. `flags`
     falls back to the env default when there is no row, and a row saying
     `false` is a different state from "no opinion": a later suite reading the
     env default would silently get this suite's opinion instead. */
  await db.query(`DELETE FROM integration_flags WHERE key = ANY($1)`,
    [['ELEMENTIX_ENABLED', 'ELEMENTIX_DRYRUN']]);
  await flags.refresh();
  ok('a dry run bills nothing, and reaches the CRM as a refusal rather than an empty success');

  paidListsAgree(ok);

  console.log(`\n✓ ${passed} checks passed — the CRM skip-trace path is sound.\n`);
  await db.pool.end?.().catch?.(() => {});
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ FAILED:', e && e.message, '\n', e); process.exit(1); });
