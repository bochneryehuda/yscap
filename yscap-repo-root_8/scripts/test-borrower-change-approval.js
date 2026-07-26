/**
 * Universal borrower change-request approval after acceptance (owner-directed
 * 2026-07-20, Q3+Q4): once a borrower has an ACCEPTED file (a current product
 * registration), they can no longer change ANYTHING directly — economics OR their
 * personal identity (name/DOB/SSN/phone/FICO/citizenship). Every edit becomes a
 * pending change_request the loan team approves; nothing is applied until approval.
 *
 * Boots the real app and drives the real borrower + staff endpoints. Asserts:
 *   • before acceptance, a personal edit writes LIVE (no request);
 *   • after acceptance, each personal edit becomes a pending request, NOT a write;
 *   • SSN is stored ENCRYPTED + shown MASKED (never plaintext in the queue);
 *   • staff APPROVE applies to the borrower row (name/DOB/SSN land correctly);
 *   • staff REJECT leaves the row untouched;
 *   • a co-borrower cannot see the primary's personal requests;
 *   • the economics path still works (regression).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-borrower-change-approval (no DATABASE_URL)'); process.exit(0); }
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
async function mkBorrower(sfx, who) {
  const bid = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ($1,'Test',$2,'1980-01-01') RETURNING id`, [who, `${who}-${sfx}@test.local`])).rows[0].id;
  await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [bid]);
  return { bid, tok: C.signJwt({ sub: bid, kind: 'borrower', tv: 0 }) };
}
const dobOf = async (bid) => (await db.query(`SELECT date_of_birth FROM borrowers WHERE id=$1`, [bid])).rows[0].date_of_birth;
const nameOf = async (bid) => (await db.query(`SELECT first_name FROM borrowers WHERE id=$1`, [bid])).rows[0].first_name;
const ssnLast4 = async (bid) => (await db.query(`SELECT ssn_last4 FROM borrowers WHERE id=$1`, [bid])).rows[0].ssn_last4;
const pendingCount = async (appId) => Number((await db.query(`SELECT count(*)::int c FROM change_requests WHERE application_id=$1 AND status='pending'`, [appId])).rows[0].c);

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let primaryId, coId, staffId, appId;
  try {
    staffId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'LO','loan_officer',true,false,'x',0) RETURNING id`, [`cra-lo-${sfx}@test.local`])).rows[0].id;
    const staffTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const primary = await mkBorrower(sfx, 'primary'); primaryId = primary.bid;
    const co = await mkBorrower(sfx, 'co'); coId = co.bid;
    appId = (await db.query(`INSERT INTO applications (borrower_id, co_borrower_id, loan_officer_id, status) VALUES ($1,$2,$3,'processing') RETURNING id`, [primaryId, coId, staffId])).rows[0].id;

    const putProfile = (tok, body) => call(server, 'PUT', '/api/borrower/profile', tok, body);

    // ---- BEFORE acceptance: a personal edit writes LIVE (no request) ----
    assert((await putProfile(primary.tok, { firstName: 'Aaron' })).status === 200, 'pre-acceptance: profile save ok');
    assert((await nameOf(primaryId)) === 'Aaron', 'pre-acceptance: name written live (no lock yet)');
    assert((await pendingCount(appId)) === 0, 'pre-acceptance: no change requests created');

    // ---- Accept the file: register a product (is_current) ----
    await db.query(
      `INSERT INTO product_registrations (application_id, program, inputs, quote, is_current)
       VALUES ($1,'Bridge','{}'::jsonb,'{}'::jsonb,true)`, [appId]);

    // ---- AFTER acceptance: personal edits become pending requests, NOT writes ----
    const r1 = await putProfile(primary.tok, { firstName: 'Aharon', dateOfBirth: '1979-05-06', ssn: '123-45-6789' });
    assert(r1.status === 200 && r1.body.locked === true, 'post-acceptance: profile save returns locked');
    assert(Array.isArray(r1.body.changeRequested) && r1.body.changeRequested.length === 3, 'three identity edits became change requests (name, DOB, SSN)');
    assert((await nameOf(primaryId)) === 'Aaron', 'name NOT written live (still Aaron)');
    assert((await dobOf(primaryId)) === '1980-01-01', 'DOB NOT written live');
    assert((await ssnLast4(primaryId)) == null, 'SSN NOT written live');
    assert((await pendingCount(appId)) === 3, 'three pending requests exist');

    // ---- SSN is stored ENCRYPTED + MASKED, never plaintext ----
    const ssnCr = (await db.query(`SELECT new_value, new_value_encrypted, old_value FROM change_requests WHERE application_id=$1 AND field='ssn' AND status='pending'`, [appId])).rows[0];
    assert(ssnCr && /^•••-••-6789$/.test(ssnCr.new_value), 'SSN request shows a MASKED new value');
    assert(ssnCr && ssnCr.new_value_encrypted && !/6789/.test(ssnCr.new_value_encrypted) && !ssnCr.new_value_encrypted.includes('123456789'),
      'SSN clear digits are NOT in the queue (encrypted payload only)');

    // ---- A co-borrower cannot SEE the primary's personal requests ----
    const coView = await call(server, 'GET', `/api/borrower/applications/${appId}/change-requests`, co.tok);
    assert(coView.status === 200, 'co-borrower can read the change-requests list');
    assert(!(coView.body.requests || []).some((x) => x.field === 'ssn' || x.field === 'date_of_birth' || x.field === 'first_name'),
      'co-borrower does NOT see the primary’s personal requests');

    // ---- Staff APPROVE name + DOB + SSN → applied to the borrower row ----
    const crs = (await db.query(`SELECT id, field FROM change_requests WHERE application_id=$1 AND status='pending'`, [appId])).rows;
    for (const cr of crs) {
      const ap = await call(server, 'POST', `/api/staff/change-requests/${cr.id}/approve`, staffTok, {});
      assert(ap.status === 200, `approve ${cr.field} -> 200`);
    }
    assert((await nameOf(primaryId)) === 'Aharon', 'approved name applied to borrower row');
    assert((await dobOf(primaryId)) === '1979-05-06', 'approved DOB applied to borrower row');
    assert((await ssnLast4(primaryId)) === '6789', 'approved SSN last4 applied to borrower row');
    // and the encrypted SSN decrypts back to the real digits
    const enc = (await db.query(`SELECT ssn_encrypted FROM borrowers WHERE id=$1`, [primaryId])).rows[0].ssn_encrypted;
    assert(C.decryptSSN(enc) === '123456789', 'approved SSN decrypts to the real 9 digits');
    assert((await pendingCount(appId)) === 0, 'no pending requests remain after approvals');

    // ---- Staff REJECT leaves the row untouched ----
    const r2 = await putProfile(primary.tok, { firstName: 'Zzz' });
    assert(r2.body.changeRequested.length === 1, 'a new name edit made one request');
    const rid = (await db.query(`SELECT id FROM change_requests WHERE application_id=$1 AND status='pending'`, [appId])).rows[0].id;
    assert((await call(server, 'POST', `/api/staff/change-requests/${rid}/reject`, staffTok, { note: 'no' })).status === 200, 'reject -> 200');
    assert((await nameOf(primaryId)) === 'Aharon', 'rejected name did NOT change the row');

    // ---- Economics regression: an economics edit still becomes a request + applies ----
    const eco = await call(server, 'POST', `/api/borrower/applications/${appId}/complete-fields`, primary.tok, { arv: '525000' });
    assert(eco.status === 200 && eco.body.locked === true, 'complete-fields locked on accepted file');
    const ecoCr = (await db.query(`SELECT id FROM change_requests WHERE application_id=$1 AND field='arv' AND status='pending'`, [appId])).rows[0];
    assert(!!ecoCr, 'economics ARV edit became a change request');
    assert((await call(server, 'POST', `/api/staff/change-requests/${ecoCr.id}/approve`, staffTok, {})).status === 200, 'approve ARV -> 200');
    assert(Number((await db.query(`SELECT arv FROM applications WHERE id=$1`, [appId])).rows[0].arv) === 525000, 'approved ARV applied to the application');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL borrower-change-approval assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (appId) await db.query(`DELETE FROM change_requests WHERE application_id=$1`, [appId]); } catch (_) {}
    try { if (appId) await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [appId]); } catch (_) {}
    try { if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) {}
    try { if (primaryId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [primaryId]); } catch (_) {}
    try { if (coId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [coId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
