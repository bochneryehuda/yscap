/**
 * Security hardening batch test (S1-16 admin gate, S1-09 email-code cap,
 * S4-06 chat filename PII guard, S3-11 mention-picker scoping).
 * Self-contained against the throwaway yscap_test DB. Run: node scripts/test-security-batch.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_test';
process.env.JWT_SECRET = 'test-secret-security-batch';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const chat = require(REPO + '/src/lib/chat.js');
const PORT = 5623;
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path, headers },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();
  // wait for db/118 column
  for (let i = 0; i < 40; i++) {
    const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='email_tokens' AND column_name='code_attempts'`).catch(() => ({ rows: [] }));
    if (r.rows[0]) break; await new Promise(r => setTimeout(r, 300));
  }

  // a REAL borrower (so authenticate passes and requireStaff is what rejects it → clean 403)
  const borrowerId = uuid();
  await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Sec','Borrower',$2)`, [borrowerId, `secb_${borrowerId.slice(0,8)}@x.test`]);
  await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0)`, [borrowerId, await C.hashPassword('Xx9!verylongpassword')]);
  const borrowerTok = C.signJwt({ sub: borrowerId, kind: 'borrower', role: 'borrower', tv: 0 });
  const staffId = uuid();
  await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active) VALUES ($1,$2,'Sec Officer','loan_officer',true) ON CONFLICT DO NOTHING`, [staffId, `sec_${staffId.slice(0,8)}@staff.test`]);
  const staffTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });
  // a super_admin passes both the blanket gate AND the per-route internal guard
  const adminId = uuid();
  await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active) VALUES ($1,$2,'Sec Admin','super_admin',true) ON CONFLICT DO NOTHING`, [adminId, `seca_${adminId.slice(0,8)}@staff.test`]);
  const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });

  try {
    // ---------- S1-16: blanket staff gate on /api/admin ----------
    console.log('\n# S1-16 admin gate');
    let r = await api('GET', '/api/admin/sharepoint/health', null, borrowerTok);
    ok(r.status === 403, 'valid BORROWER token → /api/admin/* is 403 (requireStaff blocks it) (' + r.status + ')');
    r = await api('GET', '/api/admin/sharepoint/health', null, null);
    ok(r.status === 401 || r.status === 403, 'no token → /api/admin/* rejected (' + r.status + ')');
    r = await api('GET', '/api/admin/sharepoint/health', null, adminTok);
    ok(r.status !== 403 && r.status !== 401, 'super_admin passes the blanket gate + internal guard (' + r.status + ')');

    // ---------- S1-09: email-code attempt cap ----------
    console.log('\n# S1-09 email-code attempt cap');
    const em = `verify_${uuid().slice(0,8)}@x.test`;
    const goodCode = '123456';
    await db.query(`INSERT INTO email_tokens (kind,email,code_hash,expires_at) VALUES ('verify',$1,$2, now()+interval '1 day')`, [em, C.sha256(goodCode)]);
    for (let i = 1; i <= 5; i++) await api('POST', '/auth/borrower/verify', { email: em, code: '000000' });
    const tok = await db.query(`SELECT code_attempts, used_at FROM email_tokens WHERE email=$1`, [em]);
    ok(tok.rows[0] && Number(tok.rows[0].code_attempts) >= 5, 'wrong-code attempts counted (' + (tok.rows[0] && tok.rows[0].code_attempts) + ')');
    ok(tok.rows[0] && tok.rows[0].used_at, 'token retired after 5 wrong codes');
    r = await api('POST', '/auth/borrower/verify', { email: em, code: goodCode });
    ok(r.status === 400, 'even the CORRECT code fails once the token is retired (brute-force capped)');

    // ---------- S4-06: chat attachment filename PII guard ----------
    console.log('\n# S4-06 chat filename PII guard');
    // borrower → blocked
    let threw = null;
    try {
      await chat.postMessage({ conv: { id: uuid(), application_id: uuid(), borrower_visible: true },
        actor: { kind: 'borrower', id: uuid() }, body: 'here',
        attachment: { filename: 'my ssn 123-45-6789.pdf', contentType: 'application/pdf', dataBase64: 'AAAA' } });
    } catch (e) { threw = e; }
    ok(threw && threw.code === 'pii_blocked', 'borrower attachment named with an SSN → blocked (pii_blocked)');
    // pii-guard scan redacts a filename for staff (unit-level, no DB write)
    const pii = require(REPO + '/src/lib/pii-guard.js');
    const fs = pii.scan('card 4111 1111 1111 1111 statement.pdf');
    ok(fs.found && /\[card ending 1111\]/.test(fs.redacted), 'staff filename redaction keeps last 4 (unit)');

    // ---------- S3-11: staff mention picker scoping ----------
    console.log('\n# S3-11 mention picker scoping');
    const B = uuid(), A1 = uuid(), A2 = uuid();
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Ment','Test',$2)`, [B, `m_${A1.slice(0,8)}@x.test`]);
    for (const a of [A1, A2]) await db.query(`INSERT INTO applications (id,borrower_id,property_address) VALUES ($1,$2,$3::jsonb)`, [a, B, JSON.stringify({ oneLine: 'Addr ' + a.slice(0,4) })]);
    // officer is on A1 only
    await db.query(`INSERT INTO application_assignees (application_id,staff_id,role,is_primary) VALUES ($1,$2,'loan_officer',true)`, [A1, staffId]);
    await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [A1, staffId]);
    r = await api('GET', `/api/staff/applications/${A1}/mentionables`, null, staffTok);
    const appIds = (r.body && Array.isArray(r.body.applications) ? r.body.applications : []).map(x => x.id);
    ok(r.status === 200, 'mentionables 200 for the officer on A1');
    ok(appIds.includes(A1), 'mentionables includes A1 (the officer IS on it)');
    ok(!appIds.includes(A2), 'mentionables EXCLUDES A2 (officer not on it) — S3-11 leak closed');

    // cleanup
    await db.query(`DELETE FROM application_assignees WHERE application_id=ANY($1::uuid[])`, [[A1, A2]]);
    await db.query(`DELETE FROM applications WHERE id=ANY($1::uuid[])`, [[A1, A2]]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]);
    await db.query(`DELETE FROM email_tokens WHERE email=$1`, [em]);
    await db.query(`DELETE FROM staff_users WHERE id=ANY($1::uuid[])`, [[staffId, adminId]]);
    await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  server.close();
  console.log(`\nsecurity-batch: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
