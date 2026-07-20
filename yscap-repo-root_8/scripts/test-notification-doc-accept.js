/**
 * A document being ACCEPTED never emails the borrower; a REJECT still does
 * (src/routes/staff.js POST /documents/:id/review).
 *
 * Owner-directed 2026-07-20 evening: the processor / back office accepting a
 * document was emailing the borrower every time ("getting bombarded"). Accepting
 * a document is an INTERNAL workflow step — "nobody needs to be aware when
 * somebody is accepting something internally; the borrower does not need to be
 * aware." So the borrower is NOT notified at all on an accept: no email AND no
 * in-app row. Only borrower ACTION items (a rejected / requested document the
 * borrower must redo) and real milestones still reach them.
 *
 * Boots the real Express app as a super_admin, stubs the email sender, drives the
 * real review endpoint. Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-doc-accept (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const http = require('http');
const assert = require('assert');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const email = require('../src/lib/email');
const app = require('../src/server');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// Capture every outbound email so we can assert the borrower was / wasn't mailed.
let sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };
const mailedTo = (addr) => sent.filter((m) => (Array.isArray(m.to) ? m.to : [m.to]).includes(addr)).length;

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let bd = ''; res.on('data', (c) => bd += c); res.on('end', () => resolve({ status: res.statusCode, body: bd })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

async function mkDoc(appId, borrowerId, filename) {
  return (await db.query(
    `INSERT INTO documents (filename, storage_provider, review_status, source_type, visibility, is_current, application_id, borrower_id)
     VALUES ($1,'local','pending','borrower_upload','borrower',true,$2,$3) RETURNING id`, [filename, appId, borrowerId])).rows[0].id;
}
const countNotif = async (appId, type) => Number((await db.query(
  `SELECT count(*) c FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type=$2`, [appId, type])).rows[0].c);

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  const bEmail = `acc-bo-${sfx}@example.com`;
  let adminId, borrowerId, appId;
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Accept Admin','super_admin',true,false,'x',0) RETURNING id`, [`acc-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Accept','Test',$1) RETURNING id`, [bEmail])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, adminId])).rows[0].id;

    // ACCEPT a document → the borrower is NOT notified at all: no email, no in-app row.
    sent = [];
    const doc1 = await mkDoc(appId, borrowerId, 'bank-statement.pdf');
    let r = await call(server, 'POST', `/api/staff/documents/${doc1}/review`, token, { action: 'accept' });
    assert.strictEqual(r.status, 200, 'accept returns 200');
    assert.strictEqual(mailedTo(bEmail), 0, 'accepting a document sends the borrower NO email');
    assert.strictEqual(await countNotif(appId, 'doc_accepted'), 0, 'accepting a document writes NO in-app row either (internal step)');
    ok('accepting a document does not notify the borrower at all (no email, no in-app ping)');

    // A SECOND accept on the same file — still nothing to the borrower.
    sent = [];
    const doc2 = await mkDoc(appId, borrowerId, 'insurance-binder.pdf');
    r = await call(server, 'POST', `/api/staff/documents/${doc2}/review`, token, { action: 'accept' });
    assert.strictEqual(r.status, 200, 'second accept returns 200');
    assert.strictEqual(mailedTo(bEmail), 0, 'a second acceptance also notifies the borrower nothing');
    assert.strictEqual(await countNotif(appId, 'doc_accepted'), 0, 'still no in-app "accepted" row after a second accept');
    ok('repeated internal acceptances never reach the borrower');

    // REJECT a document → the borrower MUST act, so this still emails (surgical fix).
    sent = [];
    const doc3 = await mkDoc(appId, borrowerId, 'blurry-id.jpg');
    r = await call(server, 'POST', `/api/staff/documents/${doc3}/review`, token, { action: 'reject', reason: 'The image is too blurry to read.' });
    assert.strictEqual(r.status, 200, 'reject returns 200');
    assert.ok(mailedTo(bEmail) >= 1, 'a REJECTED document still emails the borrower (they must re-upload)');
    ok('a rejected document still emails — action items are unaffected by the accept fix');

    console.log(`\nAll ${n} doc-accept notification checks passed.`);
  } finally {
    if (appId) { await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM documents WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {}); }
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]).catch(() => {});
    await new Promise((r) => server.close(r));
    await db.pool.end();
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
