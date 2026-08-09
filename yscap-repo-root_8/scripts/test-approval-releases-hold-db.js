'use strict';
/**
 * AN APPROVAL CLEARS THE APPROVAL STAMP ON THE REGISTRATION IT WAS GRANTED FOR
 * (owner-directed 2026-08-07: "if the appraisal comes in and you re-register, and
 * then the admin approves, you should not need another re-register").
 *
 * WHAT THIS IS AND IS NOT. `product_registrations.needs_approval` (db/343) was
 * written once at INSERT and thereafter only read. It is NOT what holds the term
 * sheet: `esign/gate.js` raises `manual_approval` only while `pendingForApp()`
 * still finds an OPEN escalation, so deciding the escalation already unblocks
 * issuance. This is a RECORD-KEEPING fix — the stored stamp now agrees with the
 * decision, which is what the `/pricing` history reads. The suite deliberately
 * does NOT claim to unblock anything; see the header of releaseApprovalHold.
 *
 * THE SAFETY PROPERTY IS THE KEY, not a coverage walk: the approval belongs to
 * `escalation.registration_id`, so it can only ever clear that row, and only while
 * that row is still current.
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

/* The deviation the owner described: origination approved at 1.0 instead of 1.25.
   THESE ARE THE REAL SHAPES — a change list is what pricingOverridesEngaged()
   produces ({label, unit, value}), and an escalation's `overrides` is the SLIM
   {key: rawValue} map. `override_changes` is stored as NULL when there are no
   deviations, exactly as product-registration.js does it, so no fixture here
   describes a state production cannot produce. */
const LABEL = 'Origination points — Standard';
const changesAt = (pct) => [{ key: 'origStdPct', label: LABEL, unit: 'pct', value: pct }];
const ORIG_1_0 = changesAt(1.0);

