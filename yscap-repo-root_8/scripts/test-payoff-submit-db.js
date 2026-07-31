'use strict';
/* =====================================================================
   THE PAYOFF ACTUALLY LANDS IN ITS OWN COLUMNS — and the cash-out figure
   actually derives from a REAL registered quote.

   Both halves exist because the pre-merge audit (2026-07-31) found two defects
   that every test in the suite missed for the SAME reason: they verified the
   change by regexing SOURCE TEXT instead of running it.

   1. THE COLUMN/PARAMETER SHIFT. The two new columns were inserted into the
      loan-application INSERT's column list, but their values were APPENDED to
      the end of the parameter array — so every placeholder from there on moved
      by two. The interest-reserve AMOUNT landed in `payoff_lender`, the lender's
      NAME in `payoff_loan_number`, and the payoff LOAN NUMBER — routinely
      alphanumeric — in `requested_ir_amount`, which is numeric(14,2) AND a
      frozen-engine pricing input. So:
        · an alphanumeric loan number made the whole submission FAIL (Postgres
          22P02 → a 400 the borrower cannot get past);
        · an all-digit one silently became a multi-million-dollar financed
          interest reserve;
        · every submission, purchases included, LOST its interest-reserve amount.
      The old guard only asserted the column NAMES appear in the SQL text. A
      source regex cannot see placeholder alignment. This one submits a real
      application and reads every one of those columns back.

   2. THE WRONG QUOTE KEY. `payoffState` read `quote.structure`; `pricing.js
      normalize()` publishes `quote.sizing`, and always has — so `canDerive` was
      false on EVERY registered file and the cash-out figure the owner asked for
      never appeared. The pure test passed because it FABRICATED the shape. Here
      the quote is built by the real `pricing.js` and handed straight in.

   Needs DATABASE_URL (skips the DB half cleanly without it).
   Run: DATABASE_URL=… node scripts/test-payoff-submit-db.js
   ===================================================================== */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/* ===================================================================== *
 * PART 1 — the cash-out derives off a REAL quote, not a fabricated shape.
 * ===================================================================== */
console.log('--- the cash-out figure reads the quote the pricing engine really produces ---');
{
  const payoff = require('../src/lib/payoff');
  const pricing = require('../src/lib/pricing');

  // A real Standard quote for a renovation refinance: the loan is bigger than
  // what funds at closing, because the construction money is held back.
  let quote = null;
  try {
    // The engine's OWN input names (pricing.buildInputs) — a near-miss like
    // `asIs` instead of `asIsValue` sizes a $0 loan and the whole section would
    // pass vacuously.
    quote = pricing.quoteProgram('standard', {
      loanType: 'Refinance', cashOut: true, strategy: 'FF', state: 'NJ', fico: 720,
      asIsValue: 600000, arv: 900000, rehabBudget: 200000, propertyType: 'sfr', units: 1,
      purchasePrice: 0, expFlips: 5, expHolds: 0, expGround: 0, term: 12, irMonths: 0, targetLTC: 0,
    });
  } catch (e) { assert(false, `a real quote could be produced (${e.message})`); }

  if (quote) {
    // Guard the guard: a mistyped input name would size a $0 loan and every
    // assertion below would pass without proving anything.
    assert(Number(quote.sizing && quote.sizing.initialAdvance) > 0,
      'the scenario really sized a loan (otherwise this whole section is vacuous)');
    // THE SHAPE ITSELF — asserted, because this is the thing that was wrong.
    assert(!!quote.sizing, 'a normalized quote publishes `sizing`');
    assert(!quote.structure, 'and has no `structure` key at all — reading one was the bug');
    assert(Number.isFinite(Number(quote.sizing.initialAdvance)), 'sizing carries the initial advance');
    assert(Number.isFinite(Number(quote.closingCosts.dueAtClosing)), 'and the closing costs due at closing');

    const adv = Number(quote.sizing.initialAdvance);
    const closing = Number(quote.closingCosts.dueAtClosing);
    const PAYOFF = Math.round(adv * 0.6);          // a payoff comfortably inside the advance
    const st = payoff.payoffState(
      { loan_type: 'Refinance — Cash-Out', payoff_amount: PAYOFF, payoff_lender: 'Chase', payoff_loan_number: 'CHF-1' },
      quote);

    assert(st.derived.canDerive === true,
      'the file CAN derive a cash-out figure from a real registered quote (this was false on every file)');
    eq(st.derived.initialAdvance, adv, 'it reads the real initial advance');
    eq(st.derived.closingCosts, closing, 'and the real closing costs');
    eq(st.derived.structuralCashOut, Math.max(0, adv - PAYOFF - closing),
      'and nets them the way the owner asked: advance − payoff − closing');
    eq(st.derived.cashOutSource, 'structure', 'with no typed override, the structure is the source');
    // The rehab holdback is NOT cash to the borrower — netting off the TOTAL is
    // the overstatement this whole change exists to remove.
    assert(Number(quote.sizing.totalLoan) > adv,
      'this scenario really does hold construction money back (otherwise the guard below proves nothing)');
    assert(st.derived.structuralCashOut < Number(quote.sizing.totalLoan) - PAYOFF - closing,
      'the figure is SMALLER than the whole-loan arithmetic — the holdback is not cash at closing');
  }
}

