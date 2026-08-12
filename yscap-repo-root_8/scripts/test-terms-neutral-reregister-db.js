/**
 * TERMS-NEUTRAL RE-REGISTER — end to end through the REAL register route
 * (owner-directed 2026-08-12).
 *
 * After a term sheet DocuSign package is SENT, re-registering is frozen ("clear the
 * Term Sheet package first"). A SUPER-ADMIN — and only a super-admin (owner-directed
 * 2026-08-12: "only a super admin should be able to do it") — may re-register
 * WITHOUT clearing the package when every borrower-visible number is unchanged and
 * only the internal program / markup / buy-rate moved. This drives POST
 * /pricing/register against a real Postgres and proves:
 *   (a) term-sheet SENT + super-admin + a terms-neutral (identical) re-register → 201;
 *   (b) a NON-super-admin gets 409 even on a neutral re-register (super-admin only);
 *   (c) a super-admin PROGRAM change with identical numbers (economicsChanged=true,
 *       terms-neutral=true) → 201 AND the borrower is NOT re-notified — the assertion
 *       that pins the `!termsNeutral` email-suppression clause;
 *   (d) a re-register that MOVES a final number → 409 (clear the package);
 *   (e) a re-register that changes only the TERM → 409 (term is borrower-visible);
 *   (f) a STATUS freeze (Clear to Close) refuses immediately, even when neutral;
 *   (g) clearing (voiding) the package lets a CHANGED re-register through again.
 *
 * The rule matrix is covered by scripts/test-terms-neutral-reregister-pure.js.
 */
// Skip cleanly when there is no database (the no-DB `test` CI job) — the real
// assertions run in the `test-db` job. NEVER hard-default DATABASE_URL to a local
// URL: that turns "no DB" into an ECONNREFUSED crash instead of a skip.
if (!process.env.DATABASE_URL) { console.log('SKIP test-terms-neutral-reregister-db (no DATABASE_URL)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-terms-neutral';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');
const crypto = require('crypto');
const REPO = __dirname + '/..';
const db = require(REPO + '/src/db');
const C = require(REPO + '/src/lib/crypto.js');
const uuid = () => crypto.randomUUID();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m); } };

function api(server, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}

