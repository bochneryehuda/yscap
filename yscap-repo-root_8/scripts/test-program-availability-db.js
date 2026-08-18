'use strict';
/**
 * PROGRAM AVAILABILITY — end to end over real HTTP against a real Postgres
 * (owner-directed 2026-08-18). The owner's story, in order:
 *
 *   1. CONTROL — with nothing switched off, a loan officer registers a Gold
 *      Standard product exactly as before (byte-identical pre-feature behavior).
 *   2. An admin DISCONTINUES the Gold program in the Pricing Admin Center; the
 *      switch round-trips, reaches the public /api/pricing-defaults (the
 *      marketing generator's feed) and the staff pricing payload (the studio's).
 *   3. Registering Gold now REFUSES with a plain program_discontinued — and the
 *      refusal is AUDITED. Standard still registers: only Gold moved.
 *   4. The per-file exception is SUPER-ADMIN-only (LO 403, admin 403, no
 *      reason 400) and RECORDED (audit row + who/when/why on the file).
 *   5. The excepted file registers Gold; a second file is still refused — the
 *      exception is per-deal, exactly as the owner asked.
 *   6. The BORROWER door refuses too, with borrower-safe wording (no internal
 *      super-admin coaching).
 *   7. Revoking the exception closes the door again; switching the program back
 *      ON restores everything (and leaves the shared DB in stock state).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-program-availability-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c2) => b += c2); res.on('end', () => { try { resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }); } catch (e) { resolve({ status: res.statusCode, body: null, raw: b }); } }); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

// A healthy, comfortably-eligible purchase — the same fixture the pricing-override
// suite registers with, so the ONLY variable under test is the program switch.
const SCENARIO = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)',
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
  fico: 740, expFlips: 5, term: 12,
};

(async () => {
  // The migration under test is idempotent — apply it directly so this suite is
  // self-sufficient on a database that predates db/583.
  await db.query(fs.readFileSync(path.join(__dirname, '..', 'db', '583_program_availability_toggles.sql'), 'utf8'));

  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  // Remember the settings row that is current NOW, so the suite can put the
  // shared database back exactly as it found it (append-only history: we flip
  // is_current back rather than deleting anything).
  const priorCurrent = (await db.query(`SELECT id FROM company_pricing_settings WHERE is_current LIMIT 1`)).rows[0] || null;
  try {
    const mkStaff = async (role, name) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`pav-${role}-${sfx}@test.local`, name, role])).rows[0].id;
    const loId = await mkStaff('loan_officer', 'Officer One');
    const adminId = await mkStaff('admin', 'Admin Two');
    const superId = await mkStaff('super_admin', 'Owner');
    const loTok = C.signJwt({ sub: loId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const adminTok = C.signJwt({ sub: adminId, kind: 'staff', role: 'admin', tv: 0 });
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Pav','Test',$1) RETURNING id`,
      [`pav-bo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    const boTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, property_address)
       VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',5,
               '{"line1":"1 Test St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId, loId])).rows[0].id;

    const reg = (appId) => `/api/staff/applications/${appId}/pricing/register`;
    const regRow = async (appId) => (await db.query(
      `SELECT program, status FROM product_registrations WHERE application_id=$1 AND is_current`, [appId])).rows[0];

    // Every-program-on baseline for the settings (whatever earlier suites left).
    const put0 = await call(server, 'PUT', '/api/admin/pricing', adminTok, { programAvailability: {} });
    assert(put0.status === 200, `settings baseline save (got ${put0.status})`);

    // =====================================================================
    // 1. CONTROL — Gold registers exactly as before while nothing is off
    // =====================================================================
    const appA = await mkApp();
    const r0 = await call(server, 'POST', reg(appA), loTok, { program: 'gold', overrides: { ...SCENARIO } });
    assert(r0.status === 201, `CONTROL: Gold registers with every program on (got ${r0.status} ${JSON.stringify((r0.body && r0.body.error) || '')})`);
    const rr0 = await regRow(appA);
    assert(rr0 && rr0.program === 'gold', 'CONTROL: the registration is recorded as Gold');

    // =====================================================================
    // 2. The admin DISCONTINUES Gold in the Pricing Admin Center
    // =====================================================================
    const NOTE = 'The Gold Standard program has been discontinued.';
    const put1 = await call(server, 'PUT', '/api/admin/pricing', adminTok,
      { programAvailability: { gold: { active: false, note: NOTE } } });
    assert(put1.status === 200 && put1.body && put1.body.current
      && put1.body.current.programAvailability && put1.body.current.programAvailability.gold
      && put1.body.current.programAvailability.gold.active === false,
      'the switch saves and the verified re-read carries it');
    const get1 = await call(server, 'GET', '/api/admin/pricing', adminTok);
    assert(get1.status === 200 && get1.body.current.programAvailability.gold.note === NOTE,
      'the Pricing Admin Center reads the switch + note back');
    const pub = await call(server, 'GET', '/api/pricing-defaults', null);
    assert(pub.status === 200 && pub.body && pub.body.programAvailability
      && pub.body.programAvailability.gold && pub.body.programAvailability.gold.active === false,
      'the PUBLIC /api/pricing-defaults (the marketing generator\'s feed) carries the switch');
    const appB = await mkApp();
    const load1 = await call(server, 'GET', `/api/staff/applications/${appB}/pricing`, loTok);
    assert(load1.status === 200 && load1.body.programAvailability
      && load1.body.programAvailability.gold.offered === false
      && load1.body.programAvailability.gold.active === false
      && load1.body.programAvailability.standard.offered === true,
      'the staff pricing load carries the file\'s EFFECTIVE map (gold gone, standard offered)');

    // =====================================================================
    // 3. Registering Gold refuses — audited; Standard is untouched
    // =====================================================================
    const r1 = await call(server, 'POST', reg(appB), loTok, { program: 'gold', overrides: { ...SCENARIO } });
    assert(r1.status === 422 && r1.body && r1.body.code === 'program_discontinued',
      `Gold register refuses with program_discontinued (got ${r1.status} ${JSON.stringify((r1.body && r1.body.code) || '')})`);
    assert(/discontinued/i.test((r1.body && r1.body.error) || '') && /super admin/i.test((r1.body && r1.body.error) || ''),
      'the staff refusal states the discontinuation AND the super-admin way through');
    const aud1 = await db.query(
      `SELECT 1 FROM audit_log WHERE action='register_product_refused' AND entity_id=$1 AND detail->>'reason'='program_discontinued'`, [appB]);
    assert(aud1.rows.length === 1, 'the refusal is audited (register_product_refused / program_discontinued)');
    const r2 = await call(server, 'POST', reg(appB), loTok, { program: 'standard', overrides: { ...SCENARIO } });
    assert(r2.status === 201, `Standard still registers — only Gold moved (got ${r2.status})`);

    // =====================================================================
    // 4. The per-file exception is SUPER-ADMIN-only and recorded
    // =====================================================================
    const exc = (appId) => `/api/staff/applications/${appId}/program-exception`;
    const e403a = await call(server, 'POST', exc(appB), loTok, { program: 'gold', enabled: true, reason: 'in process' });
    assert(e403a.status === 403, `a loan officer cannot grant the exception (got ${e403a.status})`);
    const e403b = await call(server, 'POST', exc(appB), adminTok, { program: 'gold', enabled: true, reason: 'in process' });
    assert(e403b.status === 403, `a plain admin cannot grant it either — SUPER admin only (got ${e403b.status})`);
    const e400 = await call(server, 'POST', exc(appB), superTok, { program: 'gold', enabled: true, reason: '' });
    assert(e400.status === 400, `enabling without a reason refuses (got ${e400.status})`);
    const e400p = await call(server, 'POST', exc(appB), superTok, { program: 'dscr', enabled: true, reason: 'in process' });
    assert(e400p.status === 400, `an unknown program refuses plainly (got ${e400p.status})`);
    const e1 = await call(server, 'POST', exc(appB), superTok,
      { program: 'gold', enabled: true, reason: 'Already in process — term sheet was out before the program was discontinued.' });
    assert(e1.status === 200 && e1.body && e1.body.enabled === true
      && e1.body.programAvailability && e1.body.programAvailability.gold.offered === true
      && e1.body.programAvailability.gold.active === false,
      'the super admin turns Gold ON for this file — offered flips while the company switch stays off');
    const row1 = (await db.query(`SELECT program_exceptions FROM applications WHERE id=$1`, [appB])).rows[0];
    assert(row1.program_exceptions && row1.program_exceptions.gold
      && row1.program_exceptions.gold.by === superId && /in process/i.test(row1.program_exceptions.gold.reason || ''),
      'the exception is recorded on the file — who and why');
    const aud2 = await db.query(
      `SELECT 1 FROM audit_log WHERE action='program_exception' AND entity_id=$1 AND actor_id=$2`, [appB, superId]);
    assert(aud2.rows.length >= 1, 'granting the exception is audited');

    // =====================================================================
    // 5. The excepted file registers Gold; another file is still refused
    // =====================================================================
    const r3 = await call(server, 'POST', reg(appB), loTok, { program: 'gold', overrides: { ...SCENARIO } });
    assert(r3.status === 201, `the excepted file registers Gold (got ${r3.status} ${JSON.stringify((r3.body && r3.body.error) || '')})`);
    const rr3 = await regRow(appB);
    assert(rr3 && rr3.program === 'gold', 'and the registration is recorded as Gold');
    const appC = await mkApp();
    const r4 = await call(server, 'POST', reg(appC), loTok, { program: 'gold', overrides: { ...SCENARIO } });
    assert(r4.status === 422 && r4.body && r4.body.code === 'program_discontinued',
      'a DIFFERENT file is still refused — the exception is per-deal');

    // =====================================================================
    // 6. The borrower door refuses too, borrower-safe
    // =====================================================================
    const rb = await call(server, 'POST', `/api/borrower/applications/${appC}/pricing/register`, boTok,
      { program: 'gold', overrides: {} });
    assert(rb.status === 422 && rb.body && rb.body.code === 'program_discontinued',
      `the borrower register refuses program_discontinued (got ${rb.status} ${JSON.stringify((rb.body && rb.body.code) || '')})`);
    assert(!/super admin/i.test((rb.body && rb.body.error) || '') && /loan team/i.test((rb.body && rb.body.error) || ''),
      'the borrower wording is borrower-safe — "ask your loan team", never the internal super-admin coaching');
    const bLoad = await call(server, 'GET', `/api/borrower/applications/${appC}/pricing`, boTok);
    assert(bLoad.status === 200 && bLoad.body.programAvailability
      && bLoad.body.programAvailability.gold.offered === false
      && bLoad.body.programAvailability.gold.exception === undefined,
      'the borrower pricing load carries the map WITHOUT the internal exception details');

    // =====================================================================
    // 7. Revoke closes the door again; switching back ON restores everything
    // =====================================================================
    const e2 = await call(server, 'POST', exc(appB), superTok, { program: 'gold', enabled: false });
    assert(e2.status === 200 && e2.body.enabled === false, 'the super admin revokes the exception');
    const r5 = await call(server, 'POST', reg(appB), loTok, { program: 'gold', overrides: { ...SCENARIO } });
    assert(r5.status === 422 && r5.body && r5.body.code === 'program_discontinued',
      'after the revoke the same file is refused again');
    const put2 = await call(server, 'PUT', '/api/admin/pricing', adminTok, { programAvailability: {} });
    assert(put2.status === 200 && (put2.body.current.programAvailability == null),
      'switching every program back ON stores NULL — the pre-feature state');
    const r6 = await call(server, 'POST', reg(appC), loTok, { program: 'gold', overrides: { ...SCENARIO } });
    assert(r6.status === 201, `with the program back on, Gold registers again with no exception needed (got ${r6.status})`);
  } catch (e) {
    failures++;
    console.error('FAIL (exception)', e && e.stack || e);
  } finally {
    // Leave the SHARED settings history exactly as found: our two saved versions
    // stay as history rows, but the row that was current before the suite ran is
    // current again (or, if none existed, no row is current — the code falls back
    // to SYSTEM_DEFAULTS either way).
    try {
      await db.query(`UPDATE company_pricing_settings SET is_current=false WHERE is_current`);
      if (priorCurrent) await db.query(`UPDATE company_pricing_settings SET is_current=true WHERE id=$1`, [priorCurrent.id]);
      require('../src/lib/pricing-settings').bust();
    } catch (_) { /* best-effort restore */ }
    server.close();
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
