/**
 * Clear the appraisal credit card OFF a file (DELETE /api/staff/applications/:id/appraisal-card).
 *
 * Owner-directed: the staff member gets a button to clear the credit card from the
 * file, behind a double warning that it is gone for good. So the things that must
 * hold here are about what "for good" costs the file:
 *   - the encrypted card row is really deleted (there is no copy to restore from);
 *   - a condition that only read 'received' BECAUSE of that card goes back to
 *     outstanding, so nobody signs off on a card that is no longer there;
 *   - a condition a HUMAN already finished (signed off / satisfied / waived) is left
 *     alone — reopening it would put finished work back on someone's list;
 *   - the borrower's own saved card lives on their PROFILE, so the clear never
 *     touches it and says so;
 *   - only somebody who may touch the file may do it, and every clear is audited.
 *
 * Boots the real Express app and drives the real endpoints as a SUPER_ADMIN.
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-card-clear-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const apprCard = require('../src/lib/appraisal-card');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

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
const json = (r) => { try { return JSON.parse(r.body); } catch (_) { return {}; } };

// A valid card the shared validator accepts (Luhn-good test number, future expiry).
const CARD = { number: '4111111111111111', expMonth: 12, expYear: new Date().getFullYear() + 3, cvc: '123', zip: '11219' };

async function mkCardItem(appId) {
  const t = await db.query(`SELECT id, label, item_kind, tool_key, is_required FROM checklist_templates WHERE code='rtl_p1_apprcard'`);
  const tpl = t.rows[0];
  const r = await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required)
     VALUES ($1,'application',$2,$3,'outstanding',$4,$5,$6) RETURNING id`,
    [tpl.id, appId, tpl.label, tpl.item_kind, tpl.tool_key, tpl.is_required]);
  return r.rows[0].id;
}
const statusOf = async (itemId) =>
  (await db.query(`SELECT status, signed_off_at, waived_at FROM checklist_items WHERE id=$1`, [itemId])).rows[0];
const cardRows = async (appId) =>
  (await db.query(`SELECT 1 FROM application_payment_cards WHERE application_id=$1`, [appId])).rows.length;

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let adminId, otherId, borrowerId;
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Card Admin','super_admin',true,false,'x',0) RETURNING id`, [`card-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    // A loan officer on NO file — the horizontal-authorization control.
    otherId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Other LO','loan_officer',true,false,'x',0) RETURNING id`, [`card-lo-${sfx}@test.local`])).rows[0].id;
    const otherToken = C.signJwt({ sub: otherId, kind: 'staff', role: 'loan_officer', tv: 0 });

    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Card','Test',$1) RETURNING id`,
      [`card-bo-${sfx}@test.local`])).rows[0].id;
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`,
      [borrowerId, adminId])).rows[0].id;

    // ---- 1. nothing to clear ------------------------------------------------
    const appA = await mkApp();
    const itemA = await mkCardItem(appA);
    assert((await call(server, 'DELETE', `/api/staff/applications/${appA}/appraisal-card`, token)).status === 404,
      'clearing a file with no card answers "no card on file" rather than pretending it worked');

    // ---- 2. the ordinary case: entered, then cleared -------------------------
    const saved = await call(server, 'POST', `/api/staff/applications/${appA}/appraisal-card`, token, CARD);
    assert(saved.status === 201, 'a card can be entered on the file');
    assert((await statusOf(itemA)).status === 'received', 'entering the card moves the condition to received');
    assert(await cardRows(appA) === 1, 'the encrypted card row is on the file');

    const cleared = await call(server, 'DELETE', `/api/staff/applications/${appA}/appraisal-card`, token);
    const out = json(cleared);
    assert(cleared.status === 200, 'the card clears');
    assert(out.last4 === '1111', 'the clear reports which card went, so the team can say so');
    assert(await cardRows(appA) === 0, 'the encrypted card row is GONE — there is nothing left to retrieve');
    assert((await statusOf(itemA)).status === 'outstanding' && out.reopened === true,
      'the condition is outstanding again — nobody can sign off on a card that is no longer there');
    assert((await call(server, 'GET', `/api/staff/applications/${appA}/appraisal-card`, token)).status === 404,
      'revealing the card afterwards finds nothing');
    const aud = await db.query(
      `SELECT 1 FROM audit_log WHERE action='clear_appraisal_card' AND entity_id=$1 LIMIT 1`, [appA]);
    assert(aud.rows.length === 1, 'the clear is audited — the audit trail is the only record it was ever there');

    // ---- 3. finished work is never reopened ---------------------------------
    const appB = await mkApp();
    const itemB = await mkCardItem(appB);
    await call(server, 'POST', `/api/staff/applications/${appB}/appraisal-card`, token, CARD);
    await db.query(`UPDATE checklist_items SET status='satisfied', signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [itemB, adminId]);
    const clearedB = json(await call(server, 'DELETE', `/api/staff/applications/${appB}/appraisal-card`, token));
    const stB = await statusOf(itemB);
    assert(await cardRows(appB) === 0, 'a signed-off file still clears its card');
    assert(stB.status === 'satisfied' && stB.signed_off_at && clearedB.reopened === false,
      'a condition somebody already signed off is left alone — the appraisal was paid, that work is done');

    const appC = await mkApp();
    const itemC = await mkCardItem(appC);
    await call(server, 'POST', `/api/staff/applications/${appC}/appraisal-card`, token, CARD);
    await db.query(`UPDATE checklist_items SET waived_at=now(), waived_by=$2 WHERE id=$1`, [itemC, adminId]);
    const clearedC = json(await call(server, 'DELETE', `/api/staff/applications/${appC}/appraisal-card`, token));
    assert((await statusOf(itemC)).status === 'received' && clearedC.reopened === false,
      'a waived condition is left alone too');

    // ---- 4. the borrower's own saved card is a DIFFERENT thing ---------------
    assert(clearedC.savedCopyRemains === false,
      'with nothing saved on the profile, the clear says nothing survives');
    const appD = await mkApp();
    await mkCardItem(appD);
    await call(server, 'POST', `/api/staff/applications/${appD}/appraisal-card`, token, CARD);
    await apprCard.saveCardForReuse(borrowerId, CARD);            // the borrower's opt-in profile copy
    const clearedD = json(await call(server, 'DELETE', `/api/staff/applications/${appD}/appraisal-card`, token));
    assert(clearedD.savedCopyRemains === true,
      'the clear says plainly that the borrower kept a saved card on their own profile');
    assert((await apprCard.getSavedCard(borrowerId)).available === true,
      'clearing the FILE never touches the borrower profile copy — it is not on this file');

    // ---- 5. only somebody who may touch the file may clear it ----------------
    const appE = await mkApp();
    await mkCardItem(appE);
    await call(server, 'POST', `/api/staff/applications/${appE}/appraisal-card`, token, CARD);
    assert((await call(server, 'DELETE', `/api/staff/applications/${appE}/appraisal-card`, otherToken)).status === 403,
      'a staffer with no relationship to the file cannot clear its card');
    assert(await cardRows(appE) === 1, 'and the card is still there after the refusal');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL appraisal-card clear assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    try { if (otherId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [otherId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
