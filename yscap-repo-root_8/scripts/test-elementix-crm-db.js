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

  console.log(`\n✓ ${passed} checks passed — the CRM skip-trace path is sound.\n`);
  await db.pool.end?.().catch?.(() => {});
  process.exit(0);
}

main().catch((e) => { console.error('\n✗ FAILED:', e && e.message, '\n', e); process.exit(1); });
