'use strict';
/* =====================================================================
   A REFINANCE IS SIZED ON THE AS-IS VALUE — through the REAL doors, against a
   REAL Postgres (owner-directed 2026-08-02).

   The pure half (`test-refi-basis-pure.js`) proves the input builder and the
   shared predicate. This half proves the parts a pure test structurally cannot:
   that every WRITE PATH actually stores what it claims, that the back-book
   migration does what its comment says, and that the register door refuses a
   refinance it cannot size. Every assertion below was checked to FAIL with the
   corresponding change reverted.

   PART 1 — db/396, run against real rows: the implicit as-is value is
            materialized, the leftover purchase price is cleared and audited,
            purchases are untouched, no cleared condition is reopened (the
            economics triggers really are suppressed and really are re-enabled),
            and a later boot is a no-op.

   PART 2 — the doors. The borrower application, the staff new-file form, the
            staff details editor, both completeness panels and the public intake
            all agree that a refinance carries no purchase price and does carry
            the payoff + the seasoning basis. And the register door refuses a
            refinance with no as-is value rather than quoting a loan built on
            nothing.

   Needs DATABASE_URL (skips cleanly without it).
   Run: DATABASE_URL=… node scripts/test-refi-basis-db.js
   ===================================================================== */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.INTAKE_API_KEY = process.env.INTAKE_API_KEY || 'refi-basis-intake-key';

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

if (!process.env.DATABASE_URL) {
  console.log('(skipping — no DATABASE_URL)');
  process.exit(0);
}

