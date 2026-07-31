'use strict';
/* =====================================================================
   THE POST-MERGE AUDIT'S FINDINGS, EACH THROUGH THE REAL HTTP DOOR
   (2026-07-31).

   Every case here was reproduced against a real Postgres BEFORE it was fixed,
   and every assertion was checked to FAIL on the pre-fix code. They are grouped
   by the audit's own numbering:

     D2  a failing register LEAKED its pooled connection — ten of them exhaust
         DB_POOL_MAX and every request in the app answers 503. This is the one
         that could take the whole service down, so it is first.
     D1  the borrower's own submit answered 500 on an oversized money value,
         leaving a finished application that could not be filed and no hint
         which box was at fault.
     D3  the info-condition door had NO freeze of any kind, so a borrower could
         rewrite economics on a FUNDED file.
     D4  the details door did not trim its text columns, so "   " stored three
         spaces, counted as answered, and rendered an empty labelled row.
     D7  the cash-to-close door bound whatever `docId` string arrived — a
         malformed uuid, a deleted document, or ANOTHER FILE'S document.

   Needs DATABASE_URL; skips cleanly without one.
   Run: DATABASE_URL=… node scripts/test-audit-hardening-db.js
   ===================================================================== */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

if (!process.env.DATABASE_URL) {
  console.log('(skipping — no DATABASE_URL)');
  process.exit(0);
}

