/**
 * TPO PORTAL — Phase 3 (files, borrowers & PII) end-to-end, real Postgres + HTTP.
 *
 * Proves:
 *   • a broker ENTERS a loan → a borrower + a TPO-stamped application (is_tpo,
 *     firm, broker as loan officer, portal ON by default);
 *   • the broker sees their firm's book with full PII (profile + SSN reveal),
 *     and every read/write is AUDITED to the broker;
 *   • firm isolation — broker B sees none of firm A's borrowers/files;
 *   • SAFE borrower resolution — entering a loan with an email that matches a
 *     RETAIL borrower creates a NEW distinct profile, never adopting (and never
 *     exposing) the retail person;
 *   • an SSN clash is refused GENERICALLY (no cross-profile detail);
 *   • the borrower-login toggle hides a TPO file from the borrower's own portal,
 *     and is a NO-OP for a retail file.
 */
const http = require('http');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { 'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1', headers },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  if (!process.env.DATABASE_URL) { console.log('  ~~ SKIP TPO files DB (no DATABASE_URL)'); process.exit(0); }
  const R = require('path').resolve(__dirname, '..');
  const db = require(R + '/src/db');
  const C = require(R + '/src/lib/crypto');
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const mail = (t) => `${t}-${sfx}@brk.test`;
  const addrOf = (n) => ({ line1: `${n} Main St`, city: 'Lakewood', state: 'NJ', zip: '08701' });
  const tpoTok = (id) => C.signJwt({ sub: id, kind: 'tpo', role: 'tpo_officer', tv: 0 });
  try {
    const hash = await C.hashPassword('BrokerPass123!');
    const firmA = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm A ${sfx}`])).rows[0].id;
    const firmB = (await db.query(`INSERT INTO tpo_firms (name,status) VALUES ($1,'active') RETURNING id`, [`Firm B ${sfx}`])).rows[0].id;
    const brokerA = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker A','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerA'), firmA, hash])).rows[0].id;
    const brokerB = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,is_external,tpo_firm_id,password_hash,token_version)
       VALUES ($1,'Broker B','tpo_officer',true,true,$2,$3,0) RETURNING id`, [mail('brokerB'), firmB, hash])).rows[0].id;
    const tokA = tpoTok(brokerA), tokB = tpoTok(brokerB);

    // 1) ENTER A LOAN (new borrower)
    const enter = await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Jane', lastName: 'Doe', email: mail('jane') },
      propertyAddress: addrOf(1), loanType: 'Purchase', purchasePrice: 300000, asIsValue: 300000, arv: 400000, rehabBudget: 50000 });
    ok(enter.status === 201 && enter.body.id, 'broker A enters a loan (201)');
    const appA = enter.body.id;
    const jane = (await db.query(`SELECT id, origin, shares_email FROM borrowers WHERE email=$1`, [mail('jane')])).rows[0];
    ok(jane && jane.origin === 'tpo', 'a TPO borrower profile is created (origin tpo)');
    const appRow = (await db.query(`SELECT is_tpo,tpo_firm_id,loan_officer_id,status,borrower_portal_enabled,source FROM applications WHERE id=$1`, [appA])).rows[0];
    ok(appRow.is_tpo === true && appRow.tpo_firm_id === firmA && appRow.loan_officer_id === brokerA,
      'the file is TPO-stamped and the broker is the loan officer');
    ok(appRow.borrower_portal_enabled === true && appRow.source === 'tpo' && appRow.status === 'file_intake',
      'the file starts at file_intake, source tpo, portal ON by default');
    ok((await db.query(`SELECT count(*)::int n FROM checklist_items WHERE application_id=$1`, [appA])).rows[0].n > 0,
      'conditions were generated for the new file');
    // an appraisal FORM code is refused as a property type (the shared guard)
    ok((await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Form', lastName: 'Code', email: mail('formcode') }, propertyAddress: addrOf(9), loanType: 'Purchase', purchasePrice: 100000, propertyType: 'FNM1025' })).status === 400,
      'entering a loan with an appraisal form code as the property type is refused (400)');

    // 2) THE BOOK + PII
    const book = await call(server, 'GET', '/api/tpo/borrowers', tokA);
    ok((book.body.borrowers || []).some((x) => x.id === jane.id && x.file_count === 1), 'broker A sees Jane in the book (1 file)');
    const det = await call(server, 'GET', `/api/tpo/borrowers/${jane.id}`, tokA);
    ok(det.status === 200 && det.body.borrower && det.body.borrower.email === mail('jane'), 'broker A sees Jane full profile');

    // 3) SSN set + reveal + audit
    const setSsn = await call(server, 'POST', `/api/tpo/borrowers/${jane.id}/ssn`, tokA, { ssn: '123-45-6789' });
    ok(setSsn.status === 200 && setSsn.body.last4 === '6789', 'broker sets Jane SSN');
    const rev = await call(server, 'GET', `/api/tpo/borrowers/${jane.id}/ssn`, tokA);
    ok(rev.status === 200 && rev.body.ssn === '123-45-6789', 'broker reveals Jane SSN (dashed format)');
    ok((await db.query(`SELECT 1 FROM audit_log WHERE action='view_ssn' AND entity_id=$1 AND actor_id=$2`, [jane.id, brokerA])).rows.length === 1,
      'the SSN reveal is audited to the broker');

    // 4) enter a second loan; a clashing SSN is refused GENERICALLY
    await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Bob', lastName: 'Roe', email: mail('bob') }, propertyAddress: addrOf(2), loanType: 'Purchase', purchasePrice: 200000 });
    const bob = (await db.query(`SELECT id FROM borrowers WHERE email=$1`, [mail('bob')])).rows[0].id;
    const clash = await call(server, 'POST', `/api/tpo/borrowers/${bob}/ssn`, tokA, { ssn: '123-45-6789' });
    ok(clash.status === 409 && !clash.body.conflict, 'a clashing SSN is refused generically (no other-profile detail leaked)');

    // 5) PATCH PII (+ bounds)
    const patch = await call(server, 'PATCH', `/api/tpo/borrowers/${jane.id}`, tokA, { fico: 720, cellPhone: '555-1212', citizenship: 'US Citizen' });
    ok(patch.status === 200, 'broker patches Jane PII');
    const jane2 = (await db.query(`SELECT fico,cell_phone,citizenship FROM borrowers WHERE id=$1`, [jane.id])).rows[0];
    ok(jane2.fico === 720 && jane2.cell_phone === '555-1212' && jane2.citizenship === 'US Citizen', 'the PII change persisted');
    ok((await call(server, 'PATCH', `/api/tpo/borrowers/${jane.id}`, tokA, { fico: 9000 })).status === 400, 'an out-of-range credit score is refused (400)');

    // 6) file detail + FIRM ISOLATION
    const fdet = await call(server, 'GET', `/api/tpo/applications/${appA}`, tokA);
    ok(fdet.status === 200 && fdet.body.application.id === appA, 'broker A sees their file detail');
    ok((await call(server, 'GET', `/api/tpo/applications/${appA}`, tokB)).status === 404, 'broker B cannot see firm A file (404)');
    ok((await call(server, 'GET', `/api/tpo/borrowers/${jane.id}`, tokB)).status === 404, 'broker B cannot see firm A borrower (404)');
    ok((await call(server, 'GET', `/api/tpo/borrowers/${jane.id}/ssn`, tokB)).status === 404, 'broker B cannot reveal firm A borrower SSN (404)');
    ok(!((await call(server, 'GET', '/api/tpo/borrowers', tokB)).body.borrowers || []).some((x) => x.id === jane.id), 'firm A borrower is absent from firm B\'s book');

    // 7) SAFE borrower resolution — never adopt a retail borrower by email
    const retailEmail = mail('retail');
    const retailId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email,shares_email) VALUES ('Retail','Person',$1,false) RETURNING id`, [retailEmail])).rows[0].id;
    const enterRetail = await call(server, 'POST', '/api/tpo/applications', tokA, {
      borrower: { firstName: 'Retail', lastName: 'Person', email: retailEmail }, propertyAddress: addrOf(3), loanType: 'Purchase', purchasePrice: 250000 });
    ok(enterRetail.status === 201, 'broker enters a loan whose email matches a retail borrower');
    const newBorrId = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [enterRetail.body.id])).rows[0].borrower_id;
    ok(newBorrId !== retailId, 'the loan links to a NEW profile, NOT the retail borrower');
    ok((await db.query(`SELECT shares_email FROM borrowers WHERE id=$1`, [newBorrId])).rows[0].shares_email === true,
      'the new profile is shares_email=true (a distinct person who happens to share the address)');
    ok((await call(server, 'GET', `/api/tpo/borrowers/${retailId}`, tokA)).status === 404, 'the retail borrower stays invisible to the broker (404)');

    // 8) the borrower-login toggle + borrower-side enforcement
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0) ON CONFLICT (borrower_id) DO NOTHING`, [jane.id, hash]);
    const janeTok = C.signJwt({ sub: jane.id, kind: 'borrower', tv: 0 });
    const retailFile = (await db.query(`INSERT INTO applications (borrower_id,status,loan_type,source) VALUES ($1,'file_intake','Purchase','portal') RETURNING id`, [jane.id])).rows[0].id;
    const idsOf = (r) => (Array.isArray(r.body) ? r.body : []).map((a) => a.id);
    const ids1 = idsOf(await call(server, 'GET', '/api/borrower/applications', janeTok));
    ok(ids1.includes(appA) && ids1.includes(retailFile), 'the borrower sees BOTH the TPO file and the retail file while the portal is ON');
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/borrower-portal`, tokA, { enabled: false })).status === 200, 'broker disables the borrower login on the TPO file');
    const ids2 = idsOf(await call(server, 'GET', '/api/borrower/applications', janeTok));
    ok(!ids2.includes(appA), 'the TPO file is now HIDDEN from the borrower');
    ok(ids2.includes(retailFile), 'the retail file is STILL visible (the toggle is a no-op for retail)');
    // and the broker can re-enable it
    ok((await call(server, 'POST', `/api/tpo/applications/${appA}/borrower-portal`, tokA, { enabled: true })).status === 200, 'broker re-enables the portal');
    ok(idsOf(await call(server, 'GET', '/api/borrower/applications', janeTok)).includes(appA), 'the TPO file is visible to the borrower again');
  } catch (e) {
    fail++; console.log('  FAIL (threw):', e.message, e.stack ? e.stack.split('\n')[1] : '');
  } finally {
    try {
      const like = `%${sfx}%`;
      await db.query(`DELETE FROM applications WHERE tpo_firm_id IN (SELECT id FROM tpo_firms WHERE name LIKE $1)`, [like]);
      await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM borrower_auth WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE email LIKE $1)`, [like]);
      await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]);
      await db.query(`DELETE FROM tpo_firms WHERE name LIKE $1`, [like]);
    } catch (_) { /* best-effort cleanup */ }
    try { server.close(); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
    console.log(`test-tpo-files-db: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
