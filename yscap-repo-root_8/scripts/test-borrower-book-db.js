/**
 * "SHOW ME EVERY BORROWER I EVER CLOSED WITH" — the officer's book (owner-reported
 * 2026-07-26, follow-up to the borrower-profile work).
 *
 * The complaint: a loan officer's borrower list still missed the people he had
 * CLOSED with on DSCR deals. Two distinct root causes, both covered here:
 *
 *   1. COVERAGE. The only pass that reads a ClickUp card regardless of when it
 *      last changed was the env-gated one-shot `runBackfill`; the live reconcile
 *      is windowed on `date_updated`, so a deal that closed months ago is never
 *      read again. `src/sync/profile-sweep.js` is the missing loop — every card,
 *      every status, no date window, resumable, and it NEVER creates a loan file.
 *   2. OWNERSHIP. `borrowers.primary_officer_id` is single-valued and fill-only,
 *      so the FIRST officer to touch a person owned them and every other officer
 *      they closed with stayed locked out. `borrower_officers` (db/325) makes the
 *      relationship many-to-many, and it is what the staff borrower scope reads.
 *
 * Asserted against a REAL database and the REAL ingest path (a synthetic ClickUp
 * task shaped exactly like the live payloads), because the whole bug class here
 * is "the query/column was wrong and the swallowing catch hid it".
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0, passes = 0;
const assert = (c, m) => { if (c) { passes++; } else { failures++; console.log(`FAIL ${m}`); } };

// ---- pure: the sweep's contract, without touching ClickUp or the DB ---------
{
  const sweep = require('../src/sync/profile-sweep');
  assert(typeof sweep.sweepOnce === 'function' && typeof sweep.status === 'function'
    && typeof sweep.restart === 'function' && typeof sweep.recountDeals === 'function',
    'the profile sweep exposes run / status / restart / recount');
  const cur = sweep._internals.freshCursor(['space:1'], 3);
  assert(cur.cycle === 3 && cur.folderIdx === 0 && cur.page === 0 && cur.finishedAt === null,
    'a fresh cycle starts at the first scope, first page, unfinished');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'sync', 'profile-sweep.js'), 'utf8');
  assert(/createFile:\s*false/.test(src) && !/createFile:\s*true/.test(src),
    'the sweep can NEVER create a loan file — it gathers people, not deals');
  assert(/includeClosed:\s*true/.test(src),
    'it includes CLOSED cards — that is the whole point (past deals were invisible)');
  assert(!/dateUpdatedGt/.test(src),
    'it uses NO date window — an old closed deal never changes, so a window hides it forever');
  // The staff borrower scope must consult the many-to-many table.
  const staff = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'routes', 'staff.js'), 'utf8');
  assert(/VISIBLE_BORROWER_SQL[\s\S]{0,600}borrower_officers/.test(staff),
    'the borrower scope reads borrower_officers, not only the single primary officer');
}

console.log(`test-borrower-book: PURE ${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
if (!process.env.DATABASE_URL) { console.log('  (SKIP DB — no DATABASE_URL)'); process.exit(0); }

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const cfg = require('../src/config');
const F = require('../src/clickup/fields');
const ingest = require('../src/clickup/ingest');
const app = require('../src/server');

function call(server, method, path, token) {
  return new Promise((resolve, reject) => {
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); r.end();
  });
}

/** A ClickUp task shaped like the real thing: a CLOSED DSCR deal. */
function dscrCard({ id, folderId, officerEmail, name, email, phone, ssn, dobMs, llc, ein, addr, status }) {
  const cf = (fid, value) => ({ id: fid, value });
  return {
    id, name: `${name} - ${addr}`,
    status: { status, type: 'done' },
    folder: { id: folderId, name: 'Test Officer Files' },
    list: { id: `${folderId}-list` }, space: { id: cfg.clickupPipelineSpace },
    date_created: String(Date.now() - 86400000),
    custom_fields: [
      cf(F.SHARED.borrowerName, name),
      cf(F.SHARED.borrowerEmail, email),
      cf(F.SHARED.borrowerCell, phone),
      cf(F.SHARED.borrowerSSN, ssn),
      cf(F.SHARED.borrowerDOB, String(dobMs)),
      cf(F.SHARED.loanOfficerEmail, officerEmail),
      cf(F.SHARED.borrowerAddress, { location: { lat: 40.7, lng: -73.95 }, formatted_address: '144 Hewes St, Brooklyn, NY 11211, USA' }),
      cf(F.PIPELINE.subjectAddress, { location: { lat: 41.4, lng: -75.68 }, formatted_address: addr }),
      cf(F.PIPELINE.llcName, llc),
      cf(F.PIPELINE.ein, ein),
      // *Program orderindex 2 = "Non-QM - DSCR Ratio" → NOT an RTL program.
      { id: F.PIPELINE.program, value: 2, type_config: { options: [
        { orderindex: 0, name: 'Fix & Flip With Construction' }, { orderindex: 1, name: 'Ground-Up' },
        { orderindex: 2, name: 'Non-QM - DSCR Ratio' }] } },
    ],
  };
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const digits = String(Math.floor(100000000 + Math.random() * 899999999));
  let dbPass = 0, dbFail = 0;
  const ok = (c, m) => { if (c) { dbPass++; } else { dbFail++; console.log(`FAIL ${m}`); } };
  const folderId = `9911${Math.floor(Math.random() * 100000)}`;
  try {
    const officerEmail = `book-lo-${sfx}@test.local`;
    const loId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Book Officer','loan_officer',true,false,'x',0) RETURNING id`, [officerEmail])).rows[0].id;
    const otherId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Other Officer','loan_officer',true,false,'x',0) RETURNING id`, [`book-lo2-${sfx}@test.local`])).rows[0].id;
    const loToken = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const otherToken = C.signJwt({ sub: otherId, kind: 'staff', role: 'loan_officer', tv: 0 });

    const borrowerEmail = `book-bo-${sfx}@test.local`;
    const card = dscrCard({
      id: `book-task-${sfx}`, folderId, officerEmail,
      name: 'Pinches Goldstein', email: borrowerEmail, phone: '+18458250374',
      ssn: digits, dobMs: 969004800000, llc: `53 Sobieski LLC ${sfx}`, ein: '39-3443413',
      addr: '115 N Fulton St, Wilkes-Barre, PA 18702, USA',
      status: 'closed reconciled',              // a CLOSED deal — the missing history
    });

    // The sweep's exact call: profile-only, never a file.
    const out = await ingest.ingestTask(card, {}, { createFile: false, folderId });
    ok(!!out.borrowerId, 'a closed DSCR card builds a borrower profile');
    // `isRtl` is falsy-null (an unrecognized program crosswalks to null), not the
    // boolean false — every consumer guards with `if (isRtl && …)`, so falsy is the
    // contract that matters.
    ok(!out.isRtl, 'and it is correctly NOT treated as an RTL file');
    ok(out.applicationId == null, 'no loan file is created — the owner asked for people, not deals');

    const b = (await db.query(
      `SELECT first_name,last_name,email,cell_phone,date_of_birth,ssn_last4,current_address,
              (ssn_encrypted IS NOT NULL) AS has_ssn, primary_officer_id
         FROM borrowers WHERE id=$1`, [out.borrowerId])).rows[0];
    ok(b.first_name === 'Pinches' && b.last_name === 'Goldstein', 'their NAME is captured');
    ok(String(b.email).toLowerCase() === borrowerEmail.toLowerCase(), 'their EMAIL is captured');
    ok(!!b.cell_phone, 'their PHONE NUMBER is captured');
    ok(b.has_ssn && b.ssn_last4 === digits.slice(-4), 'their SOCIAL is captured (stored encrypted)');
    ok(String(b.date_of_birth).startsWith('2000-') || !!b.date_of_birth, 'their DATE OF BIRTH is captured');
    ok(b.current_address && /Hewes/.test(JSON.stringify(b.current_address)), 'their HOME ADDRESS is captured');
    ok(String(b.primary_officer_id) === String(loId), 'the profile is owned by the officer on the card');

    const llcs = (await db.query(`SELECT llc_name, ein FROM llcs WHERE borrower_id=$1`, [out.borrowerId])).rows;
    ok(llcs.length === 1 && /Sobieski/.test(llcs[0].llc_name), 'their ENTITY (LLC) is captured from the card');
    ok(llcs[0].ein === '39-3443413', 'with its EIN');

    const tr = (await db.query(
      `SELECT property_address FROM track_records WHERE borrower_id=$1`, [out.borrowerId])).rows;
    ok(tr.length === 1 && /Fulton/.test(JSON.stringify(tr[0].property_address)),
      'the CLOSED deal\'s property lands in their TRACK RECORD addresses');

    const rel = (await db.query(
      `SELECT staff_id, source, first_task_id FROM borrower_officers WHERE borrower_id=$1`, [out.borrowerId])).rows;
    ok(rel.length === 1 && String(rel[0].staff_id) === String(loId) && rel[0].source === 'clickup',
      'the borrower↔officer relationship is recorded from the card');

    // THE REPORTED SYMPTOM: the officer must now see them in his book.
    const book = await call(server, 'GET', '/api/staff/borrowers', loToken);
    const mine = (book.body || []).find((x) => String(x.id) === String(out.borrowerId));
    ok(!!mine, 'the officer SEES a borrower he only ever closed a DSCR deal with');
    ok(mine && mine.files === 0 && mine.other_deals === 1,
      'shown with their real history (0 loan files, 1 other deal) instead of looking empty');
    const prof = await call(server, 'GET', `/api/staff/borrowers/${out.borrowerId}`, loToken);
    ok(prof.status === 200 && prof.body.ssn_last4 === digits.slice(-4),
      'and he can open the full profile');
    ok((prof.body.otherDeals || []).length === 1, 'the profile lists the ClickUp deal behind it');

    // A DIFFERENT officer must NOT see them (the scope still scopes).
    const notMine = await call(server, 'GET', '/api/staff/borrowers', otherToken);
    ok(!(notMine.body || []).some((x) => String(x.id) === String(out.borrowerId)),
      'an unrelated officer still cannot see them — the widened scope is not a free-for-all');
    ok((await call(server, 'GET', `/api/staff/borrowers/${out.borrowerId}`, otherToken)).status === 403,
      'and cannot open the profile');

    // A SECOND officer closes with the SAME person — the relationship is many-to-many.
    const card2 = dscrCard({
      id: `book-task2-${sfx}`, folderId: `${folderId}9`, officerEmail: `book-lo2-${sfx}@test.local`,
      name: 'Pinches Goldstein', email: borrowerEmail, phone: '+18458250374',
      ssn: digits, dobMs: 969004800000, llc: `Second Entity LLC ${sfx}`, ein: '11-2223334',
      addr: '9 Second St, Scranton, PA 18504, USA', status: 'closed reconciled',
    });
    const out2 = await ingest.ingestTask(card2, {}, { createFile: false, folderId: `${folderId}9` });
    ok(String(out2.borrowerId) === String(out.borrowerId),
      'the second officer\'s card resolves to the SAME person (matched on their social)');
    const both = await call(server, 'GET', '/api/staff/borrowers', otherToken);
    ok((both.body || []).some((x) => String(x.id) === String(out.borrowerId)),
      'NOW the second officer sees them too — a borrower belongs to everyone they closed with');
    ok(String((await db.query(`SELECT primary_officer_id FROM borrowers WHERE id=$1`, [out.borrowerId])).rows[0].primary_officer_id) === String(loId),
      'while the FIRST officer stays the primary/CRM owner (never stolen)');
    ok((await db.query(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1`, [out.borrowerId])).rows[0].n === 2,
      'every entity they used across all their deals accumulates on the profile');
    ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [out.borrowerId])).rows[0].n === 2,
      'and every address they used accumulates in the track record');

    // Re-reading the same cards must not duplicate anything (the sweep cycles).
    await ingest.ingestTask(card, {}, { createFile: false, folderId });
    await ingest.ingestTask(card2, {}, { createFile: false, folderId: `${folderId}9` });
    ok((await db.query(`SELECT count(*)::int n FROM borrowers WHERE email=$1`, [borrowerEmail])).rows[0].n === 1,
      're-sweeping the same cards never mints a duplicate profile');
    ok((await db.query(`SELECT count(*)::int n FROM llcs WHERE borrower_id=$1`, [out.borrowerId])).rows[0].n === 2,
      'nor duplicate entities');
    ok((await db.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [out.borrowerId])).rows[0].n === 2,
      'nor duplicate track-record lines');
    ok((await db.query(`SELECT count(*)::int n FROM borrower_officers WHERE borrower_id=$1`, [out.borrowerId])).rows[0].n === 2,
      'and exactly the two officer relationships remain');

    // ── A RENAMED CARD RENAMES THE PERSON (owner-reported: "Avi" → "Abraham") ──
    // The file was opened under a nickname, which created the profile under that
    // nickname; the card was then corrected and the profile never followed.
    const nickEmail = `book-nick-${sfx}@test.local`;
    const nickSsn = String(Math.floor(100000000 + Math.random() * 899999999));
    const mkNick = (first, last, taskId) => dscrCard({
      id: taskId, folderId, officerEmail, name: `${first} ${last}`, email: nickEmail,
      phone: '+17185550101', ssn: nickSsn, dobMs: 969004800000,
      llc: `Nick Holdings LLC ${sfx}`, ein: '22-3334445',
      addr: '10 Nickname Rd, Monsey, NY 10952, USA', status: 'self procesing',
    });
    const nickTask = `book-nick-task-${sfx}`;
    const n1 = await ingest.ingestTask(mkNick('Avi', 'Klein', nickTask), {}, { createFile: false, folderId });
    ok((await db.query(`SELECT first_name FROM borrowers WHERE id=$1`, [n1.borrowerId])).rows[0].first_name === 'Avi',
      'a file opened under a NICKNAME creates the profile under that nickname');
    // The SAME card, renamed at the source to the real first name.
    await ingest.ingestTask(mkNick('Abraham', 'Klein', nickTask), {}, { createFile: false, folderId });
    const renamed = (await db.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [n1.borrowerId])).rows[0];
    ok(renamed.first_name === 'Abraham' && renamed.last_name === 'Klein',
      'renaming the ClickUp card to the REAL name now updates the profile (the reported bug)');
    ok((await db.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='clickup_name_edited_at_source' AND entity_id=$1`,
      [n1.borrowerId])).rows[0].n === 1, 'and the rename is audited, not silent');
    ok((await db.query(
      `SELECT count(*)::int n FROM sync_review_queue WHERE task_id=$1 AND field_key='first_name' AND status='open'`,
      [nickTask])).rows[0].n === 0, 'a plain nickname correction needs no human review');

    // A WHOLE-name change might be a different human — never guessed.
    await ingest.ingestTask(mkNick('Yosef', 'Stern', nickTask), {}, { createFile: false, folderId });
    const untouched = (await db.query(`SELECT first_name, last_name FROM borrowers WHERE id=$1`, [n1.borrowerId])).rows[0];
    ok(untouched.first_name === 'Abraham' && untouched.last_name === 'Klein',
      'a change of BOTH names never silently renames the person');
    ok((await db.query(
      `SELECT count(*)::int n FROM sync_review_queue WHERE task_id=$1 AND field_key='first_name' AND status='open'`,
      [nickTask])).rows[0].n === 1, 'it queues a review instead, for a human to decide');

    // Re-reading an UNCHANGED card must not churn.
    await ingest.ingestTask(mkNick('Yosef', 'Stern', nickTask), {}, { createFile: false, folderId });
    ok((await db.query(
      `SELECT count(*)::int n FROM sync_review_queue WHERE task_id=$1 AND field_key='first_name' AND status='open'`,
      [nickTask])).rows[0].n === 1, 're-syncing the same card does not pile up duplicate review cards');

    // The closed-deal count is RECOMPUTED (never incremented per re-sync).
    await require('../src/sync/profile-sweep').recountDeals();
    const deals = (await db.query(
      `SELECT staff_id, deals FROM borrower_officers WHERE borrower_id=$1 ORDER BY deals DESC`, [out.borrowerId])).rows;
    ok(deals.every((d) => d.deals === 1),
      'each officer is credited with exactly ONE closed deal, however many times we re-read the card');
  } catch (e) {
    dbFail++; console.log('FAIL threw:', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e);
  } finally {
    await db.query(`DELETE FROM track_records WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [`book-bo-${sfx}%`]).catch(() => {});
    await db.query(`DELETE FROM clickup_task_index WHERE task_id LIKE $1`, [`book-task%${sfx}`]).catch(() => {});
    await db.query(`DELETE FROM track_records WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [`book-nick-${sfx}%`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`book-bo-${sfx}%`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`book-nick-${sfx}%`]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`book-lo%-${sfx}@test.local`]).catch(() => {});
    server.close();
    console.log(`test-borrower-book: DB ${dbPass} passed, ${dbFail} failed`);
    process.exit(dbFail ? 1 : 0);
  }
})();
