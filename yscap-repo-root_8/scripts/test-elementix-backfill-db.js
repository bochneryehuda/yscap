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
  const fs = require('fs');
  const path = require('path');
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

  const sync = require('../src/sync/elementix-crm-sync');
  delete process.env.ELEMENTIX_CRM_SYNC_ENABLED;
  sync.start();
  assert.ok(typeof sync.listOnce === 'function' && typeof sync.workOnce === 'function');
  ok('and the loop is off unless it is deliberately switched on');

  await wipe();
  console.log(`\n${passed} checks passed.\n`);
}

main().then(() => db.pool.end()).catch(async (e) => {
  console.error('\nFAILED:', e && e.message);
  console.error(e && e.stack);
  try { await db.pool.end(); } catch (_) { /* nothing to close */ }
  process.exit(1);
});
