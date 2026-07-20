/**
 * A funded / clear-to-close file's loan structure is FROZEN for everyone — and a
 * super_admin can UNLOCK it to make a correction, then re-lock (#84, owner-directed
 * 2026-07-20). Also closes the second door where the internal-status endpoint could
 * advance a file past unsatisfied required gate conditions.
 *
 * Boots the real app + drives the real endpoints. Requires DATABASE_URL; skips
 * cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-funded-lock (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const priceOf = async (id) => Number((await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [id])).rows[0].purchase_price);
const statusOf = async (id) => (await db.query(`SELECT status FROM applications WHERE id=$1`, [id])).rows[0].status;

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let superId, adminId, borrowerId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`fl-super-${sfx}@test.local`])).rows[0].id;
    adminId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Admin','admin',true,false,'x',0) RETURNING id`, [`fl-admin-${sfx}@test.local`])).rows[0].id;
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Fl','Test',$1) RETURNING id`, [`fl-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, purchase_price) VALUES ($1,$2,'funded',500000) RETURNING id`, [borrowerId, superId])).rows[0].id;

    const patch = (tok, body) => call(server, 'PATCH', `/api/staff/applications/${appId}/details`, tok, body);
    const setLock = (tok, unlocked) => call(server, 'POST', `/api/staff/applications/${appId}/structural-lock`, tok, { unlocked });

    // H1 — a funded file's economics editor is blocked, even for a super_admin.
    assert((await patch(superTok, { purchasePrice: 999999 })).status === 409, 'funded file: editing details is blocked (H1) even for super_admin');
    assert((await priceOf(appId)) === 500000, 'the funded price did not change');

    // Only a super_admin may unlock — a regular admin cannot.
    assert((await setLock(adminTok, true)).status === 403, 'a regular admin cannot unlock a frozen file');
    assert((await priceOf(appId)) === 500000, 'still unchanged after the admin unlock attempt');

    // Super_admin unlocks → the edit goes through.
    assert((await setLock(superTok, true)).status === 200, 'a super_admin can unlock the file');
    assert((await patch(superTok, { purchasePrice: 999999 })).status === 200, 'once unlocked, a super_admin can correct the price');
    assert((await priceOf(appId)) === 999999, 'the correction persisted');

    // Re-lock → frozen again.
    assert((await setLock(superTok, false)).status === 200, 'a super_admin can re-lock the file');
    assert((await patch(superTok, { purchasePrice: 888888 })).status === 409, 'after re-locking, editing is blocked again');
    assert((await priceOf(appId)) === 999999, 'the price stayed at the corrected value');

    // F1 — the staff completeness path is also blocked on a funded file (it writes
    // the same frozen economics fields).
    assert((await call(server, 'POST', `/api/staff/applications/${appId}/complete-fields`, superTok, { rehab_budget: '250000' })).status === 409,
      'staff complete-fields is blocked on a funded file (F1)');
    assert((await priceOf(appId)) === 999999, 'complete-fields did not change the funded file');

    // F2 — undoing an appraisal import (which reverts economics) is blocked on funded.
    await db.query(`INSERT INTO appraisals (application_id, superseded, imported_at) VALUES ($1,false,now())`, [appId]);
    assert((await call(server, 'POST', `/api/appraisal/${appId}/undo-import`, superTok, {})).status === 409,
      'appraisal undo-import is blocked on a funded file (F2)');

    // M6 — approving a change request cannot rewrite a funded file's economics.
    const cid = (await db.query(
      `INSERT INTO change_requests (application_id, field, field_label, new_value, status, requested_by_kind, requested_by_id)
       VALUES ($1,'purchase_price','Purchase price','777777','pending','borrower',$2) RETURNING id`, [appId, borrowerId])).rows[0].id;
    assert((await call(server, 'POST', `/api/staff/change-requests/${cid}/approve`, superTok, {})).status === 409, 'approving a change request is blocked on a funded file (M6)');
    assert((await priceOf(appId)) === 999999, 'the change request did not write onto the funded file');

    // H2 — the internal-status endpoint cannot advance a file to funded past an
    // unsatisfied required condition.
    const app2 = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, superId])).rows[0].id;
    const tpl = (await db.query(`SELECT id, label, item_kind FROM checklist_templates WHERE code='rtl_p1_id'`)).rows[0];
    const item = (await db.query(
      `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
       VALUES ($1,'application',$2,$3,'outstanding',$4,true) RETURNING id`, [tpl.id, app2, tpl.label, tpl.item_kind])).rows[0].id;
    const toFunded = () => call(server, 'POST', `/api/staff/applications/${app2}/internal-status`, superTok, { internalStatus: 'closed (6-email funded)' });
    assert((await toFunded()).status === 409, 'internal-status cannot fund a file with an open required condition (H2)');
    assert((await statusOf(app2)) !== 'funded', 'the file did not become funded');
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [item, superId]);
    assert((await toFunded()).status === 200, 'once the condition is satisfied, funding succeeds');
    assert((await statusOf(app2)) === 'funded', 'the file is now funded');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL funded-lock assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
