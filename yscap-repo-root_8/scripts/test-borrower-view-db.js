'use strict';
/**
 * BORROWER VIEW — the ACCESS-CONTROL + session-lifecycle proof (owner-directed
 * 2026-07-26). DB-gated (skips cleanly with no DATABASE_URL), in `npm test`.
 *
 * The pure test (test-borrower-view-pure.js) proves the token + blocklist. This
 * one proves the part a pure test structurally cannot: that the eligibility SQL
 * runs against the REAL schema and answers correctly —
 *
 *   • a loan officer may step into a borrower on THEIR file, and may NOT step
 *     into a borrower on someone else's file (the whole boundary the owner
 *     asked for: "all the loan officers have access only to his borrowers");
 *   • a co-borrower on my file counts as my borrower;
 *   • a full-access assistant (application_assignees) counts, matching every
 *     other staff gate;
 *   • a SOFT-DELETED file grants nothing;
 *   • `see_all_files` (admin) reaches any borrower;
 *   • the session register opens, heartbeats, closes, and never keeps two live
 *     sessions for one staffer;
 *   • the history view is self-scoped without `view_audit_log` and global with it.
 *
 * A wrong column name here would make the whole feature silently deny everyone
 * (or, far worse, silently allow everyone) — exactly the #248 class this repo
 * has been bitten by, which a mock-db test can never catch.
 *
 *   DATABASE_URL=postgres://… node scripts/test-borrower-view-db.js
 */
const R = require('path').resolve(__dirname, '..');
const bv = require(R + '/src/lib/borrower-view');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const actorFor = (id, role, perms) => ({ id, kind: 'staff', role, perms: new Set(perms || []) });

