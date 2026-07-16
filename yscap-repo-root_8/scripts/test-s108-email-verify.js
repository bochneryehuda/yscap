/**
 * S1-08 — confirm email before a session. Register gives no token; the one-click
 * verify link activates AND logs in; an unverified account can't log in; existing
 * active borrowers are grandfathered (db/119). Run: node scripts/test-s108-email-verify.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-s108';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5624;
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

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const PW = 'Xx9!verylongpassword-abc';
  try {
    // 1) register → verifyRequired, no token, email_verified=false
    const E = `s108_${uuid().slice(0, 8)}@x.test`;
    let r = await api('POST', '/auth/borrower/register', { email: E, password: PW, firstName: 'Ann', lastName: 'Test' });
    ok(r.status === 202 && r.body && r.body.verifyRequired && !r.body.token, 'register → verifyRequired, NO session token');
    const av = await db.query(`SELECT ba.email_verified, ba.borrower_id FROM borrower_auth ba JOIN borrowers b ON b.id=ba.borrower_id WHERE b.email=$1`, [E]);
    ok(av.rows[0] && av.rows[0].email_verified === false, 'new account starts email_verified=false');
    const bid = av.rows[0].borrower_id;

    // 2) login BEFORE verifying → verifyRequired, no token
    r = await api('POST', '/auth/borrower/login', { email: E, password: PW });
    ok(r.body && r.body.verifyRequired && !r.body.token, 'login before verifying → verifyRequired, no session');

    // 3) verify with a one-click token → returns a session token (auto-login).
    // Use the REAL issueEmailToken path so the token hashes exactly as the system does.
    const auth = require(REPO + '/src/auth');
    const issued = await auth.issueEmailToken({ borrowerId: bid, email: E, kind: 'verify', ttlMin: 10080, withToken: true, withCode: false });
    r = await api('POST', '/auth/borrower/verify', { token: issued.token });
    ok(r.status === 200 && r.body && r.body.verified && r.body.token, 'verify → activated AND returns a session token');
    const av2 = await db.query(`SELECT email_verified FROM borrower_auth WHERE borrower_id=$1`, [bid]);
    ok(av2.rows[0] && av2.rows[0].email_verified === true, 'email_verified flips to true on verify');

    // 4) login AFTER verifying → real session token
    r = await api('POST', '/auth/borrower/login', { email: E, password: PW });
    ok(r.status === 200 && r.body && r.body.token && !r.body.verifyRequired, 'login after verifying → real session token');

    // 5) grandfather (db/119): an unverified account WITH an application becomes verified
    const G = uuid();
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Grand','Father',$2)`, [G, `gf_${G.slice(0,8)}@x.test`]);
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified) VALUES ($1,$2,0,false)`, [G, await C.hashPassword(PW)]);
    await db.query(`INSERT INTO applications (id,borrower_id) VALUES ($1,$2)`, [uuid(), G]);
    // re-run the grandfather migration statement (idempotent; matches db/119 incl. co-borrowers)
    await db.query(`UPDATE borrower_auth ba SET email_verified=true, email_verified_at=COALESCE(ba.email_verified_at, now())
                     WHERE ba.email_verified=false AND (ba.last_login_at IS NOT NULL OR EXISTS (
                       SELECT 1 FROM applications a WHERE a.borrower_id=ba.borrower_id OR a.co_borrower_id=ba.borrower_id))`);
    const gf = await db.query(`SELECT email_verified FROM borrower_auth WHERE borrower_id=$1`, [G]);
    ok(gf.rows[0] && gf.rows[0].email_verified === true, 'grandfather: existing account with an application → verified (no lockout)');

    // cleanup
    await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [G]);
    await db.query(`DELETE FROM email_tokens WHERE email=$1`, [E]);
    await db.query(`DELETE FROM borrower_auth WHERE borrower_id=ANY($1::uuid[])`, [[bid, G]]);
    await db.query(`DELETE FROM borrowers WHERE id=ANY($1::uuid[]) OR email=$2`, [[G], E]);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  server.close();
  console.log(`\nS1-08 email-verify: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
