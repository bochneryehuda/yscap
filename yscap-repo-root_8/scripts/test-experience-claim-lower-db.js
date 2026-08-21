/**
 * A staffer can LOWER the experience claim from the Term Sheet Studio and have
 * it stick (owner-directed 2026-07-28: "no matter how many times I remove the 5
 * and put 0 for fix & flips completed, it comes back").
 *
 * ROOT CAUSE the fix addresses: persistProductRegistration wrote the experience
 * claim with GREATEST(existing, new), so a register could RAISE the count but
 * never LOWER it — a studio-typed 0 was silently discarded and the studio
 * re-prefilled the un-lowered value, which read as "it bounces back". (It is NOT
 * a ClickUp sync — the requested_exp_* columns are not mapped to ClickUp at all.)
 *
 * What must hold, end to end over real HTTP against a real Postgres:
 *   1. Registering with an EXPLICIT lower count (5 → 0) writes 0 to the file.
 *   2. Registering with an EXPLICIT higher count (5 → 8) still raises it.
 *   3. Registering with the experience field BLANK ('') never zeroes a real
 *      claim (a blank is not a deliberate 0 — the conservative GREATEST is kept).
 *   4. Registering with NO experience key at all leaves the claim untouched.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-experience-claim-lower-db (no DATABASE_URL)'); process.exit(0); }
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

// A healthy, comfortably-eligible Standard Fix & Flip so the register succeeds at
// ANY experience count (the tier changes, the deal still sizes).
const SCENARIO = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)',
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
  fico: 760, term: 12,
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  try {
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Owner','super_admin',true,false,'x',0) RETURNING id`,
      [`expclaim-${sfx}@test.local`])).rows[0].id;
    const tok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    const borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Exp','Test',$1) RETURNING id`,
      [`expclaim-bo-${sfx}@test.local`])).rows[0].id;

    // Every file starts with a stored claim of flips=5, holds=5 so we can prove a
    // LOWER sticks (not just a first-time fill).
    const mkApp = async () => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, requested_exp_holds, requested_exp_ground, property_address)
       VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',5,5,0,
               '{"line1":"1 Test St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
       RETURNING id`, [borrowerId, staffId])).rows[0].id;

    const reg = (appId) => `/api/staff/applications/${appId}/pricing/register`;
    const expOf = async (appId) => (await db.query(
      `SELECT requested_exp_flips f, requested_exp_holds h, requested_exp_ground g FROM applications WHERE id=$1`,
      [appId])).rows[0];

    // 1. LOWER: 5 → 0 must stick (the reported bug).
    const appA = await mkApp();
    const rA = await call(server, 'POST', reg(appA), tok,
      { program: 'standard', overrides: { ...SCENARIO, expFlips: 0, expHolds: 5, expGround: 0 } });
    assert(rA.status === 201, `register with a lowered experience is accepted (got ${rA.status} ${JSON.stringify(rA.body && rA.body.error || '')})`);
    const eA = await expOf(appA);
    assert(eA && Number(eA.f) === 0, `Fix & flips lowered 5 → 0 STICKS (got ${eA && eA.f})`);
    assert(eA && Number(eA.h) === 5, 'an untouched bucket (holds) is unchanged');

    // 2. RAISE: 5 → 8 still works.
    const appB = await mkApp();
    const rB = await call(server, 'POST', reg(appB), tok,
      { program: 'standard', overrides: { ...SCENARIO, expFlips: 8, expHolds: 5, expGround: 0 } });
    assert(rB.status === 201, `register raising experience is accepted (got ${rB.status})`);
    const eB = await expOf(appB);
    assert(eB && Number(eB.f) === 8, `Fix & flips raised 5 → 8 (got ${eB && eB.f})`);

    // 3. BLANK '' never zeroes a real claim (a blank is not a deliberate 0).
    const appC = await mkApp();
    const rC = await call(server, 'POST', reg(appC), tok,
      { program: 'standard', overrides: { ...SCENARIO, expFlips: '', expHolds: 5, expGround: 0 } });
    assert(rC.status === 201, `register with a blank experience field is accepted (got ${rC.status})`);
    const eC = await expOf(appC);
    assert(eC && Number(eC.f) === 5, `a BLANK experience field keeps the stored 5 (never a silent 0) (got ${eC && eC.f})`);

    // 4. NO experience key at all leaves the claim untouched.
    const appD = await mkApp();
    const rD = await call(server, 'POST', reg(appD), tok,
      { program: 'standard', overrides: { ...SCENARIO, expHolds: 5, expGround: 0 } }); // no expFlips
    assert(rD.status === 201, `register with no experience key is accepted (got ${rD.status})`);
    const eD = await expOf(appD);
    assert(eD && Number(eD.f) === 5, `a register that never touches experience keeps the stored 5 (got ${eD && eD.f})`);

    // ---- THE OWNER'S ITEM 22 STORY, walked in order ------------------------
    // "We started a file and entered five experiences. The condition says that we need
    //  five experiences. We verified only three, and we changed the application to only
    //  three. We changed the products and prices to only three, but the condition is
    //  still requiring five experiences, and we can't sign off that condition."
    console.log('\n--- item 22: the requirement must follow a re-register DOWN ---');
    const EXP = require('../src/lib/experience');
    const needOf = (id) => EXP.registeredExperienceNeed(id, db);

    const appE = await mkApp();
    // 1. registered on FIVE.
    const e1 = await call(server, 'POST', reg(appE), tok,
      { program: 'standard', overrides: { ...SCENARIO, expFlips: 5, expHolds: 0, expGround: 0 } });
    assert(e1.status === 201, `item22: registers on five (got ${e1.status})`);
    const n1 = await needOf(appE);
    assert(n1.flips === 5, `item22: the condition requires five (got ${n1.flips})`);

    // 2. the officer edits the APPLICATION down to three. On its own this must NOT move
    //    the requirement — that ordering is a deliberate 2026-08-09 rule: a lowered claim
    //    only relaxes the gate once the product is RE-REGISTERED on it.
    await db.query(`UPDATE applications SET requested_exp_flips=3 WHERE id=$1`, [appE]);
    const n2 = await needOf(appE);
    assert(n2.flips === 5, `item22: editing the application alone does not relax it (got ${n2.flips})`);

    // 3. they re-register Products & Pricing on THREE. THIS is the step the owner says
    //    does not take.
    const e3 = await call(server, 'POST', reg(appE), tok,
      { program: 'standard', overrides: { ...SCENARIO, expFlips: 3, expHolds: 0, expGround: 0 } });
    assert(e3.status === 201, `item22: re-registers on three (got ${e3.status})`);
    const n3 = await needOf(appE);
    assert(n3.flips === 3, `item22: THE CONDITION NOW REQUIRES THREE (got ${n3.flips})`);
    const claim3 = await expOf(appE);
    assert(claim3 && Number(claim3.f) === 3, `item22: …and the file's own claim followed it down (got ${claim3 && claim3.f})`);

    await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
  } catch (e) {
    console.error('FAIL unexpected error:', e && e.stack || e);
    failures++;
  } finally {
    server.close();
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