(async function dbPart() {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP borrower-view DB scope (no DATABASE_URL)'); return finish(); }
  const db = require(R + '/src/db');
  const rnd = (p) => `${p}${Math.random().toString(36).slice(2)}@bview.test`;

  // ---- two officers, one processor, one admin ----
  const mk = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,$2,$3) RETURNING id`,
    [rnd('s'), name, role])).rows[0].id;
  const loA = await mk('loan_officer', 'Officer A');
  const loB = await mk('loan_officer', 'Officer B');
  const proc = await mk('processor', 'Processor P');
  const admin = await mk('admin', 'Admin Z');

  // ---- borrowers ----
  const mkB = async (first, last) => (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,$2,$3) RETURNING id`,
    [first, last, rnd('b')])).rows[0].id;
  const bMine   = await mkB('Mine', 'Borrower');     // on officer A's file
  const bTheirs = await mkB('Theirs', 'Borrower');   // on officer B's file
  const bCo     = await mkB('Co', 'Borrower');       // co-borrower on officer A's file
  const bAssist = await mkB('Assist', 'Borrower');   // officer A is an assistant on their file
  const bGone   = await mkB('Deleted', 'Borrower');  // only on a soft-deleted file

  const mkApp = async (borrowerId, officerId, extra = {}) => (await db.query(
    `INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, processor_id, deleted_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [borrowerId, extra.coBorrowerId || null, officerId, extra.processorId || null, extra.deletedAt || null])).rows[0].id;

  const appA      = await mkApp(bMine, loA, { coBorrowerId: bCo, processorId: proc });
  const appB      = await mkApp(bTheirs, loB);
  const appAssist = await mkApp(bAssist, loB);
  const appGone   = await mkApp(bGone, loA, { deletedAt: new Date() });
  await db.query(
    `INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'loan_officer')
     ON CONFLICT DO NOTHING`, [appAssist, loA]);

  const officerA = actorFor(loA, 'loan_officer', ['review_conditions']);
  const officerB = actorFor(loB, 'loan_officer', ['review_conditions']);
  const processorP = actorFor(proc, 'processor', ['sign_off_conditions']);
  const adminZ = actorFor(admin, 'admin', ['see_all_files']);

  // ---- the boundary ----
  ok(!!(await bv.resolveViewable(officerA, bMine)), 'officer reaches the borrower on their own file');
  ok(!!(await bv.resolveViewable(officerA, bCo)), 'a CO-borrower on my file is my borrower');
  ok(!!(await bv.resolveViewable(officerA, bAssist)), 'a full-access assistant reaches that file’s borrower');
  ok((await bv.resolveViewable(officerA, bTheirs)) === null,
    "an officer can NOT step into another officer's borrower");
  ok((await bv.resolveViewable(officerB, bMine)) === null, 'the boundary holds in both directions');
  ok((await bv.resolveViewable(officerA, bGone)) === null,
    'a soft-deleted file grants no borrower view (mirrors every other staff gate)');
  ok(!!(await bv.resolveViewable(processorP, bMine)), 'the processor on the file reaches its borrower');
  ok((await bv.resolveViewable(processorP, bTheirs)) === null, 'a processor is scoped to files they process');
  // see_all_files reaches everyone — including the borrower whose only file is
  // deleted (they are still a real borrower in the system to an admin).
  ok(!!(await bv.resolveViewable(adminZ, bTheirs)), 'an admin (see_all_files) reaches any borrower');
  ok(!!(await bv.resolveViewable(adminZ, bGone)), 'an admin is not restricted by the file scope');

  // Garbage / missing inputs never throw and never grant.
  ok((await bv.resolveViewable(officerA, null)) === null, 'no borrower id → no access');
  ok((await bv.resolveViewable({ id: loA, kind: 'borrower' }, bMine)) === null, 'a borrower actor is never eligible');

  // ---- has_login is reported, not assumed ----
  const noLogin = await bv.resolveViewable(officerA, bMine);
  ok(noLogin.has_login === false, 'a borrower with no login row is flagged (the UI offers an invite instead)');
  await db.query(
    `INSERT INTO borrower_auth (borrower_id, password_hash, token_version) VALUES ($1,'x',4)
     ON CONFLICT (borrower_id) DO UPDATE SET token_version=4`, [bMine]);
  const withLogin = await bv.resolveViewable(officerA, bMine);
  ok(withLogin.has_login === true, 'a borrower with a login is viewable');
  ok(Number(withLogin.token_version) === 4, 'the CURRENT borrower token_version is read (the token binds to it)');

  // ---- the picker list ----
  const listA = await bv.listEligible(officerA, {});
  const idsA = listA.map((r) => r.id);
  ok(idsA.includes(bMine) && idsA.includes(bCo) && idsA.includes(bAssist), 'the picker lists my borrowers');
  ok(!idsA.includes(bTheirs), 'the picker never lists another officer’s borrower');
  ok(!idsA.includes(bGone), 'the picker never lists a borrower whose only file is deleted');
  const searched = await bv.listEligible(officerA, { q: 'Mine' });
  ok(searched.some((r) => r.id === bMine), 'search finds a borrower by name');
  ok(!searched.some((r) => r.id === bAssist), 'search actually filters');
  // A search term must not widen the scope (a classic injection-shaped mistake).
  const searchB = await bv.listEligible(officerA, { q: 'Theirs' });
  ok(!searchB.some((r) => r.id === bTheirs), 'search can never reach outside the scope');
  const listAdmin = await bv.listEligible(adminZ, {});
  ok(listAdmin.some((r) => r.id === bTheirs), 'an admin’s picker spans everyone');

  // ---- session lifecycle ----
  const s1 = await bv.startSession({ actor: officerA, borrower: withLogin, applicationId: appA, ip: '10.0.0.1', userAgent: 'test' });
  ok(s1 && s1.token && s1.sessionId, 'starting a view opens a session and mints a token');
  const C = require(R + '/src/lib/crypto');
  const claims = C.verifyJwt(s1.token);
  ok(claims.sub === bMine && claims.impBy === loA, 'the minted token binds borrower ↔ staffer');
  ok(claims.tv === 4, 'the token carries the borrower’s live token_version');
  ok(s1.expiresAt - s1.startedAt * 1000 === bv.MAX_SESSION_SEC * 1000, 'the session advertises its absolute cap');

  const row1 = (await db.query('SELECT * FROM borrower_view_sessions WHERE id=$1', [s1.sessionId])).rows[0];
  ok(row1 && row1.staff_id === loA && row1.borrower_id === bMine, 'the register records who looked at whom');
  ok(row1.application_id === appA, 'the register records the file they entered from');
  ok(row1.ended_at === null && row1.request_count === 0, 'a fresh session is open with no traffic yet');

  await bv.touchSession(s1.sessionId);
  await bv.touchSession(s1.sessionId);
  const touched = (await db.query('SELECT request_count FROM borrower_view_sessions WHERE id=$1', [s1.sessionId])).rows[0];
  ok(touched.request_count === 2, 'each request inside the view is counted');

  // Opening a second view supersedes the first — one live view per staffer.
  const s2 = await bv.startSession({ actor: officerA, borrower: withLogin, applicationId: null });
  const prior = (await db.query('SELECT ended_at, end_reason FROM borrower_view_sessions WHERE id=$1', [s1.sessionId])).rows[0];
  ok(prior.ended_at !== null && prior.end_reason === 'superseded', 'starting a new view closes the previous one');
  const openCount = (await db.query(
    'SELECT count(*)::int AS n FROM borrower_view_sessions WHERE staff_id=$1 AND ended_at IS NULL', [loA])).rows[0].n;
  ok(openCount === 1, 'a staffer never has two live borrower views');

  await bv.endSession(s2.sessionId, 'exit');
  const ended = (await db.query('SELECT ended_at, end_reason FROM borrower_view_sessions WHERE id=$1', [s2.sessionId])).rows[0];
  ok(ended.ended_at !== null && ended.end_reason === 'exit', 'leaving the view closes the session');
  // Closing twice must not rewrite the original reason.
  await bv.endSession(s2.sessionId, 'expired');
  const stillExit = (await db.query('SELECT end_reason FROM borrower_view_sessions WHERE id=$1', [s2.sessionId])).rows[0];
  ok(stillExit.end_reason === 'exit', 'a closed session is never re-closed with a different reason');
  // A touch on a closed session is a no-op, not an error.
  await bv.touchSession(s2.sessionId);
  ok(true, 'heartbeating a closed session is harmless');

  // ---- the register view ----
  const mine = await bv.history(officerA, { limit: 50 });
  ok(mine.length >= 2 && mine.every((h) => h.staff_id === loA), 'without view_audit_log a staffer sees only their own views');
  const auditor = actorFor(admin, 'admin', ['see_all_files', 'view_audit_log']);
  await bv.startSession({ actor: auditor, borrower: withLogin });
  const all = await bv.history(auditor, { limit: 50 });
  ok(all.some((h) => h.staff_id === loA) && all.some((h) => h.staff_id === admin),
    'view_audit_log widens the register to the whole team');

  // ---- the audit stamp columns really exist (db/318) ----
  const cols = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name IN ('audit_log','request_audit_log') AND column_name LIKE 'impersonator%'`);
  const names = cols.rows.map((r) => r.column_name);
  ok(names.filter((c) => c === 'impersonator_staff_id').length === 2,
    'both audit trails carry impersonator_staff_id');
  ok(names.includes('impersonator_role'), 'the request firehose carries the impersonator role');
  // And a row can actually be written with it (a column that exists but rejects
  // the insert would still break every audited action inside a borrower view).
  await db.query(
    `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,impersonator_staff_id)
     VALUES ('borrower',$1,'borrower_view_test','borrower',$1,$2)`, [bMine, loA]);
  const stamped = (await db.query(
    `SELECT impersonator_staff_id FROM audit_log WHERE action='borrower_view_test' AND actor_id=$1`, [bMine])).rows[0];
  ok(stamped && stamped.impersonator_staff_id === loA,
    'an action taken inside a borrower view is attributable to the real staffer');

  // ---- cleanup (leave the test database as we found it) ----
  await db.query('DELETE FROM audit_log WHERE action=$1', ['borrower_view_test']);
  await db.query('DELETE FROM borrower_view_sessions WHERE staff_id = ANY($1::uuid[])', [[loA, loB, proc, admin]]);
  await db.query('DELETE FROM application_assignees WHERE application_id = ANY($1::uuid[])', [[appA, appB, appAssist, appGone]]);
  await db.query('DELETE FROM applications WHERE id = ANY($1::uuid[])', [[appA, appB, appAssist, appGone]]);
  await db.query('DELETE FROM borrower_auth WHERE borrower_id = ANY($1::uuid[])', [[bMine, bTheirs, bCo, bAssist, bGone]]);
  await db.query('DELETE FROM borrowers WHERE id = ANY($1::uuid[])', [[bMine, bTheirs, bCo, bAssist, bGone]]);
  await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [[loA, loB, proc, admin]]);

  finish();
})().catch((e) => { console.error(e); fail++; finish(); });

function finish() {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
