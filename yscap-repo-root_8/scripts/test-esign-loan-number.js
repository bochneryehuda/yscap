'use strict';
/**
 * Send-package loan-number backfill + rules (owner-directed 2026-07-20).
 * POST /api/staff/applications/:id/loan-number must enforce: value starts with
 * "YSCAP", is UNIQUE across non-deleted files, fills a blank freely, and only an
 * admin may CHANGE an existing number. Boots the real server + forged tokens.
 * Run: DATABASE_URL=... node scripts/test-esign-loan-number.js
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5433/yscap';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-ln';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const PORT = 5679;
const uuid = () => crypto.randomUUID();
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

const TAG = 't' + Date.now().toString(36);

async function main() {
  const app = require(REPO + '/src/server.js');
  const server = app.listen(PORT);
  await require(REPO + '/src/migrate-boot').ensureSchema();

  const adminId = uuid(), loId = uuid(), borrower = uuid();
  const appA = uuid(), appB = uuid();
  const LN = ('YSCAP' + TAG.replace(/[^a-z0-9]/gi, '') + '1').toUpperCase();   // unique per run

  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active) VALUES ($1,$2,'LN Admin','super_admin',true)`, [adminId, `lnadmin_${TAG}@x.test`]);
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active) VALUES ($1,$2,'LN LO','loan_officer',true)`, [loId, `lnlo_${TAG}@x.test`]);
    const admin = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    const lo = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'LN','Test',$2)`, [borrower, `lnb_${TAG}@x.test`]);
    // Two files with NO loan number; assign the LO to A so it can touch it.
    await db.query(`INSERT INTO applications (id,borrower_id,status,loan_officer_id) VALUES ($1,$2,'processing',$3)`, [appA, borrower, loId]);
    await db.query(`INSERT INTO applications (id,borrower_id,status) VALUES ($1,$2,'processing')`, [appB, borrower]);

    // 1) Format rule: must start with YSCAP.
    let r = await api('POST', `/api/staff/applications/${appA}/loan-number`, admin, { loanNumber: 'ABC123' });
    ok(r.status === 400, 'rejects a loan number that does not start with YSCAP (400)');
    r = await api('POST', `/api/staff/applications/${appA}/loan-number`, admin, { loanNumber: 'YSCAP' });
    ok(r.status === 400, 'rejects a bare "YSCAP" with no numbers (400)');

    // 2) Fill a blank — a loan officer on the file may do it; value is normalized upper.
    r = await api('POST', `/api/staff/applications/${appA}/loan-number`, lo, { loanNumber: LN.toLowerCase() });
    ok(r.status === 200 && r.body.ok, 'LO fills a blank loan number (200)');
    const savedA = (await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [appA])).rows[0].ys_loan_number;
    ok(savedA === LN, 'stored uppercased/normalized (YSCAP…)');

    // 3) Uniqueness: the SAME number on another file is refused.
    r = await api('POST', `/api/staff/applications/${appB}/loan-number`, admin, { loanNumber: LN });
    ok(r.status === 409, 'a duplicate loan number on another file is refused (409)');
    r = await api('POST', `/api/staff/applications/${appB}/loan-number`, admin, { loanNumber: LN.toLowerCase() });
    ok(r.status === 409, 'duplicate check is case-insensitive (409)');
    const savedB = (await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [appB])).rows[0].ys_loan_number;
    ok(savedB == null, 'the second file was NOT given the duplicate number');

    // 4) Re-posting the SAME value on the same file is a harmless no-op.
    r = await api('POST', `/api/staff/applications/${appA}/loan-number`, lo, { loanNumber: LN });
    ok(r.status === 200 && r.body.unchanged === true, 'same value again is a no-op (unchanged)');

    // 5) CHANGING an existing number: a non-admin is refused; an admin may.
    const LN2 = LN + '9';
    r = await api('POST', `/api/staff/applications/${appA}/loan-number`, lo, { loanNumber: LN2 });
    ok(r.status === 403, 'a loan officer cannot CHANGE an existing loan number (403)');
    r = await api('POST', `/api/staff/applications/${appA}/loan-number`, admin, { loanNumber: LN2 });
    ok(r.status === 200 && r.body.loanNumber === LN2, 'an admin CAN change an existing loan number (200)');

    // 6) The per-file esign payload surfaces the loan number (drives the inline backfill).
    r = await api('GET', `/api/staff/applications/${appA}/esign`, admin);
    ok(r.status === 200 && r.body.loanNumber === LN2, 'fileEsign returns the loan number so the UI can show/hide the backfill');
    r = await api('GET', `/api/staff/applications/${appB}/esign`, admin);
    ok(r.status === 200 && (r.body.loanNumber == null), 'fileEsign returns null loanNumber for a file still missing one');

    console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}: ${pass} passed, ${fail} failed`);
  } finally {
    await db.query(`DELETE FROM applications WHERE id = ANY($1)`, [[appA, appB]]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrower]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1)`, [[adminId, loId]]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
