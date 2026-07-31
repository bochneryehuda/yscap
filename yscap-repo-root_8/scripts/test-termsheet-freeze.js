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

    // ---- The SCOPE-OF-WORK RE-ALLOCATION EXCLUSION, end to end (owner-directed
    // 2026-07-26). The freeze exists so a SENT term sheet can't disagree with the
    // file. Moving money BETWEEN line items leaves the construction budget total
    // untouched, so it can't cause that disagreement and must go through; moving
    // the TOTAL still can, so it must not. Proven through the REAL staff route,
    // not just the lock function — the matrix itself is covered by the pure test
    // scripts/test-sow-reallocation-lock-pure.js.
    await db.query(`UPDATE applications SET rehab_budget=126000 WHERE id=$1`, [appId]);
    await setEnv('sent');
    const saveSow = (total, items) => call(server, 'POST', `/api/staff/applications/${appId}/rehab-budget`, superTok,
      { payload: { total, state: { target: 126000, items } } });
    // The owner's case: $126,000 stays $126,000, $100 just moves between two lines.
    const before = [{ name: 'Kitchen', amount: 60000 }, { name: 'Baths', amount: 66000 }];
    const after = [{ name: 'Kitchen', amount: 59900 }, { name: 'Baths', amount: 66100 }];
    const sowA = await saveSow(126000, before);
    assert(sowA.status === 200, 'term-sheet SENT: a Scope of Work totalling the frozen budget SAVES (no longer a 409)');
    const sowB = await saveSow(126000, after);
    assert(sowB.status === 200, 'term-sheet SENT: money MOVED between line items, same $126,000 total → saves');
    const stored = (await db.query(`SELECT tool_payload FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' LIMIT 1`, [appId])).rows[0];
    assert(!!stored && Number(stored.tool_payload.state.items[0].amount) === 59900,
      'the reallocated line items actually persisted on the condition');
    assert(Number((await db.query(`SELECT rehab_budget FROM applications WHERE id=$1`, [appId])).rows[0].rehab_budget) === 126000,
      'the file’s rehab budget is untouched by the Scope of Work (it never writes it)');
    // Changing the TOTAL is still refused, and the refusal explains the allowance.
    const sowC = await saveSow(130000, [{ name: 'Kitchen', amount: 130000 }]);
    assert(sowC.status === 409, 'term-sheet SENT: a Scope of Work that CHANGES the total is still frozen (409)');
    assert(/move money BETWEEN Scope of Work line items/i.test((sowC.body && sowC.body.error) || ''),
      'the refusal tells staff that a same-total reallocation is what is allowed');
    // Past Clear to Close the same neutral save is frozen again — the scope has
    // gone to the investor, so it goes through the change-request workflow.
    await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [appId]);
    const sowD = await saveSow(126000, before);
    assert(sowD.status === 409, 'Clear to Close: even a same-total reallocation is frozen');
    assert(/change request/i.test((sowD.body && sowD.body.error) || ''),
      'the Clear-to-Close refusal points at the Scope of Work change request');
    await db.query(`UPDATE applications SET status='processing' WHERE id=$1`, [appId]);

    /* ---- THE PAYOFF WHO/WHICH EXCLUSION, end to end (owner-directed 2026-07-31).
       The closing attorney needs the servicer's name and their loan number in
       order to ORDER the payoff letter — which happens at closing prep, at or
       past Clear to Close and long after the term sheet went out. Neither field
       carries money, neither is a pricing input, and neither can change a number
       on the sheet, so an edit that touches ONLY those two must go through. The
       payoff AMOUNT is money and stays frozen, and a request that mixes the two
       falls straight back into the ordinary freeze. Proven through the REAL staff
       route, at super_admin authority with NO unlock on the file — so a 409 here
       is the genuine freeze, not a missing permission. */
    await setEnv('sent');
    const payoffOf = async () => (await db.query(
      `SELECT payoff_amount, payoff_lender, payoff_loan_number FROM applications WHERE id=$1`, [appId])).rows[0];
    await db.query(`UPDATE applications SET payoff_amount=300000, payoff_lender=NULL, payoff_loan_number=NULL WHERE id=$1`, [appId]);

    const p1 = await patch({ payoffLender: 'Chase Home Finance', payoffLoanNumber: 'CHF-88213' });
    assert(p1.status === 200, 'term-sheet SENT: naming WHO is paid off and their loan number goes through');
    const after1 = await payoffOf();
    assert(after1.payoff_lender === 'Chase Home Finance' && after1.payoff_loan_number === 'CHF-88213',
      'and it actually persisted');

    const p2 = await patch({ payoffAmount: 310000 });
    assert(p2.status === 409, 'term-sheet SENT: the payoff AMOUNT is still frozen — it is money');
    assert(Number((await payoffOf()).payoff_amount) === 300000, 'the frozen payoff amount did not change');

    const p3 = await patch({ payoffLender: 'Someone Else', payoffAmount: 310000 });
    assert(p3.status === 409, 'term-sheet SENT: a request that MIXES the amount in is refused as a whole');
    assert((await payoffOf()).payoff_lender === 'Chase Home Finance',
      'and the mixed request wrote nothing at all — not even the part that would have been allowed');

    // Clear to Close is the case this exists for: the payoff letter is ordered here.
    await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [appId]);
    const p4 = await patch({ payoffLender: 'Kiavi Servicing', payoffLoanNumber: 'KV-7781' });
    assert(p4.status === 200, 'Clear to Close: the servicer and their loan number can still be recorded');
    assert((await payoffOf()).payoff_lender === 'Kiavi Servicing', 'and persisted at Clear to Close');
    const p5 = await patch({ payoffAmount: 999999 });
    assert(p5.status === 409, 'Clear to Close: the payoff amount is still frozen');
    assert(Number((await payoffOf()).payoff_amount) === 300000, 'the amount is untouched at Clear to Close');

    /* AND IT STOPS THERE. The exclusion exists for the closing-prep window; past
       it the payoff has already been wired, so rewriting the record of who was
       paid on a closed loan is not closing prep, it is editing history. A first
       cut returned null for a contact-only body whatever the status, which
       lifted the freeze on funded / declined / withdrawn files too — found by
       the pre-merge audit. A super_admin unlock stays the recorded way through. */
    for (const st of ['funded', 'declined', 'withdrawn']) {
      await db.query(`UPDATE applications SET status=$2 WHERE id=$1`, [appId, st]);
      const px = await patch({ payoffLender: `SHOULD-NOT-STICK-${st}`, payoffLoanNumber: 'X' });
      assert(px.status === 409, `${st}: naming the payoff lender is frozen — this is no longer closing prep`);
      assert((await payoffOf()).payoff_lender === 'Kiavi Servicing',
        `${st}: and nothing was written`);
    }
    await db.query(`UPDATE applications SET status='processing' WHERE id=$1`, [appId]);

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
