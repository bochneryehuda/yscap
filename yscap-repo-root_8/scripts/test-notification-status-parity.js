/**
 * Status-change notification PARITY across BOTH doors + no wrong-time sends
 * (src/routes/staff.js notifyStatusTransition).
 *
 * Owner-directed 2026-07-20: the team drives files through the 38-status ClickUp
 * workflow via POST /applications/:id/internal-status — but that door used to
 * notify NOBODY, so funding/approving a file there gave the borrower no email
 * while the same move via PATCH /applications/:id did. Both doors now call one
 * shared helper. It fires ONLY when the borrower-facing bucket actually changes
 * (many internal statuses map to the same external bucket — re-announcing an
 * unchanged bucket would be a wrong-time/duplicate email) and never on a
 * soft-deleted file.
 *
 * Boots the real Express app as a super_admin and stubs the notify chokepoint to
 * capture what would have been sent. Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-notification-status-parity (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const http = require('http');
const assert = require('assert');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const notify = require('../src/lib/notify');
const app = require('../src/server');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// Capture what the two chokepoints would send, instead of writing rows/email.
let borrowerCalls = [];
let staffCalls = [];
notify.notifyAppBorrowers = async (appId, opts) => { borrowerCalls.push({ appId, opts }); return []; };
notify.notifyAppStaff = async (appId, opts) => { staffCalls.push({ appId, opts }); return []; };
const reset = () => { borrowerCalls = []; staffCalls = []; };

function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Date.now() / 1000)}`;
  let adminId, borrowerId, appId;
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Parity Admin','super_admin',true,false,'x',0) RETURNING id`, [`parity-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Parity','Test',$1) RETURNING id`, [`parity-bo-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, internal_status)
       VALUES ($1,$2,'processing','self procesing') RETURNING id`, [borrowerId, adminId])).rows[0].id;

    // 1) PATCH door → a decision milestone. Borrower IS emailed (major), team notified.
    reset();
    let r = await call(server, 'PATCH', `/api/staff/applications/${appId}`, token, { status: 'approved' });
    assert.strictEqual(r.status, 200, 'PATCH to approved returns 200');
    assert.strictEqual(borrowerCalls.length, 1, 'PATCH door notifies the borrower once');
    assert.strictEqual(borrowerCalls[0].opts.type, 'status_change', 'borrower notify is a status_change');
    assert.strictEqual(borrowerCalls[0].opts.major, true, 'approved is a MAJOR borrower email');
    assert.ok(/approved/i.test(borrowerCalls[0].opts.title), 'borrower title names the new status');
    assert.strictEqual(staffCalls.length, 1, 'PATCH door notifies the team once');
    ok('PATCH /:id door announces the transition to borrower + team');

    // Reset the file back to processing/self procesing for the internal-status cases.
    await db.query(`UPDATE applications SET status='processing', internal_status='self procesing' WHERE id=$1`, [appId]);

    // 2) INTERNAL-STATUS door → an internal status that CHANGES the external bucket
    //    (processing → funded). Borrower IS notified now (was silent before the fix).
    reset();
    r = await call(server, 'POST', `/api/staff/applications/${appId}/internal-status`, token, { internalStatus: 'closed (6-email funded)' });
    assert.strictEqual(r.status, 200, 'internal-status to a funded bucket returns 200');
    assert.strictEqual(JSON.parse(r.body).status, 'funded', 'external bucket re-derived to funded');
    assert.strictEqual(borrowerCalls.length, 1, 'internal-status door notifies the borrower when the bucket changes');
    assert.strictEqual(borrowerCalls[0].opts.major, true, 'funded is a MAJOR borrower email via the internal door too');
    assert.strictEqual(staffCalls.length, 1, 'internal-status door notifies the team when the bucket changes');
    ok('internal-status door reaches parity — funding via the 38-status dropdown emails the borrower');

    // 3) INTERNAL-STATUS door → a DIFFERENT internal status in the SAME external
    //    bucket (self procesing → assigned to processor, both = processing). NO
    //    borrower/team announcement (would be a wrong-time / duplicate email).
    await db.query(`UPDATE applications SET status='processing', internal_status='self procesing' WHERE id=$1`, [appId]);
    reset();
    r = await call(server, 'POST', `/api/staff/applications/${appId}/internal-status`, token, { internalStatus: 'assigned to processor' });
    assert.strictEqual(r.status, 200, 'same-bucket internal move returns 200');
    assert.strictEqual(JSON.parse(r.body).status, 'processing', 'external bucket unchanged (still processing)');
    assert.strictEqual(borrowerCalls.length, 0, 'a same-bucket internal move does NOT re-announce to the borrower');
    assert.strictEqual(staffCalls.length, 0, 'a same-bucket internal move does NOT re-announce to the team');
    ok('a same-bucket internal-status move sends nothing (no wrong-time/duplicate email)');

    // 4) A soft-deleted file never announces a status move (it is out of the pipeline).
    await db.query(`UPDATE applications SET status='processing', internal_status='self procesing', deleted_at=now() WHERE id=$1`, [appId]);
    reset();
    r = await call(server, 'PATCH', `/api/staff/applications/${appId}`, token, { status: 'underwriting' });
    assert.strictEqual(borrowerCalls.length, 0, 'a soft-deleted file never emails the borrower a status move');
    ok('a soft-deleted file is skipped (no wrong-time send)');
    await db.query(`UPDATE applications SET deleted_at=NULL WHERE id=$1`, [appId]);

    console.log(`\nAll ${n} status-parity checks passed.`);
  } finally {
    if (appId) { await db.query(`DELETE FROM notifications WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM application_status_history WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM application_assignees WHERE application_id=$1`, [appId]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {}); }
    if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]).catch(() => {});
    await new Promise((r) => server.close(r));
    await db.pool.end();
  }
})().catch((e) => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
