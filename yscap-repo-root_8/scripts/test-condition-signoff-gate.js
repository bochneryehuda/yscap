/**
 * Condition sign-off gate (src/routes/staff.js signOffGate + PATCH /checklist/:id).
 *
 * Owner-directed 2026-07-20 ("major fatal"): a REQUIRED condition can never be
 * signed off until it is FULFILLED — no role bypasses it (the old super_admin
 * override is gone), and the structured-DATA conditions (appraisal credit card,
 * title contact, insurance contact) are gated on their data, not just documents.
 * Only an OPTIONAL condition (is_required=false) may be completed empty.
 *
 * Boots the real Express app and drives the real endpoint as a SUPER_ADMIN.
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-condition-signoff-gate (no DATABASE_URL)'); process.exit(0); }
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
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function mkItem(appId, code, over = {}) {
  const t = await db.query(`SELECT id, item_kind, tool_key, is_required, label FROM checklist_templates WHERE code=$1`, [code]);
  const tpl = t.rows[0];
  const r = await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required)
     VALUES ($1,'application',$2,$3,'received',$4,$5,$6) RETURNING id`,
    [tpl.id, appId, tpl.label, over.item_kind || tpl.item_kind,
     over.tool_key !== undefined ? over.tool_key : tpl.tool_key,
     over.is_required !== undefined ? over.is_required : tpl.is_required]);
  return r.rows[0].id;
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let adminId, borrowerId;
  try {
    adminId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Gate Admin','super_admin',true,false,'x',0) RETURNING id`, [`gate-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Gate','Test',$1) RETURNING id`, [`gate-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, adminId])).rows[0].id;

    const govId = await mkItem(appId, 'rtl_p1_id');            // required document, no doc
    const card  = await mkItem(appId, 'rtl_p1_apprcard');      // credit card, none
    const titleC = await mkItem(appId, 'rtl_p1_titlec');       // title contact, none
    const insC   = await mkItem(appId, 'rtl_p1_insc');         // insurance contact, none
    const optDoc = await mkItem(appId, 'rtl_cond_investorstruct', { is_required: false });

    const so = (id) => call(server, 'PATCH', `/api/staff/checklist/${id}`, token, { signedOff: true });

    assert((await so(govId)).status === 422, 'required document (gov-ID) blocked for super_admin with nothing uploaded');
    assert((await so(card)).status === 422, 'appraisal credit-card blocked with no card on file');
    assert((await so(titleC)).status === 422, 'title contact blocked with no contact linked');
    assert((await so(insC)).status === 422, 'insurance contact blocked with no contact linked');
    assert((await so(optDoc)).status === 200, 'OPTIONAL document condition may be signed off empty');

    await db.query(`INSERT INTO application_payment_cards (application_id, borrower_id, card_encrypted, last4) VALUES ($1,$2,'enc','1111')`, [appId, borrowerId]);
    assert((await so(card)).status === 200, 'credit-card sign-off allowed once the card is on file');

    const sct = (await db.query(`INSERT INTO service_contacts (borrower_id,contact_type,company_name) VALUES ($1,'title_company','Acme Title') RETURNING id`, [borrowerId])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id,service_contact_id,contact_type) VALUES ($1,$2,'title_company')`, [appId, sct]);
    assert((await so(titleC)).status === 200, 'title-contact sign-off allowed once the contact is linked');

    const sci = (await db.query(`INSERT INTO service_contacts (borrower_id,contact_type,company_name) VALUES ($1,'insurance_agent','Acme Ins') RETURNING id`, [borrowerId])).rows[0].id;
    await db.query(`INSERT INTO application_service_contacts (application_id,service_contact_id,contact_type) VALUES ($1,$2,'insurance_agent')`, [appId, sci]);
    assert((await so(insC)).status === 200, 'insurance-contact sign-off allowed once the contact is linked');

    // Government-ID REUSE: the photo ID is collected once on the borrower profile
    // and reused across files. A file's gov-ID condition with NO document linked
    // to its own item, but the borrower carrying photo_id_document_id, must still
    // be signable — the strict doc gate must NOT falsely block a reused ID.
    const docId = (await db.query(`INSERT INTO documents (filename) VALUES ('gov-id.pdf') RETURNING id`)).rows[0].id;
    await db.query(`UPDATE borrowers SET photo_id_document_id=$2 WHERE id=$1`, [borrowerId, docId]);
    assert((await so(govId)).status === 200, 'reused gov-ID (photo on profile, none linked to this item) is signable');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL condition sign-off gate assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    // Clean up the rows this run created (borrowers/applications cascade).
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
