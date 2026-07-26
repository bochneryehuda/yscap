/**
 * Staff new-file loan-officer self-assign (src/routes/staff.js POST /applications).
 *
 * Owner-directed 2026-07-20: the staffer OPENING a file is put on it
 * automatically when they are officer-eligible (loan_officer / admin /
 * super_admin) — it never falls to "Lead Capture" just because they didn't pick
 * an officer. A processor/underwriter opener is not a valid LO (stays Lead
 * Capture). An explicit pick still wins.
 *
 * Boots the real app and drives the real endpoint. Requires DATABASE_URL;
 * skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-staff-selfassign (no DATABASE_URL)'); process.exit(0); }
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
const mkStaff = async (role, sfx) => (await db.query(
  `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
   VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`, [`sa-${role}-${sfx}@test.local`, `${role} user`, role])).rows[0].id;
const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });
const body = (sfx, extra = {}) => ({
  borrower: { firstName: 'Self', lastName: 'Assign', email: `sa-bo-${sfx}@test.local` },
  propertyAddress: { line1: '1 Test St', city: 'Testville', state: 'NY', zip: '10001', oneLine: '1 Test St, Testville, NY 10001' },
  ...extra,
});
const officerOf = async (appId) => (await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [appId])).rows[0].loan_officer_id;

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const created = [];
  try {
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const adminId = await mkStaff('admin', sfx);
    const loId = await mkStaff('loan_officer', sfx);
    const prId = await mkStaff('processor', sfx);
    created.push(adminId, loId, prId);

    // admin opens a file, no officer picked -> assigned to the admin
    let r = await call(server, 'POST', '/api/staff/applications', tok(adminId, 'admin'), body(`a-${sfx}`));
    assert(r.status === 201 && (await officerOf(r.body.applicationId)) === adminId, 'admin opener self-assigns (not Lead Capture)');

    // loan officer opens a file, no officer picked -> assigned to that LO
    r = await call(server, 'POST', '/api/staff/applications', tok(loId, 'loan_officer'), body(`lo-${sfx}`));
    assert(r.status === 201 && (await officerOf(r.body.applicationId)) === loId, 'loan-officer opener self-assigns');

    // processor opens a file -> NOT a valid LO -> Lead Capture (null)
    r = await call(server, 'POST', '/api/staff/applications', tok(prId, 'processor'), body(`pr-${sfx}`));
    assert(r.status === 201 && (await officerOf(r.body.applicationId)) === null, 'processor opener stays Lead Capture (null)');

    // explicit pick still wins over the self-assign default
    r = await call(server, 'POST', '/api/staff/applications', tok(adminId, 'admin'), body(`x-${sfx}`, { loanOfficerId: loId }));
    assert(r.status === 201 && (await officerOf(r.body.applicationId)) === loId, 'explicit officer pick still wins');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL staff self-assign assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    for (const id of created) { try { await db.query(`DELETE FROM staff_users WHERE id=$1`, [id]); } catch (_) {} }
    try { await db.query(`DELETE FROM borrowers WHERE email LIKE 'sa-bo-%@test.local'`); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
