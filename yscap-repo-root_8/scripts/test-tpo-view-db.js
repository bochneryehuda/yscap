'use strict';
/**
 * TPO VIEW — the ACCESS-CONTROL + session-lifecycle proof (owner-directed
 * 2026-08-04; TPO blueprint decision 6). DB-gated (skips cleanly with no
 * DATABASE_URL), in `npm test`.
 *
 * The pure test proves the token + blocklist. This one proves the part a pure
 * test structurally cannot: that the eligibility SQL runs against the REAL
 * schema and answers correctly —
 *
 *   • an AE/AM on a firm's file may step into ANY broker of THAT firm (the
 *     firm-level scope the owner asked for), and may NOT step into a broker at
 *     another firm;
 *   • a staffer with no relationship to the firm reaches no broker;
 *   • a broker at a SUSPENDED firm, or an INACTIVE broker, is never viewable;
 *   • `see_all_files` (admin) reaches any active broker at any active firm;
 *   • the impersonator MUST be internal (an external user can never start a
 *     view), and the session register opens / heartbeats / supersedes / closes;
 *   • the history view is self-scoped without `view_audit_log`, global with it;
 *   • the firm-isolation invariant holds end to end (a tpo-view only ever binds
 *     a broker to a firm the staffer can already reach).
 *
 *   DATABASE_URL=postgres://… node scripts/test-tpo-view-db.js
 */
const R = require('path').resolve(__dirname, '..');
const tv = require(R + '/src/lib/tpo-view');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const actorFor = (id, role, perms) => ({ id, kind: 'staff', role, perms: new Set(perms || []) });

