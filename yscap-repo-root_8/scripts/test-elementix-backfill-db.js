'use strict';
/**
 * scripts/test-elementix-backfill-db.js — the history import, for real.
 *
 * The owner's requirement was "go back to the beginning and give every officer
 * the contacts they already skip traced". This proves the whole chain against a
 * real Postgres with the vendor stubbed — using the SHAPES CAPTURED LIVE on
 * 2026-08-18, because the shapes are the part that was wrong twice already.
 *
 * NOTHING HERE MAY SPEND A CREDIT. The stub fails the suite outright if the paid
 * tool is called: every person in a backfill is already unlocked, so re-buying
 * one would be the most expensive possible way to import it.
 */

const assert = require('assert');

if (!process.env.DATABASE_URL) {
  console.log('· test-elementix-backfill-db: no DATABASE_URL — skipped');
  process.exit(0);
}

const db = require('../src/db');
const crmTools = require('../src/lib/elementix/crm-tools');

const P = (n) => `88888888-8888-4888-8888-${String(n).padStart(12, '0')}`;
const PEOPLE = [
  { id: P(1), name: 'MOTY BRISK', primaryState: 'NJ', unlockedBy: 'yosef@yscapgroup.com', unlockedAt: '2026-06-10T12:00:00.000Z' },
  { id: P(2), name: 'JOSEPH MCGUIGAN', primaryState: 'NJ', unlockedBy: 'josef@yscapgroup.com', unlockedAt: '2026-07-01T12:00:00.000Z' },
  { id: P(3), name: 'A THIRD PERSON', primaryState: 'NY', unlockedBy: 'sol@yscapgroup.com', unlockedAt: '2026-07-15T12:00:00.000Z' },
  // Nobody on the roster owns this login — the honest-unmatched case.
  { id: P(4), name: 'A FOURTH PERSON', primaryState: 'PA', unlockedBy: 'departed@yscapgroup.com', unlockedAt: '2026-08-01T12:00:00.000Z' },
];

/* The real `get_contact_info` envelope: the JOB, two levels deep. A reader that
   stops one level short finds nothing at all — which is what ours did before
   this shape was captured. */
const CONTACT = (n) => ({
  job: {
    id: `job-${n}`, personId: P(n), status: 'COMPLETED',
    createdAt: '2025-10-06T13:33:55.144Z', completedAt: '2025-10-06T14:17:02.947Z',
    result: {
      email: [{ value: `person${n}@example.com`, reason: 'ok', result: 'deliverable', provider: 'example.com', confidence: 0.9 }],
      phone: [
        { type: 'MOBILE', value: `97366807${String(n).padStart(2, '0')}`, carrier: 'NEW CINGULAR WIRELESS', location: 'SUCCASUNNA, NJ', confidence: 0.7 },
        { type: 'FIXED', value: `97356410${String(n).padStart(2, '0')}`, carrier: 'PEERLESS NETWORK', location: 'MILLBURN, NJ', confidence: 0.85 },
      ],
      summary: 'A real estate investor.', company_name: 'Adar Capital', company_domain: 'adar-capital.com', linkedin_url: null,
    },
    logs: ['Starting contact search...'],
  },
});

let listFailFromPage = 0;
let contactFails = new Set();
const seen = [];

crmTools.call = async (tool, args, opts) => {
  seen.push({ tool, args, staffId: opts && opts.staffId });
  assert.notStrictEqual(tool, 'submit_contact_enrichment',
    'THE BACKFILL MUST NEVER BUY A CONTACT — every person in it is already unlocked');
  if (tool === 'list_people') {
    if (listFailFromPage && args.page >= listFailFromPage) {
      return { ok: false, reason: 'vendor_error', detail: 'Elementix stopped answering.' };
    }
    const per = args.perPage;
    const start = (args.page - 1) * per;
    const slice = PEOPLE.slice(start, start + per);
    const more = start + per < PEOPLE.length;
    return { ok: true, data: { data: slice, ...(more ? { nextPage: args.page + 1 } : {}) } };
  }
  if (tool === 'get_contact_info') {
    const n = Number(String(args.personId).slice(-1));
    if (contactFails.has(args.personId)) return { ok: false, reason: 'vendor_error', detail: 'That job could not be read.' };
    return { ok: true, data: CONTACT(n) };
  }
  return { ok: false, reason: 'not_stubbed', detail: tool };
};

