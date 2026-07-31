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

      /* ASSERTED ON A ROUTE THAT NEEDS A POOLED CLIENT — not on /api/health,
         which races its DB probe against a 2.5s timeout and answers 200 with
         `db:'down'` when it loses. Measured (re-audit 2026-07-31): holding all
         10 pooled clients, health still returned 200 while a request that
         actually needs a connection never came back at all. A health check that
         is 200 either way cannot fail, so it cannot be the assertion. */
      const stillWorks = await call('GET', `/api/staff/applications/${appId}`, sTok, null);
      eq(stillWorks.status, 200,
        'an ordinary request still gets its connection after 12 failures — with the leak this never returns');

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
      /* THE TRIGGER IS SCOPED TO THIS ONE APPLICATION, so a leaked one is inert.
         DDL through `db.query` is autocommit, and the DROPs live in a JS
         `finally` — which a SIGKILL does not run. Measured (re-audit
         2026-07-31): killing the suite mid-run left the trigger live and every
         later register in that database failed, breaking three other DB suites;
         and because `npm test` is `&&`-chained with this suite LAST, the
         poisoned database aborted the next whole run hundreds of steps before
         reaching the only code that would drop it. The documented way to verify
         the release fix — revert it and watch the suite hang, then kill it — is
         precisely how that happens.
         An `application_id` guard removes the blast radius entirely: the id is
         one this suite just created, so even a permanently leaked trigger can
         only ever affect a file nobody will register again. A defensive DROP
         first clears one left by an earlier killed run. */
      await db.query(`DROP TRIGGER IF EXISTS trg_pilot_test_reg_boom ON product_registrations`);
      await db.query(`CREATE OR REPLACE FUNCTION pilot_test_reg_boom() RETURNS trigger AS $$
        BEGIN
          IF NEW.application_id = '${appId}'::uuid THEN
            RAISE EXCEPTION 'test-induced mid-transaction failure';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql`);
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
      // Again on a route that TAKES a pooled client, for the same reason.
      const afterMidTx = await call('GET', `/api/staff/applications/${appId}`, sTok, null);
      eq(afterMidTx.status, 200,
        'the pool survived 12 mid-transaction failures — without the release this never returns');
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
      /* THE FILE IS ALSO REGISTERED — and it has to be, BEFORE the parity loop
         (fourth audit's test-design point, proven by mutation). The
         change-request sandbox only engages on a file that carries current
         terms, so on an unregistered file the five governed economics fields
         never take that branch at all: the parity loop passed, and removing the
         route's freeze-first ordering — the very defect this block exists to
         catch — failed ZERO assertions. A signed term sheet without a
         registration is also not a state that occurs.
         The loan amount is set FIRST: db/126's reopen trigger fires on a
         `loan_amount` change, so setting it after the registration would flag
         that registration stale from the test's own setup and the later
         "was not re-priced by a borrower answering a question" assertions would
         be measuring this fixture rather than the behaviour. */
      await db.query(`UPDATE applications SET loan_amount=440000 WHERE id=$1`, [appId]);
      await db.query(
        `INSERT INTO product_registrations (application_id, program, status, note_rate, total_loan, inputs, quote, is_current)
         VALUES ($1,'standard','ELIGIBLE',0.1199,440000,'{"fico":700}'::jsonb,'{"sizing":{"totalLoan":440000}}'::jsonb,true)`,
        [appId]);
      /* THE RULE IS PARITY WITH THE DOOR THAT OWNS THE FIELD, and that is what
         is asserted — for each field, the staff details door and this door must
         AGREE. Three rounds each invented a different private field list here,
         and each one was a proxy that drifted:
           · freeze the whole request → conditions unanswerable post-term-sheet;
           · freeze nothing → a borrower moved a SIGNED sheet's loan $440,000→$1;
           · freeze the reopen trigger's list → a PRICING proxy, so the borrower
             could still move `payoff_amount`, which PRINTS on the sheet twice
             (the payoff row and the cash-out derived from it: $85,000→$384,999),
             while staff got a 409 on the same field of the same file.
         Asserting agreement instead of a list is what makes a fourth private
         list impossible. */
      const staffSays = async (body) =>
        (await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, body)).status;
      /* THROUGH THE REAL ROUTE, not `writeFieldValue` directly. Calling the
         engine skips the route's change-request branch — which is exactly the
         branch that caused the disagreement the previous cut of this test could
         not see (fourth audit, 2026-07-31). */
      const borrowerSays = async (fieldKey, value) => {
        const c = await call('POST', `/api/staff/applications/${appId}/conditions/custom`, sTok, {
          conditionType: 'info_field', fieldKey, label: `Confirm ${fieldKey}`, audience: 'borrower',
        });
        const itemId = c.body && c.body.itemId;
        if (!itemId) return `no-condition(${c.status})`;
        const r = await call('POST', `/api/borrower/applications/${appId}/checklist/${itemId}/info`, bTok, { value });
        return r.status;
      };
      /* EVERY field this door can write that the details door also writes —
         derived from the registry, NOT hand-listed. The previous cut pinned
         eight fields, which turned out to be precisely the set where the two
         doors happened to agree; the five that disagreed (the governed
         economics fields, which short-circuited into a change request on a
         FROZEN file) were absent. A hand-list here is a fourth private list. */
      const REG_TARGETS = require('../src/lib/conditions/field-registry').WRITE_TARGETS;
      const DETAILS_BODY_KEY = {
        purchase_price: 'purchasePrice', as_is_value: 'asIsValue', arv: 'arv',
        rehab_budget: 'rehabBudget', units: 'units', property_type: 'propertyType',
        payoff_amount: 'payoffAmount', original_purchase_price: 'originalPurchasePrice',
        acquisition_date: 'acquisitionDate', requested_ir_amount: 'requestedIrAmount',
        requested_ir_months: 'requestedIrMonths', assignment_fee: 'assignmentFee',
        underlying_contract_price: 'underlyingContractPrice',
        requested_exp_flips: 'requestedExpFlips', requested_exp_holds: 'requestedExpHolds',
        requested_exp_ground: 'requestedExpGround', sqft_pre: 'sqftPre', sqft_post: 'sqftPost',
      };
      const SAMPLE = {
        acquisition_date: '2024-03-05', property_type: 'Condo', requested_ir_months: 9,
        units: 3, requested_exp_flips: 9, requested_exp_holds: 9, requested_exp_ground: 9,
        sqft_pre: 1100, sqft_post: 1400,
      };
      let compared = 0, agreed = 0;
      for (const [fieldKey, t] of Object.entries(REG_TARGETS)) {
        if (!t || t.table !== 'applications') continue;
        const bodyKey = DETAILS_BODY_KEY[fieldKey];
        if (!bodyKey) continue;                  // the details door cannot write it
        const value = Object.prototype.hasOwnProperty.call(SAMPLE, fieldKey) ? SAMPLE[fieldKey] : 4321;
        const s = await staffSays({ [bodyKey]: value });
        const b = await borrowerSays(fieldKey, value);
        compared++;
        const ok = (s === 409 && b === 409) || (s === 200 && b === 200);
        if (ok) agreed++;
        assert(ok, `${fieldKey}: the condition door agrees with the details door (staff ${s}, borrower ${b})`);
      }
      assert(compared >= 15, `every comparable field was actually compared (${compared}) — a shrinking list is how this hid before`);
      /* AND THE FREEZE IS GENUINELY ENGAGED. Without this the loop passes
         trivially when both doors are OPEN — measured: with the term-sheet
         freeze stubbed out, 7 of 8 rows still "agreed". */
      assert(agreed === compared && compared > 0, 'every compared field agreed');
      const anyFrozen = await borrowerSays('loan_amount', 1);
      eq(anyFrozen, 409, 'and the signed term sheet really is freezing this door (not a vacuous both-open pass)');
      const loanNow = (await db.query(`SELECT loan_amount FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(Number(loanNow.loan_amount), 440000,
        'the sheet’s headline number is untouched — it was moved to $1 before this');
      // The owner-directed carve-out is the ONE place they legitimately differ
      // from a plain freeze, and both doors implement it identically.
      const cS = await staffSays({ payoffLender: 'Servicer LLC' });
      const cB = await borrowerSays('payoff_lender', 'Servicer LLC');
      assert(cS === cB, `the payoff CONTACT carve-out is the same on both doors (staff ${cS}, borrower ${cB})`);

      // FUNDED — the strictest freeze. Nothing may be written, not even the
      // payoff contact (past funding the payoff has already been wired).
      await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appId]);
      const refused = async (key, value) => {
        try { await engine.writeFieldValue(appId, borrowerId, key, value, { kind: 'borrower', id: borrowerId }); return null; }
        catch (e) { return e; }
      };
      /* A FUNDED FILE WITH NO TERM SHEET AT ALL — so this really tests the
         STATUS freeze. Every other funded assertion here sits on a file that
         also carries a signed term-sheet package, so the term-sheet freeze
         answered first: measured (fourth audit), disabling the entire status
         freeze failed ZERO assertions in this suite while failing ten in
         test-funded-lock.js. A file with no envelope has only one freeze left
         to be doing the work. */
      {
        const bare = await newFile();
        await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [bare]);
        let statusOnly = null;
        try { await engine.writeFieldValue(bare, borrowerId, 'acquisition_date', '2024-01-01', { kind: 'borrower', id: borrowerId }); }
        catch (e) { statusOnly = e; }
        assert(statusOnly && statusOnly.status === 409,
          `a FUNDED file with NO term sheet still refuses (got ${statusOnly ? statusOnly.status : 'a successful write'}) — this is the STATUS freeze on its own`);
      }

      const e1 = await refused('payoff_lender', 'Somebody Else');
      assert(e1 && e1.status === 409, `a FUNDED file refuses the payoff contact (got ${e1 ? e1.status : 'a successful write'})`);
      /* The far worse half of the same hole — an ECONOMICS field with no
         change-request governance, on a funded loan. */
      const e2 = await refused('requested_ir_amount', 50000);
      assert(e2 && e2.status === 409, `a FUNDED file refuses an ECONOMICS field (got ${e2 ? e2.status : 'a successful write'})`);
      const e3 = await refused('assignment_fee', 12345);
      assert(e3 && e3.status === 409, '…and refuses the assignment fee');
      // 'Servicer LLC' is what the parity block wrote through the closing-prep
      // carve-out a moment ago, while the file was still pre-Clear-to-Close.
      const after = (await db.query(`SELECT payoff_lender, requested_ir_amount FROM applications WHERE id=$1`, [appId])).rows[0];
      eq(after.payoff_lender, 'Servicer LLC', 'nothing was written to the frozen file');
      eq(after.requested_ir_amount, null, '…on either column');

      /* CLEAR TO CLOSE is the carve-out this feature is built on: the payoff
         letter is ordered at closing prep, so the who-and-which stays
         editable — while the AMOUNT beside it does not. */
      await db.query(`UPDATE applications SET status='clear_to_close' WHERE id=$1`, [appId]);
      const ctc = await engine.writeFieldValue(appId, borrowerId, 'payoff_lender', 'Servicer LLC', { kind: 'borrower', id: borrowerId });
      eq(ctc.value, 'Servicer LLC', 'at Clear to Close the payoff CONTACT is still editable (closing prep)');
      const e4 = await refused('payoff_amount', 123456);
      assert(e4 && e4.status === 409, '…but the payoff AMOUNT beside it is not');

      /* A BORROWER-TABLE FIELD GOES TO THE CHANGE-REQUEST SANDBOX ON A
         REGISTERED FILE — it is not exempt, it is governed by its OWN door's
         rule (third audit, 2026-07-31).

         Three rounds of this comment claimed personal fields were "untouched
         by this — they have their own governance in change-requests.js". They
         did not: the route gated the sandbox on `isGovernedField`, which covers
         only the eight ECONOMICS fields, so every identity field — name, DOB,
         SSN, phone, citizenship, FICO — wrote LIVE from this door in all seven
         file states. `fico` is the expensive one: db/126 puts a reopen trigger
         on `borrowers` for exactly that column, so answering a credit-score
         condition on a FUNDED loan re-priced it — the registration went stale,
         Products & Pricing reopened, and the SIGNED term-sheet condition went
         back to outstanding. That is verbatim the defect this whole series
         began with, on the one table nobody had checked. */
      await db.query(`UPDATE applications SET status='funded' WHERE id=$1`, [appId]);
      // (the registration was put on this file before the parity loop above —
      // the sandbox only engages on a file that carries current terms)
      const beforeFico = (await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [borrowerId])).rows[0].fico;
      const ficoCond = await call('POST', `/api/staff/applications/${appId}/conditions/custom`, sTok, {
        conditionType: 'info_field', fieldKey: 'fico', label: 'Confirm your credit score', audience: 'borrower',
      });
      assert(ficoCond.status === 200 || ficoCond.status === 201,
        `a credit-score information condition was posted (got ${ficoCond.status} ${JSON.stringify(ficoCond.body && ficoCond.body.error)})`);
      const ficoItemId = (ficoCond.body && (ficoCond.body.itemId || ficoCond.body.id)) || null;
      assert(!!ficoItemId, 'and it has an id to answer (otherwise this case is vacuous)');
      const ficoAnswer = await call('POST', `/api/borrower/applications/${appId}/checklist/${ficoItemId}/info`, bTok, { value: 640 });
      eq(ficoAnswer.status, 200, 'the borrower can still ANSWER a credit-score condition');
      assert(ficoAnswer.body && ficoAnswer.body.locked === true && ficoAnswer.body.changeRequested === true,
        '…but on a registered file it opens a change request for the team, it does not write the record');
      const afterFico = (await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [borrowerId])).rows[0].fico;
      eq(afterFico, beforeFico, 'the credit score on the borrower’s record is unchanged');
      const regStale = (await db.query(
        `SELECT stale FROM product_registrations WHERE application_id=$1 AND is_current`, [appId])).rows[0];
      assert(!regStale || regStale.stale !== true,
        'and the FUNDED loan’s registration was NOT flipped stale by a borrower answering a question');

      /* THE SAME PERSON'S SECOND FILE — the bypass the per-FILE lock left open
         (fourth audit, 2026-07-31). `borrowers` is a SHARED row and db/126's
         `reopen_pricing_on_fico_change` re-prices EVERY file the borrower is
         on, so asking "does THIS file carry terms" was the wrong question:
         with a funded registered file A and any second UNREGISTERED file B —
         the ordinary shape for a repeat borrower — answering the credit-score
         condition on B wrote the score live and flipped A stale. The lock for a
         personal field is per PERSON, and this is the case that proves it. */
      const fileB = await newFile();
      assert(!!fileB, 'the same borrower has a second, unregistered file');
      const bCond = await call('POST', `/api/staff/applications/${fileB}/conditions/custom`, sTok, {
        conditionType: 'info_field', fieldKey: 'fico', label: 'Confirm your credit score', audience: 'borrower',
      });
      const bItem = bCond.body && bCond.body.itemId;
      assert(!!bItem, 'with its own credit-score condition');
      const beforeB = (await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [borrowerId])).rows[0].fico;
      const bAnswer = await call('POST', `/api/borrower/applications/${fileB}/checklist/${bItem}/info`, bTok, { value: 611 });
      eq(bAnswer.status, 200, 'the borrower can answer it');
      assert(bAnswer.body && bAnswer.body.locked === true,
        '…and it is STILL a change request, because the PERSON has accepted terms somewhere');
      const afterB = (await db.query(`SELECT fico FROM borrowers WHERE id=$1`, [borrowerId])).rows[0].fico;
      eq(afterB, beforeB, 'the shared credit score is unchanged');
      const staleB = (await db.query(
        `SELECT stale FROM product_registrations WHERE application_id=$1 AND is_current`, [appId])).rows[0];
      assert(!staleB || staleB.stale !== true,
        'and the OTHER file’s funded registration was not re-priced from here either');
      // The item is answered on this door too — it used to return before marking it,
      // so a credit-score condition on a registered file could never be cleared.
      /* A PENDING REQUEST IS NOT AN ANSWER. The item stays outstanding until the
         team decides — the previous cut marked it `received` immediately, and
         since nothing moves it back on a REJECT, the condition stayed green
         holding a number the team had refused (and could then be signed off).
         Confirming the value already on file IS an answer, and is marked. */
      const bItemRow = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [bItem])).rows[0];
      eq(bItemRow.status, 'outstanding', 'a PENDING request leaves the condition outstanding — it is not answered yet');
      // Confirm a value that is genuinely ON the record (the score is still
      // unset above precisely because the request is pending, not applied).
      await db.query(`UPDATE borrowers SET fico=700 WHERE id=$1`, [borrowerId]);
      const confirm = await call('POST', `/api/borrower/applications/${fileB}/checklist/${bItem}/info`, bTok, { value: 700 });
      eq(confirm.status, 200, 'confirming the value already on file is accepted');
      assert(confirm.body && confirm.body.changeRequested === false, '…and opens no request');
      const bConfirmed = (await db.query(`SELECT status FROM checklist_items WHERE id=$1`, [bItem])).rows[0];
      eq(bConfirmed.status, 'received', '…and DOES mark the condition answered, so it leaves the borrower’s list');

      /* A VALUE THE COLUMN CANNOT HOLD IS REFUSED AT THIS DOOR TOO — it used to
         be filed as a pending request that made the approve door 500 forever,
         while staff got a plain 400 for the identical value. */
      const arvCond = await call('POST', `/api/staff/applications/${fileB}/conditions/custom`, sTok, {
        conditionType: 'info_field', fieldKey: 'arv', label: 'Confirm the ARV', audience: 'borrower',
      });
      const arvItem = arvCond.body && arvCond.body.itemId;
      if (arvItem) {
        await db.query(
          `INSERT INTO product_registrations (application_id, program, status, note_rate, total_loan, inputs, quote, is_current)
           VALUES ($1,'standard','ELIGIBLE',0.1199,100000,'{}'::jsonb,'{"sizing":{"totalLoan":100000}}'::jsonb,true)`,
          [fileB]);
        const huge = await call('POST', `/api/borrower/applications/${fileB}/checklist/${arvItem}/info`, bTok,
          { value: '99999999999999999' });
        eq(huge.status, 400, 'an unstorable ARV is refused here, not filed as a request that can never be applied');
        assert(/999,999,999,999\.99/.test(String(huge.body && huge.body.error)),
          '…quoting the same limit the staff details door quotes');
        const pend = await db.query(
          `SELECT 1 FROM change_requests WHERE application_id=$1 AND field='arv' AND status='pending'`, [fileB]);
        eq(pend.rows.length, 0, '…and no pending request was left behind');
      } else {
        assert(false, 'an ARV information condition was posted');
      }
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

    /* ================================================================ *
     * THE PUBLIC INTAKE DOOR — an out-of-range LTV must not lose the lead.
     *
     * `ltv` is numeric(6,3), a PERCENT, but it was bound through a helper
     * calibrated to numeric(14,2), so `ltv: 5000` raised 22003 and the whole
     * submission came back a 500 — the exact outcome this work exists to
     * prevent, on the one door where the submitter is an anonymous visitor
     * with no way to correct anything. Untested until the re-audit pointed out
     * that reverting the fix broke nothing (this is the only suite that
     * exercises the intake core, and it never sent an ltv).
     * ================================================================ */
    console.log('\n--- the public intake form: an out-of-range LTV drops, it does not lose the lead ---');
    {
      const intake = (body) => new Promise((resolve) => {
        const data = JSON.stringify(body);
        const rq = http.request({ method: 'POST', path: '/api/intake', port: server.address().port,
          host: '127.0.0.1', timeout: REQ_TIMEOUT_MS,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data),
            ...(process.env.INTAKE_API_KEY ? { 'x-api-key': process.env.INTAKE_API_KEY } : {}) } },
          (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 200) }; } resolve({ status: res.statusCode, body: j }); }); });
        rq.on('timeout', () => { rq.destroy(); resolve({ status: 'timeout', body: null }); });
        rq.on('error', () => resolve({ status: 'error', body: null }));
        rq.write(data); rq.end();
      });
      const base = {
        tool: 'loan_application', firstName: 'Ltv', lastName: 'Probe',
        propertyAddress: ADDR, purchasePrice: 400000, asIsValue: 400000, arv: 600000,
      };
      const huge = await intake({ ...base, email: `ltv-huge-${sfx}@test.local`, ltv: 5000 });
      assert(huge.status === 200 || huge.status === 201,
        `an out-of-range LTV still captures the lead (got ${huge.status}) — this was a 500 and the lead was lost`);
      const ok = await intake({ ...base, email: `ltv-ok-${sfx}@test.local`, ltv: 75 });
      assert(ok.status === 200 || ok.status === 201, `and an ordinary LTV still captures it (got ${ok.status})`);
      const stored = await db.query(
        `SELECT a.ltv FROM applications a JOIN borrowers b ON b.id=a.borrower_id
          WHERE b.email = ANY($1) ORDER BY a.created_at`,
        [[`ltv-huge-${sfx}@test.local`, `ltv-ok-${sfx}@test.local`]]);
      if (stored.rows.length === 2) {
        eq(stored.rows[0].ltv, null, 'the unstorable LTV is recorded as "not provided"…');
        eq(Number(stored.rows[1].ltv), 75, '…while a real one is stored exactly');
      } else {
        assert(false, `both intake submissions created a file (got ${stored.rows.length})`);
      }
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
