/**
 * A LOAN OFFICER can override the pricing again — and EVERY change to the
 * defaults goes to an admin for approval (owner-directed 2026-07-27).
 *
 * The owner's report: "on the products and pricing screen they don't have the
 * option to override the pricing anymore, like the admin section at the bottom,
 * to create manual programs, to send it for exception and override pricing for
 * exception… every single time somebody is changing the defaults and he's
 * overriding something in the admin section this should be sent to the admin for
 * approval, no matter if it's reducing the rate, reducing the fee, or manual
 * programs."
 *
 * What must hold, end to end over real HTTP against a real Postgres:
 *   1. A loan officer QUOTING with admin-zone knobs is no longer refused (403)
 *      — and the quote says the scenario would need approval.
 *   2. A loan officer REGISTERING a reduced origination fee is not refused: the
 *      file carries the new terms, `needs_approval` is set, and a PENDING
 *      escalation names exactly what changed.
 *   3. The borrower is NOT sent terms, and the DocuSign term sheet cannot issue,
 *      while it waits.
 *   4. A loan officer registering a MANUAL program (LTV/LTC/ARV) is not refused
 *      either — it asks for the liquidity months, then escalates.
 *   5. A clean registration on the company defaults still confirms immediately
 *      (no escalation, no approval flag) — the ordinary deal is untouched.
 *   6. The REQUESTER cannot approve their own exception; an admin who didn't
 *      request it can, and approving clears the issuance block.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-pricing-override-approval-db (no DATABASE_URL)'); process.exit(0); }
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

// A healthy, comfortably-eligible Standard purchase — so the ONLY reason any
// escalation appears is the admin-zone override under test.
const SCENARIO = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)',
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
  fico: 740, expFlips: 5, term: 12,
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const mkStaff = async (role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`pov-${role}-${sfx}@test.local`, name, role])).rows[0].id;
    const loId = await mkStaff('loan_officer', 'Officer One');
    const adminId = await mkStaff('admin', 'Admin Two');
    const superId = await mkStaff('super_admin', 'Owner');
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pov','Test',$1) RETURNING id`,
      [`pov-bo-${sfx}@test.local`])).rows[0].id;
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, property_address)
       VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',5,
               '{"line1":"1 Test St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId, loId])).rows[0].id;

    const reg = (appId) => `/api/staff/applications/${appId}/pricing/register`;
    const regRow = async (appId) => (await db.query(
      `SELECT program, status, needs_approval, override_changes, total_loan FROM product_registrations
        WHERE application_id=$1 AND is_current`, [appId])).rows[0];
    const escRow = async (appId) => (await db.query(
      `SELECT id, status, summary, overrides, requested_by FROM manual_program_escalations
        WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [appId])).rows[0];

    // =====================================================================
    // 1. The loan officer can QUOTE with the admin-zone knobs (no more 403)
    // =====================================================================
    const appA = await mkApp();
    const q = await call(server, 'POST', `/api/staff/applications/${appA}/pricing/quote`, loTok,
      { program: 'standard', overrides: { ...SCENARIO, origStdPct: 0.5, markupStdPct: 0 } });
    assert(q.status === 200, `LO quote with admin-zone overrides is allowed (got ${q.status})`);
    assert(q.body && q.body.needsApproval === true,
      'the quote tells the officer up-front that this scenario needs approval');
    assert(q.body && Array.isArray(q.body.overrideChanges) && q.body.overrideChanges.length === 2,
      'the quote names both changes (reduced points + waived markup)');

    // The pricing load hands the studio the company defaults, so its "this goes
    // to an admin" warning compares against the SAME numbers the register does
    // (never a client-side guess that could warn on a non-change).
    const load = await call(server, 'GET', `/api/staff/applications/${appA}/pricing`, loTok);
    assert(load.status === 200 && load.body.pricingDefaults
      && load.body.pricingDefaults.origStdPct != null && load.body.pricingDefaults.markupStdPct != null,
      'the staff pricing load carries the company pricing defaults');

    // =====================================================================
    // 2. The loan officer REGISTERS a reduced origination fee
    // =====================================================================
    const r1 = await call(server, 'POST', reg(appA), loTok,
      { program: 'standard', overrides: { ...SCENARIO, origStdPct: 0.5 } });
    assert(r1.status === 201, `LO register with a reduced fee is NOT refused (got ${r1.status} ${JSON.stringify(r1.body && r1.body.error || '')})`);
    assert(r1.body && r1.body.pendingApproval === true, 'the response says it is pending approval');
    assert(r1.body && r1.body.pendingReason === 'pricing_override', 'the reason is a pricing override, not a manual review');
    assert(Array.isArray(r1.body.overrideLines) && /Origination points/.test(r1.body.overrideLines.join(' ')),
      `the response names the change in plain language (${JSON.stringify(r1.body.overrideLines)})`);

    const regA = await regRow(appA);
    assert(regA && regA.needs_approval === true, 'the stored registration is flagged needs_approval');
    assert(regA && regA.program === 'standard' && regA.status === 'ELIGIBLE',
      'it is still an ordinary ELIGIBLE Standard registration — only the approval is new');
    assert(regA && Array.isArray(regA.override_changes) && regA.override_changes[0].key === 'origStdPct',
      'the registration records WHAT was changed');
    assert(Number(regA.total_loan) > 0, 'the file still carries real terms (the officer is not blocked from working)');

    const escA = await escRow(appA);
    assert(escA && escA.status === 'pending', 'a PENDING escalation is waiting for an admin');
    assert(escA && escA.summary && escA.summary.kind === 'pricing_override', 'the escalation is typed as a pricing override');
    assert(escA && Array.isArray(escA.summary.overrideLines) && escA.summary.overrideLines.length === 1,
      'the approver sees the exact before → after line');
    assert(escA && escA.overrides && escA.overrides.origStdPct != null,
      'the escalation stores the overridden value itself');
    assert(String(escA.requested_by) === String(loId), 'the escalation records the loan officer as the requester');

    // =====================================================================
    // 3. Nothing goes out while it waits
    // =====================================================================
    const blockers = await require('../src/lib/esign/gate').registrationIssuabilityBlockers(appA, db);
    assert(blockers.some((b) => b.code === 'manual_approval'),
      'the DocuSign term sheet cannot issue while the override waits for approval');

    // =====================================================================
    // 4. A MANUAL program from a loan officer: asks for liquidity, then escalates
    // =====================================================================
    const appB = await mkApp();
    const rNoMonths = await call(server, 'POST', reg(appB), loTok,
      { program: 'standard', overrides: { ...SCENARIO, manualPricing: true, ovrLTCPct: 92 } });
    assert(rNoMonths.status === 422 && rNoMonths.body.code === 'manual_asset_months_required',
      `a manual program from an LO asks for the liquidity months (got ${rNoMonths.status})`);
    const rManual = await call(server, 'POST', reg(appB), loTok,
      { program: 'standard', assetMonths: 3, overrides: { ...SCENARIO, manualPricing: true, ovrLTCPct: 92 } });
    assert(rManual.status === 201, `a loan officer CAN register a manual program (got ${rManual.status} ${JSON.stringify(rManual.body && rManual.body.error || '')})`);
    const regB = await regRow(appB);
    assert(regB && regB.program === 'manual' && regB.needs_approval === true,
      'it registers as a Manual Program pending approval');
    const escB = await escRow(appB);
    assert(escB && escB.status === 'pending' && escB.summary.kind === 'manual_product',
      'the manual product escalates as before');

    // =====================================================================
    // 5. An ordinary registration on the company defaults is UNTOUCHED
    // =====================================================================
    const appC = await mkApp();
    const rClean = await call(server, 'POST', reg(appC), loTok, { program: 'standard', overrides: { ...SCENARIO } });
    assert(rClean.status === 201 && rClean.body.pendingApproval === false,
      'a deal priced on the company defaults confirms immediately — no approval, no escalation');
    const regC = await regRow(appC);
    assert(regC && regC.needs_approval === false && regC.override_changes == null,
      'the clean registration carries no approval flag and no override record');
    assert((await escRow(appC)) == null, 'no escalation row is created for a clean registration');

    // =====================================================================
    // 6. Requester ≠ approver; an admin approves and the block lifts
    // =====================================================================
    // The loan officer cannot even see the box (manage_pricing), let alone decide.
    const loSee = await call(server, 'GET', '/api/admin/manual-programs/escalations?status=open', loTok);
    assert(loSee.status === 403, 'a loan officer cannot reach the escalation box');

    // An ADMIN who did not request it can decide (this is the widening: it used
    // to be super-admin only).
    const adminSee = await call(server, 'GET', '/api/admin/manual-programs/escalations?status=open', adminTok);
    assert(adminSee.status === 200 && adminSee.body.canDecide === true,
      'an admin can now approve/decline (owner-directed 2026-07-27)');
    const rowForAdmin = (adminSee.body.escalations || []).find((r) => String(r.id) === String(escA.id));
    assert(rowForAdmin && rowForAdmin.canDecide === true, 'the row is decidable by this admin');

    // An admin who DID request it cannot decide their own.
    const appD = await mkApp();
    const rAdminOwn = await call(server, 'POST', reg(appD), adminTok,
      { program: 'standard', overrides: { ...SCENARIO, lenderFee: 995 } });
    assert(rAdminOwn.status === 201 && rAdminOwn.body.pendingApproval === true,
      'an ADMIN changing the defaults also needs an approval — not a free pass');
    const escD = await escRow(appD);
    const selfDecide = await call(server, 'POST', `/api/admin/manual-programs/escalations/${escD.id}/decide`, adminTok,
      { decision: 'approved' });
    assert(selfDecide.status === 403, `an admin cannot approve their OWN exception (got ${selfDecide.status})`);
    const selfCounter = await call(server, 'POST', `/api/admin/manual-programs/escalations/${escD.id}/counter`, adminTok,
      { counterNote: 'I would accept 1.0 points.' });
    assert(selfCounter.status === 403, 'nor counter-offer their own');
    const superDecides = await call(server, 'POST', `/api/admin/manual-programs/escalations/${escD.id}/decide`, superTok,
      { decision: 'approved', note: 'Fine on this one.' });
    assert(superDecides.status === 200, 'a super-admin decides it instead');

    // Approve the loan officer's request as the admin, then the term sheet frees up.
    const okDecide = await call(server, 'POST', `/api/admin/manual-programs/escalations/${escA.id}/decide`, adminTok,
      { decision: 'approved', note: 'Approved — repeat borrower.' });
    assert(okDecide.status === 200, `the admin approves the loan officer's override (got ${okDecide.status})`);
    const escAfter = await escRow(appA);
    assert(escAfter && escAfter.status === 'approved', 'the escalation is recorded as approved');
    const blockersAfter = await require('../src/lib/esign/gate').registrationIssuabilityBlockers(appA, db);
    assert(!blockersAfter.some((b) => b.code === 'manual_approval'),
      'once approved, the term sheet can issue');

    // Cleanup — leave the database as we found it.
    await db.query(`DELETE FROM manual_program_escalations WHERE application_id = ANY($1::uuid[])`, [[appA, appB, appC, appD]]);
    await db.query(`DELETE FROM product_registrations WHERE application_id = ANY($1::uuid[])`, [[appA, appB, appC, appD]]);
    await db.query(`DELETE FROM applications WHERE id = ANY($1::uuid[])`, [[appA, appB, appC, appD]]);
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
    await db.query(`DELETE FROM staff_users WHERE id = ANY($1::uuid[])`, [[loId, adminId, superId]]);
  } catch (e) {
    console.error('FAIL (threw):', e && e.stack || e);
    failures++;
  } finally {
    server.close();
  }
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILING`);
  process.exit(failures === 0 ? 0 : 1);
})();
