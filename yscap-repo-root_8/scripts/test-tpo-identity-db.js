'use strict';
/**
 * TPO PORTAL foundation — the ACCESS-CONTROL proof against the REAL schema
 * (db/464 + db/465). DB-gated (skips cleanly with no DATABASE_URL), in `npm test`.
 *
 * The pure test proves the scope SQL shape; this proves the part a mock cannot —
 * that against real Postgres:
 *   • a broker signs in ONLY at /auth/tpo/login and gets a kind='tpo' session;
 *   • a broker is REFUSED at the staff door, and an internal staffer is REFUSED
 *     at the TPO door (the external boundary is symmetric);
 *   • /api/tpo is FIRM-SCOPED — a broker sees their own firm's TPO files and
 *     NOTHING else (not another firm's TPO file, not a retail file);
 *   • a tpo session is structurally refused by /api/staff and /api/borrower, and
 *     a staff session is refused by /api/tpo;
 *   • the DB invariants hold — an external user with no firm, and a TPO file with
 *     no firm, are both refused by the schema.
 *
 * A wrong column or a dropped scope branch here would silently let one firm see
 * another's files — the exact class the single-definition scope helpers exist to
 * prevent.
 *
 *   DATABASE_URL=postgres://… node scripts/test-tpo-identity-db.js
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
function finish() {
  console.log(`test-tpo-identity-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

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
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO identity DB (no DATABASE_URL)'); return finish(); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const PW = 'BrokerPass123!';
  try {
    const hash = await C.hashPassword(PW);

    // ---- two brokerage firms ----
    const firmA = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name) VALUES ($1) RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;

    // ---- a broker in each firm + one internal staffer ----
    const mkTpo = async (firm, mail, firmAdmin) => (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, is_external, tpo_firm_id, is_firm_admin, password_hash, token_version)
       VALUES ($1,'Broker',$2,true,true,$3,$4,$5,0) RETURNING id`,
      [mail, 'tpo_officer', firm, !!firmAdmin, hash])).rows[0].id;
    const brokerA = await mkTpo(firmA, `tpo-a-${sfx}@brk.test`, true);
    const brokerB = await mkTpo(firmB, `tpo-b-${sfx}@brk.test`, true);
    const staffEmail = `tpo-staff-${sfx}@brk.test`;
    const staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, password_hash, token_version)
       VALUES ($1,'Internal LO','loan_officer',true,$2,0) RETURNING id`, [staffEmail, hash])).rows[0].id;

    // ---- borrowers + files: a TPO file for each firm, and a retail file ----
    const mkB = async (name) => (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ($1,'Borrower',$2) RETURNING id`,
      [name, `b-${name}-${sfx}@brk.test`])).rows[0].id;
    const bA = await mkB('AAA'), bB = await mkB('BBB'), bR = await mkB('RRR');
    const fileA = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, is_tpo, tpo_firm_id)
       VALUES ($1,$2,'file_intake','Purchase',true,$3) RETURNING id`, [bA, brokerA, firmA])).rows[0].id;
    await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, is_tpo, tpo_firm_id)
       VALUES ($1,$2,'file_intake','Purchase',true,$3)`, [bB, brokerB, firmB]);      // firm B's file
    await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type)
       VALUES ($1,$2,'file_intake','Purchase')`, [bR, staffId]);                     // retail file

    // ==================================================================
    // 1) LOGIN — the broker signs in at the TPO door and nowhere else.
    // ==================================================================
    const tpoLogin = await call(server, 'POST', '/auth/tpo/login', null, { email: `tpo-a-${sfx}@brk.test`, password: PW });
    ok(tpoLogin.status === 200 && tpoLogin.body && tpoLogin.body.token, 'broker signs in at /auth/tpo/login');
    const brokerTok = tpoLogin.body && tpoLogin.body.token;

    const brokerAtStaff = await call(server, 'POST', '/auth/staff/login', null, { email: `tpo-a-${sfx}@brk.test`, password: PW });
    ok(brokerAtStaff.status === 401, 'broker is REFUSED at /auth/staff/login');

    const staffAtTpo = await call(server, 'POST', '/auth/tpo/login', null, { email: staffEmail, password: PW });
    ok(staffAtTpo.status === 401, 'internal staffer is REFUSED at /auth/tpo/login');

    // a staff session for the cross-door checks
    const staffTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });

    // ==================================================================
    // 2) /auth/me + /api/tpo/me report the tpo identity + firm.
    // ==================================================================
    const me = await call(server, 'GET', '/auth/me', brokerTok);
    ok(me.status === 200 && me.body && me.body.kind === 'tpo', '/auth/me returns kind=tpo');
    ok(me.body && me.body.firm && me.body.firm.id === firmA, '/auth/me names the broker\'s firm');
    const tpoMe = await call(server, 'GET', '/api/tpo/me', brokerTok);
    ok(tpoMe.status === 200 && tpoMe.body && tpoMe.body.firm && tpoMe.body.firm.id === firmA && tpoMe.body.is_firm_admin === true,
      '/api/tpo/me returns firm + firm-admin flag');

    // ==================================================================
    // 3) FIRM SCOPING — the broker sees ONLY their firm's TPO files.
    // ==================================================================
    const pipe = await call(server, 'GET', '/api/tpo/applications', brokerTok);
    ok(pipe.status === 200 && Array.isArray(pipe.body.applications), '/api/tpo/applications answers');
    const ids = (pipe.body.applications || []).map((a) => a.id);
    ok(ids.length === 1 && ids[0] === fileA,
      'broker sees exactly their firm\'s ONE TPO file — never firm B\'s, never the retail file');

    // ==================================================================
    // 4) CROSS-DOOR isolation — the kinds cannot wander.
    // ==================================================================
    const tpoAtStaff = await call(server, 'GET', '/api/staff/applications', brokerTok);
    ok(tpoAtStaff.status === 403, 'a tpo session is refused by /api/staff (staff only)');
    const tpoAtBorrower = await call(server, 'GET', '/api/borrower/applications', brokerTok);
    ok(tpoAtBorrower.status === 403, 'a tpo session is refused by /api/borrower (borrower only)');
    const staffAtTpoApi = await call(server, 'GET', '/api/tpo/applications', staffTok);
    ok(staffAtTpoApi.status === 403, 'a staff session is refused by /api/tpo (tpo only)');
    const noAuth = await call(server, 'GET', '/api/tpo/applications', null);
    ok(noAuth.status === 401, '/api/tpo requires a session');

    // ==================================================================
    // 5) DB INVARIANTS — the schema itself refuses an unscoped identity.
    // ==================================================================
    let threw = false;
    try { await db.query(`INSERT INTO staff_users (email, role, is_external) VALUES ($1,'tpo_officer',true)`, [`bad-ext-${sfx}@brk.test`]); }
    catch (_) { threw = true; }
    ok(threw, 'an external user with NO firm is refused by the schema (staff_users_external_firm_check)');

    threw = false;
    try { await db.query(`INSERT INTO applications (borrower_id, is_tpo) VALUES ($1,true)`, [bA]); }
    catch (_) { threw = true; }
    ok(threw, 'a TPO file with NO firm is refused by the schema (applications_tpo_firm_check)');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message);
  } finally {
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    finish();
  }
})();
