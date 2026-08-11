/**
 * A PUBLIC application registers the product it was built on (owner-directed
 * 2026-08-06: "it should feed automatically into the products and pricing that
 * he'd chosen" … "register it automatically too").
 *
 *   A. A marketing application carrying `pricingProgram` is BORN REGISTERED —
 *      on the program elected, with the engine's own loan amount, and the note
 *      buyer that program implies.
 *   B. Officer routing is untouched: a named officer still owns the file; an
 *      unnamed one still lands unassigned for a human to assign.
 *   C. MANUAL never self-registers from a public post (nor does junk, nor an
 *      absent program) — the file simply arrives unpriced, as it does today.
 *   D. It never registers twice on one file.
 *   E. An INELIGIBLE / MANUAL-status scenario is left for a human — no automatic
 *      exception is ever raised by an anonymous form.
 *   F. It NEVER costs the lead: even when registration is impossible, the
 *      application and borrower are created exactly as before.
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-intake-auto-register-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
require('../src/server');                     // boots migrations + the engines
const AR = require('../src/lib/intake-auto-register');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let borrowerId = null, staffId = null;
  try {
    // ---- the pure half first: what may a public post register at all? --------
    assert(AR.publicProgram('standard') === 'standard' && AR.publicProgram('gold') === 'gold'
        && AR.publicProgram('silver') === 'silver', 'P1 the three self-registerable programs are accepted');
    for (const bad of ['manual', 'MANUAL', '', null, undefined, 'bogus', 0, {}]) {
      assert(AR.publicProgram(bad) === null, `P2 a public post may not register '${JSON.stringify(bad)}'`);
    }

    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Auto Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`autoreg-${sfx}@test.local`])).rows[0].id;
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Auto','Reg',$1,760) RETURNING id`,
      [`autoreg-bo-${sfx}@test.local`])).rows[0].id;

    // A healthy, comfortably eligible purchase — the plain case this door exists for.
    const mkApp = async (over = {}) => (await db.query(
      `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                 purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                 requested_exp_flips, property_address, source)
       VALUES ($1,$2,'new','Purchase','standard','SFR (1 unit)',$3,$4,$5,$6,'Cosmetic','12 Months',5,
               '{"line1":"1 Public Way","city":"Newark","state":"NJ","zip":"07102"}'::jsonb,'website')
       RETURNING id`,
      [borrowerId, over.officer === undefined ? staffId : over.officer,
       over.price || 400000, over.asIs || 400000, over.arv || 600000, over.rehab || 80000])).rows[0].id;
    const regOf = async (id) => (await db.query(
      `SELECT program, total_loan, registered_by FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [id])).rows[0] || null;
    const lenderOf = async (id) => (await db.query(`SELECT lender, loan_amount FROM applications WHERE id=$1`, [id])).rows[0];

    // ---- A. Born registered -------------------------------------------------
    const appA = await mkApp();
    const rA = await AR.autoRegisterFromIntake(appA, 'standard', db);
    assert(rA.registered === true, `A1 a public application registers the elected product (got ${JSON.stringify(rA)})`);
    const regA = await regOf(appA);
    assert(regA && regA.program === 'standard', `A2 …as the program they chose (got ${regA && regA.program})`);
    assert(regA && Number(regA.total_loan) > 0,
      `A3 …with the engine's own loan amount, not one carried from the browser (got ${regA && regA.total_loan})`);
    assert(regA && regA.registered_by === null,
      'A4 …recorded honestly as registered by nobody (no staff member was behind it)');
    const fileA = await lenderOf(appA);
    assert(fileA.lender === 'Fidelis Investors LLC',
      `A5 …and the Standard program picks up its note buyer (got ${JSON.stringify(fileA.lender)})`);
    assert(Number(fileA.loan_amount) === Number(regA.total_loan),
      'A6 …and the file carries the registered loan amount');

    // ---- B. Officer routing untouched ---------------------------------------
    assert((await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [appA])).rows[0].loan_officer_id === staffId,
      'B1 a file that named an officer still belongs to that officer after registering');
    const appB = await mkApp({ officer: null });
    const rB = await AR.autoRegisterFromIntake(appB, 'standard', db);
    assert(rB.registered === true, 'B2 an UNASSIGNED file registers just the same');
    assert((await db.query(`SELECT loan_officer_id FROM applications WHERE id=$1`, [appB])).rows[0].loan_officer_id === null,
      'B3 …and stays unassigned, for a human to assign from the general box');

    // ---- C. Manual / junk never self-register --------------------------------
    for (const bad of ['manual', 'bogus', '', null]) {
      const appC = await mkApp();
      const rC = await AR.autoRegisterFromIntake(appC, bad, db);
      assert(rC.registered === false && rC.reason === 'no_public_program',
        `C1 '${JSON.stringify(bad)}' does not self-register (got ${JSON.stringify(rC)})`);
      assert((await regOf(appC)) === null, 'C2 …and the file is left unpriced for the team');
    }

    // ---- D. Never twice ------------------------------------------------------
    const rD = await AR.autoRegisterFromIntake(appA, 'gold', db);
    assert(rD.registered === false && rD.reason === 'already_registered',
      `D1 a second post never mints a competing product (got ${JSON.stringify(rD)})`);
    assert((await regOf(appA)).program === 'standard', 'D2 …the first registration stands');

    // ---- E. Anything needing a human is left to one --------------------------
    // A purchase price far above the after-repair value cannot price as ELIGIBLE.
    const appE = await mkApp({ price: 5000000, asIs: 5000000, arv: 300000, rehab: 0 });
    const rE = await AR.autoRegisterFromIntake(appE, 'standard', db);
    assert(rE.registered === false, `E1 a scenario that is not plainly eligible is left for a human (got ${JSON.stringify(rE)})`);
    assert((await regOf(appE)) === null, 'E2 …with no registration and no automatic exception raised');

    // ---- F. Never costs the lead --------------------------------------------
    const rF = await AR.autoRegisterFromIntake('00000000-0000-0000-0000-000000000000', 'standard', db);
    assert(rF.registered === false && !!rF.reason, `F1 an impossible register answers a reason, never throws (got ${JSON.stringify(rF)})`);
    let threw = false;
    try { await AR.autoRegisterFromIntake(null, 'standard', null); } catch (_) { threw = true; }
    assert(!threw, 'F2 …and it never throws, whatever it is handed');
  } catch (e) {
    console.error('FAIL unexpected error:', (e && e.stack) || e);
    failures++;
  } finally {
    if (borrowerId) {
      await db.query(`DELETE FROM product_registrations WHERE application_id IN (SELECT id FROM applications WHERE borrower_id=$1)`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    }
    if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
  }
  /* THE FICO MUST BE JOINED IN — it is NOT a column on `applications`.
     A bare `SELECT * FROM applications` left it undefined, `buildInputs` resolved it
     to 0, and EVERY engine guards its floor with `fico > 0` — so a zero score did not
     FAIL the floor, it SKIPPED it. On this public, unauthenticated door that meant
     anyone could cause a file to be born with an ELIGIBLE, approval-free
     registration on a program the borrower is flatly ineligible for (Gold priced
     7.75% at a 600 score against a 660 floor). It was also wrong on every
     auto-registered file: the rate never matched what the applicant was shown. */
  {
    const bid = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,fico) VALUES ('Floor','Test',$1,600) RETURNING id`,
      [`autoreg-floor-${sfx}@test.local`])).rows[0].id;
    const mk = async () => (await db.query(
      `INSERT INTO applications
        (borrower_id,loan_type,program,property_type,units,property_address,purchase_price,
         as_is_value,arv,rehab_budget,rehab_type,term,requested_ir_months,
         requested_exp_flips,requested_exp_holds,requested_exp_ground,status)
       VALUES ($1,'Purchase','Fix & Flip w/ Construction','SFR (1 unit)',1,
         '{"line1":"5 Floor St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb,
         558000,558000,900000,150000,'Light Rehab','12 Months',0,6,6,6,'file_intake')
       RETURNING id`, [bid])).rows[0].id;

    for (const prog of ['gold', 'silver']) {
      const id = await mk();
      const r = await AR.autoRegisterFromIntake(id, prog, db);
      assert(r.registered === false && /ineligible/.test(String(r.reason)),
        `Z1 a 600 score is REFUSED on ${prog} — the floor is tested, not skipped (${JSON.stringify(r)})`);
      await db.query('DELETE FROM applications WHERE id=$1', [id]);
    }
    // …and with no score at all, nothing auto-registers: an absent score is
    // PROVISIONAL pricing, which is right for a human what-if and wrong for an
    // unattended door that would register an ELIGIBLE product nobody vetted.
    await db.query('UPDATE borrowers SET fico=NULL WHERE id=$1', [bid]);
    const id2 = await mk();
    const r2 = await AR.autoRegisterFromIntake(id2, 'standard', db);
    assert(r2.registered === false && r2.reason === 'no_fico',
      `Z2 no score at all is refused, never registered provisionally (${JSON.stringify(r2)})`);
    await db.query('DELETE FROM applications WHERE id=$1', [id2]);
    await db.query('DELETE FROM borrowers WHERE id=$1', [bid]);
  }

    await db.pool.end().catch(() => {});

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