(async () => {
  let borrowerId, appId;
  const mkReg = async (changes, totalLoan, opts = {}) => (await db.query(
    `INSERT INTO product_registrations
       (application_id, program, status, total_loan, inputs, quote, is_current,
        needs_approval, override_changes)
     VALUES ($1,$4,$5,$2,'{}'::jsonb,'{}'::jsonb,true,true,$3::jsonb)
     RETURNING id`,
    [appId, totalLoan, changes && changes.length ? JSON.stringify(changes) : null,
     opts.program || 'standard', opts.status || 'ELIGIBLE'])).rows[0].id;
  // registration_id is what every production door records (staff.js / borrower.js).
  const mkEsc = async (regId, changes, totalLoan) => (await db.query(
    `INSERT INTO manual_program_escalations
       (application_id, registration_id, status, overrides, summary)
     VALUES ($1,$2,'pending',$4::jsonb,$3::jsonb) RETURNING id`,
    [appId, regId,
     JSON.stringify({ kind: 'pricing_override', program: 'standard', totalLoan,
       manualReasons: [], overrideLines: ['Origination points — Standard: 1.25% → 1%'],
       overrideChanges: changes }),
     JSON.stringify({ origStdPct: changes[0].value })])).rows[0].id;
  const held = async (id) => (await db.query(
    `SELECT COALESCE(needs_approval,false) h FROM product_registrations WHERE id=$1`, [id])).rows[0].h;
  const retire = () => db.query(
    `UPDATE product_registrations SET is_current=false WHERE application_id=$1`, [appId]);

  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Hold','Release',$1) RETURNING id`,
      [`hold-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'underwriting','Purchase') RETURNING id`,
      [borrowerId])).rows[0].id;

    // ---- 1. THE OWNER'S SEQUENCE: re-register first, THEN approve --------------
    const reg1 = await mkReg(ORIG_1_0, 400000);
    const esc1 = await mkEsc(reg1, ORIG_1_0, 400000);
    ok(await held(reg1) === true, 'the registration starts stamped "waiting for approval"');
    const d1 = await mp.decideEscalation(esc1, 'approved', null, 'approved at 1%');
    ok(d1 && d1.status === 'approved', 'the admin approves the request');
    ok(await held(reg1) === false,
      "APPROVING CLEARS THE STAMP — no second re-register (the owner's sequence)");
    ok(d1.holdRelease && d1.holdRelease.released === true
      && d1.holdRelease.registrationId === reg1,
      '…and it names the registration it cleared — the one the approval was opened for');

    // ---- 2. A DECLINE LEAVES THE STAMP EXACTLY WHERE IT IS ---------------------
    await retire();
    const reg2 = await mkReg(ORIG_1_0, 400000);
    const esc2 = await mkEsc(reg2, ORIG_1_0, 400000);
    const d2 = await mp.decideEscalation(esc2, 'declined', null, 'no');
    ok(d2 && d2.status === 'declined' && await held(reg2) === true,
      'a DECLINE never clears the stamp');
    ok(d2.holdRelease === undefined, '…and a decline does not even evaluate a release');

    /* ---- 3. THE APPROVAL ONLY EVER TOUCHES ITS OWN REGISTRATION ---------------
       The officer re-registered at different terms while the request sat pending.
       The pending request belongs to the RETIRED row, so approving it must not
       reach the new one — that row carries its own escalation, and an approval has
       to be granted for it. This is the case the first cut got wrong by keying on
       "whatever registration is current". */
    await retire();
    const regOld = await mkReg(ORIG_1_0, 400000);          // what was sent for approval
    const escOld = await mkEsc(regOld, ORIG_1_0, 400000);
    await retire();                                        // the officer re-registers…
    const regNew = await mkReg(changesAt(0.9), 372500);    // …at 0.9% on the appraisal
    const d3 = await mp.decideEscalation(escOld, 'approved', null, 'approved at 1%');
    ok(await held(regNew) === true,
      'approving the OLD request does NOT clear the stamp on a newly re-registered row');
    ok(await held(regOld) === true,
      '…and it does not clear the retired row it belonged to either (no longer current)');
    ok(d3.holdRelease && d3.holdRelease.released === false
      && d3.holdRelease.reason === 'superseded',
      `…and it says the request was superseded by the re-register (got ${d3.holdRelease && d3.holdRelease.reason})`);

    // ---- 4. THE SAME REQUEST APPROVED TWICE IS A NO-OP ------------------------
    await retire();
    const reg4 = await mkReg(ORIG_1_0, 400000);
    const esc4 = await mkEsc(reg4, ORIG_1_0, 400000);
    await mp.decideEscalation(esc4, 'approved', null, 'ok');
    ok(await held(reg4) === false, 'the stamp is cleared once');
    const again = await mp.releaseApprovalHold({ application_id: appId, registration_id: reg4 });
    ok(again.released === false && again.reason === 'nothing_on_hold',
      'a second release is a no-op — nothing left on hold');

    // ---- 5. NOTHING TO GO ON → NOTHING RELEASED, AND NEVER A THROW ------------
    const noApp = await mp.releaseApprovalHold({ application_id: null, registration_id: reg4 });
    ok(noApp.released === false && noApp.reason === 'no_application',
      'a decision with no file releases nothing and does not throw');
    const noReg = await mp.releaseApprovalHold({ application_id: appId, registration_id: null });
    ok(noReg.released === false && noReg.reason === 'no_registration',
      'an escalation with no recorded registration is never guessed at');

    /* ---- 6. WHAT THE STAMP ACTUALLY DOES TO THE GATE --------------------------
       Two facts that together are the whole reason this function is keyed the way
       it is, and the reason it must never become a sweep. Both are measured here
       rather than asserted in a comment, because the first cut of this change was
       built on a wrong belief about them.
         (a) DECIDING the escalation is what unblocks issuance — so this function
             does not unblock anything, and must not be described as if it does.
         (b) On a pricing-override-only row the stamp is nevertheless LOAD-BEARING:
             it is the only reason needsSuperAdminApproval() returns true, so
             clearing it while the escalation is still OPEN makes the file issuable
             with an approval outstanding. That is the hazard the registration_id +
             is_current keying exists to prevent. */
    await retire();
    const reg6 = await mkReg(ORIG_1_0, 400000);
    const esc6 = await mkEsc(reg6, ORIG_1_0, 400000);
    const gate = require('../src/lib/esign/gate');
    const blocks = async () => (await gate.registrationIssuabilityBlockers(appId, db))
      .some((b) => b.code === 'manual_approval');
    ok(await blocks() === true, 'while the escalation is OPEN the gate blocks with manual_approval');
    await db.query(`UPDATE product_registrations SET needs_approval=false WHERE id=$1`, [reg6]);
    ok(await blocks() === false,
      'the stamp IS load-bearing on a pricing-override row — clearing it early would issue with an approval outstanding');
    await db.query(`UPDATE product_registrations SET needs_approval=true WHERE id=$1`, [reg6]);
    ok(await blocks() === true, '…restored: still blocked while the request is open');
    // Now decide it. The blocker goes because the escalation is decided (a), and the
    // stamp is cleared in the same breath so the record agrees with the decision.
    await mp.decideEscalation(esc6, 'approved', null, 'ok');
    ok(await blocks() === false, 'deciding the escalation is what unblocks issuance');
    ok(await held(reg6) === false, '…and the stored record now agrees with the decision');

    /* ---- 7. THE CROSS-FILE GUARD (post-merge audit #2) -----------------------
       `AND application_id=$2` is the only thing standing between a corrupt or
       hand-edited escalation row and a write to ANOTHER borrower's file. Production
       cannot produce one (both doors record the row they just inserted for the same
       file), so it is forged here — the guard was previously removable with the whole
       suite still green, which is the one state a safety check must never be in. */
    {
      const otherBor = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Other','File',$1) RETURNING id`,
        [`hold-other-${sfx}@test.local`])).rows[0].id;
      const otherApp = (await db.query(
        `INSERT INTO applications (borrower_id,status,loan_type) VALUES ($1,'underwriting','Purchase') RETURNING id`,
        [otherBor])).rows[0].id;
      const otherReg = (await db.query(
        `INSERT INTO product_registrations
           (application_id, program, status, total_loan, inputs, quote, is_current, needs_approval)
         VALUES ($1,'standard','ELIGIBLE',500000,'{}'::jsonb,'{}'::jsonb,true,true) RETURNING id`,
        [otherApp])).rows[0].id;
      // An escalation on OUR file naming the OTHER file's registration.
      const out = await mp.releaseApprovalHold({ application_id: appId, registration_id: otherReg });
      ok(out.released === false, 'an escalation naming another file\u2019s registration releases nothing');
      ok(out.reason === 'registration_not_on_this_file',
        `\u2026and it says the registration is not on this file (got ${out.reason})`);
      const otherStill = (await db.query(
        `SELECT COALESCE(needs_approval,false) h FROM product_registrations WHERE id=$1`, [otherReg])).rows[0].h;
      ok(otherStill === true, '\u2026and the OTHER file\u2019s registration is untouched');
      try { await db.query(`DELETE FROM applications WHERE id=$1`, [otherApp]); } catch (_) { }
      try { await db.query(`DELETE FROM borrowers WHERE id=$1`, [otherBor]); } catch (_) { }
    }

    /* ---- 8. THE SAVEPOINT ACTUALLY PROTECTS THE CALLER (audit #3) ------------
       Every other case here runs on the autocommit pool, so the savepoint branch
       never executed under test and could be deleted with the suite still green.
       The regression that would reintroduce: a swallowed pg error leaves the
       caller's transaction ABORTED (25P02), so its COMMIT silently becomes a
       rollback and the DECISION ITSELF is lost. Forced by pointing the escalation's
       registration at a non-UUID so the UPDATE raises 22P02 inside the release. */
    {
      const reg8 = await (async () => { await retire(); return mkReg(ORIG_1_0, 400000); })();
      const esc8 = await mkEsc(reg8, ORIG_1_0, 400000);
      const client = await db.pool.connect();
      let committed = false, decided = null;
      try {
        await client.query('BEGIN');
        // A caller-owned write in the same transaction, to prove it survives.
        await client.query(`UPDATE applications SET status='underwriting' WHERE id=$1`, [appId]);
        const wrapped = {
          query: (sql, params) => client.query(sql, params),
          pool: db.pool,
        };
        // Force the inner UPDATE to fail: hand back a row whose registration_id is junk.
        const orig = wrapped.query;
        wrapped.query = (sql, params) => {
          if (/UPDATE product_registrations SET needs_approval=false/.test(String(sql))) {
            return orig('UPDATE product_registrations SET needs_approval=false WHERE id=$1::uuid RETURNING id', ['not-a-uuid']);
          }
          return orig(sql, params);
        };
        decided = await mp.decideEscalation(esc8, 'approved', null, 'ok', wrapped);
        await client.query('COMMIT');
        committed = true;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch (_) { }
        console.log('  (savepoint case threw:', e.message, ')');
      } finally { client.release(); }
      ok(committed === true,
        'a failed stamp release does NOT abort the caller\u2019s transaction \u2014 the COMMIT still succeeds');
      ok(decided && decided.status === 'approved' && decided.holdRelease
        && decided.holdRelease.reason === 'error',
        '\u2026and it reports the failure rather than claiming a release');
      const stillDecided = (await db.query(
        `SELECT status FROM manual_program_escalations WHERE id=$1`, [esc8])).rows[0];
      ok(stillDecided && stillDecided.status === 'approved',
        '\u2026and THE DECISION SURVIVED the commit (the 25P02 regression this guards)');
      ok(await held(reg8) === true, '\u2026while the stamp was correctly left alone');
    }

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
