/**
 * EXCEPTION STICKINESS — end to end over real HTTP (owner-directed 2026-08-05).
 *
 * The owner's report: re-registering a file that ALREADY has an approved exception
 * (a manual program at 90% LTC, a 1% origination, a 0.2 markup) sends it back through
 * the exception workflow every single time — even when nothing about the approved item
 * changed. That overwhelms the escalation box with duplicate approvals.
 *
 * What must hold, end to end against a real Postgres:
 *   1. A loan officer registers a reduced origination fee → PENDING escalation; an
 *      admin approves it → the term sheet frees up.
 *   2. RE-REGISTERING the SAME origination reuses the approved exception: it confirms
 *      immediately (no pending approval, needs_approval=false), opens NO new escalation,
 *      and the term sheet stays issuable.
 *   3. RE-REGISTERING with a CHANGED value (a lower origination) DOES open a fresh
 *      escalation and re-holds the term sheet.
 *   4. A manual program approved at a given LTC stays covered when re-registered at the
 *      same LTC — but the owner's special case, the loan amount GOING UP, re-escalates.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-exception-stickiness-e2e-db (no DATABASE_URL)'); process.exit(0); }
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
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

const SCENARIO = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)',
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
  fico: 740, expFlips: 5, term: 12,
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const gate = require('../src/lib/esign/gate');
  try {
    const mkStaff = async (role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`exs-${role}-${sfx}@test.local`, name, role])).rows[0].id;
    const loId = await mkStaff('loan_officer', 'Officer One');
    const adminId = await mkStaff('admin', 'Admin Two');
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Exs','Test',$1) RETURNING id`,
      [`exs-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified) VALUES ($1,'x',0,true)`, [borrowerId]);
    const boTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, property_address)
       VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',5,
               '{"line1":"1 Exc St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId, loId])).rows[0].id;
    const reg = (appId) => `/api/staff/applications/${appId}/pricing/register`;
    const regRow = async (appId) => (await db.query(
      `SELECT needs_approval, total_loan FROM product_registrations WHERE application_id=$1 AND is_current`, [appId])).rows[0];
    const escCount = async (appId, status) => Number((await db.query(
      `SELECT count(*)::int n FROM manual_program_escalations WHERE application_id=$1${status ? ` AND status='${status}'` : ''}`, [appId])).rows[0].n);
    const latestEsc = async (appId) => (await db.query(
      `SELECT id, status FROM manual_program_escalations WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];
    const held = async (appId) => (await gate.registrationIssuabilityBlockers(appId, db)).some((b) => b.code === 'manual_approval');

    // ============ 1. Register a reduced origination → approve it ============
    const appA = await mkApp();
    const r1 = await call(server, 'POST', reg(appA), loTok, { program: 'standard', overrides: { ...SCENARIO, origStdPct: 0.5 } });
    assert(r1.status === 201 && r1.body.pendingApproval === true, `first register of 0.5% origination is pending approval (got ${r1.status})`);
    assert((await escCount(appA, 'pending')) === 1, 'one PENDING escalation exists');
    assert((await held(appA)) === true, 'the term sheet is held while it waits');

    const esc1 = await latestEsc(appA);
    const dec = await call(server, 'POST', `/api/admin/manual-programs/escalations/${esc1.id}/decide`, adminTok, { decision: 'approved', note: 'ok' });
    assert(dec.status === 200, `the admin approves it (got ${dec.status})`);
    assert((await held(appA)) === false, 'the term sheet frees up once approved');
    const escAfterApprove = await escCount(appA);   // total rows so far

    // ============ 2. RE-REGISTER the SAME origination → reuses the grant ============
    const r2 = await call(server, 'POST', reg(appA), loTok, { program: 'standard', overrides: { ...SCENARIO, origStdPct: 0.5 } });
    assert(r2.status === 201, `re-register of the same 0.5% origination succeeds (got ${r2.status})`);
    assert(r2.body.pendingApproval === false, 'RE-REGISTER of the already-approved exception does NOT go pending again');
    assert((await regRow(appA)).needs_approval === false, 'the new registration is not flagged needs_approval');
    assert((await escCount(appA)) === escAfterApprove, 'NO new escalation row was created');
    assert((await escCount(appA, 'pending')) === 0, 'the escalation box has nothing new to show');
    assert((await held(appA)) === false, 'the term sheet stays issuable — no fresh hold');

    // ============ 3. RE-REGISTER with a CHANGED value → re-escalates ============
    const r3 = await call(server, 'POST', reg(appA), loTok, { program: 'standard', overrides: { ...SCENARIO, origStdPct: 0.4 } });
    assert(r3.status === 201 && r3.body.pendingApproval === true, 'changing 0.5% → 0.4% origination DOES need a fresh approval');
    assert((await escCount(appA, 'pending')) === 1, 'a new PENDING escalation opens for the changed value');
    assert((await held(appA)) === true, 'and the term sheet is held again');

    // ============ 4. Manual program: same LTC covered; loan UP re-escalates ============
    const appB = await mkApp();
    const m1 = await call(server, 'POST', reg(appB), loTok, { program: 'standard', assetMonths: 3, overrides: { ...SCENARIO, manualPricing: true, ovrLTCPct: 92 } });
    assert(m1.status === 201 && m1.body.pendingApproval === true, `manual program at 92% LTC is pending approval (got ${m1.status})`);
    const escM = await latestEsc(appB);
    await call(server, 'POST', `/api/admin/manual-programs/escalations/${escM.id}/decide`, adminTok, { decision: 'approved', note: 'ok' });
    const escBAfter = await escCount(appB);

    // Same LTC, same inputs → same loan → covered.
    const m2 = await call(server, 'POST', reg(appB), loTok, { program: 'standard', assetMonths: 3, overrides: { ...SCENARIO, manualPricing: true, ovrLTCPct: 92 } });
    assert(m2.status === 201 && m2.body.pendingApproval === false, 'RE-REGISTER of the same manual program (same LTC, same loan) reuses the grant');
    assert((await escCount(appB)) === escBAfter, 'no new escalation for the unchanged manual program');

    // Same LTC, but a bigger deal → the loan amount goes UP → owner's special re-escalation.
    const m3 = await call(server, 'POST', reg(appB), loTok, {
      program: 'standard', assetMonths: 3,
      overrides: { ...SCENARIO, manualPricing: true, ovrLTCPct: 92, purchasePrice: 620000, asIsValue: 620000, arv: 900000, rehabBudget: 120000 },
    });
    const loanUp = Number((await regRow(appB)).total_loan) > 0;
    assert(m3.status === 201 && loanUp, `the bigger manual deal registers (got ${m3.status})`);
    assert(m3.body.pendingApproval === true, 'the manual program with the loan amount UP needs a fresh approval (capital / BP structure)');
    assert((await escCount(appB, 'pending')) === 1, 'and a new PENDING escalation opens for the increased loan');

    // ============ 5. THE BORROWER PATH stores needs_approval=false on a covered re-register ============
    // A below-minimum deal quotes MANUAL; the borrower submits it as an exception, an admin
    // approves, and the borrower re-registering the identical terms reuses the grant AND
    // stores needs_approval=FALSE (the fallback would have re-derived TRUE from status===MANUAL).
    const appBo = (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, property_address)
       VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',90000,90000,120000,8000,'Cosmetic','12 Months',5,
               '{"line1":"2 Exc St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId, loId])).rows[0].id;
    const bo1 = await call(server, 'POST', `/api/borrower/applications/${appBo}/pricing/register`, boTok,
      { program: 'standard', overrides: {}, submitException: true });
    assert(bo1.status === 201 && bo1.body.pendingApproval === true, `borrower's below-minimum deal is a pending MANUAL exception (got ${bo1.status} ${JSON.stringify(bo1.body && (bo1.body.error || bo1.body.code) || '')})`);
    const escBo = await latestEsc(appBo);
    if (escBo) {
      await call(server, 'POST', `/api/admin/manual-programs/escalations/${escBo.id}/decide`, adminTok, { decision: 'approved', note: 'ok' });
      const escBoAfter = await escCount(appBo);
      const bo2 = await call(server, 'POST', `/api/borrower/applications/${appBo}/pricing/register`, boTok,
        { program: 'standard', overrides: {}, submitException: true });
      assert(bo2.status === 201 && bo2.body.pendingApproval === false, 'borrower RE-register of the approved MANUAL exception reuses the grant');
      assert((await regRow(appBo)).needs_approval === false, 'and the stored registration is needs_approval=FALSE (not the misleading fallback TRUE)');
      assert((await escCount(appBo)) === escBoAfter, 'no new escalation on the borrower re-register');
    }

    // Cleanup.
    await db.query(`DELETE FROM manual_program_escalations WHERE application_id = ANY($1::uuid[])`, [[appA, appB, appBo]]);
    await db.query(`DELETE FROM product_registrations WHERE application_id = ANY($1::uuid[])`, [[appA, appB, appBo]]);
    await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appA, appB, appBo]]);
    await db.query(`DELETE FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[loId, adminId]]);
  } catch (e) {
    console.error('FAIL (threw):', e && e.stack || e);
    failures++;
  } finally {
    server.close();
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
  process.exit(failures === 0 ? 0 : 1);
})();
