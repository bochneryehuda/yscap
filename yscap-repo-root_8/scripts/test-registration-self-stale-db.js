'use strict';
/**
 * A REGISTRATION MUST NEVER MARK ITSELF STALE — and the reason must always NAME
 * what changed (owner-reported 2026-08-07, the term-sheet dead end).
 *
 * THE REPORT. "Before sending out the DocuSign Term Sheet package, the registration
 * needs to be current, and you need to sign off on the registration … even after you
 * re-register, you sign off, and you upload your appraisal, you do everything the
 * system is requiring, it still says that the registration needs to be current. Deal
 * economics has changed … Deal economics were not changed. Who changed the deal
 * economics? I just went a minute ago to do it."
 *
 * THE CAUSE, reproduced here in both halves:
 *  (A) `persistProductRegistration` clears `stale` on the row it just wrote, and its
 *      own comment says it does so LAST "so nothing re-flags it". It was not last:
 *      the staff register route then writes the four sticky `file_markup_*` columns
 *      and the typed cash-out. The markup write trips the economics trigger, whose
 *      UPDATE targets `is_current AND NOT stale` — precisely what the clear had just
 *      made true — so the brand-new registration was stamped stale a few statements
 *      after being created. `esignSendGate` then refused on `registration_stale`
 *      forever, and the trigger's second UPDATE re-opened Products & Pricing, so
 *      signing off could not settle it either.
 *  (B) The trigger's change DETECTOR watched ten inputs its change DESCRIPTION never
 *      named, so this fired with the generic "deal economics changed" and nothing
 *      listed — which is why nobody could answer the owner's question.
 *
 * Both are pinned against a REAL database and the REAL trigger, because the whole
 * defect lives in the interaction between a route's statement order and a trigger.
 * DB-gated. Run: DATABASE_URL=... node scripts/test-registration-self-stale-db.js
 */