/* ===================================================================== *
 * PART 2 — a real submission, through the real door, read back.
 * ===================================================================== */
if (!process.env.DATABASE_URL) {
  console.log('\n(skipping the submission half — no DATABASE_URL)');
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL payoff-submit (pure) assertions passed');
  process.exit(failures ? 1 : 0);
}

(async () => {
  const db = require('../src/db');
  const C = require('../src/lib/crypto');
  const http = require('http');
  const sfx = Date.now().toString(36);
  let server = null, borrowerId = null, staffId = null;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Payoff','Submit') RETURNING id`,
      [`payoff-submit-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [borrowerId]);
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Payoff Officer','loan_officer',true,false,'x',0) RETURNING id`,
      [`payoff-submit-lo-${sfx}@test.local`])).rows[0].id;

    const app = require('../src/server');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const call = (method, p, token, body) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const rq = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 200) }; } resolve({ status: res.statusCode, body: j }); }); });
      rq.on('error', reject); if (data) rq.write(data); rq.end();
    });
    const bTok = C.signJwt({ sub: borrowerId, kind: 'borrower', tv: 0 });
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'loan_officer', tv: 0 });
    const ADDR = { line1: '144 Hewes St', city: 'Brooklyn', state: 'NY', zip: '11211' };

    const submit = async (data) => {
      const dr = await call('POST', '/api/borrower/drafts', bTok, { data: { ...data, propertyAddress: ADDR }, step: 5 });
      return call('POST', `/api/borrower/drafts/${dr.body && dr.body.id}/submit`, bTok, {});
    };
    const COLS = 'payoff_amount,payoff_lender,payoff_loan_number,estimated_cash_out,requested_ir_amount,requested_ir_months,acquisition_date,original_purchase_price';
    const readBack = async (id) => (await db.query(`SELECT ${COLS} FROM applications WHERE id=$1`, [id])).rows[0];

    console.log('\n--- a refinance with an ALPHANUMERIC payoff loan number ---');
    {
      // THE CASE THAT COULD NOT BE SUBMITTED AT ALL. db/386's own note says a
      // payoff loan number is routinely alphanumeric with dashes or slashes.
      const r = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: 'Chase Home Finance', payoffLoanNumber: 'CHF-88213',
        irAmount: '42000', irMonths: '6',
      });
      eq(r.status, 201, 'the borrower can submit at all (this used to be a 400: numeric 22P02)');
      if (r.status === 201) {
        const a = await readBack(r.body.applicationId);
        eq(a.payoff_lender, 'Chase Home Finance', 'the LENDER is stored in payoff_lender');
        eq(a.payoff_loan_number, 'CHF-88213', 'the LOAN NUMBER is stored in payoff_loan_number');
        eq(Number(a.payoff_amount), 300000, 'the payoff AMOUNT is stored in payoff_amount');
        eq(Number(a.requested_ir_amount), 42000,
          'and the interest reserve is still the interest reserve — a frozen-engine pricing input');
      }
    }

    console.log('\n--- a refinance whose payoff loan number is ALL DIGITS ---');
    {
      // The quiet one: this DID submit, and turned a $42,000 reserve into a
      // $55,512,345 one because the loan number is a valid number.
      const r = await submit({
        loanType: 'Refinance — Rate & Term', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: 'Kiavi Servicing', payoffLoanNumber: '55512345',
        irAmount: '42000', irMonths: '6',
      });
      eq(r.status, 201, 'it submits');
      if (r.status === 201) {
        const a = await readBack(r.body.applicationId);
        eq(a.payoff_lender, 'Kiavi Servicing', 'the lender is the lender, not the reserve amount');
        eq(a.payoff_loan_number, '55512345', 'the loan number is the loan number, not the lender');
        eq(Number(a.requested_ir_amount), 42000,
          'the reserve is $42,000 — NOT the payoff loan number read as money');
        assert(Number(a.requested_ir_amount) !== 55512345,
          'a payoff account number can never become a financed interest reserve');
      }
    }

    console.log('\n--- a PURCHASE with an interest reserve and no payoff at all ---');
    {
      // Every submission was losing requested_ir_amount, purchases included.
      const r = await submit({
        loanType: 'Purchase', purchasePrice: '500000', asIsValue: '500000', arv: '700000',
        rehabBudget: '100000', irAmount: '42000', irMonths: '6',
      });
      eq(r.status, 201, 'it submits');
      if (r.status === 201) {
        const a = await readBack(r.body.applicationId);
        eq(Number(a.requested_ir_amount), 42000, 'the reserve survives on a purchase too');
        eq(a.payoff_lender, null, 'and nothing was invented in payoff_lender');
        eq(a.payoff_loan_number, null, 'nor in payoff_loan_number');
      }
    }

    console.log('\n--- the neighbours of the shifted placeholders are unharmed ---');
    {
      // A shift of two moves EVERY later value, so the columns either side are
      // pinned too rather than trusted.
      const r = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '275000', originalPurchasePrice: '410000', acquisitionDate: '2021-04-15',
        payoffLender: 'A Private Lender', payoffLoanNumber: 'PL/2021/88',
        irAmount: '0', irMonths: '3',
      });
      eq(r.status, 201, 'it submits');
      if (r.status === 201) {
        const a = await readBack(r.body.applicationId);
        eq(Number(a.original_purchase_price), 410000, 'the original purchase price landed');
        eq(String(a.acquisition_date).slice(0, 10), '2021-04-15', 'the acquisition date landed');
        eq(Number(a.requested_ir_months), 3, 'the reserve MONTHS landed');
        eq(a.payoff_loan_number, 'PL/2021/88', 'a slashed loan number is stored verbatim');
      }
    }

    console.log('\n--- clearing a text field stores NOTHING, not the word "null" ---');
    {
      /* POST-MERGE AUDIT 2026-07-31. `String(null)` is "null" — four characters,
         and a non-blank string everywhere downstream. Clearing the payoff lender
         stored it, the file then reported itself COMPLETE with a green tick, and
         the borrower's own screen read "Lender being paid off: null". The trap
         was latent on every free-text field this door writes; the payoff card is
         simply the first caller in the repo that sends an explicit null. */
      const r = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: 'Chase', payoffLoanNumber: 'C-1',
      });
      if (r.status === 201) {
        const appId = r.body.applicationId;
        await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [appId, staffId]);
        const cleared = await call('PATCH', `/api/staff/applications/${appId}/details`, sTok,
          { payoffLender: null, payoffLoanNumber: null });
        eq(cleared.status, 200, 'clearing them is accepted');
        const a = await readBack(appId);
        eq(a.payoff_lender, null, 'the lender is NULL — not the string "null"');
        eq(a.payoff_loan_number, null, 'nor is the loan number');
        const p = await call('GET', `/api/staff/applications/${appId}/payoff`, sTok, null);
        eq(p.body && p.body.ready, false, 'and the file no longer claims to be complete');
        eq((p.body && p.body.missing || []).map((m) => m.key).join(','), 'payoffLender,payoffLoanNumber',
          'it asks for exactly what was cleared');
        // An empty STRING must behave identically — that is the path the details
        // form has always used, and the two must not diverge.
        await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, { payoffLender: 'Chase' });
        await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, { payoffLender: '' });
        eq((await readBack(appId)).payoff_lender, null, 'an empty string clears it the same way');
      } else { assert(false, `setup submit failed (${r.status})`); }
    }

    console.log('\n--- a typed cash-out of ZERO is a real answer; a negative is not ---');
    {
      const r = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: 'Chase', payoffLoanNumber: 'C-2',
      });
      if (r.status === 201) {
        const appId = r.body.applicationId;
        await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [appId, staffId]);
        const z = await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, { estimatedCashOut: '0' });
        eq(z.status, 200, 'a typed zero is accepted');
        const p = await call('GET', `/api/staff/applications/${appId}/payoff`, sTok, null);
        eq(p.body && p.body.derived && p.body.derived.cashOut, 0, 'and the file reports ZERO, not the structural figure');
        eq(p.body && p.body.derived && p.body.derived.cashOutSource, 'typed', 'reported as the human’s number');
        // A negative is refused rather than stored — a stored one would print on
        // a term sheet as the figure of record.
        const neg = await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, { estimatedCashOut: '-5000' });
        eq(neg.status, 400, 'a NEGATIVE cash-out is refused at the door');
        eq(Number((await readBack(appId)).estimated_cash_out), 0, 'and the refused value never reached the file');
        /* A BOX OF SPACES IS AN EMPTY BOX (audit round 4). `Number('   ')` is 0,
           so whitespace read as a typed ZERO on the server while the studio —
           whose reader trims — read it as blank and fell back to the structure.
           The two then quoted different cash for the same deal. */
        await call('PATCH', `/api/staff/applications/${appId}/details`, sTok, { estimatedCashOut: '   ' });
        eq((await readBack(appId)).estimated_cash_out, null,
          'whitespace CLEARS the column — it does not store a hard zero');
        const ws = await call('GET', `/api/staff/applications/${appId}/payoff`, sTok, null);
        assert(!ws.body || !ws.body.derived || ws.body.derived.cashOutSource !== 'typed',
          'and it is never reported as a figure a human typed');
      } else { assert(false, `setup submit failed (${r.status})`); }
    }

    console.log('\n--- a legacy NEGATIVE cash-out is not a dead end ---');
    {
      /* AUDIT ROUND 4. Both doors briefly stored a negative. The studio prefills
         its cash-out box from the file and sends it on EVERY register, the
         register door now refuses a negative, and on anything but a cash-out
         that box is HIDDEN — so such a file could not be re-registered at all,
         refused over a field nobody could see. db/387 clears them, and the
         refusal is now gated to the same condition as the write so a PURCHASE is
         never refused over a field it would have ignored. */
      const r = await submit({
        loanType: 'Refinance — Rate & Term', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: 'Chase', payoffLoanNumber: 'C-3',
      });
      if (r.status === 201) {
        const appId = r.body.applicationId;
        // Write the legacy shape directly — the doors refuse it now, which is the point.
        await db.query(`UPDATE applications SET estimated_cash_out=-5000 WHERE id=$1`, [appId]);
        /* db/387's predicate, SCOPED TO THIS FILE. The migration itself is
           deliberately unscoped, but a test that runs an unscoped UPDATE and
           then asserts on its rowCount is asserting about every other row in the
           database — it would flake the moment another test left a negative
           behind. Scoped here; the migration's real reach is proven by applying
           it for real on a fresh database. */
        const SCOPED = `UPDATE applications SET estimated_cash_out=NULL, updated_at=now()
                         WHERE id=$1 AND estimated_cash_out IS NOT NULL AND estimated_cash_out < 0`;
        await db.query(SCOPED, [appId]);
        eq((await readBack(appId)).estimated_cash_out, null, 'db/387 clears a stored negative');
        eq((await db.query(SCOPED, [appId])).rowCount, 0, 'and re-running it matches no rows');
        // A positive figure is untouched by the same statement.
        await db.query(`UPDATE applications SET estimated_cash_out=62000 WHERE id=$1`, [appId]);
        await db.query(SCOPED, [appId]);
        eq(Number((await readBack(appId)).estimated_cash_out), 62000, 'a real figure is never touched');

        /* THE REGISTER DOOR'S OWN BEHAVIOUR, through real HTTP — the half the
           previous round claimed and did not have. Reverting either the
           isRefinance gate or the refuse() call left the whole suite green. */
        const auditRows = async (reason) => Number((await db.query(
          `SELECT count(*) c FROM audit_log WHERE entity_id=$1 AND action='register_product_refused'
             AND detail->>'reason'=$2`, [appId, reason])).rows[0].c);
        const reg = (termOptions) => call('POST', `/api/staff/applications/${appId}/pricing/register`, sTok,
          { program: 'standard', termOptions });
        const before = await auditRows('cash_out_negative');
        const neg = await reg({ estimatedCashOut: '-5000' });
        eq(neg.status, 400, 'the REGISTER door refuses a negative too');
        eq(await auditRows('cash_out_negative') - before, 1,
          'and the refusal is AUDITED — this route’s own contract, and the one an officer needs diagnosed from the logs');
        const nan = await reg({ estimatedCashOut: 'abc' });
        eq(nan.status, 400, 'and an unreadable value');
        assert(await auditRows('cash_out_not_a_number') >= 1, 'audited with its own reason');

        // A PURCHASE must NOT be refused over a field it would never write —
        // the studio sends the key on every register, so gating the refusal
        // differently from the write made purchases un-registerable.
        await db.query(`UPDATE applications SET loan_type='Purchase', purchase_price=500000 WHERE id=$1`, [appId]);
        const pur = await reg({ estimatedCashOut: '-5000' });
        assert(pur.status !== 400 || !/cash out|cashOut/i.test(JSON.stringify(pur.body || {})),
          `a PURCHASE is never refused over the cash-out (got ${pur.status} ${JSON.stringify(pur.body).slice(0, 120)})`);
      } else { assert(false, `setup submit failed (${r.status})`); }
    }

    console.log('\n--- the staff file screen reads it all back ---');
    {
      const r = await submit({
        loanType: 'Refinance — Cash-Out', asIsValue: '600000', arv: '900000', rehabBudget: '200000',
        payoffAmount: '300000', payoffLender: 'Chase', payoffLoanNumber: 'C-9',
      });
      if (r.status === 201) {
        const appId = r.body.applicationId;
        await db.query(`UPDATE applications SET loan_officer_id=$2 WHERE id=$1`, [appId, staffId]);
        const p = await call('GET', `/api/staff/applications/${appId}/payoff`, sTok, null);
        eq(p.status, 200, 'GET …/payoff answers');
        if (p.status === 200) {
          eq(p.body.kind, 'cash_out', 'it knows this is a cash-out refinance');
          eq(p.body.entered.payoffLender, 'Chase', 'and reports the lender that was entered');
          eq(p.body.entered.payoffLoanNumber, 'C-9', 'and the loan number');
          eq(p.body.ready, true, 'a file with all three entered is ready');
        }
        // A malformed id is a BAD REQUEST, not a 500.
        const bad = await call('GET', '/api/staff/applications/not-a-uuid/payoff', sTok, null);
        eq(bad.status, 400, 'a malformed id answers 400, the same as every other route');
      }
    }
  } catch (e) {
    console.error('ERROR', e); failures++;
  } finally {
    if (server) { try { server.close(); } catch (_) { /* best-effort */ } }
    try { if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]); } catch (_) {}
    try { if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]); } catch (_) {}
  }
  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL payoff-submit assertions passed');
  process.exit(failures ? 1 : 0);
})();