async function main() {
  const app = require(REPO + '/src/server.js');
  await require(REPO + '/src/migrate-boot').ensureSchema();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  const B = uuid(), APP = uuid(), SUPER = uuid(), ADMIN = uuid();
  const notifCount = async () => Number((await db.query(
    `SELECT count(*) AS n FROM notifications WHERE application_id=$1 AND recipient_kind='borrower' AND type='term_sheet'`,
    [APP])).rows[0].n);
  const setEnv = async (status) => {
    await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [APP]);
    if (status) await db.query(`INSERT INTO esign_envelopes (application_id, purpose, status) VALUES ($1,'term_sheet_package',$2)`, [APP, status]);
  };
  const curReg = async () => {
    const q = (await db.query(`SELECT program, quote FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [APP])).rows[0];
    const quote = q && (typeof q.quote === 'string' ? JSON.parse(q.quote) : q.quote);
    const s = (quote && quote.sizing) || {};
    return q ? { program: q.program, totalLoan: s.totalLoan, rehabHoldback: s.rehabHoldback } : null;
  };

  try {
    await db.query(`INSERT INTO staff_users (id,email,full_name,role,password_hash,is_active) VALUES
      ($1,$2,'TN Super','super_admin','x',true), ($3,$4,'TN Admin','admin','x',true)`,
      [SUPER, `tnsuper_${SUPER.slice(0, 8)}@x.test`, ADMIN, `tnadmin_${ADMIN.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'TN','Borrower',$2)`, [B, `tn_${B.slice(0, 8)}@x.test`]);
    await db.query(`INSERT INTO applications (id,borrower_id,loan_officer_id,property_address,purchase_price,as_is_value,arv,rehab_budget,term,requested_exp_flips)
      VALUES ($1,$2,$3,$4,300000,300000,450000,50000,'12',2)`,
      [APP, B, SUPER, JSON.stringify({ line1: '5 Neutral Rd', city: 'Lakewood', state: 'NJ', zip: '08701' })]);
    const superTok = C.signJwt({ sub: SUPER, kind: 'staff', role: 'super_admin', tv: 0 });
    const adminTok = C.signJwt({ sub: ADMIN, kind: 'staff', role: 'admin', tv: 0 });

    const vanilla = { program: 'standard', overrides: {
      strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)', loanType: 'Purchase',
      purchasePrice: 300000, asIsValue: 300000, arv: 450000, rehabBudget: 50000, term: 12,
      expFlips: 2, expHolds: 0, expGround: 0, manualPricing: false,
    } };
    const register = (body, tok) => api(server, 'POST', `/api/staff/applications/${APP}/pricing/register`, body, tok);

    // ---- 1) First registration (no term sheet yet) ----
    let r = await register(vanilla, superTok);
    ok(r.status === 201, `first register succeeds — got ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`);
    const q0 = await curReg();
    ok(q0 && Number(q0.totalLoan) > 0, `a real quote landed on the file (loan ${q0 && q0.totalLoan})`);
    const notifAfterFirst = await notifCount();
    ok(notifAfterFirst >= 1, `the first registration notified the borrower (${notifAfterFirst} term_sheet notice)`);

    // ---- 2) Term sheet SENT → the freeze is live ----
    await setEnv('sent');

    // (b) A NON-super-admin is refused even on a terms-neutral (identical) re-register.
    r = await register(vanilla, adminTok);
    ok(r.status === 409, `term-sheet SENT + a plain ADMIN + neutral → 409 (carve-out is super-admin only) — got ${r.status}`);
    ok(/Clear the Term Sheet package first/i.test((r.body && r.body.error) || ''),
      'the admin refusal is the "clear the Term Sheet package" message');

    // (a) A SUPER-ADMIN terms-neutral (identical) re-register goes through.
    r = await register(vanilla, superTok);
    ok(r.status === 201, `term-sheet SENT + super-admin + terms-NEUTRAL re-register → 201 — got ${r.status}: ${JSON.stringify(r.body).slice(0, 140)}`);
    const q1 = await curReg();
    ok(q1 && Number(q1.totalLoan) === Number(q0.totalLoan) && Number(q1.rehabHoldback) === Number(q0.rehabHoldback),
      'the borrower-visible numbers are unchanged (still terms-neutral)');
    ok((await notifCount()) === notifAfterFirst, `an identical re-register does NOT re-notify (${await notifCount()} == ${notifAfterFirst})`);

    // (c) THE `!termsNeutral` EMAIL CLAUSE. Simulate the owner's Standard→Silver case
    // reliably: force the current registration to read program='silver' (its numbers
    // unchanged), then re-register Standard. borrowerTermsKey now DIFFERS (program) so
    // economicsChanged=true, while every borrower-visible number is identical so
    // termsNeutral=true. The freeze must lift AND the borrower must NOT be re-notified
    // — removing `!termsNeutral` would send the email here (economicsChanged=true).
    await db.query(`UPDATE product_registrations SET program='silver' WHERE application_id=$1 AND is_current`, [APP]);
    ok((await curReg()).program === 'silver', 'the current registration now reads a DIFFERENT program (silver) with the same numbers');
    const notifBeforeProgSwitch = await notifCount();
    r = await register(vanilla, superTok);   // re-register Standard, numbers identical
    ok(r.status === 201, `super-admin PROGRAM change with identical numbers → 201 (freeze lifted) — got ${r.status}`);
    ok((await curReg()).program === 'standard', 'the re-register actually changed the program back to standard (economicsChanged path)');
    ok((await notifCount()) === notifBeforeProgSwitch,
      `a program-only neutral re-register does NOT re-notify the borrower (${await notifCount()} == ${notifBeforeProgSwitch}) — the !termsNeutral clause`);

    // (d) A re-register that MOVES a final number (construction holdback, via the
    // rehab budget) is still frozen — the old rule stands.
    r = await register({ ...vanilla, overrides: { ...vanilla.overrides, rehabBudget: 40000 } }, superTok);
    ok(r.status === 409, `term-sheet SENT + a MOVED final number → 409 (still frozen) — got ${r.status}`);
    ok(/Clear the Term Sheet package first/i.test((r.body && r.body.error) || ''), 'the refusal is the "clear the Term Sheet package" message');
    ok(Number((await curReg()).rehabHoldback) === Number(q1.rehabHoldback), 'the frozen re-register wrote nothing');

    // (e) A re-register that changes ONLY the loan term is still frozen (the term is
    // borrower-visible; on Standard it also moves the rate, but the term guard alone
    // would catch it too).
    r = await register({ ...vanilla, overrides: { ...vanilla.overrides, term: 18 } }, superTok);
    ok(r.status === 409, `term-sheet SENT + a term change (12 → 18) → 409 (not neutral) — got ${r.status}`);

    // (f) A STATUS freeze refuses immediately, even for a super-admin's neutral re-register.
    await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [APP]);
    r = await register(vanilla, superTok);
    ok(r.status === 409, `Clear to Close + super-admin + neutral → 409 (status freeze stands) — got ${r.status}`);
    ok(/its loan structure is locked/i.test((r.body && r.body.error) || '') && !/Clear the Term Sheet package first/i.test((r.body && r.body.error) || ''),
      'the Clear-to-Close refusal is the STATUS-lock message, not the term-sheet one');
    await db.query(`UPDATE applications SET status='processing' WHERE id=$1`, [APP]);

    // (g) Clearing (voiding) the package lifts the freeze — a CHANGED re-register now persists.
    await setEnv('voided');
    r = await register({ ...vanilla, overrides: { ...vanilla.overrides, rehabBudget: 40000 } }, superTok);
    ok(r.status === 201, `package cleared → a CHANGED re-register succeeds — got ${r.status}`);
    ok(Number((await curReg()).rehabHoldback) !== Number(q1.rehabHoldback), 'the changed re-register moved the construction holdback once unfrozen');
  } catch (e) { fail++; console.log('  ✗ EXCEPTION', e && e.stack ? e.stack : e); }
  finally {
    await db.query(`DELETE FROM notifications WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM product_registrations WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM checklist_items WHERE application_id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE id=$1`, [APP]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [B]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=ANY($1::uuid[])`, [[SUPER, ADMIN]]).catch(() => {});
  }
  server.close();
  console.log(`\nterms-neutral-reregister-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main();
