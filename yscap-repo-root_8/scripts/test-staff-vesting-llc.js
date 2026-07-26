/**
 * Staff new-file vesting entity (owner-directed 2026-07-20): the staff create
 * endpoint persists which LLC the property is purchased under — a typed entity
 * NAME is created on the borrower, or a picked llcId is used — through the
 * vesting chokepoint (which also wires the LLC condition). Requires DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-staff-vesting-llc (no DATABASE_URL)'); process.exit(0); }
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

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  let adminId; const boEmails = [];
  try {
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    adminId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'A','super_admin',true,false,'x',0) RETURNING id`, [`vl-admin-${sfx}@test.local`])).rows[0].id;
    const token = C.signJwt({ sub: adminId, kind: 'staff', role: 'super_admin', tv: 0 });
    const boEmail = `vl-bo-${sfx}@test.local`; boEmails.push(boEmail);
    const base = { borrower: { firstName: 'Vest', lastName: 'Test', email: boEmail },
      propertyAddress: { line1: '9 Vest St', city: 'Testville', state: 'NY', zip: '10001', oneLine: '9 Vest St, Testville, NY 10001' } };

    // (1) typed entity NAME -> LLC created on the borrower + set as vesting + LLC condition wired
    let r = await call(server, 'POST', '/api/staff/applications', token, { ...base, entityName: 'Vesta Holdings LLC' });
    assert(r.status === 201, 'file created with a typed entity name');
    const app1 = r.body.applicationId, borrowerId = r.body.borrowerId;
    const llc1 = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [app1])).rows[0].llc_id;
    assert(!!llc1, 'the application vests in an LLC (llc_id set)');
    const named = (await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(llc_name)=lower($2)`, [borrowerId, 'Vesta Holdings LLC'])).rows[0];
    assert(named && named.id === llc1, 'the LLC was created on the borrower by the typed name and linked');
    const cond = (await db.query(`SELECT count(*)::int n FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id WHERE ci.application_id=$1 AND t.code='rtl_p1_llc'`, [app1])).rows[0].n;
    assert(cond >= 1, 'the LLC (vesting) condition was wired onto the file');

    // (2) picked llcId (existing, same borrower) -> used as vesting on a second file
    r = await call(server, 'POST', '/api/staff/applications', token, { ...base, llcId: llc1 });
    assert(r.status === 201, 'second file created with a picked LLC id');
    const llc2 = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [r.body.applicationId])).rows[0].llc_id;
    assert(String(llc2) === String(llc1), 'the picked LLC id is set as the vesting entity');

    // (3) an LLC NOT owned by this borrower is ignored (never cross-links)
    const otherBo = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('X','Y',$1) RETURNING id`, [`vl-other-${sfx}@test.local`])).rows[0].id;
    boEmails.push(`vl-other-${sfx}@test.local`);
    const foreignLlc = (await db.query(`INSERT INTO llcs (borrower_id,llc_name) VALUES ($1,'Foreign LLC') RETURNING id`, [otherBo])).rows[0].id;
    r = await call(server, 'POST', '/api/staff/applications', token, { ...base, llcId: foreignLlc });
    const llc3 = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [r.body.applicationId])).rows[0].llc_id;
    assert(r.status === 201 && !llc3, "another borrower's LLC is ignored (no cross-link)");

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL staff vesting-LLC assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    for (const em of boEmails) { try { await db.query(`DELETE FROM borrowers WHERE email=$1`, [em]); } catch (_) {} }
    try { if (adminId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [adminId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
