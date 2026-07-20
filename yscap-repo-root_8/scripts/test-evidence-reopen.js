/**
 * A condition's sign-off is dropped when its document EVIDENCE becomes invalid
 * (src/lib/checklist-evidence.js + the reject / new-version / appraisal-undo /
 * gov-ID-reuse paths).
 *
 * Root cause found in a proactive audit: reject / replace / undo rewrote a
 * condition's status but left signed_off_at set, so the clear-to-close gate and
 * pipeline KPIs — which read (signed_off_at IS NOT NULL OR status='satisfied') —
 * kept counting a condition as done on evidence that was rejected or removed. A
 * file could close on paperwork a reviewer already rejected. This proves the
 * sign-off now drops on every such event, and that a rejected reused gov-ID no
 * longer passes the gate.
 *
 * Boots the real app + drives the real endpoints as a super_admin. Requires
 * DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-evidence-reopen (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const desk = require('../src/lib/appraisal/desk');

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
async function mkItem(appId, code, status = 'received') {
  const t = (await db.query(`SELECT id, item_kind, is_required FROM checklist_templates WHERE code=$1`, [code])).rows[0];
  return (await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, is_required)
     VALUES ($1,'application',$2,$3,$4,$5,$6) RETURNING id`,
    [t.id, appId, code, status, t.item_kind, t.is_required])).rows[0].id;
}
async function mkDoc(appId, borrowerId, itemId, over = {}) {
  return (await db.query(
    `INSERT INTO documents (application_id, borrower_id, checklist_item_id, filename, is_current, review_status, doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [appId, borrowerId, itemId, over.filename || 'doc.pdf',
     over.is_current !== undefined ? over.is_current : true,
     over.review_status || 'accepted', over.doc_kind || null])).rows[0].id;
}
const st = async (id) => (await db.query(`SELECT status, signed_off_at FROM checklist_items WHERE id=$1`, [id])).rows[0];

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let adminId, borrowerId;
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Ev Admin','super_admin',true,false,'x',0) RETURNING id`, [`ev-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ev','Test',$1) RETURNING id`, [`ev-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, adminId])).rows[0].id;
    const so = (id) => call(server, 'PATCH', `/api/staff/checklist/${id}`, token, { signedOff: true });
    const review = (docId, action, reason) => call(server, 'POST', `/api/staff/documents/${docId}/review`, token, { action, reason });

    // --- H3: rejecting the document drops the sign-off ---
    const item1 = await mkItem(appId, 'rtl_p3_assets');
    const doc1 = await mkDoc(appId, borrowerId, item1);
    assert((await so(item1)).status === 200, 'a condition with a current accepted doc can be signed off');
    let s = await st(item1);
    assert(s.status === 'satisfied' && s.signed_off_at != null, 'it is now satisfied + signed off');
    assert((await review(doc1, 'reject', 'blurry')).status === 200, 'the document is rejected');
    s = await st(item1);
    assert(s.status === 'issue' && s.signed_off_at == null, 'REJECT re-opens the condition and clears the sign-off (H3)');

    // --- M2: a rejected reused gov-ID does NOT pass the gate; an accepted one does ---
    const item2 = await mkItem(appId, 'rtl_p1_id');
    const rejectedId = await mkDoc(appId, borrowerId, null, { review_status: 'rejected', filename: 'id-bad.pdf' });
    await db.query(`UPDATE borrowers SET photo_id_document_id=$2 WHERE id=$1`, [borrowerId, rejectedId]);
    assert((await so(item2)).status === 422, 'a REJECTED on-file photo ID does not fulfill the gov-ID condition (M2)');
    const goodId = await mkDoc(appId, borrowerId, null, { review_status: 'accepted', filename: 'id-good.pdf' });
    await db.query(`UPDATE borrowers SET photo_id_document_id=$2 WHERE id=$1`, [borrowerId, goodId]);
    assert((await so(item2)).status === 200, 'a current accepted on-file photo ID still fulfills it');

    // --- M3: uploading a new version drops the prior sign-off ---
    const item3 = await mkItem(appId, 'rtl_p3_assets');
    await mkDoc(appId, borrowerId, item3);
    assert((await so(item3)).status === 200, 'second condition signed off');
    const pdf = Buffer.from('%PDF-1.4\nnew version\n').toString('base64');
    const up = await call(server, 'POST', `/api/staff/applications/${appId}/documents`, token,
      { filename: 'assets-v2.pdf', contentType: 'application/pdf', dataBase64: pdf, checklistItemId: item3 });
    assert(up.status >= 200 && up.status < 300, 'a new version uploads');
    s = await st(item3);
    assert(s.status === 'received' && s.signed_off_at == null, 'a NEW VERSION clears the prior sign-off for re-review (M3)');

    // --- M1: undoing an appraisal import re-opens the appraisal-documents condition ---
    const item4 = await mkItem(appId, 'rtl_cond_appraisaldocs', 'satisfied');
    await db.query(`UPDATE checklist_items SET signed_off_at=now(), signed_off_by=$2 WHERE id=$1`, [item4, adminId]);
    await mkDoc(appId, borrowerId, item4, { doc_kind: 'appraisal_xml', filename: 'appraisal.xml' });
    await db.query(`INSERT INTO appraisals (application_id, superseded, imported_at) VALUES ($1,false,now())`, [appId]);
    const undo = await desk.undoAppraisalImport(appId, { actor: { id: adminId, kind: 'staff' } });
    assert(undo.ok === true, 'undoAppraisalImport ran');
    s = await st(item4);
    assert(s.status === 'outstanding' && s.signed_off_at == null, 'appraisal UNDO re-opens the appraisal-documents condition (M1)');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL evidence-reopen assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
