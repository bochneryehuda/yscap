'use strict';
/**
 * AN APPROVAL RELEASES THE HOLD — order must not matter (owner-reported 2026-08-07).
 *
 * "For example, if the appraisal comes in and you re-register, and then the admin
 * approves, you should not need another re-register."
 *
 * THE BUG. `product_registrations.needs_approval` (db/343) was written once at INSERT
 * and thereafter only READ — `esign/gate.js` blocks the term sheet on it. Approving
 * the escalation marked the REQUEST approved and never touched that stamp, so the
 * gate kept saying "waiting for approval" AFTER approval. The only way to get a row
 * without the stamp was to register again (where exceptionCoveredByGrant recognises
 * the grant) — the pointless extra re-register.
 *
 * The release asks the SAME question a re-register asks (exceptionCoveredByGrant), so
 * approve-then-re-register and re-register-then-approve settle identically, and an
 * approval can never clear a hold on terms it does not cover.
 *
 * DB-gated. Run: DATABASE_URL=... node scripts/test-approval-releases-hold-db.js
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-approval-releases-hold-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);

const db = require('../src/db');
const mp = require('../src/lib/manual-program');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

// The deviation the owner described: origination approved at 1.0 instead of 1.25.
const ORIG_1_0 = [{ key: 'origStdPct', label: 'Origination points — Standard', from: 1.25, to: 1.0 }];
const ORIG_0_9 = [{ key: 'origStdPct', label: 'Origination points — Standard', from: 1.25, to: 0.9 }];

(async () => {
  let borrowerId, appId;
  const mkReg = async (changes, totalLoan) => (await db.query(
    `INSERT INTO product_registrations
       (application_id, program, status, total_loan, inputs, quote, is_current,
        needs_approval, override_changes)
     VALUES ($1,'standard','ELIGIBLE',$2,'{}'::jsonb,'{}'::jsonb,true,true,$3::jsonb)
     RETURNING id`, [appId, totalLoan, JSON.stringify(changes)])).rows[0].id;
  const mkEsc = async (changes, totalLoan) => (await db.query(
    `INSERT INTO manual_program_escalations
       (application_id, status, overrides, summary)
     VALUES ($1,'pending','{}'::jsonb,$2::jsonb) RETURNING id`,
    [appId, JSON.stringify({ kind: 'pricing_override', program: 'standard',
      totalLoan, manualReasons: [], overrideLines: ['Origination points — Standard: 1.25% → 1%'],
      overrideChanges: changes })])).rows[0].id;
  const held = async (id) => (await db.query(
    `SELECT COALESCE(needs_approval,false) h FROM product_registrations WHERE id=$1`, [id])).rows[0].h;

  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Hold','Release',$1) RETURNING id`,
      [`hold-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'underwriting','Purchase') RETURNING id`,
      [borrowerId])).rows[0].id;

    // ---- 1. THE OWNER'S SEQUENCE: re-register first, THEN approve --------------
    const reg1 = await mkReg(ORIG_1_0, 400000);
    const esc1 = await mkEsc(ORIG_1_0, 400000);
    ok(await held(reg1) === true, 'the registration starts on hold (waiting for approval)');
    const d1 = await mp.decideEscalation(esc1, 'approved', null, 'approved at 1%');
    ok(d1 && d1.status === 'approved', 'the admin approves the request');
    ok(await held(reg1) === false,
      "APPROVING RELEASES THE HOLD — no second re-register (the owner's report)");
    ok(d1.holdRelease && d1.holdRelease.released === true,
      '…and the decision reports which registration it released');

    // ---- 2. A DECLINE MUST LEAVE THE HOLD EXACTLY WHERE IT IS ------------------
    await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
    const reg2 = await mkReg(ORIG_0_9, 400000);
    const esc2 = await mkEsc(ORIG_0_9, 400000);
    const d2 = await mp.decideEscalation(esc2, 'declined', null, 'no');
    ok(d2 && d2.status === 'declined' && await held(reg2) === true,
      'a DECLINE never releases the hold');
    ok(d2.holdRelease === undefined, '…and a decline does not even evaluate a release');

    // ---- 3. AN APPROVAL MAY ONLY RELEASE TERMS IT ACTUALLY COVERS --------------
    // The officer re-registered at 0.9% while 1.0% was pending. Approving the 1.0%
    // request must NOT clear a hold on 0.9% terms nobody approved.
    await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
    await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [appId]);
    const reg3 = await mkReg(ORIG_0_9, 400000);          // current terms: 0.9%
    const esc3 = await mkEsc(ORIG_1_0, 400000);          // the request: 1.0%
    const d3 = await mp.decideEscalation(esc3, 'approved', null, 'approved at 1%');
    ok(await held(reg3) === true,
      'approving 1.0% does NOT release a hold on 0.9% terms — the release asks the same question a re-register asks');
    ok(d3.holdRelease && d3.holdRelease.released === false,
      '…and it says why it did not release');

    // ---- 4. THE SAME VALUE ON A DIFFERENT LOAN SIZE IS STILL COVERED -----------
    // The appraisal moved the loan; origination is still the approved 1.0%.
    await db.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);
    await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [appId]);
    const reg4 = await mkReg(ORIG_1_0, 372500);          // re-registered on the appraisal
    const esc4 = await mkEsc(ORIG_1_0, 400000);          // approved at the ORIGINAL size
    await mp.decideEscalation(esc4, 'approved', null, 'ok');
    ok(await held(reg4) === false,
      'a loan amount that MOVED with the appraisal is still covered at the same 1.0% (the stickiness rule)');

    // ---- 5. IDEMPOTENT + NOTHING-TO-DO ----------------------------------------
    const again = await mp.releaseApprovalHold({ application_id: appId });
    ok(again.released === false && again.reason === 'nothing_on_hold',
      'a second release is a no-op — nothing on hold');
    const noApp = await mp.releaseApprovalHold({ application_id: null });
    ok(noApp.released === false, 'a decision with no file releases nothing and does not throw');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\ntest-approval-releases-hold-db: ALL PASS');
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('FATAL', e);
    process.exitCode = 1;
  } finally {
    try { if (appId) await db.query(`DELETE FROM manual_program_escalations WHERE application_id=$1`, [appId]); } catch (_) { }
    try { if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) { }
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) { }
    await db.pool.end().catch(() => {});
  }
})();