if (!process.env.DATABASE_URL) {
  console.log('SKIP test-registration-self-stale-db (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);

const db = require('../src/db');
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;

(async () => {
  let borrowerId, appId, regId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Self','Stale',$1) RETURNING id`,
      [`selfstale-${sfx}@test.local`])).rows[0].id;
    appId = (await db.query(
      `INSERT INTO applications (borrower_id,status,loan_type,program,purchase_price,arv,rehab_budget)
       VALUES ($1,'underwriting','Purchase','Fix & Flip',500000,800000,100000) RETURNING id`,
      [borrowerId])).rows[0].id;
    regId = (await db.query(
      `INSERT INTO product_registrations (application_id,program,status,total_loan,inputs,quote,is_current,stale)
       VALUES ($1,'gold','ELIGIBLE',400000,'{}'::jsonb,'{}'::jsonb,true,false) RETURNING id`,
      [appId])).rows[0].id;

    const reg = async () => (await db.query(
      `SELECT stale, stale_reason FROM product_registrations WHERE id=$1`, [regId])).rows[0];
    const clear = () => db.query(
      `UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1`, [regId]);

    // ---- (B) EVERY WATCHED INPUT NAMES ITSELF -------------------------------
    // Each of these moved the file WITHOUT being itemized, so each produced the
    // generic wording. The assertion is on the WORDS an officer reads.
    const cases = [
      ['file_markup_gold_pct = 1.25',            'Gold markup',        'the Gold markup'],
      ['file_markup_std_pct = 0.5',              'Standard markup',    'the Standard markup'],
      ['file_markup_silver_pct = 0.75',          'Silver markup',      'the Silver markup'],
      ['file_markup_gold_t1_pct = 0.25',         'Gold top-tier markup', 'the Gold top-tier markup'],
      ['requested_exp_flips = 7',                'Experience (flips)', 'a claimed flip count'],
      ['requested_exp_holds = 3',                'Experience (holds)', 'a claimed hold count'],
      ['requested_exp_ground = 2',               'Experience (ground-up)', 'a claimed ground-up count'],
      ['is_assignment = true',                   'Assignment',         'the assignment flag'],
      ['rehab_type = \'Heavy\'',                 'Rehab type',         'the rehab type'],
      ['sqft_pre = 1200',                        'Square footage (current)', 'the current square footage'],
      ['sqft_post = 1800',                       'Square footage (after)',   'the after square footage'],
    ];
    for (const [setSql, needle, what] of cases) {
      await clear();
      await db.query(`UPDATE applications SET ${setSql} WHERE id=$1`, [appId]);
      const r = await reg();
      ok(r.stale === true, `B: moving ${what} still flags the registration (detection unchanged)`);
      ok(String(r.stale_reason || '').includes(needle),
        `B: …and the reason NAMES it ("${needle}") instead of the generic wording`);
      ok(!/^deal economics changed/.test(String(r.stale_reason || '')),
        `B: …so "${what}" never reads as the un-nameable generic message`);
    }

    // The co-borrower reads as added/removed rather than a bare id.
    {
      const cob = (await db.query(
        `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Co','Bor',$1) RETURNING id`,
        [`cob-${sfx}@test.local`])).rows[0].id;
      await clear();
      await db.query(`UPDATE applications SET co_borrower_id=$2 WHERE id=$1`, [appId, cob]);
      const r = await reg();
      ok(/Co-borrower: added/.test(String(r.stale_reason || '')),
        'B: adding a co-borrower reads "Co-borrower: added", never a raw id and never generic');
      await db.query(`UPDATE applications SET co_borrower_id=NULL WHERE id=$1`, [appId]);
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [cob]);
    }

    /* The semantic compares MUST still be semantic — a re-spelling is not a change.
       Establish the term FIRST (blank → "12 Months" is a real change and correctly
       flags), clear, and only THEN re-spell: otherwise the assertion reads the flag
       the setup itself raised, which is what the first cut of this test did. */
    await db.query(`UPDATE applications SET term='12 Months' WHERE id=$1`, [appId]);
    await clear();
    await db.query(`UPDATE applications SET term='12' WHERE id=$1`, [appId]);
    ok((await reg()).stale === false,
      'B: a term RE-SPELLING ("12 Months" → "12") still changes nothing — the db/288 rule survives');

    // ---- (A) THE ROUTE'S ORDER — the clear is the last word ------------------
    // The route's real sequence, in order: persist clears the flag, THEN the sticky
    // markup lands, THEN (the fix) the clear runs again before COMMIT.
    await clear();                                                   // persist's clear
    await db.query(`UPDATE applications SET file_markup_gold_pct=2.5 WHERE id=$1`, [appId]);
    ok((await reg()).stale === true,
      'A: the sticky-markup write DOES trip the trigger — this is the loop, reproduced');
    await db.query(                                                  // the fix, verbatim
      `UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1 AND stale`, [regId]);
    const settled = await reg();
    ok(settled.stale === false && settled.stale_reason == null,
      'A: …and the final clear settles it, so the fresh registration is NOT stale');

    // The guard must be narrow: it may only undo a flag, never touch anything else.
    const other = (await db.query(
      `INSERT INTO product_registrations (application_id,program,status,total_loan,inputs,quote,is_current,stale,stale_reason)
       VALUES ($1,'gold','ELIGIBLE',390000,'{}'::jsonb,'{}'::jsonb,false,true,'a genuinely stale older row') RETURNING id`,
      [appId])).rows[0].id;
    await db.query(
      `UPDATE product_registrations SET stale=false, stale_reason=NULL WHERE id=$1 AND stale`, [regId]);
    const older = (await db.query(`SELECT stale, stale_reason FROM product_registrations WHERE id=$1`, [other])).rows[0];
    ok(older.stale === true && older.stale_reason === 'a genuinely stale older row',
      'A: the clear is keyed on the NEW registration only — an older stale row is untouched');

    // A REAL later change must still flag it. The fix must not make a registration
    // permanently un-stale-able — that would be a far worse bug than the loop.
    await db.query(`UPDATE applications SET arv=999000 WHERE id=$1`, [appId]);
    const afterReal = await reg();
    ok(afterReal.stale === true && /ARV/.test(String(afterReal.stale_reason || '')),
      'A: a REAL change after the register still flags it, and still names the number');

    /* THE ROUTE MUST ACTUALLY BE WIRED THAT WAY — asserted STRUCTURALLY, because
       everything above drives the SQL sequence directly and would keep passing with
       the route reverted. The clear has to be the LAST statement before COMMIT: a
       file write added after it would silently re-arm the whole loop, and no
       scenario test would notice until an officer could not send a term sheet. */
    {
      const src = require('fs').readFileSync(
        require('path').join(__dirname, '..', 'src/routes/staff.js'), 'utf8');
      const CLEAR = /UPDATE product_registrations SET stale=false, stale_reason=NULL\s*\n\s*WHERE id=\$1 AND stale`, \[reg\.id\]\);\s*\n\s*await client\.query\('COMMIT'\);/;
      ok(CLEAR.test(src),
        'A: the register route clears stale IMMEDIATELY before COMMIT (nothing may write the file after it)');
    }

    console.log(failures ? `\n${failures} assertion(s) failed` : '\ntest-registration-self-stale-db: ALL PASS');
    process.exitCode = failures ? 1 : 0;
  } catch (e) {
    console.error('FATAL', e);
    process.exitCode = 1;
  } finally {
    try { if (appId) await db.query(`DELETE FROM applications WHERE id=$1`, [appId]); } catch (_) { }
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) { }
    await db.pool.end().catch(() => {});
  }
})();