(async () => {
  const db = require('../src/db');
  const C = require('../src/lib/crypto');
  const http = require('http');
  const sfx = Date.now().toString(36);
  let server = null;

  try {
    const borrowerId = (await db.query(
      `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Audit','Hardening') RETURNING id`,
      [`aud-hard-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Audit Admin','super_admin',true,false,'x',0) RETURNING id`,
      [`aud-hard-admin-${sfx}@test.local`])).rows[0].id;

    const app = require('../src/server');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    /* EVERY REQUEST IS GIVEN A DEADLINE, and a request that blows it resolves as
       `status:'timeout'` rather than hanging the suite. That is not tidiness —
       it is what makes D2 observable. A LEAKED pooled connection does not make
       the next request answer 503; `pool.connect()` simply WAITS for a
       connection that is never coming, so the request hangs until something
       upstream gives up. With the leak put back, this suite hung indefinitely
       and had to be killed. "The app still ANSWERS, and quickly" is the property
       that actually matters, so it is the one measured. */
    const REQ_TIMEOUT_MS = 8000;
    const call = (method, p, token, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const rq = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
        timeout: REQ_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 300) }; } resolve({ status: res.statusCode, body: j }); }); });
      rq.on('timeout', () => { rq.destroy(); resolve({ status: 'timeout', body: { error: `no answer in ${REQ_TIMEOUT_MS}ms` } }); });
      rq.on('error', (e) => (e && e.code === 'ECONNRESET' ? resolve({ status: 'timeout', body: { error: 'connection destroyed' } }) : reject(e)));
      if (data) rq.write(data); rq.end();
    });
    const bTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });
    const ADDR = { line1: '9 Audit Way', city: 'Lakewood', state: 'NJ', zip: '08701' };

    const newFile = async (extra) => {
      const r = await call('POST', '/api/staff/applications', sTok, {
        borrower: { email: `aud-hard-${sfx}@test.local`, firstName: 'Audit', lastName: 'Hardening' },
        propertyAddress: ADDR, program: 'Fix & Flip w/ Construction', loanType: 'Refinance — Cash-Out',
        asIsValue: 600000, arv: 900000, rehabBudget: 200000, propertyType: 'SFR (1 unit)', units: 1,
        ...(extra || {}),
      });
      return r.body && r.body.applicationId ? r.body.applicationId : (r.body && r.body.id) || null;
    };

    /* ================================================================ *
     * D2 — A FAILING REGISTER MUST NOT CONSUME A POOLED CONNECTION.
     *
     * The `finally { client.release() }` belonged to the VESTING try/catch
     * that starts AFTER the transaction block, so a rethrow from the
     * transaction skipped it entirely and leaked the client permanently.
     * DB_POOL_MAX is 10, so ten failures exhausted the pool — and from then
     * on every request that needs a connection simply WAITS for one that is
     * never coming. Measured with the fix reverted: this suite stopped dead
     * and had to be killed. That is the failure mode — not a clean 503, but
     * a service that stops answering.
     *
     * The register is driven into failure through the admin pricing zone —
     * an absurd markup produces a note rate numeric(7,5) cannot hold. That
     * is now refused with a 400 BEFORE the transaction opens (so there is
     * no leak to have), and the release-on-the-way-out is belt-and-braces
     * for any OTHER mid-transaction failure. What this proves is the thing
     * that actually matters: after far more failures than the pool has
     * connections, the app is still answering, and answering promptly.
     * ================================================================ */
    console.log('\n--- D2: a register that fails must leave the app alive ---');
    {
      // A genuinely ELIGIBLE scenario — otherwise the route refuses on
      // eligibility long before it reaches a transaction, and this whole
      // section would pass without ever exercising the thing it is about.
      const SCENARIO = {
        loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR (1 unit)',
        purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
        fico: 740, expFlips: 5, term: 12,
      };
      const appId = (await db.query(
        `INSERT INTO applications (borrower_id, loan_officer_id, status, loan_type, program, property_type,
                                   purchase_price, as_is_value, arv, rehab_budget, rehab_type, term,
                                   requested_exp_flips, property_address)
         VALUES ($1,$2,'underwriting','Purchase','standard','SFR (1 unit)',400000,400000,600000,80000,'Cosmetic','12 Months',5,
                 $3::jsonb) RETURNING id`,
        [borrowerId, staffId, JSON.stringify(ADDR)])).rows[0].id;
      assert(!!appId, 'a file was created to register against');

      // Guard the guard: the SAME scenario without the absurd markup must
      // register cleanly, or "it refused" proves nothing about the markup.
      const sanity = await call('POST', `/api/staff/applications/${appId}/pricing/register`, sTok,
        { program: 'standard', overrides: { ...SCENARIO } });
      assert(sanity.status === 200 || sanity.status === 201,
        `the scenario really is registrable (got ${sanity.status} ${JSON.stringify(sanity.body && sanity.body.error)}) — otherwise this section is vacuous`);

      const badRegister = () => call('POST', `/api/staff/applications/${appId}/pricing/register`, sTok, {
        program: 'standard',
        overrides: { ...SCENARIO, markupStdPct: 1e9 },   // a rate no column can hold
      });

      const first = await badRegister();
      eq(first.status, 400, 'an unstorable quote is a BAD REQUEST, not a 500 "server error"');
      assert(/note rate|admin pricing/i.test(String(first.body && first.body.error)),
        '…and the refusal names the box to look at');

      /* THE LEAK ITSELF. Eleven consecutive failures is one more than
         DB_POOL_MAX; on the pre-fix code the pool was empty by the tenth and
         everything after it stopped answering at all. */
      let statuses = [];
      for (let i = 0; i < 11; i++) statuses.push((await badRegister()).status);
      assert(statuses.every((s) => s === 400),
        `11 consecutive failures all answer 400 (got ${JSON.stringify(statuses)})`);

      const health = await call('GET', '/api/health', sTok, null);
      assert(health.status === 200,
        `the app still answers after 12 failed registers (health=${health.status}) — with the leak, this never returns`);
      const stillWorks = await call('GET', `/api/staff/applications/${appId}`, sTok, null);
      eq(stillWorks.status, 200, 'and an ordinary request still gets its connection');

      // A CLEAN register on the same file still works AFTER all those failures —
      // the guard refuses only what cannot be stored, and the pool is intact.
      const good = await call('POST', `/api/staff/applications/${appId}/pricing/register`, sTok,
        { program: 'standard', overrides: { ...SCENARIO } });
      assert(good.status === 200 || good.status === 201,
        `a normal register still works after 12 failed ones (got ${good.status} ${JSON.stringify(good.body && good.body.error)})`);

      /* ---------------------------------------------------------------- *
       * THE RELEASE ITSELF, exercised — not just the guard in front of it.
       *
       * Everything above is refused BEFORE `db.getClient()`, so it never
       * opens a transaction and never reaches the release. Reverting the
       * release alone therefore left this suite green (pre-merge audit
       * 2026-07-31): it was testing the guard and calling it coverage.
       *
       * The point of the release is the failure the guard CANNOT foresee —
       * a constraint added later, a trigger, a deadlock. So one is created
       * on purpose: a trigger that raises inside the register's transaction,
       * past every validation. Twelve of those must still leave the pool
       * whole. The trigger is dropped again immediately, whatever happens.
       * ---------------------------------------------------------------- */
      await db.query(`CREATE OR REPLACE FUNCTION pilot_test_reg_boom() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'test-induced mid-transaction failure'; END; $$ LANGUAGE plpgsql`);
      await db.query(`DROP TRIGGER IF EXISTS trg_pilot_test_reg_boom ON product_registrations`);
      await db.query(`CREATE TRIGGER trg_pilot_test_reg_boom BEFORE INSERT ON product_registrations
                      FOR EACH ROW EXECUTE FUNCTION pilot_test_reg_boom()`);
      let midTx = [];
      try {
        for (let i = 0; i < 12; i++) {
          midTx.push((await call('POST', `/api/staff/applications/${appId}/pricing/register`, sTok,
            { program: 'standard', overrides: { ...SCENARIO } })).status);
        }
      } finally {
        await db.query(`DROP TRIGGER IF EXISTS trg_pilot_test_reg_boom ON product_registrations`);
        await db.query(`DROP FUNCTION IF EXISTS pilot_test_reg_boom()`);
      }
      assert(midTx.every((s) => s === 500),
        `12 registers really did fail INSIDE the transaction (got ${JSON.stringify(midTx)})`);
      const healthAfter = await call('GET', '/api/health', sTok, null);
      assert(healthAfter.status === 200,
        `the pool survived 12 mid-transaction failures (health=${healthAfter.status}) — without the release this never returns`);
      const recovered = await call('POST', `/api/staff/applications/${appId}/pricing/register`, sTok,
        { program: 'standard', overrides: { ...SCENARIO } });
      assert(recovered.status === 200 || recovered.status === 201,
        `and a real register works again once the failure is gone (got ${recovered.status})`);
    }

    /* ================================================================ *
     * D1 — the borrower's own submit, with an oversized money value.
     * ================================================================ */
    console.log('\n--- D1: an oversized amount on the borrower’s application ---');
    {
      const submit = async (data) => {
        const dr = await call('POST', '/api/borrower/drafts', bTok, { data: { ...data, propertyAddress: ADDR }, step: 5 });
        return call('POST', `/api/borrower/drafts/${dr.body && dr.body.id}/submit`, bTok, {});
      };
      const big = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000',
        payoffAmount: '99999999999999999',
      });
      eq(big.status, 400, 'an oversized payoff amount is a bad request (this was a 500 "server error")');
      assert(/payoff amount/i.test(String(big.body && big.body.error)),
        '…and the message names the box, in the words the form uses');
      assert(/999,999,999,999\.99/.test(String(big.body && big.body.error)),
        '…and quotes the limit, so following the advice works');

      const units = await submit({ loanType: 'Purchase', purchasePrice: '450000', units: '99999999999' });
      eq(units.status, 400, 'an oversized unit COUNT is refused too');
      assert(/2,147,483,647/.test(String(units.body && units.body.error)),
        '…quoting int4’s limit, not the money one (the "follow the advice, get another 500" trap)');

      const ok = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: '  Chase Home Finance  ', payoffLoanNumber: ' CHF-88213 ',
      });
      eq(ok.status, 201, 'an ordinary application still submits');
      if (ok.status === 201) {
        const a = (await db.query(
          `SELECT payoff_lender, payoff_loan_number, payoff_amount FROM applications WHERE id=$1`,
          [ok.body.applicationId])).rows[0];
        eq(a.payoff_lender, 'Chase Home Finance', 'and the borrower door TRIMS what it stores');
        eq(a.payoff_loan_number, 'CHF-88213', '…on both text columns');
        eq(Number(a.payoff_amount), 300000, 'with the amount intact');
      }
    }

    /* ================================================================ *
     * D4 — the staff details door trims, and an explicit null clears.
     * ================================================================ */
    console.log('\n--- D4: "   " is an empty box on the details door too ---');
    {
      const appId = await newFile();
      const set = (body) => call('PATCH', `/api/staff/applications/${appId}/details`, sTok, body);
      const read = async () => (await db.query(
        `SELECT payoff_lender, payoff_loan_number FROM applications WHERE id=$1`, [appId])).rows[0];

      await set({ payoffLender: '  Wells Fargo  ', payoffLoanNumber: '  WF-1  ' });
      let a = await read();
      eq(a.payoff_lender, 'Wells Fargo', 'a typed value is trimmed');
      eq(a.payoff_loan_number, 'WF-1', '…on both columns');

      await set({ payoffLender: '   ' });
      a = await read();
      eq(a.payoff_lender, null, 'A BOX OF SPACES CLEARS IT — it never stores three spaces');

      await set({ payoffLender: 'Chase' });
      await set({ payoffLender: null });
      a = await read();
      eq(a.payoff_lender, null, 'an explicit null clears it');
      assert(a.payoff_lender !== 'null', '…and never stores the four characters n-u-l-l');

      const tooBig = await set({ payoffAmount: 99999999999999999 });
      eq(tooBig.status, 400, 'an oversized amount on THIS door is still a plain 400');
    }

    /* ================================================================ *
     * D3 — the info-condition door had no freeze at all.
     *
     * The audit found it on the payoff pair, but the hole was the whole
     * class: of the twenty fields that target `applications`, only the
     * eight change-request fields were governed, so `loan_amount`,
     * `requested_ir_amount`, `assignment_fee` and the rest wrote LIVE on a
     * funded file — and most are pricing inputs the db/071 trigger watches,
     * so answering a condition on a closed loan reopened Products & Pricing.
     * ================================================================ */
    console.log('\n--- D3: the file freeze reaches the info-condition door ---');
    {
      const appId = await newFile();
      const engine = require('../src/lib/conditions/engine');

      // Open file: the payoff contact writes normally.
      const before = await engine.writeFieldValue(appId, borrowerId, 'payoff_lender', 'Chase', { kind: 'borrower', id: borrowerId });
      eq(before.value, 'Chase', 'on an OPEN file the answer is written as before');

      // …and it is trimmed + capped by the COLUMN here too (this door used to
      // use a flat 500 and no trim — the third of three different answers).
      const trimmed = await engine.writeFieldValue(appId, borrowerId, 'payoff_loan_number', '  ABC-9  ', { kind: 'borrower', id: borrowerId });
      eq(trimmed.value, 'ABC-9', 'the info-condition door trims too');
      const capped = await engine.writeFieldValue(appId, borrowerId, 'payoff_loan_number', 'x'.repeat(400), { kind: 'borrower', id: borrowerId });
      eq(String(capped.value).length, 100, '…and caps by the COLUMN, not by the door’s own old 500');
      let blankErr = null;
      try { await engine.writeFieldValue(appId, borrowerId, 'payoff_lender', '   ', { kind: 'borrower', id: borrowerId }); }
      catch (e) { blankErr = e; }
      assert(blankErr && blankErr.status === 400, 'a box of spaces is refused, never recorded as an answer');

      /* A SENT / SIGNED TERM SHEET DOES NOT CLOSE THIS DOOR — the regression the
         pre-merge audit caught, and the reason the freeze here is the STATUS one
         only. Every file reaching Clear to Close carries a completed term-sheet
         package, and a package sits in sent/delivered/completed for the whole
         underwriting phase — exactly when the team posts information conditions
         and the borrower answers them. The first cut refused those with "clear
         the Term Sheet package first", which means voiding a SIGNED term sheet:
         a condition with no way to clear it. */
      const env = await db.query(
        `INSERT INTO esign_envelopes (application_id, purpose, status, provider, envelope_id)
         VALUES ($1,'term_sheet_package','completed','test',$2) RETURNING id`,
        [appId, `tsp-${sfx}`]).then((r) => r.rows[0].id).catch(() => null);
      assert(!!env, 'a signed term-sheet package was put on the file (otherwise this case is vacuous)');
      const withSheet = await engine.writeFieldValue(appId, borrowerId, 'acquisition_date', '2024-03-05', { kind: 'borrower', id: borrowerId });
      eq(withSheet.value, '2024-03-05',
        'an information condition is still answerable with a SIGNED term sheet out — the whole underwriting phase depends on it');
      const amt = await engine.writeFieldValue(appId, borrowerId, 'payoff_amount', 250000, { kind: 'borrower', id: borrowerId });
      eq(Number(amt.value), 250000,
        '…including the payoff AMOUNT, whose quote arrives from the servicer after the sheet goes out');

      // FUNDED — the strictest freeze. Nothing may be written, not even the
      // payoff contact (past funding the payoff has already been wired).
      await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appId]);
      const refused = async (key, value) => {
        try { await engine.writeFieldValue(appId, borrowerId, key, value, { kind: 'borrower', id: borrowerId }); return null; }
        catch (e) { return e; }
      };
      const e1 = await refused('payoff_lender', 'Somebody Else');
      assert(e1 && e1.status === 409, `a FUNDED file refuses the payoff contact (got ${e1 ? e1.status : 'a successful write'})`);
      /* The far worse half of the same hole — an ECONOMICS field with no
         change-request governance, on a funded loan. */
      const e2 = await refused('requested_ir_amount', 50000);
      assert(e2 && e2.status === 409, `a FUNDED file refuses an ECONOMICS field (got ${e2 ? e2.status : 'a successful write'})`);
      const e3 = await refused('assignment_fee', 12345);
      assert(e3 && e3.status === 409, '…and refuses the assignment fee');
      const after = (await db.query(`SELECT payoff_lender, requested_ir_amount FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(after.payoff_lender, 'Chase', 'nothing was written to the frozen file');
      eq(after.requested_ir_amount, null, '…on either column');

      /* CLEAR TO CLOSE is the carve-out this feature is built on: the payoff
         letter is ordered at closing prep, so the who-and-which stays
         editable — while the AMOUNT beside it does not. */
      await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [appId]);
      const ctc = await engine.writeFieldValue(appId, borrowerId, 'payoff_lender', 'Servicer LLC', { kind: 'borrower', id: borrowerId });
      eq(ctc.value, 'Servicer LLC', 'at Clear to Close the payoff CONTACT is still editable (closing prep)');
      const e4 = await refused('payoff_amount', 123456);
      assert(e4 && e4.status === 409, '…but the payoff AMOUNT beside it is not');

      /* A BORROWER-table field is untouched by any of this — a person's credit
         score is equally true on a closed file and has its own governance. */
      await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appId]);
      const fico = await engine.writeFieldValue(appId, borrowerId, 'fico', 720, { kind: 'borrower', id: borrowerId });
      eq(fico.value, 720, 'a BORROWER field still writes on a funded file — the freeze is about the loan, not the person');
    }

    /* ================================================================ *
     * D7 — the cash-to-close attachment.
     * ================================================================ */
    console.log('\n--- D7: the ALTA attachment must be a real document on THIS file ---');
    {
      const appId = await newFile();
      const otherId = await newFile();
      const post = (body) => call('POST', `/api/staff/applications/${appId}/closing/cash-to-close`, sTok, body);

      const junk = await post({ actualCashToClose: 1000, docId: 'not-a-uuid' });
      eq(junk.status, 400, 'a malformed uuid is a bad request (this was a 500: Postgres 22P02)');

      const ghost = await post({ actualCashToClose: 1000, docId: '11111111-1111-4111-8111-111111111111' });
      eq(ghost.status, 400, 'a uuid that is not a document is refused (this was a 500: foreign key violation)');

      const otherDoc = (await db.query(
        `INSERT INTO documents (application_id, filename, storage_provider, storage_ref, content_type)
         VALUES ($1,'someone-elses-alta.pdf','local','k/other','application/pdf') RETURNING id`, [otherId])).rows[0].id;
      const wrongFile = await post({ actualCashToClose: 1000, docId: otherDoc });
      eq(wrongFile.status, 400, 'ANOTHER FILE’S document is refused — it used to be accepted as this file’s evidence');

      const mine = (await db.query(
        `INSERT INTO documents (application_id, filename, storage_provider, storage_ref, content_type)
         VALUES ($1,'alta.pdf','local','k/mine','application/pdf') RETURNING id`, [appId])).rows[0].id;
      const good = await post({ actualCashToClose: 1000, docId: mine });
      eq(good.status, 200, 'this file’s own document is accepted');
      const stored = (await db.query(
        `SELECT actual_cash_to_close, actual_cash_to_close_doc_id FROM closing_workflow WHERE application_id=$1`, [appId])).rows[0];
      eq(stored.actual_cash_to_close_doc_id, mine, '…and is what gets recorded');
      eq(Number(stored.actual_cash_to_close), 1000, 'with the amount');

      const noDoc = await post({ actualCashToClose: 2000 });
      eq(noDoc.status, 200, 'no attachment at all is still valid (the ALTA may not be uploaded yet)');
      const tooBig = await post({ actualCashToClose: 99999999999999999 });
      eq(tooBig.status, 400, 'and an oversized amount is still a plain 400');
    }
  } catch (e) {
    assert(false, `the suite threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
  } finally {
    if (server) server.close();
    try { await db.pool.end(); } catch (_) {}
  }

  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL audit-hardening assertions passed');
  process.exit(failures ? 1 : 0);
})();