(async () => {
  const fs = require('fs');
  const path = require('path');
  const http = require('http');
  const db = require('../src/db');
  const C = require('../src/lib/crypto');
  const sfx = Date.now().toString(36);
  let server = null;

  const MIG = path.join(__dirname, '..', 'db', '396_refinance_sized_on_as_is_value.sql');

  try {
    /* ================================================================= *
     * PART 1 — db/396 on real rows
     * ================================================================= */
    console.log('\n--- db/396: the back book ---');
    const bid = (await db.query(
      `INSERT INTO borrowers (email,first_name,last_name) VALUES ($1,'Refi','Basis') RETURNING id`,
      [`refi-basis-${sfx}@test.local`])).rows[0].id;

    const mk = async (loanType, price, asIs) => (await db.query(
      `INSERT INTO applications (borrower_id, loan_type, program, property_type, units,
         purchase_price, as_is_value, arv, rehab_budget, status)
       VALUES ($1,$2,'Fix & Flip w/ Construction','SFR',1,$3,$4,600000,90000,'processing') RETURNING id`,
      [bid, loanType, price, asIs])).rows[0].id;

    const refiNoAsIs = await mk('Refinance — Cash-Out', 400000, null);
    const refiWithAsIs = await mk('Refinance — Rate & Term', 410000, 380000);
    const purchase = await mk('Purchase', 450000, 430000);
    // "Delayed Purchase Financing" carries PURCHASE leverage — the frozen engine
    // reads it as a purchase, so the migration must leave it alone.
    const delayed = await mk('Delayed Purchase Financing', 460000, null);

    // A CLEARED, SIGNED-OFF condition on each refinance. If the migration let the
    // economics triggers fire, these would be reopened — which is the whole
    // reason it disables them.
    const tpl = (await db.query(`SELECT id FROM checklist_templates LIMIT 1`)).rows[0];
    for (const id of [refiNoAsIs, refiWithAsIs]) {
      await db.query(
        `INSERT INTO checklist_items (application_id, template_id, label, audience, item_kind, scope, status, signed_off_at)
         VALUES ($1,$2,'Products & Pricing','staff','condition','application','satisfied', now())`, [id, tpl.id]);
    }
    const clearedCount = async () => (await db.query(
      `SELECT count(*)::int n FROM checklist_items
        WHERE application_id = ANY($1) AND status='satisfied' AND signed_off_at IS NOT NULL`,
      [[refiNoAsIs, refiWithAsIs]])).rows[0].n;
    const before = await clearedCount();

    await db.query(fs.readFileSync(MIG, 'utf8'));

    const get = async (id) => (await db.query(
      `SELECT purchase_price, as_is_value FROM applications WHERE id=$1`, [id])).rows[0];

    const a = await get(refiNoAsIs);
    assert(a.purchase_price === null, 'refinance with no as-is: the leftover purchase price is cleared');
    eq(Number(a.as_is_value), 400000,
      'refinance with no as-is: the price becomes the as-is value — the SAME number buildInputs already fed the engine, so no loan changes size');

    const b = await get(refiWithAsIs);
    assert(b.purchase_price === null, 'refinance with an as-is: the purchase price is cleared');
    eq(Number(b.as_is_value), 380000, 'refinance with an as-is: the real as-is value is never overwritten');

    const p = await get(purchase);
    assert(Number(p.purchase_price) === 450000 && Number(p.as_is_value) === 430000, 'a PURCHASE is untouched');
    const d = await get(delayed);
    eq(Number(d.purchase_price), 460000, 'Delayed Purchase Financing is a purchase — untouched');

    const aud = (await db.query(
      `SELECT entity_id, detail FROM audit_log WHERE action='refi_purchase_price_cleared' AND entity_id = ANY($1)`,
      [[refiNoAsIs, refiWithAsIs, purchase, delayed]])).rows;
    eq(aud.length, 2, 'an audit row is written for each refinance that had a price — and for nothing else');
    const audA = aud.find((r) => String(r.entity_id) === String(refiNoAsIs));
    eq(audA && Number(audA.detail.purchase_price), 400000, 'the audit row records the exact value that was cleared, so nothing is lost');
    assert(audA && audA.detail.adopted_as_as_is === true, 'and says whether that value became the as-is value');

    eq(await clearedCount(), before, 'NO cleared condition was reopened — the economics triggers really were suppressed');
    eq(before, 2, '(and the fixture really did have cleared conditions to reopen)');

    const trg = (await db.query(
      `SELECT tgenabled FROM pg_trigger WHERE tgrelid='applications'::regclass AND tgname='trg_reopen_on_budget_change'`)).rows[0];
    eq(trg && trg.tgenabled, 'O', 'the reopen trigger is ENABLED again afterwards — a failure would have rolled the DISABLE back with it');

    const auditN = async () => (await db.query(`SELECT count(*)::int n FROM audit_log WHERE action='refi_purchase_price_cleared'`)).rows[0].n;
    const n1 = await auditN();
    await db.query(fs.readFileSync(MIG, 'utf8'));
    eq(await auditN(), n1, 'idempotent: a later boot matches no rows and writes no new audit rows');

    /* ================================================================= *
     * PART 2 — the real doors
     * ================================================================= */
    console.log('\n--- the write doors ---');
    const staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Refi Officer','admin',true,false,'x',0) RETURNING id`,
      [`refi-basis-lo-${sfx}@test.local`])).rows[0].id;
    await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,'x',0) ON CONFLICT DO NOTHING`, [bid]);

    const app = require('../src/server');
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const call = (method, p, token, body, extraHeaders) => new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const rq = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(extraHeaders || {}), ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
        (res) => { let s = ''; res.on('data', (c) => s += c); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch (_) { j = { _raw: s.slice(0, 300) }; } resolve({ status: res.statusCode, body: j }); }); });
      rq.on('error', reject); if (data) rq.write(data); rq.end();
    });
    const bTok = C.signJwt({ sub: bid, kind: 'borrower', tv: 0 });
    const sTok = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv: 0 });
    const ADDR = { line1: `${1000 + (Date.now() % 8000)} Hewes St`, city: 'Brooklyn', state: 'NY', zip: '11211' };
    const REFI_COLS = 'purchase_price, as_is_value, payoff_amount, original_purchase_price, acquisition_date, payoff_lender, payoff_loan_number, is_assignment';
    const read = async (id) => (await db.query(`SELECT ${REFI_COLS} FROM applications WHERE id=$1`, [id])).rows[0];

    // ---- the borrower application (draft → submit) ----
    console.log('\n  · borrower application');
    {
      const dr = await call('POST', '/api/borrower/drafts', bTok, {
        data: {
          propertyAddress: ADDR, loanType: 'Refinance — Cash-Out',
          // A stale purchase price, exactly as a draft that started life as a
          // purchase would carry it. It must not reach the file.
          purchasePrice: '400000',
          asIsValue: '600000', arv: '900000', rehabBudget: '200000',
          payoffAmount: '300000', payoffLender: 'Chase Home Finance', payoffLoanNumber: 'CHF-88213',
          originalPurchasePrice: '250000', acquisitionDate: '2021-06-15',
          // An assignment is a purchase concept and must be forced off too.
          isAssignment: true, underlyingContractPrice: '380000', assignmentFee: '20000',
        }, step: 5 });
      const r = await call('POST', `/api/borrower/drafts/${dr.body && dr.body.id}/submit`, bTok, {});
      eq(r.status, 201, 'a refinance application submits');
      if (r.status === 201) {
        const row = await read(r.body.applicationId);
        assert(row.purchase_price === null, 'borrower door: a refinance stores NO purchase price, even when one is sent');
        eq(Number(row.as_is_value), 600000, 'borrower door: the as-is value is stored — it is what the loan is sized on');
        eq(Number(row.payoff_amount), 300000, 'borrower door: the payoff is stored');
        eq(Number(row.original_purchase_price), 250000, 'borrower door: the ORIGINAL purchase price is stored (the seasoning basis)');
        eq(String(row.acquisition_date).slice(0, 10), '2021-06-15', 'borrower door: the acquisition date is stored');
        eq(row.payoff_lender, 'Chase Home Finance', 'borrower door: the payoff lender is stored');
        assert(row.is_assignment === false, 'borrower door: a refinance is never an assignment');
      }
    }

    // ---- the staff new-file form ----
    console.log('\n  · staff new file');
    let staffAppId = null;
    {
      const r = await call('POST', '/api/staff/applications', sTok, {
        borrower: { firstName: 'New', lastName: 'RefiFile', email: `refi-new-${sfx}@test.local` },
        propertyAddress: { line1: `${2000 + (Date.now() % 6000)} Bedford Ave`, city: 'Brooklyn', state: 'NY', zip: '11211' },
        propertyType: 'SFR', units: 1, program: 'Fix & Flip w/ Construction',
        loanType: 'Refinance — Rate & Term',
        purchasePrice: 400000,             // stale — must be refused
        asIsValue: 550000, arv: 800000, rehabBudget: 120000,
        payoffAmount: 275000, payoffLender: 'Kiavi Servicing', payoffLoanNumber: 'KV-55512345',
        originalPurchasePrice: 310000, acquisitionDate: '2019-11-04',
        inviteBorrower: false,
      });
      eq(r.status, 201, 'staff can open a refinance file');
      if (r.status === 201) {
        staffAppId = r.body.applicationId;
        const row = await read(staffAppId);
        assert(row.purchase_price === null, 'staff new file: a refinance stores NO purchase price');
        eq(Number(row.as_is_value), 550000, 'staff new file: the as-is value is stored');
        eq(Number(row.payoff_amount), 275000, 'staff new file: the payoff is stored (it used to be dropped on the floor)');
        eq(Number(row.original_purchase_price), 310000, 'staff new file: the original purchase price is stored');
        eq(String(row.acquisition_date).slice(0, 10), '2019-11-04', 'staff new file: the acquisition date is stored');
        eq(row.payoff_loan_number, 'KV-55512345', 'staff new file: the payoff loan number is stored');
      }
    }

    // ---- the staff details editor + completeness panel ----
    console.log('\n  · staff details editor + completeness panel');
    if (staffAppId) {
      // A stale tab re-sending a purchase price on a refinance.
      const r1 = await call('PATCH', `/api/staff/applications/${staffAppId}/details`, sTok, { purchasePrice: 399000 });
      assert(r1.status < 400, 'the details save is accepted');
      const row1 = await read(staffAppId);
      assert(row1.purchase_price === null, 'details door: a purchase price sent on a refinance is refused, not stored');

      // The completeness pill is gone on a refinance, but a direct call must be
      // refused too — it writes the same column.
      await call('POST', `/api/staff/applications/${staffAppId}/complete-fields`, sTok, { purchase_price: 388000 });
      const row2 = await read(staffAppId);
      assert(row2.purchase_price === null, 'completeness door: a purchase price on a refinance is refused there too');

      // The seasoning fields ARE writable from the details door.
      await call('PATCH', `/api/staff/applications/${staffAppId}/details`, sTok,
        { originalPurchasePrice: 315000, acquisitionDate: '2019-11-05' });
      const row3 = await read(staffAppId);
      eq(Number(row3.original_purchase_price), 315000, 'details door: the original purchase price is editable');
      eq(String(row3.acquisition_date).slice(0, 10), '2019-11-05', 'details door: the acquisition date is editable');

      // Switching a refinance to a PURCHASE clears the refinance-only economics.
      await call('PATCH', `/api/staff/applications/${staffAppId}/details`, sTok, {
        loanType: 'Purchase', purchasePrice: 500000,
        payoffAmount: '', payoffLender: '', payoffLoanNumber: '', originalPurchasePrice: '', acquisitionDate: '',
      });
      const row4 = await read(staffAppId);
      eq(Number(row4.purchase_price), 500000, 'switched to a purchase: the purchase price is now accepted');
      assert(row4.payoff_amount === null && row4.original_purchase_price === null && row4.acquisition_date === null,
        'switched to a purchase: the refinance-only economics are cleared');
    }

    // ---- the register door refuses a refinance it cannot size ----
    console.log('\n  · the register door');
    {
      /* A real, otherwise-eligible refinance: the frozen matrix declines a fix &
         flip refinance from a first-time investor, so without experience and a
         FICO the register would 422 for a reason that has nothing to do with the
         as-is value — and the second half of this check would pass vacuously. */
      await db.query(`UPDATE borrowers SET fico=740 WHERE id=$1`, [bid]);
      const noValue = (await db.query(
        `INSERT INTO applications (borrower_id, loan_type, program, property_type, units,
           as_is_value, arv, rehab_budget, status, loan_officer_id,
           requested_exp_flips, requested_exp_holds, requested_exp_ground, term)
         VALUES ($1,'Refinance — Cash-Out','Fix & Flip w/ Construction','SFR',1,NULL,900000,200000,'processing',$2,
                 6,0,0,'12')
         RETURNING id`, [bid, staffId])).rows[0].id;
      const r = await call('POST', `/api/staff/applications/${noValue}/pricing/register`, sTok, { program: 'standard' });
      eq(r.status, 400, 'a refinance with no as-is value is REFUSED — never quoted off a purchase price');
      assert(r.body && /as-is value/i.test(String(r.body.error || '')),
        'and the refusal says which figure to enter');

      // With an as-is value it registers normally.
      await db.query(`UPDATE applications SET as_is_value=600000 WHERE id=$1`, [noValue]);
      const r2 = await call('POST', `/api/staff/applications/${noValue}/pricing/register`, sTok, { program: 'standard' });
      assert(r2.status < 400,
        `and with an as-is value it registers (status ${r2.status}${r2.status >= 400 ? ' — ' + JSON.stringify(r2.body).slice(0, 300) : ''})`);
    }

    // ---- the public intake door ----
    console.log('\n  · public intake');
    {
      const r = await call('POST', '/api/intake', null, {
        firstName: 'Intake', lastName: 'Refi', email: `refi-intake-${sfx}@test.local`,
        loanType: 'Refinance — Cash-Out',
        propertyAddress: { line1: `${3000 + (Date.now() % 5000)} Marcy Ave`, city: 'Brooklyn', state: 'NY', zip: '11211' },
        propertyType: 'SFR', units: 1,
        purchasePrice: 400000,               // the public form sends null; a hand-rolled post might not
        asIsValue: 640000, arv: 900000, rehabBudget: 150000,
        payoffAmount: 320000, originalPurchasePrice: 275000, acquisitionDate: '2020-02-11',
      }, { 'x-intake-key': process.env.INTAKE_API_KEY });
      assert(r.status < 400, `the public intake accepts a refinance (status ${r.status})`);
      if (r.status < 400 && r.body && r.body.applicationId) {
        const row = await read(r.body.applicationId);
        assert(row.purchase_price === null, 'intake door: a refinance stores NO purchase price');
        eq(Number(row.as_is_value), 640000, 'intake door: the as-is value is stored');
        eq(Number(row.payoff_amount), 320000, 'intake door: the payoff now reaches the file (it used to be dropped)');
        eq(Number(row.original_purchase_price), 275000, 'intake door: the original purchase price now reaches the file');
        eq(String(row.acquisition_date).slice(0, 10), '2020-02-11', 'intake door: the acquisition date now reaches the file');
      }
    }

    // ---- seasoning reaches the rule engine ----
    console.log('\n  · seasoning as a rule field');
    {
      const seasoned = (await db.query(
        `INSERT INTO applications (borrower_id, loan_type, program, property_type, units,
           as_is_value, arv, rehab_budget, acquisition_date, status)
         VALUES ($1,'Refinance — Cash-Out','Fix & Flip w/ Construction','SFR',1,600000,900000,200000,'2024-03-05','processing')
         RETURNING id`, [bid])).rows[0].id;
      const { ctx } = await require('../src/lib/conditions/engine').loadRuleContext(seasoned);
      assert(ctx && typeof ctx.ownership_seasoning_months === 'number',
        'the Condition Center can read ownership seasoning off the file');
      assert(ctx.ownership_seasoning_months >= 12,
        `and it is a real month count (${ctx && ctx.ownership_seasoning_months})`);
      eq(ctx.original_purchase_price == null ? 'null' : 'set', 'null',
        'a file with no original purchase price reports it as unknown, never 0');
    }

  } catch (e) {
    assert(false, `unexpected error: ${e && e.message}`);
    console.error(e);
  } finally {
    if (server) server.close();
    try { await db.pool.end(); } catch (_) { /* best-effort */ }
  }

  console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL refinance-basis (db) assertions passed');
  process.exit(failures ? 1 : 0);
})();
