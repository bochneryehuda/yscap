/**
 * Borrower-side loan-officer LOCK + invite branding (borrower.js draft submit +
 * auth /accept). Owner-directed 2026-07-20:
 *  - a borrower who already has an owning officer (loan officer of record) is
 *    LOCKED to that officer — a client-supplied officer can never override it;
 *  - a borrower with NO owning officer may still request one;
 *  - signing up through an officer's invite link binds the borrower to that
 *    officer (fills a blank owner only).
 *
 * Boots the real app + Postgres. Requires DATABASE_URL; skips otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-borrower-officer-lock (no DATABASE_URL)'); process.exit(0); }
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
    const h = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1', headers: h },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const mkStaff = async (role, tag) => (await db.query(
  `INSERT INTO staff_users (email, full_name, role, is_active, mfa_enabled, password_hash, token_version)
   VALUES ($1,$2,$3,true,false,'x',0) RETURNING id,email`, [`bl-${tag}@test.local`, `${tag} officer`, role])).rows[0];
const officerOf = async (appId) => (await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [appId])).rows[0].loan_officer_id;
const addr = { propertyAddress: { line1: '2 Lock St', city: 'Testville', state: 'NY', zip: '10001', oneLine: '2 Lock St, Testville, NY 10001' } };

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const staffIds = [];
  const boEmails = [];
  try {
    const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
    const own = await mkStaff('loan_officer', `own-${sfx}`);
    const other = await mkStaff('loan_officer', `other-${sfx}`);
    staffIds.push(own.id, other.id);

    // --- 1) LOCK: borrower already owned by `own` submits a draft naming `other` ---
    const bo1 = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,primary_officer_id) VALUES ('Locked','Borrower',$1,$2) RETURNING id`, [`bl-bo1-${sfx}@test.local`, own.id])).rows[0].id;
    boEmails.push(`bl-bo1-${sfx}@test.local`);
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)`, [bo1]);
    const tok1 = C.signJwt({ sub: bo1, kind: 'borrower', role: 'borrower', tv: 0 });
    const draft1 = (await db.query(`INSERT INTO application_drafts (borrower_id,data) VALUES ($1,$2) RETURNING id`, [bo1, JSON.stringify(addr)])).rows[0].id;
    let r = await call(server, 'POST', `/api/borrower/drafts/${draft1}/submit`, tok1, { loanOfficerEmail: other.email });
    assert(r.status === 201 && (await officerOf(r.body.applicationId)) === own.id, 'owning officer WINS over a client-supplied officer (lock)');

    // --- 2) NO owner: borrower requests `other` and gets them ---
    const bo2 = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Free','Borrower',$1) RETURNING id`, [`bl-bo2-${sfx}@test.local`])).rows[0].id;
    boEmails.push(`bl-bo2-${sfx}@test.local`);
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0)`, [bo2]);
    const tok2 = C.signJwt({ sub: bo2, kind: 'borrower', role: 'borrower', tv: 0 });
    const draft2 = (await db.query(`INSERT INTO application_drafts (borrower_id,data) VALUES ($1,$2) RETURNING id`, [bo2, JSON.stringify(addr)])).rows[0].id;
    r = await call(server, 'POST', `/api/borrower/drafts/${draft2}/submit`, tok2, { loanOfficerEmail: other.email });
    assert(r.status === 201 && (await officerOf(r.body.applicationId)) === other.id, 'borrower with no owning officer may request one');

    // --- 3) INVITE stamp: accepting an invite created by `own` binds the borrower to `own` ---
    const inviteEmail = `bl-invitee-${sfx}@test.local`;
    boEmails.push(inviteEmail);
    const rawToken = `tok-${sfx}`;
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,created_by,expires_at) VALUES ($1,'borrower',$2,$3, now() + interval '7 days')`,
      [C.sha256(rawToken), inviteEmail, own.id]);
    r = await call(server, 'POST', '/auth/accept', null, { token: rawToken, password: 'Sup3rSecret!pw', firstName: 'Invited', lastName: 'User' });
    const boInv = (await db.query(`SELECT id, primary_officer_id FROM borrowers WHERE email=$1`, [inviteEmail])).rows[0];
    assert(r.status === 200 && boInv && boInv.primary_officer_id === own.id, 'invite-link signup binds the borrower to the inviting officer');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL borrower officer-lock assertions passed');
  } catch (e) { console.error('ERROR', e); failures++; }
  finally {
    for (const em of boEmails) { try { await db.query(`DELETE FROM borrowers WHERE email=$1`, [em]); } catch (_) {} }
    for (const id of staffIds) { try { await db.query(`DELETE FROM staff_users WHERE id=$1`, [id]); } catch (_) {} }
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