(async function dbPart() {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP tpo-view DB scope (no DATABASE_URL)'); return finish(); }
  const db = require(R + '/src/db');
  const rnd = (p) => `${p}${Math.random().toString(36).slice(2)}@tpoview.test`;

  // ---- firms ----
  const mkFirm = async (name, status) => (await db.query(
    `INSERT INTO tpo_firms (name, status) VALUES ($1,$2) RETURNING id`, [name, status])).rows[0].id;
  const firmA = await mkFirm('Firm A', 'active');
  const firmB = await mkFirm('Firm B', 'active');
  const firmSusp = await mkFirm('Firm Suspended', 'suspended');

  // ---- internal staffers ----
  const mkStaff = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,$2,$3) RETURNING id`,
    [rnd('s'), name, role])).rows[0].id;
  const aeA    = await mkStaff('loan_officer', 'AE Alice');    // account_executive on firm A's file
  const other  = await mkStaff('loan_officer', 'Bob Nobody');  // no firm relationship
  const admin  = await mkStaff('admin', 'Admin Zoe');

  // ---- external brokers ----
  const mkBroker = async (firmId, role, name, { login = true, active = true, firmAdmin = false } = {}) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, is_external, tpo_firm_id, is_firm_admin, is_active, password_hash, token_version)
     VALUES ($1,$2,$3,true,$4,$5,$6,$7,9) RETURNING id`,
    [rnd('t'), name, role, firmId, firmAdmin, active, login ? 'x' : null])).rows[0].id;
  const brokerA1 = await mkBroker(firmA, 'tpo_officer', 'Broker A1', { firmAdmin: true });
  const brokerA2 = await mkBroker(firmA, 'tpo_processor', 'Broker A2');
  const brokerB1 = await mkBroker(firmB, 'tpo_officer', 'Broker B1');
  const brokerNoLogin  = await mkBroker(firmA, 'tpo_officer', 'Broker NoLogin', { login: false });
  const brokerInactive = await mkBroker(firmA, 'tpo_officer', 'Broker Inactive', { active: false });
  const brokerSusp     = await mkBroker(firmSusp, 'tpo_officer', 'Broker Susp');

  // ---- TPO files (the broker is the loan officer; the AE is an assignee) ----
  // The tpo-view scope is firm-based (is_tpo / tpo_firm_id / the AE assignee), not
  // borrower-based, so one throwaway borrower for the files is enough.
  const bId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('T','V',$1) RETURNING id`, [rnd('b')])).rows[0].id;
  const mkApp = async (firmId, brokerId) => (await db.query(
    `INSERT INTO applications (is_tpo, tpo_firm_id, loan_officer_id, borrower_id) VALUES (true,$1,$2,$3) RETURNING id`,
    [firmId, brokerId, bId])).rows[0].id;
  const appA = await mkApp(firmA, brokerA1);
  const appB = await mkApp(firmB, brokerB1);
  await db.query(
    `INSERT INTO application_assignees (application_id, staff_id, role) VALUES ($1,$2,'account_executive')
     ON CONFLICT DO NOTHING`, [appA, aeA]);

  const aeActor    = actorFor(aeA, 'loan_officer', ['review_conditions']);
  const otherActor = actorFor(other, 'loan_officer', ['review_conditions']);
  const adminActor = actorFor(admin, 'admin', ['see_all_files']);

  // ---- the boundary ----
  ok(!!(await tv.resolveViewable(aeActor, brokerA1)), 'the AE reaches the broker on their own firm file');
  ok(!!(await tv.resolveViewable(aeActor, brokerA2)),
    'the AE reaches ANY broker of a firm they handle (firm-level scope, not just the file broker)');
  ok((await tv.resolveViewable(aeActor, brokerB1)) === null,
    'the AE can NOT step into a broker at a firm they do not handle');
  ok((await tv.resolveViewable(otherActor, brokerA1)) === null,
    'a staffer with no relationship to the firm reaches no broker');
  ok((await tv.resolveViewable(aeActor, brokerSusp)) === null,
    'a broker at a SUSPENDED firm is never viewable (even in scope)');
  ok((await tv.resolveViewable(aeActor, brokerInactive)) === null,
    'an inactive broker is never viewable');
  // see_all_files reaches any active broker at any active firm — but still never a
  // suspended firm's broker (the firm gate is independent of the file scope).
  ok(!!(await tv.resolveViewable(adminActor, brokerA1)), 'an admin (see_all_files) reaches any broker');
  ok(!!(await tv.resolveViewable(adminActor, brokerB1)), 'an admin is not restricted by the file scope');
  ok((await tv.resolveViewable(adminActor, brokerSusp)) === null,
    'even an admin cannot view a suspended firm’s broker');
  ok((await tv.resolveViewable(adminActor, brokerInactive)) === null, 'even an admin cannot view an inactive broker');

  // Garbage / wrong-kind inputs never throw and never grant.
  ok((await tv.resolveViewable(aeActor, null)) === null, 'no broker id → no access');
  ok((await tv.resolveViewable({ id: aeA, kind: 'tpo' }, brokerA1)) === null, 'a tpo actor is never eligible to impersonate');
  ok((await tv.resolveViewable({ id: aeA, kind: 'borrower' }, brokerA1)) === null, 'a borrower actor is never eligible');

  // ---- has_login is reported, not assumed ----
  const withLogin = await tv.resolveViewable(aeActor, brokerA1);
  ok(withLogin.has_login === true, 'a broker with a login is viewable');
  ok(Number(withLogin.token_version) === 9, 'the CURRENT broker token_version is read (the token binds to it)');
  ok(String(withLogin.tpo_firm_id) === String(firmA), 'the broker’s firm rides on the row');
  const noLogin = await tv.resolveViewable(aeActor, brokerNoLogin);
  ok(noLogin && noLogin.has_login === false, 'a broker with no login is in scope but flagged (the door offers no view)');

  // ---- the picker list ----
  const listAE = await tv.listEligible(aeActor, {});
  const idsAE = listAE.map((r) => r.id);
  ok(idsAE.includes(brokerA1) && idsAE.includes(brokerA2), 'the picker lists the brokers of a firm I handle');
  ok(!idsAE.includes(brokerB1), 'the picker never lists a broker at a firm I do not handle');
  ok(!idsAE.includes(brokerSusp), 'the picker never lists a suspended firm’s broker');
  ok(!idsAE.includes(brokerInactive), 'the picker never lists an inactive broker');
  const searched = await tv.listEligible(aeActor, { q: 'Broker A2' });
  ok(searched.some((r) => r.id === brokerA2), 'search finds a broker by name');
  ok(!searched.some((r) => r.id === brokerA1), 'search actually filters');
  const searchFirm = await tv.listEligible(aeActor, { q: 'Firm A' });
  ok(searchFirm.some((r) => r.id === brokerA1), 'search finds brokers by FIRM name too');
  // A search term must not widen the scope.
  const searchB = await tv.listEligible(aeActor, { q: 'Broker B1' });
  ok(!searchB.some((r) => r.id === brokerB1), 'search can never reach outside the scope');
  const listAdmin = await tv.listEligible(adminActor, {});
  ok(listAdmin.some((r) => r.id === brokerA1) && listAdmin.some((r) => r.id === brokerB1),
    'an admin’s picker spans every firm');

  // ---- the impersonator must be internal ----
  const externalActor = { id: brokerA1, kind: 'staff', role: 'tpo_officer', perms: new Set() };
  const refusedExternal = await tv.startSession({ actor: externalActor, broker: withLogin });
  ok(refusedExternal === null, 'an EXTERNAL user can never start a broker view (the impersonator is internal-only)');

  // ---- session lifecycle ----
  const s1 = await tv.startSession({ actor: aeActor, broker: withLogin, applicationId: appA, ip: '10.0.0.1', userAgent: 'test' });
  ok(s1 && s1.token && s1.sessionId, 'starting a view opens a session and mints a token');
  const C = require(R + '/src/lib/crypto');
  const claims = C.verifyJwt(s1.token);
  ok(claims.sub === brokerA1 && claims.kind === 'tpo' && claims.impBy === aeA, 'the minted token binds broker ↔ staffer, kind tpo');
  ok(claims.tv === 9, 'the token carries the broker’s live token_version');
  ok(claims.role === 'tpo_officer', 'the token carries the broker’s role');
  ok(s1.expiresAt - s1.startedAt * 1000 === tv.MAX_SESSION_SEC * 1000, 'the session advertises its absolute cap');

  const row1 = (await db.query('SELECT * FROM tpo_view_sessions WHERE id=$1', [s1.sessionId])).rows[0];
  ok(row1 && row1.staff_id === aeA && row1.tpo_user_id === brokerA1, 'the register records who looked at whom');
  ok(String(row1.tpo_firm_id) === String(firmA), 'the register records the broker’s firm');
  ok(row1.application_id === appA, 'the register records the file they entered from');
  ok(row1.ended_at === null && row1.request_count === 0, 'a fresh session is open with no traffic yet');

  await tv.touchSession(s1.sessionId);
  await tv.touchSession(s1.sessionId);
  const touched = (await db.query('SELECT request_count FROM tpo_view_sessions WHERE id=$1', [s1.sessionId])).rows[0];
  ok(touched.request_count === 2, 'each request inside the view is counted');

  // Opening a second view supersedes the first — one live view per staffer.
  const s2 = await tv.startSession({ actor: aeActor, broker: withLogin, applicationId: null });
  const prior = (await db.query('SELECT ended_at, end_reason FROM tpo_view_sessions WHERE id=$1', [s1.sessionId])).rows[0];
  ok(prior.ended_at !== null && prior.end_reason === 'superseded', 'starting a new view closes the previous one');
  const openCount = (await db.query(
    'SELECT count(*)::int AS n FROM tpo_view_sessions WHERE staff_id=$1 AND ended_at IS NULL', [aeA])).rows[0].n;
  ok(openCount === 1, 'a staffer never has two live broker views');

  await tv.endSession(s2.sessionId, 'exit');
  const ended = (await db.query('SELECT ended_at, end_reason FROM tpo_view_sessions WHERE id=$1', [s2.sessionId])).rows[0];
  ok(ended.ended_at !== null && ended.end_reason === 'exit', 'leaving the view closes the session');
  // Closing twice must not rewrite the original reason.
  await tv.endSession(s2.sessionId, 'expired');
  const stillExit = (await db.query('SELECT end_reason FROM tpo_view_sessions WHERE id=$1', [s2.sessionId])).rows[0];
  ok(stillExit.end_reason === 'exit', 'a closed session is never re-closed with a different reason');
  await tv.touchSession(s2.sessionId);
  ok(true, 'heartbeating a closed session is harmless');

  // ---- the register view ----
  const mine = await tv.history(aeActor, { limit: 50 });
  ok(mine.length >= 2 && mine.every((h) => h.staff_id === aeA), 'without view_audit_log a staffer sees only their own views');
  ok(mine[0].firm_name === 'Firm A' && (mine[0].broker_name || '').includes('Broker A1'), 'the register names the firm + broker');
  const auditor = actorFor(admin, 'admin', ['see_all_files', 'view_audit_log']);
  await tv.startSession({ actor: auditor, broker: withLogin });
  const all = await tv.history(auditor, { limit: 50 });
  ok(all.some((h) => h.staff_id === aeA) && all.some((h) => h.staff_id === admin),
    'view_audit_log widens the register to the whole team');

  // ---- an action inside a tpo view is attributable to the real staffer (db/320) ----
  // A TPO user audits as actor_kind='staff' (the audit_log CHECK is
  // borrower|staff|system) with the impersonator naming the real internal human.
  await db.query(
    `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,impersonator_staff_id)
     VALUES ('staff',$1,'tpo_view_test','tpo_user',$1,$2)`, [brokerA1, aeA]);
  const stamped = (await db.query(
    `SELECT impersonator_staff_id FROM audit_log WHERE action='tpo_view_test' AND actor_id=$1`, [brokerA1])).rows[0];
  ok(stamped && stamped.impersonator_staff_id === aeA,
    'an action taken inside a tpo view is attributable to the real staffer');

  // ---- cleanup (leave the test database as we found it) ----
  const staffIds = [aeA, other, admin, brokerA1, brokerA2, brokerB1, brokerNoLogin, brokerInactive, brokerSusp];
  await db.query('DELETE FROM audit_log WHERE action=$1', ['tpo_view_test']);
  await db.query('DELETE FROM tpo_view_sessions WHERE staff_id = ANY($1::uuid[]) OR tpo_user_id = ANY($1::uuid[])', [staffIds]);
  await db.query('DELETE FROM application_assignees WHERE application_id = ANY($1::uuid[])', [[appA, appB]]);
  await db.query('DELETE FROM applications WHERE id = ANY($1::uuid[])', [[appA, appB]]);
  await db.query('DELETE FROM borrowers WHERE id=$1', [bId]);
  await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [staffIds]);
  await db.query('DELETE FROM tpo_firms WHERE id = ANY($1::uuid[])', [[firmA, firmB, firmSusp]]);

  finish();
})().catch((e) => { console.error(e); fail++; finish(); });

function finish() {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
