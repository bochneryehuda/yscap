/**
 * Staff enters the title/insurance contact ON the condition (owner-directed
 * 2026-07-20): the staff file-contacts endpoint the inline StaffContactEntry form
 * calls must link the contact AND let the condition be signed off afterward
 * (it stays blocked until the contact exists — the signOffGate structured-data
 * check). Requires DATABASE_URL; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-staff-contact-entry (no DATABASE_URL)'); process.exit(0); }
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
async function mkItem(appId, code) {
  const t = await db.query(`SELECT id, item_kind, tool_key, label FROM checklist_templates WHERE code=$1`, [code]);
  const tpl = t.rows[0];
  return (await db.query(
    `INSERT INTO checklist_items (template_id, scope, application_id, label, status, item_kind, tool_key, is_required)
     VALUES ($1,'application',$2,$3,'received',$4,$5,true) RETURNING id`,
    [tpl.id, appId, tpl.label, tpl.item_kind, tpl.tool_key])).rows[0].id;
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  let adminId, borrowerId;
  try {
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    adminId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'A','super_admin',true,false,'x',0) RETURNING id`, [`ce-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ce','Test',$1) RETURNING id`, [`ce-bo-${sfx}@test.local`])).rows[0].id;
    const appId = (await db.query(`INSERT INTO applications (borrower_id,loan_officer_id,status) VALUES ($1,$2,'processing') RETURNING id`, [borrowerId, adminId])).rows[0].id;
    const titleItem = await mkItem(appId, 'rtl_p1_titlec');

    // sign-off blocked before any contact
    assert((await call(server, 'PATCH', `/api/staff/checklist/${titleItem}`, token, { signedOff: true })).status === 422,
      'title condition is blocked before a contact is entered');

    // staff enters the title contact ON the condition (what StaffContactEntry POSTs)
    const add = await call(server, 'POST', `/api/staff/applications/${appId}/file-contacts`, token,
      { contactType: 'title_company', companyName: 'Acme Title', contactName: 'Pat', email: 'pat@acme.test', phone: '5551234567', checklistItemId: titleItem });
    assert(add.status === 201 && add.body && add.body.linkId, 'staff can add the title contact via the file-contacts endpoint');

    // it is now linked to the file as a title_company contact
    const linked = (await db.query(`SELECT count(*)::int n FROM application_service_contacts WHERE application_id=$1 AND contact_type='title_company'`, [appId])).rows[0].n;
    assert(linked === 1, 'the contact is linked to the file');

    // and the condition can now be signed off
    assert((await call(server, 'PATCH', `/api/staff/checklist/${titleItem}`, token, { signedOff: true })).status === 200,
      'title condition is signable once staff entered the contact');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL staff contact-entry assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
