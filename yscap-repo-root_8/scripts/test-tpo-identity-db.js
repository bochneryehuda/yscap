'use strict';
/**
 * TPO PORTAL — the identity + onboarding + firm-isolation proof against the REAL
 * schema (db/483 + db/484 + db/485). DB-gated (skips with no DATABASE_URL), in
 * `npm test`. Cleans up every row it creates.
 *
 * Proves end-to-end over real HTTP:
 *   • an internal admin creates a firm and invites the lead broker; the broker
 *     accepts and gets a kind='tpo' session tied to that firm;
 *   • a broker signs in ONLY at /auth/tpo/login (refused at the staff door), and
 *     an internal staffer is refused at the TPO door;
 *   • /api/tpo is FIRM-SCOPED — a broker (and their processor) see only their own
 *     firm's TPO file, never another firm's, never a retail file;
 *   • a tpo session is refused by /api/staff and /api/borrower, a staff session
 *     by /api/tpo;
 *   • a firm admin invites a processor into their OWN firm; the processor is
 *     scoped identically;
 *   • an EXTERNAL broker never appears on the public roster or the internal team
 *     list; an internal officer still does;
 *   • suspending a firm revokes its brokers' live sessions and blocks new logins;
 *   • an internal email cannot be taken over by a TPO invite;
 *   • the DB invariants reject an unscoped external user and an is_tpo file with
 *     no firm.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO identity DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const PW = 'BrokerPass123!';
  const mail = (t) => `${t}-${sfx}@brk.test`;
  try {
    const hash = await C.hashPassword(PW);

    // an internal ADMIN (holds manage_team) + a token
    const adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, password_hash, token_version)
       VALUES ($1,'Internal Admin','admin',true,$2,0) RETURNING id`, [mail('admin'), hash])).rows[0].id;
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    // an internal, site-selectable loan officer (should stay on the roster)
    await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, site_selectable, password_hash, token_version)
       VALUES ($1,'Internal LO','loan_officer',true,true,$2,0)`, [mail('lo'), hash]);
    const staffTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });

    // ============================================================
    // 1) ONBOARD firm A + invite the lead broker + accept.
    // ============================================================
    const firmA = (await call(server, 'POST', '/api/admin/tpo/firms', adminTok, { name: `Firm A ${sfx}`, nmls: '111' })).body.firm.id;
    const inv = await call(server, 'POST', `/api/admin/tpo/firms/${firmA}/invite`, adminTok,
      { email: mail('brokerA'), fullName: 'Broker A', role: 'tpo_officer', isFirmAdmin: true });
    ok(inv.status === 201 && inv.body.token, 'admin invites the lead broker (gets an accept token)');
    const acc = await call(server, 'POST', '/auth/accept', null, { token: inv.body.token, password: PW, fullName: 'Broker A' });
    ok(acc.status === 200 && acc.body.token, 'broker accepts the invite and gets a session');
    const brokerTok = acc.body.token;
    const brokerA = (await db.query(`SELECT id, is_external, is_firm_admin, tpo_firm_id, site_selectable FROM staff_users WHERE email=$1`, [mail('brokerA')])).rows[0];
    ok(brokerA && brokerA.is_external === true && brokerA.tpo_firm_id === firmA && brokerA.is_firm_admin === true,
      'accept created an EXTERNAL firm-admin row tied to firm A');
    ok(brokerA && brokerA.site_selectable === false, 'a broker is created NOT site-selectable (never on the public roster)');

    // ============================================================
    // 2) A second firm + broker + file (raw), an internal retail file.
    // ============================================================
    const firmB = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id, password_hash, token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const mkB = async (n) => (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'B',$2) RETURNING id`, [n, mail('b' + n)])).rows[0].id;
    const bA = await mkB('AA'), bB = await mkB('BB'), bR = await mkB('RR');
    const fileA = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, is_tpo, tpo_firm_id)
       VALUES ($1,$2,'file_intake','Purchase',true,$3) RETURNING id`, [bA, brokerA.id, firmA])).rows[0].id;
    await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, is_tpo, tpo_firm_id) VALUES ($1,$2,'file_intake','Purchase',true,$3)`, [bB, brokerB, firmB]);
    await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type) VALUES ($1,$2,'file_intake','Purchase')`, [bR, adminId]);

    // ============================================================
    // 3) LOGIN doors + identity.
    // ============================================================
    const tpoLogin = await call(server, 'POST', '/auth/tpo/login', null, { email: mail('brokerA'), password: PW });
    ok(tpoLogin.status === 200 && tpoLogin.body.token, 'broker signs in at /auth/tpo/login');
    ok((await call(server, 'POST', '/auth/staff/login', null, { email: mail('brokerA'), password: PW })).status === 401, 'broker refused at /auth/staff/login');
    ok((await call(server, 'POST', '/auth/tpo/login', null, { email: mail('admin'), password: PW })).status === 401, 'internal staffer refused at /auth/tpo/login');
    const me = await call(server, 'GET', '/api/tpo/me', brokerTok);
    ok(me.status === 200 && me.body.firm && me.body.firm.id === firmA && me.body.is_firm_admin === true, '/api/tpo/me: firm A + firm-admin');

    // ============================================================
    // 4) FIRM SCOPING + cross-door isolation.
    // ============================================================
    const pipe = await call(server, 'GET', '/api/tpo/applications', brokerTok);
    const ids = (pipe.body.applications || []).map((a) => a.id);
    ok(ids.length === 1 && ids[0] === fileA, 'broker sees only their firm\'s ONE TPO file (never firm B, never retail)');
    ok((await call(server, 'GET', '/api/staff/applications', brokerTok)).status === 403, 'tpo session refused by /api/staff');
    ok((await call(server, 'GET', '/api/borrower/applications', brokerTok)).status === 403, 'tpo session refused by /api/borrower');
    ok((await call(server, 'GET', '/api/tpo/applications', staffTok)).status === 403, 'staff session refused by /api/tpo');

    // 4b) 2FA ENROLLMENT routes a broker to staff_users (audit fix — setup/enable
    //     used to write to borrower_auth for a tpo actor, so it silently no-op'd).
    const setup = await call(server, 'GET', '/api/tpo/me', brokerTok); // keep brokerTok warm
    ok(setup.status === 200, 'broker session still live before 2FA');
    const mfaSetup = await call(server, 'POST', '/auth/mfa/setup', brokerTok, {});
    ok(mfaSetup.status === 200 && mfaSetup.body.secret, 'broker can start 2FA setup');
    const secRow = (await db.query(`SELECT mfa_secret FROM staff_users WHERE id=$1`, [brokerA.id])).rows[0];
    ok(secRow && secRow.mfa_secret, '2FA secret lands in the broker\'s staff_users row (not borrower_auth)');
    const bauth = await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [brokerA.id]);
    ok(bauth.rows.length === 0, 'nothing was written to borrower_auth for the broker');

    // ============================================================
    // 5) FIRM ADMIN invites a processor into their OWN firm.
    // ============================================================
    const pInv = await call(server, 'POST', '/api/tpo/team/invite', brokerTok, { email: mail('proc'), fullName: 'Proc P', role: 'tpo_processor' });
    ok(pInv.status === 201 && pInv.body.token, 'firm admin invites a processor');
    const pAcc = await call(server, 'POST', '/auth/accept', null, { token: pInv.body.token, password: PW, fullName: 'Proc P' });
    ok(pAcc.status === 200 && pAcc.body.token, 'processor accepts');
    const procTok = pAcc.body.token;
    const procPipe = await call(server, 'GET', '/api/tpo/applications', procTok);
    ok((procPipe.body.applications || []).length === 1 && procPipe.body.applications[0].id === fileA, 'the processor is scoped to the SAME firm (sees fileA)');
    const team = await call(server, 'GET', '/api/tpo/team', brokerTok);
    const teamEmails = (team.body.team || []).map((u) => u.email);
    ok(teamEmails.includes(mail('brokerA')) && teamEmails.includes(mail('proc')) && !teamEmails.includes(mail('brokerB')), 'firm roster = own firm only');
    ok((await call(server, 'POST', '/api/tpo/team/invite', procTok, { email: mail('x'), role: 'tpo_processor' })).status === 403, 'a non-firm-admin processor cannot invite');

    // ============================================================
    // 6) ROSTER / TEAM exclusion — a broker never appears internally.
    // ============================================================
    const roster = await call(server, 'GET', '/api/roster?flat=1', null);
    const rosterEmails = (roster.body.people || []).map((p) => p.email);
    ok(!rosterEmails.includes(mail('brokerA')) && !rosterEmails.includes(mail('brokerB')) && !rosterEmails.includes(mail('proc')),
      'no broker/processor appears on the PUBLIC roster');
    ok(rosterEmails.includes(mail('lo')), 'the internal site-selectable officer DOES appear on the roster (sanity)');
    const teamList = await call(server, 'GET', '/api/staff/team', staffTok);
    const teamListEmails = (teamList.body || []).map((u) => u.email);
    ok(!teamListEmails.includes(mail('brokerA')) && !teamListEmails.includes(mail('proc')), 'no broker appears on the internal team list');
    ok(teamListEmails.includes(mail('lo')), 'the internal officer DOES appear on the internal team list');

    // ============================================================
    // 6b) AUDIT FIXES — a broker never receives an INTERNAL staff
    //     notification (they ARE the loan-officer assignee on their
    //     firm's files), and an existing broker can't be re-invited
    //     (no cross-firm move / steal / same-firm demote).
    // ============================================================
    const notify = require('../src/lib/notify');
    const notifBefore = (await db.query(`SELECT count(*)::int n FROM notifications WHERE staff_id=$1`, [brokerA.id])).rows[0].n;
    const notifRes = await notify.notifyStaff(brokerA.id, { type: 'digest', title: 'internal only', body: 'must never reach a broker' });
    ok(notifRes === null, 'notifyStaff returns null for an external (broker) user');
    const notifAfter = (await db.query(`SELECT count(*)::int n FROM notifications WHERE staff_id=$1`, [brokerA.id])).rows[0].n;
    ok(notifAfter === notifBefore, 'no internal notification row is written for a broker');
    ok((await call(server, 'POST', `/api/admin/tpo/firms/${firmA}/invite`, adminTok, { email: mail('brokerB'), role: 'tpo_officer' })).status === 409,
      'admin cannot re-invite another firm\'s broker into firm A (cross-firm move refused)');
    ok((await call(server, 'POST', '/api/tpo/team/invite', brokerTok, { email: mail('brokerB'), role: 'tpo_processor' })).status === 409,
      'a firm admin cannot invite an existing broker (no cross-firm steal)');
    ok((await call(server, 'POST', '/api/tpo/team/invite', brokerTok, { email: mail('proc'), role: 'tpo_processor' })).status === 409,
      'a firm admin cannot re-invite a same-firm colleague (would demote them)');

    // ============================================================
    // 7) SUSPEND the firm — revoke sessions + block new logins.
    // ============================================================
    const susp = await call(server, 'POST', '/api/admin/tpo/firms', adminTok, {}); // (noise call to keep adminTok warm)
    ok(susp.status === 400, 'creating a firm with no name is refused');
    ok((await call(server, 'PATCH', `/api/admin/tpo/firms/${firmA}`, adminTok, { status: 'suspended' })).status === 200, 'admin suspends firm A');
    ok((await call(server, 'GET', '/api/tpo/me', brokerTok)).status === 401, 'the broker\'s live session is revoked on suspend');
    ok((await call(server, 'POST', '/auth/tpo/login', null, { email: mail('brokerA'), password: PW })).status === 401, 'a suspended firm\'s broker cannot sign in');
    await call(server, 'PATCH', `/api/admin/tpo/firms/${firmA}`, adminTok, { status: 'active' });
    ok((await call(server, 'POST', '/auth/tpo/login', null, { email: mail('brokerA'), password: PW })).status === 200, 'reactivating restores login');

    // ============================================================
    // 8) INTERNAL TAKEOVER guard + DB invariants.
    // ============================================================
    ok((await call(server, 'POST', `/api/admin/tpo/firms/${firmA}/invite`, adminTok, { email: mail('admin'), role: 'tpo_officer' })).status === 409,
      'an INTERNAL email cannot be invited as a broker (409)');
    let threw = false;
    try { await db.query(`INSERT INTO staff_users (email, role, is_external) VALUES ($1,'tpo_officer',true)`, [mail('badext')]); } catch (_) { threw = true; }
    ok(threw, 'an external user with no firm is refused by the schema');
    threw = false;
    try { await db.query(`INSERT INTO applications (borrower_id, is_tpo) VALUES ($1,true)`, [bA]); } catch (_) { threw = true; }
    ok(threw, 'a TPO file with no firm is refused by the schema');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message, e.stack ? e.stack.split('\n')[1] : '');
  } finally {
    // teardown — delete every row this run created (sfx-scoped).
    try {
      const like = `%${sfx}%`;
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)`, [like]);
      await db.query(`DELETE FROM invite_tokens WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM tpo_firms WHERE name LIKE $1`, [like]);
    } catch (_) { /* best-effort cleanup */ }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    console.log(`test-tpo-identity-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
