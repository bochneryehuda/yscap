/**
 * TERM-SHEET-SENT structure freeze (owner-directed 2026-07-22). Once the Term
 * Sheet DocuSign package is SENT, the loan's figures + structure freeze at the
 * shared structuralLockReason chokepoint (so every economics write path enforces
 * it), and only clearing (voiding) the package lifts it. A super_admin unlock
 * does NOT bypass this freeze — clearing the package is the deliberate action.
 *
 * Direct lock-function matrix + a real PATCH /details enforcement proof. Requires
 * DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-termsheet-freeze (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const lock = require('../src/lib/file-lock');
const app = require('../src/server');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
function call(server, method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  let superId, borrowerId;
  try {
    superId = (await db.query(`INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version) VALUES ($1,'Super','super_admin',true,false,'x',0) RETURNING id`, [`tf-super-${sfx}@test.local`])).rows[0].id;
    const superTok = C.signJwt({ sub: superId, kind: 'staff', role: 'super_admin', tv: 0 });
    const superActor = { kind: 'staff', role: 'super_admin', id: superId };
    borrowerId = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Tf','Test',$1) RETURNING id`, [`tf-bo-${sfx}@test.local`])).rows[0].id;
    // A NON-locked file (status 'processing') so the ONLY freeze under test is the term-sheet one.
    const appId = (await db.query(`INSERT INTO applications (borrower_id, loan_officer_id, status, purchase_price) VALUES ($1,$2,'processing',400000) RETURNING id`, [borrowerId, superId])).rows[0].id;

    const setEnv = async (status) => {
      await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]);
      if (status) await db.query(`INSERT INTO esign_envelopes (application_id, purpose, status) VALUES ($1,'term_sheet_package',$2)`, [appId, status]);
    };

    // ---- Direct lock-function matrix ----
    await setEnv(null);
    assert((await lock.structuralLockReason(appId, db)) === null, 'no term-sheet envelope → editable');

    for (const st of ['sent', 'delivered', 'completed']) {
      await setEnv(st);
      // Staff actor → the actionable "clear the package" copy (and a super_admin
      // is still frozen — a non-null reason proves the freeze isn't bypassed).
      const staffMsg = await lock.structuralLockReason(appId, db, { actor: superActor });
      assert(!!staffMsg && /clear the term sheet package/i.test(staffMsg), `term-sheet "${st}" → staff (incl. super_admin) get the "clear the package" message; freeze not bypassed`);
      // No actor (the borrower register/SOW paths) → a borrower-friendly message
      // that does NOT tell them to clear a package they can't clear.
      const borrowerMsg = await lock.structuralLockReason(appId, db);
      assert(!!borrowerMsg && /loan officer/i.test(borrowerMsg) && !/clear the term sheet package/i.test(borrowerMsg),
        `term-sheet "${st}" → a borrower sees a loan-officer message, not "clear the package"`);
      assert((await lock.termSheetSentLock(appId, db)) === true, `termSheetSentLock true when "${st}"`);
    }

    for (const st of ['not_sent', 'voided', 'declined', 'error']) {
      await setEnv(st);
      assert((await lock.structuralLockReason(appId, db)) === null, `term-sheet package "${st}" → NOT frozen (cleared/inactive)`);
      assert((await lock.termSheetSentLock(appId, db)) === false, `termSheetSentLock false when "${st}"`);
    }

    // A DIFFERENT package (heter_iska) sent must NOT freeze the structure.
    await db.query(`DELETE FROM esign_envelopes WHERE application_id=$1`, [appId]);
    await db.query(`INSERT INTO esign_envelopes (application_id, purpose, status) VALUES ($1,'heter_iska','sent')`, [appId]);
    assert((await lock.structuralLockReason(appId, db)) === null, 'a sent Heter Iska package does NOT freeze the structure (only the Term Sheet package does)');

    // ---- Real enforcement: PATCH /details is blocked when term-sheet-sent, allowed when cleared ----
    await setEnv('sent');
    const patch = (body) => call(server, 'PATCH', `/api/staff/applications/${appId}/details`, superTok, body);
    const r1 = await patch({ purchasePrice: 555000 });
    assert(r1.status === 409 && /Term Sheet/i.test((r1.body && r1.body.error) || ''), 'PATCH /details is blocked (409) with the clear-the-package message while term-sheet-sent');
    assert(Number((await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [appId])).rows[0].purchase_price) === 400000, 'the frozen price did not change');
    // Clear the package (void) → the freeze lifts → the edit goes through.
    await setEnv('voided');
    const r2 = await patch({ purchasePrice: 555000 });
    assert(r2.status === 200, 'after the package is cleared (voided), PATCH /details succeeds');
    assert(Number((await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [appId])).rows[0].purchase_price) === 555000, 'the edit persisted once unfrozen');

    console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL term-sheet-freeze assertions passed');
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (superId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [superId]); } catch (_) {}
    server.close();
  }
  process.exit(failures ? 1 : 0);
})();
