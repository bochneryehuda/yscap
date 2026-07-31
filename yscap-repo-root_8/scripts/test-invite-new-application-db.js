/**
 * "Invite for a new application" (owner-directed): a staffer starts a loan file
 * from JUST an email, and the borrower fills in the rest themselves.
 *
 *   1. POST /api/staff/applications { inviteOnly:true, borrower:{ email } }
 *      creates a real file (no name / no property required) and sends the invite.
 *   2. The email is still the ONE hard requirement (missing → 400).
 *   3. A NORMAL create (no inviteOnly) still requires a name + address (400) —
 *      the relaxation is scoped to invite-only.
 *   4. The borrower then adds the subject PROPERTY ADDRESS via complete-fields
 *      (previously not borrower-editable), and it persists.
 *
 * Requires DATABASE_URL; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-invite-new-application-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const call = (method, path, token, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });

  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let staffId, borrowerId, appId;
  const inviteEmail = `invite-bo-${sfx}@test.local`;
  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
       VALUES ($1,'Invite Admin','super_admin',true,false,'x',0) RETURNING id`, [`invite-admin-${sfx}@test.local`])).rows[0].id;
    const stTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    // 1) INVITE-ONLY: email only, no name, no property → a real file + an invite.
    const created = await call('POST', '/api/staff/applications', stTok, { inviteOnly: true, borrower: { email: inviteEmail } });
    assert(created.status === 201, 'invite-only create returns 201 from just an email');
    assert(created.body && created.body.applicationId, 'invite-only create returns an applicationId');
    appId = created.body && created.body.applicationId;
    borrowerId = created.body && created.body.borrowerId;
    // The invite token is committed before the (best-effort) email is sent, so it
    // is the authoritative proof the invite was issued regardless of the mailer.
    const tok = (await db.query(
      `SELECT count(*)::int n FROM invite_tokens WHERE kind='borrower' AND lower(email)=lower($1)`, [inviteEmail])).rows[0];
    assert(tok && tok.n >= 1, 'invite-only ALWAYS issues the borrower invite');

    if (appId) {
      const row = (await db.query(`SELECT borrower_id, property_address, loan_officer_id FROM applications WHERE id=$1`, [appId])).rows[0];
      assert(row && row.property_address == null, 'invite-only file starts with NO property address (borrower fills it)');
      assert(row && row.borrower_id === borrowerId, 'the returned borrower owns the created file');
      assert(row && row.loan_officer_id === staffId, 'the inviting staffer is put on the file');
      const bemail = (await db.query(`SELECT lower(email) e FROM borrowers WHERE id=$1`, [borrowerId])).rows[0];
      assert(bemail && bemail.e === inviteEmail.toLowerCase(), 'the borrower row carries the invited email');
    }

    // 2) email is still the ONE hard requirement.
    const noEmail = await call('POST', '/api/staff/applications', stTok, { inviteOnly: true, borrower: {} });
    assert(noEmail.status === 400, 'invite-only still requires an email');

    // 3) a NORMAL create (no inviteOnly) still requires a first name + address.
    const normal = await call('POST', '/api/staff/applications', stTok, { borrower: { email: `normal-${sfx}@test.local` } });
    assert(normal.status === 400, 'a normal create (not invite-only) still requires more than an email');

    // 4) the BORROWER adds the subject property address themselves via completeness.
    if (borrowerId && appId) {
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)
                      ON CONFLICT (borrower_id) DO NOTHING`, [borrowerId]);
      const boTok = C.signJwt({ sub: borrowerId, kind: 'borrower', role: 'borrower', tv: 0 });
      // Send only the parts (no oneLine) — the server must build the one-line.
      const addrSave = await call('POST', `/api/borrower/applications/${appId}/complete-fields`, boTok,
        { property_address: { street: '12 Highland St', city: 'Lakewood', state: 'NJ', zip: '08701' } });
      assert(addrSave.status >= 200 && addrSave.status < 300, 'borrower can add the property address via complete-fields');
      const pa = (await db.query(`SELECT property_address AS a FROM applications WHERE id=$1`, [appId])).rows[0].a;
      assert(pa && String(pa.city) === 'Lakewood', 'the property address persisted (re-read from the DB)');
      assert(pa && String(pa.oneLine || '').includes('12 Highland St'), 'the server built a display one-line from the parts');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL invite-new-application assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    try { if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]); } catch (_) {}
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { await db.query(`DELETE FROM borrowers WHERE lower(email) LIKE $1`, [`%${sfx}@test.local`]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