const backfill = require('../src/lib/elementix/backfill');
const crm = require('../src/lib/elementix/crm');
const fs = require('fs');
const path = require('path');
const flags = require('../src/lib/flags');

let passed = 0;
const ok = (m) => { passed += 1; console.log(`  ✓ ${m}`); };

const ids = PEOPLE.map((p) => p.id);
const wipe = async () => {
  await db.query(`DELETE FROM elementix_backfill_queue WHERE person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM elementix_skip_traces WHERE person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM elementix_contacts WHERE person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM leads WHERE elementix_person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM elementix_persons WHERE person_id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM elementix_users WHERE email LIKE '%@yscapgroup.test'`);
};

async function main() {
  console.log('\nELEMENTIX BACKFILL — the whole history, given back to the right officers\n');
  await wipe();

  // Two officers whose emails are ONE LETTER APART. That is not a contrived
  // fixture: josef@ and yosef@ are both real logins on this account, and so are
  // sol@ and solomon@.
  const sfx = Date.now();
  const mk = async (name, addr) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_active, is_external)
     VALUES ($1::citext,$2,'loan_officer',true,false) RETURNING id`, [addr, name])).rows[0].id;
  // The real addresses are used so the match is proven on the genuine article.
  await db.query(`DELETE FROM elementix_users WHERE email = ANY($1)`,
    [['yosef@yscapgroup.com', 'josef@yscapgroup.com', 'sol@yscapgroup.com', 'departed@yscapgroup.com']]);
  const existing = await db.query(
    `SELECT id, email FROM staff_users WHERE email = ANY($1::citext[])`,
    [['yosef@yscapgroup.com', 'josef@yscapgroup.com', 'sol@yscapgroup.com']]);
  const have = new Map(existing.rows.map((r) => [String(r.email).toLowerCase(), r.id]));
  const yosef = have.get('yosef@yscapgroup.com') || await mk(`Yosef ${sfx}`, 'yosef@yscapgroup.com');
  const josef = have.get('josef@yscapgroup.com') || await mk(`Josef ${sfx}`, 'josef@yscapgroup.com');
  const sol = have.get('sol@yscapgroup.com') || await mk(`Sol ${sfx}`, 'sol@yscapgroup.com');
  const admin = await mk(`Backfill Admin ${sfx}`, `bfadmin.${sfx}@yscapgroup.test`);

  // -------------------------------------------------------------------------
  console.log('1. Listing the history');
  // -------------------------------------------------------------------------
  let r = await backfill.listUnlocked({ staffId: null });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_actor');
  ok('an import with nobody behind it is refused');

  r = await backfill.listUnlocked({ staffId: admin, perPage: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.peopleSeen, 4, 'it paged to the end');
  assert.strictEqual(r.newlyQueued, 4);
  ok('every unlocked contact is queued, across pages');

  assert.strictEqual(r.users.length, 4, 'four distinct logins');
  assert.strictEqual(r.users[0].unlocks, 1);
  ok('and the distinct Elementix logins are recorded — the user list the owner asked for');

  // THE NEAR-MISS GUARD.
  const u = await db.query(`SELECT email, staff_id FROM elementix_users ORDER BY email`);
  const byEmail = new Map(u.rows.map((x) => [String(x.email).toLowerCase(), x.staff_id]));
  assert.strictEqual(byEmail.get('yosef@yscapgroup.com'), yosef);
  assert.strictEqual(byEmail.get('josef@yscapgroup.com'), josef);
  assert.notStrictEqual(yosef, josef);
  ok('josef@ and yosef@ matched their OWN officers — one letter apart, never crossed');

  assert.strictEqual(byEmail.get('departed@yscapgroup.com'), null);
  assert.ok(r.unmatchedUsers.some((x) => x.email === 'departed@yscapgroup.com'));
  ok('a login nobody on the roster owns is reported, not given to the nearest name');

  // -------------------------------------------------------------------------
  console.log('\n2. Working the queue');
  // -------------------------------------------------------------------------
  const spentBefore = seen.filter((c) => c.tool === 'submit_contact_enrichment').length;
  let w = await backfill.workBatch({ staffId: admin, limit: 10 });
  assert.strictEqual(w.ok, true);
  assert.strictEqual(w.worked, 4);
  assert.strictEqual(w.leads, 3, 'three had an officer to give them to');
  assert.strictEqual(w.noOfficer, 1);
  ok('every queued person was read and settled');

  assert.strictEqual(seen.filter((c) => c.tool === 'submit_contact_enrichment').length, spentBefore);
  ok('and not one credit was spent doing it');

  const lead1 = await db.query(
    `SELECT id, officer_id, name, phone, phone_alt, email, lead_source FROM leads WHERE elementix_person_id = $1`, [P(1)]);
  assert.strictEqual(lead1.rows.length, 1);
  assert.strictEqual(lead1.rows[0].officer_id, yosef, 'to the officer whose login unlocked it');
  assert.ok(lead1.rows[0].phone, 'carrying the phone number');
  assert.ok(lead1.rows[0].email, 'and the email address');
  ok('the lead landed in the right officer’s pipeline with the contact details on it');

  const c1 = await db.query(
    `SELECT phones, emails, unlocked_by, unlocked_by_email, vendor_unlocked_at, source FROM elementix_contacts WHERE person_id = $1`, [P(1)]);
  assert.strictEqual(c1.rows[0].phones.length, 2, 'BOTH numbers, not just the first');
  assert.strictEqual(c1.rows[0].phones[0].label, 'MOBILE');
  assert.strictEqual(c1.rows[0].phones[0].carrier, 'NEW CINGULAR WIRELESS');
  assert.strictEqual(c1.rows[0].phones[0].confidence, 0.7);
  assert.strictEqual(c1.rows[0].emails[0].status, 'deliverable');
  ok('every number is stored with the vendor’s own label, carrier and confidence');

  assert.strictEqual(String(c1.rows[0].unlocked_by_email), 'yosef@yscapgroup.com');
  assert.ok(c1.rows[0].vendor_unlocked_at, 'and when Elementix says it happened');
  assert.strictEqual(c1.rows[0].unlocked_by, yosef);
  assert.strictEqual(c1.rows[0].source, 'imported');
  ok('the vendor’s own answer is kept beside the officer we matched it to');

  // -------------------------------------------------------------------------
  console.log('\n3. The one nobody owns');
  // -------------------------------------------------------------------------
  let q4 = await db.query(`SELECT status, detail, lead_id FROM elementix_backfill_queue WHERE person_id = $1`, [P(4)]);
  assert.strictEqual(q4.rows[0].status, 'skipped');
  assert.strictEqual(q4.rows[0].lead_id, null);
  assert.ok(/no PILOT officer/i.test(q4.rows[0].detail || ''), 'and it says why, in words');
  const c4 = await db.query(`SELECT person_id FROM elementix_contacts WHERE person_id = $1`, [P(4)]);
  assert.strictEqual(c4.rows.length, 1, 'the contact is still imported — only the lead waits');
  ok('an unowned login imports the contact and holds the lead, saying so');

  const link = await backfill.linkUser({ email: 'departed@yscapgroup.com', staffId: sol, actorId: admin });
  assert.strictEqual(link.ok, true);
  const rel = await backfill.releaseSkipped({ email: 'departed@yscapgroup.com' });
  assert.strictEqual(rel.requeued, 1);
  w = await backfill.workBatch({ staffId: admin, limit: 10 });
  assert.strictEqual(w.leads, 1);
  const lead4 = await db.query(`SELECT officer_id FROM leads WHERE elementix_person_id = $1`, [P(4)]);
  assert.strictEqual(lead4.rows[0].officer_id, sol);
  ok('saying whose login it was turns the held contact into their lead — with no second vendor call for the contact');

  // A HUMAN'S DECISION IS NOT UNDONE BY THE AUTOMATIC MATCHER, and proving that
  // needs a login the matcher WOULD have an opinion about. `departed@` matches
  // nobody, so re-running the matcher over it proves nothing — the guard is
  // never reached. `yosef@yscapgroup.com` DOES match its own officer, so
  // deliberately pointing it somewhere else is the only case that tests the rule.
  await backfill.linkUser({ email: 'yosef@yscapgroup.com', staffId: josef, actorId: admin });
  await backfill.matchUsers();
  const overruled = await db.query(`SELECT staff_id, linked_by FROM elementix_users WHERE email = 'yosef@yscapgroup.com'`);
  assert.strictEqual(overruled.rows[0].staff_id, josef,
    'the matcher must NOT pull it back to the officer whose address it is');
  assert.strictEqual(overruled.rows[0].linked_by, admin);
  ok('and the automatic matcher never overrules a person’s decision, even when it disagrees');
  // Put it back, so the rest of the suite reads the ordinary state.
  await backfill.linkUser({ email: 'yosef@yscapgroup.com', staffId: yosef, actorId: admin });

  await backfill.matchUsers();
  const after = await db.query(`SELECT staff_id, linked_by FROM elementix_users WHERE email = 'departed@yscapgroup.com'`);
  assert.strictEqual(after.rows[0].staff_id, sol);
  assert.strictEqual(after.rows[0].linked_by, admin);
  ok('a hand-linked login that matches nobody automatically keeps its officer too');

  // -------------------------------------------------------------------------
  console.log('\n4. Re-running it is safe');
  // -------------------------------------------------------------------------
  const callsBefore = seen.filter((c) => c.tool === 'get_contact_info').length;
  r = await backfill.listUnlocked({ staffId: admin, perPage: 2 });
  assert.strictEqual(r.newlyQueued, 0, 'nobody is queued twice');
  w = await backfill.workBatch({ staffId: admin, limit: 10 });
  assert.strictEqual(w.worked, 0, 'and nothing already finished is re-read');
  assert.strictEqual(seen.filter((c) => c.tool === 'get_contact_info').length, callsBefore);
  const leadCount = await db.query(`SELECT count(*)::int n FROM leads WHERE elementix_person_id = ANY($1)`, [ids]);
  assert.strictEqual(leadCount.rows[0].n, 4, 'and no duplicate leads appear');
  ok('running the whole import again costs nothing and changes nothing');

  // -------------------------------------------------------------------------
  console.log('\n5. A refusal is never a silent drop');
  // -------------------------------------------------------------------------
  await db.query(`UPDATE elementix_backfill_queue SET status='pending', attempts=0 WHERE person_id=$1`, [P(2)]);
  contactFails.add(P(2));
  for (let i = 0; i < backfill._internals.MAX_ATTEMPTS; i += 1) await backfill.workBatch({ staffId: admin, limit: 10 });
  const q2 = await db.query(`SELECT status, attempts, detail FROM elementix_backfill_queue WHERE person_id = $1`, [P(2)]);
  assert.strictEqual(q2.rows[0].status, 'failed');
  assert.strictEqual(q2.rows[0].attempts, backfill._internals.MAX_ATTEMPTS);
  assert.ok(q2.rows[0].detail, 'with the vendor’s reason kept');
  ok('a contact Elementix will not answer for is marked failed after a bounded retry, with the reason');
  contactFails.clear();

  // -------------------------------------------------------------------------
  console.log('\n6. A half-read history says so');
  // -------------------------------------------------------------------------
  listFailFromPage = 2;
  r = await backfill.listUnlocked({ staffId: admin, perPage: 2 });
  assert.strictEqual(r.ok, false, 'a listing that stopped early is NOT reported as complete');
  assert.ok(r.partial && r.partial.page === 2, 'and it names the page it stopped on');
  assert.ok(r.peopleSeen === 2, 'while keeping what it did read');
  ok('a history that could only be half-read reports itself half-read');
  listFailFromPage = 0;

  const prog = await backfill.progress();
  assert.strictEqual(prog.total, 4);
  assert.ok(prog.users.length >= 4);
  assert.ok(prog.users.every((x) => 'officer' in x));
  ok('and the progress report names every login, its officer, and how many it unlocked');

  // -------------------------------------------------------------------------
  console.log('\n7. The unattended loop can never spend money');
  // -------------------------------------------------------------------------
  // A SOURCE assertion, deliberately. The runtime stub above proves this run did
  // not buy anything; only reading the source proves no BRANCH of it could. An
  // unattended timer that can reach the paid tool is the one thing about this
  // feature that could cost the owner real money while nobody is watching.
  for (const f of ['../src/lib/elementix/backfill.js', '../src/sync/elementix-crm-sync.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // Strip comments first: this file's own header EXPLAINS that it never calls
    // the paid tool, and a guard that read prose would fail on the sentence
    // promising the very thing it checks.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/submit_contact_enrichment/.test(code),
      `${f} must not be able to reach the paid tool`);
  }
  ok('neither the importer nor the timer that runs it can reach the paid tool, on any branch');

  const fsrc = fs.readFileSync(path.join(__dirname, '../src/sync/elementix-crm-sync.js'), 'utf8');
  // The SETTLE pass runs even with the bulk import switched off, so it has to be
  // proven not to reach the paid tool through the module it now requires. It
  // touches exactly THREE functions in crm.js — the sweep, the finisher it calls,
  // and contactState, which the sweep asks about every row — so read those three
  // and nothing else, because crm.js as a whole DOES buy contacts and a
  // whole-file grep would either fail here or, worse, be "fixed" by weakening it.
  const crmSrc = fs.readFileSync(path.join(__dirname, '../src/lib/elementix/crm.js'), 'utf8');
  for (const fn of ['drainPendingSkipTraces', 'finishSkipTrace', 'contactState']) {
    const at = crmSrc.indexOf(`async function ${fn}(`);
    assert.ok(at > -1, `${fn} must exist`);
    // To the next top-level declaration, which is where the function ends.
    const rest = crmSrc.slice(at + 10);
    const end = rest.search(/\n(?:async function |function |module\.exports)/);
    const body = (end === -1 ? rest : rest.slice(0, end))
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/submit_contact_enrichment/.test(body),
      `${fn} is reached by the unattended settle pass and must not be able to buy a contact`);
  }
  ok('the settle pass reads three functions of crm.js, and none of them can buy a contact');

  const sync = require('../src/sync/elementix-crm-sync');
  assert.ok(typeof sync.listOnce === 'function' && typeof sync.workOnce === 'function'
    && typeof sync.settleOnce === 'function');

  /* THE AUTO-IMPORT IS ON, AND IT IS A LIVE SWITCH (owner-directed 2026-08-19:
     "set up auto pull leads"). Two separate things are asserted, because the
     second is what makes the first safe to hand over: it is ON by default, and
     the switch is read at CALL TIME so an owner can stop it from the API Health
     page without waiting for a deploy. Read once at boot — which is how it
     started life — a flip would have done nothing, because the timers were
     never armed and there was nothing to turn back on. */
  const cfg = require('../src/config');
  assert.strictEqual(cfg.elementix.crmSync, true, 'the auto-import ships ON');
  const SW = require('../src/lib/integrations/switches');
  const entry = SW.SWITCHES.find((x) => x.key === 'ELEMENTIX_CRM_SYNC_ENABLED');
  assert.ok(entry, 'and it is a switch on the API Health page, not only an env var');
  assert.strictEqual(entry.dangerous, false,
    'not marked dangerous — it cannot spend a credit and never writes to Elementix');

  assert.strictEqual(sync.autoImportOn(), true, 'on with no override');
  await flags.setFlag('ELEMENTIX_CRM_SYNC_ENABLED', false, admin);
  assert.strictEqual(sync.autoImportOn(), false, 'an owner turning it off is honoured at once');
  assert.strictEqual(await sync.listOnce(), null, '…and the listing pass stands down');
  assert.strictEqual(await sync.workOnce(), null, '…as does the import pass');
  await db.query(`DELETE FROM integration_flags WHERE key = 'ELEMENTIX_CRM_SYNC_ENABLED'`);
  await flags.refresh();
  assert.strictEqual(sync.autoImportOn(), true, 'and turning it back on takes effect with no deploy');
  ok('the auto-import is ON, and can be stopped and restarted from a screen rather than a deploy');
  /* THE BULK IMPORT OBEYS THE SWITCH; SETTLING A PAID LOOKUP DOES NOT. A pending
     trace means a member of staff pressed the button HERE and a credit was
     already spent, so leaving it unsettled wastes money that is gone and drops a
     lead somebody asked for — it is the second half of a click, not an import.
     Creating leads out of work done in Elementix's own screens is the different
     thing, and that is what the switch governs.
     Read from the FUNCTION BODIES rather than from the schedule: the schedule
     used to carry the rule (the bulk timers sat after an early return) and no
     longer does, so an assertion about the schedule would now be testing an
     arrangement instead of the rule. */
  const bodyOf = (fn) => {
    const at = fsrc.indexOf(`async function ${fn}(`);
    assert.ok(at > -1, `${fn} must exist`);
    const rest = fsrc.slice(at + 10);
    const end = rest.search(/\n(?:async function |function |module\.exports)/);
    return end === -1 ? rest : rest.slice(0, end);
  };
  for (const fn of ['listOnce', 'workOnce']) {
    assert.ok(/autoImportOn\(\)/.test(bodyOf(fn)),
      `${fn} imports leads in bulk and must stand down when the switch is off`);
  }
  assert.ok(!/autoImportOn\(\)/.test(bodyOf('settleOnce')),
    'settleOnce finishes a paid lookup somebody already started and must never be gated by the import switch');
  ok('paid lookups are settled whether or not the bulk import is switched on');

  // -------------------------------------------------------------------------
  console.log('\n8. A contact PILOT itself traced is not handed to the shared login');
  // -------------------------------------------------------------------------
  // THE SHARED-SEAT TRAP. Every unlock PILOT makes goes out on the ONE company
  // connection, so Elementix stamps it with that login's email — and mapping
  // that email to an officer, which is exactly right for a real Elementix seat,
  // would hand every trace made in PILOT to that one person. The officer who
  // clicked already has the lead; a second one would appear in somebody else's
  // pipeline, with a notification telling them a contact is theirs.
  await wipe();
  const shared = await mk(`Shared Seat ${sfx}`, `shared.${sfx}@yscapgroup.test`);
  const clicker = await mk(`Clicking Officer ${sfx}`, `clicker.${sfx}@yscapgroup.test`);
  // PILOT's own record of the click: the contact, the lead and the trace.
  await crm.ensurePerson({ personId: P(1), name: 'MOTY BRISK', state: 'NJ' });
  await crm.storeContact({ personId: P(1), contact: { phones: [], emails: [], addresses: [] },
    raw: {}, staffId: clicker, source: 'pilot_skip_trace' });
  const own = await crm.ensureLead({ personId: P(1), staffId: clicker, name: 'MOTY BRISK', state: 'NJ',
    contact: { phones: [], emails: [], addresses: [] } });
  await crm.recordSkipTrace({ personId: P(1), staffId: clicker, name: 'MOTY BRISK', state: 'NJ',
    reason: 'Calling about 41 Arlington Ave', charged: true, source: 'pilot_skip_trace',
    leadId: own.id, status: 'complete' });
  // ...and the vendor hands it back down the history under the SHARED login.
  await db.query(
    `INSERT INTO elementix_users (email, staff_id, linked_by, linked_at)
     VALUES ($1,$2,$3,now()) ON CONFLICT (email) DO UPDATE SET staff_id = EXCLUDED.staff_id`,
    [`shared.${sfx}@yscapgroup.test`, shared, admin]);
  await db.query(
    `INSERT INTO elementix_backfill_queue (person_id, person_name, person_state, unlocked_by_email, unlocked_at, status)
     VALUES ($1,'MOTY BRISK','NJ',$2,now(),'pending')
     ON CONFLICT (person_id) DO UPDATE SET status='pending', attempts=0, unlocked_by_email=EXCLUDED.unlocked_by_email`,
    [P(1), `shared.${sfx}@yscapgroup.test`]);

  const reimport = await backfill.workBatch({ staffId: admin, limit: 5 });
  assert.strictEqual(reimport.alreadyOurs, 1, 'the import recognised its own trace');
  const leads = await db.query(
    `SELECT officer_id FROM leads WHERE elementix_person_id = $1`, [P(1)]);
  assert.strictEqual(leads.rowCount, 1, 'exactly one lead — no copy in the shared login\'s pipeline');
  assert.strictEqual(leads.rows[0].officer_id, clicker, 'and it belongs to the officer who clicked');
  ok('a trace made in PILOT is not duplicated into the shared login\'s pipeline');

  const tr = await db.query(
    `SELECT staff_id, reason, charged, source FROM elementix_skip_traces WHERE person_id = $1`, [P(1)]);
  assert.strictEqual(tr.rowCount, 1);
  assert.strictEqual(tr.rows[0].staff_id, clicker);
  assert.strictEqual(tr.rows[0].reason, 'Calling about 41 Arlington Ave',
    'the reason the officer typed is not overwritten by "Imported from Elementix history"');
  assert.strictEqual(tr.rows[0].charged, true, 'and the record that a credit was spent survives');
  ok('the reason typed at the click, and the spend, are left exactly as they were');

  // A PENDING trace is charged and belongs to the settle pass. The import must
  // not rewrite it either — "complete" is not what makes the history ours.
  await db.query(`DELETE FROM elementix_skip_traces WHERE person_id = $1`, [P(1)]);
  await db.query(`DELETE FROM elementix_contacts WHERE person_id = $1`, [P(1)]);
  await crm.recordSkipTrace({ personId: P(1), staffId: clicker, name: 'MOTY BRISK', state: 'NJ',
    reason: 'Waiting on the vendor', charged: true, source: 'pilot_skip_trace', status: 'pending' });
  await db.query(`UPDATE elementix_backfill_queue SET status='pending', attempts=0 WHERE person_id=$1`, [P(1)]);
  const rerun = await backfill.workBatch({ staffId: admin, limit: 5 });
  assert.strictEqual(rerun.alreadyOurs, 1);
  const pend = await db.query(
    `SELECT staff_id, reason, charged, status FROM elementix_skip_traces WHERE person_id = $1`, [P(1)]);
  assert.strictEqual(pend.rowCount, 1);
  assert.strictEqual(pend.rows[0].staff_id, clicker);
  assert.strictEqual(pend.rows[0].reason, 'Waiting on the vendor');
  assert.strictEqual(pend.rows[0].charged, true);
  assert.strictEqual(pend.rows[0].status, 'pending', 'the settle pass still owns it');
  ok('a charged trace still running is left for the settle pass, not overwritten as an import');

  // -------------------------------------------------------------------------
  console.log('\n9. The officer is told about a NEW unlock, and not about the backlog');
  // -------------------------------------------------------------------------
  /* The owner's requirement is a notification per contact. The SAME import also
     carries the whole history back to the beginning — about a thousand contacts
     on the first pass — so notifying on those would drop hundreds of notices
     into one officer's list in an afternoon, about people they looked up months
     ago, burying the one notice that is actually news. The test is the vendor's
     own unlock date, so it holds whenever the import happens to run. */
  const nowIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 120 * 24 * 3600 * 1000).toISOString();
  assert.strictEqual(backfill._internals.unlockIsNews(nowIso), true, 'unlocked just now is news');
  assert.strictEqual(backfill._internals.unlockIsNews(oldIso), false, 'unlocked four months ago is history');
  assert.strictEqual(backfill._internals.unlockIsNews(null), false,
    'no unlock date states nothing — news is never invented from a missing timestamp');
  assert.strictEqual(backfill._internals.unlockIsNews('not a date'), false, 'nor from junk');
  assert.strictEqual(
    backfill._internals.unlockIsNews(new Date(Date.now() + 86400000).toISOString()), false,
    'a date in the future is a clock problem, not news');
  ok('what counts as news is the vendor\'s own unlock date, and an absent one is never news');

  // …and end to end: two contacts, one fresh and one from the backlog.
  await wipe();
  const freshOfficer = await mk(`Fresh Officer ${sfx}`, `fresh.${sfx}@yscapgroup.test`);
  await db.query(
    `INSERT INTO elementix_users (email, staff_id, linked_by, linked_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (email) DO UPDATE SET staff_id = EXCLUDED.staff_id`,
    [`fresh.${sfx}@yscapgroup.test`, freshOfficer, admin]);
  for (const [pid, when] of [[P(1), nowIso], [P(2), oldIso]]) {
    await db.query(
      `INSERT INTO elementix_backfill_queue (person_id, person_name, person_state, unlocked_by_email, unlocked_at, status)
       VALUES ($1,'IMPORTED PERSON','NJ',$2,$3,'pending')
       ON CONFLICT (person_id) DO UPDATE SET status='pending', attempts=0,
             unlocked_by_email=EXCLUDED.unlocked_by_email, unlocked_at=EXCLUDED.unlocked_at`,
      [pid, `fresh.${sfx}@yscapgroup.test`, when]);
  }
  const before = (await db.query(
    `SELECT count(*)::int n FROM notifications WHERE staff_id = $1::uuid`, [freshOfficer])).rows[0].n;
  const imported = await backfill.workBatch({ staffId: admin, limit: 5 });
  assert.strictEqual(imported.leads, 2, 'both became leads');
  assert.strictEqual(imported.notified, 1, 'and exactly one of them was worth telling somebody about');
  // The notify is fire-and-forget by design, so give it a moment to land.
  await new Promise((r) => setTimeout(r, 300));
  const notices = await db.query(
    `SELECT title, body, type FROM notifications WHERE staff_id = $1::uuid ORDER BY created_at DESC LIMIT 5`,
    [freshOfficer]);
  assert.strictEqual(notices.rowCount - before, 1, 'one notification, not two');
  assert.strictEqual(notices.rows[0].type, 'elementix_lead');
  assert.ok(/lead in your CRM/i.test(notices.rows[0].body));
  assert.ok(!/skip traced/i.test(notices.rows[0].body),
    'and it does not name a button this officer never pressed — they unlocked them in Elementix');
  ok('a contact unlocked today notifies its officer; the historical backlog imports silently');

  await db.query(`DELETE FROM notifications WHERE staff_id = $1::uuid`, [freshOfficer]);
  await wipe();

  // -------------------------------------------------------------------------
  console.log('\n10. One unworkable row can never stall the import');
  // -------------------------------------------------------------------------
  /* Rows are taken oldest-first and a row that THROWS is never stamped, so it
     comes back at the head of the very next batch, throws again, and the whole
     import stops behind it while the log says only "import pass failed" — with a
     thousand contacts queued behind it. The failure is made to happen at the
     database layer rather than at the vendor, because the vendor's own failure
     was always handled and this is the half that was not. */
  await wipe();
  await db.query(
    `INSERT INTO elementix_users (email, staff_id, linked_by, linked_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (email) DO UPDATE SET staff_id = EXCLUDED.staff_id`,
    [`poison.${sfx}@yscapgroup.test`, yosef, admin]);
  for (const pid of [P(1), P(2), P(3)]) {
    await db.query(
      `INSERT INTO elementix_backfill_queue (person_id, person_name, person_state, unlocked_by_email, unlocked_at, status)
       VALUES ($1,'QUEUED PERSON','NJ',$2,now(),'pending')
       ON CONFLICT (person_id) DO UPDATE SET status='pending', attempts=0,
             unlocked_by_email=EXCLUDED.unlocked_by_email`,
      [pid, `poison.${sfx}@yscapgroup.test`]);
  }
  const realStore = crm.storeContact;
  crm.storeContact = async (args) => {
    if (args.personId === P(2)) throw new Error('a column this row cannot satisfy');
    return realStore(args);
  };
  // Caught rather than awaited bare, so removing the guard fails a NAMED
  // assertion instead of taking the suite down — a crashing test also "fails",
  // and a crash is not proof of the thing being asserted.
  const poisoned = await backfill.workBatch({ staffId: admin, limit: 5 })
    .catch((e) => ({ threw: (e && e.message) || 'unknown' }));
  crm.storeContact = realStore;

  assert.ok(!poisoned.threw,
    `the batch must not throw out — a row that throws is never stamped and stalls every row behind it (threw: ${poisoned.threw})`);
  assert.strictEqual(poisoned.worked, 2, 'the two good rows were still worked');
  assert.strictEqual(poisoned.failed, 1, 'and the bad one is counted as a failure, not as a crash');
  const stamped = await db.query(
    `SELECT status, attempts, detail FROM elementix_backfill_queue WHERE person_id = $1`, [P(2)]);
  assert.strictEqual(stamped.rows[0].attempts, 1, 'the bad row was STAMPED, so it cannot sit at the head forever');
  assert.ok(/could not file this contact/i.test(stamped.rows[0].detail || ''),
    '…with the reason recorded, never a silent drop');
  const good = await db.query(
    `SELECT count(*)::int n FROM elementix_backfill_queue WHERE person_id = ANY($1) AND status <> 'pending'`,
    [[P(1), P(3)]]);
  assert.strictEqual(good.rows[0].n, 2, 'and the rows behind it went through');
  ok('a row PILOT cannot file is recorded and retired — it never stalls the thousand behind it');

  await db.query(`DELETE FROM elementix_users WHERE email = $1`, [`poison.${sfx}@yscapgroup.test`]);
  await wipe();

  // -------------------------------------------------------------------------
  console.log('\n11. A login is never auto-matched to somebody who has left');
  // -------------------------------------------------------------------------
  const gone = await mk(`Departed Officer ${sfx}`, `gone.${sfx}@yscapgroup.test`);
  await db.query(`UPDATE staff_users SET is_active = false WHERE id = $1`, [gone]);
  await db.query(
    `INSERT INTO elementix_users (email, unlock_count) VALUES ($1, 3)
     ON CONFLICT (email) DO UPDATE SET staff_id = NULL, linked_by = NULL, ignored = false`,
    [`gone.${sfx}@yscapgroup.test`]);
  await backfill.matchUsers();
  const g = await db.query(`SELECT staff_id FROM elementix_users WHERE email = $1`,
    [`gone.${sfx}@yscapgroup.test`]);
  assert.strictEqual(g.rows[0].staff_id, null,
    'a deactivated staffer would file every contact into a pipeline nobody reads');
  ok('an Elementix login whose email belongs to a deactivated staffer stays unmatched');

  await db.query(`DELETE FROM elementix_users WHERE email LIKE $1`, [`%.${sfx}@yscapgroup.test`]);
  await wipe();
  console.log(`\n${passed} checks passed.\n`);
}

main().then(() => db.pool.end()).catch(async (e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  process.exit(1);
});
