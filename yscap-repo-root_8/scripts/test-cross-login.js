/**
 * Cross-surface sign-in routing (the Chaim Lebowitz "reset every time" loop,
 * root-caused 2026-07-16). One email can have a STAFF account, a BORROWER
 * account, or both; each login page used to check only its own store, so the
 * wrong-surface sign-in 401'd forever. Now correct credentials sign you into
 * the account they actually belong to, from either page.
 * Run: node scripts/test-cross-login.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-xlogin';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5631;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
const kindOf = (tok) => { try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).kind; } catch { return null; } };

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const PW_STAFF = 'Xx9!staffpass-cross-1', PW_BORR = 'Xx9!borrowerpass-cross-2';
  const S = uuid(), B = uuid();
  const E_STAFF = `xstaff_${S.slice(0, 8)}@x.test`;   // staff-only email
  const E_DUAL = `xdual_${B.slice(0, 8)}@x.test`;     // staff + borrower email
  const S2 = uuid();
  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'Cross Staff','loan_officer',$3,true)`,
      [S, E_STAFF, await C.hashPassword(PW_STAFF)]);
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES ($1,$2,'Dual Staff','processor',$3,true)`,
      [S2, E_DUAL, await C.hashPassword(PW_STAFF)]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Dual','Borrower',$2)`, [B, E_DUAL]);
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified) VALUES ($1,$2,0,true)`,
      [B, await C.hashPassword(PW_BORR)]);

    // 1) THE LOOP: staff-only email on the BORROWER page → staff session (was 401 forever)
    let r = await api('POST', '/auth/borrower/login', { email: E_STAFF, password: PW_STAFF });
    ok(r.status === 200 && r.body.token && kindOf(r.body.token) === 'staff', 'staff-only email on borrower page → STAFF session');

    // 2) wrong password still fails on both pages
    r = await api('POST', '/auth/borrower/login', { email: E_STAFF, password: 'Wr0ng!password-xyz' });
    ok(r.status === 401, 'wrong password on borrower page → 401');
    r = await api('POST', '/auth/staff/login', { email: E_STAFF, password: 'Wr0ng!password-xyz' });
    ok(r.status === 401, 'wrong password on staff page → 401');

    // 3) borrower-only... via staff page: dual email's BORROWER password on the staff page → borrower session
    r = await api('POST', '/auth/staff/login', { email: E_DUAL, password: PW_BORR });
    ok(r.status === 200 && r.body.token && kindOf(r.body.token) === 'borrower', 'borrower password on staff page → BORROWER session');

    // 4) dual identity prefers the surface's OWN store when its password is used
    r = await api('POST', '/auth/borrower/login', { email: E_DUAL, password: PW_BORR });
    ok(r.status === 200 && r.body.token && kindOf(r.body.token) === 'borrower', 'dual email + borrower password on borrower page → borrower session');
    r = await api('POST', '/auth/staff/login', { email: E_DUAL, password: PW_STAFF });
    ok(r.status === 200 && r.body.token && kindOf(r.body.token) === 'staff', 'dual email + staff password on staff page → staff session');

    // 5) dual identity CROSS: staff password on the borrower page → staff session (the flip-flop killer)
    r = await api('POST', '/auth/borrower/login', { email: E_DUAL, password: PW_STAFF });
    ok(r.status === 200 && r.body.token && kindOf(r.body.token) === 'staff', 'dual email + staff password on borrower page → STAFF session');
    // ...and the borrower row was NOT penalized for it
    const fa = (await db.query(`SELECT failed_attempts FROM borrower_auth WHERE borrower_id=$1`, [B])).rows[0];
    ok(fa && fa.failed_attempts === 0, 'cross-login does not bump the borrower row failed_attempts');

    // 6) inactive staff never rides the fallback
    await db.query(`UPDATE staff_users SET is_active=false WHERE id=$1`, [S]);
    r = await api('POST', '/auth/borrower/login', { email: E_STAFF, password: PW_STAFF });
    ok(r.status === 401, 'deactivated staff account cannot sign in via the borrower page');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM staff_users WHERE id=ANY($1::uuid[])`, [[S, S2]]).catch(() => {});
    await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
  }
  server.close();
  console.log(`\ncross-login: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
