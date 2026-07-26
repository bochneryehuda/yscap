'use strict';
/*
 * WO-B — DB-gated test for the Encompass reconcile service's LIVE query.
 *
 * computeFindings runs a real SELECT over applications + llcs (and
 * product_registrations + encompass_sync_resolutions). A pure test mocks the DB,
 * so it can never catch a wrong-column bug — exactly how two phantom columns
 * (a.deal_type, l.name) slipped past the pure test the first time. This exercises
 * the real query against a real schema so a column that doesn't exist throws HERE
 * instead of in production the moment WO-D/WO-E wires the panel/gate.
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in
 * a transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-encompass-reconcile-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const recon = require('../src/encompass/reconcile');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const email = 'encrecon+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Enc','Recon',$1,'1985-03-10') RETURNING id`, [email])).rows[0];
    const llc = (await client.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'ABC Holdings LLC') RETURNING id`, [b.id])).rows[0];

    // The Encompass loan we "pulled" (full loan shape: customFields[] + standard props).
    const loan = {
      baseLoanAmount: '525450.0000', purchasePriceAmount: '450500.0000',
      propertyAppraisedValueAmount: '750000.0000', loanAmortizationTermMonths: 12,
      requestedInterestRatePercent: '8.0', maturityDate: '2027-06-22', loanNumber: 'YSCAP-DBT',
      property: { propertyType: 'Single Family' },
      customFields: [
        { fieldName: 'CX.REHABBUDGET', value: '120000.0000' },
        { fieldName: 'CX.ASISVALUE', value: '500000.0000' },
        { fieldName: 'CX.DEALPROJECTTYPE', value: 'Fix and Flip' },
        { fieldName: 'CX.ACCRUALTYPE', value: 'Drawn' },
      ],
    };

    // An application that uses the REAL columns the reconcile query SELECTs.
    const app = (await client.query(
      `INSERT INTO applications
         (borrower_id, llc_id, ys_loan_number, property_address, program, loan_type,
          loan_amount, purchase_price, as_is_value, arv, rehab_budget, rate_pct, term,
          property_type, rehab_type, accrual_type, encompass_extra,
          encompass_last_pulled_at)
       VALUES ($1,$2,'YSCAP-DBT','{"state":"NY"}'::jsonb,'Fix & Flip w/ Construction','Purchase',
               525450, 450500, 500000, 750000, 120000, 8.0, '12',
               'SFR', 'Cosmetic', 'non_dutch', $3::jsonb, now())
       RETURNING id`, [b.id, llc.id, JSON.stringify(loan)])).rows[0];

    // 1. The real query runs without throwing (the phantom-column guard) and reads the loan.
    const c = await recon.computeFindings(app.id, client);
    assert.strictEqual(c.found, true, 'the application was found');
    assert.strictEqual(c.hasLoan, true, 'the pulled loan is read from encompass_extra');
    ok('computeFindings runs the real applications+llcs SELECT without a phantom-column throw');

    // 2. The compare produced real matches from both sides (columns + extracted loan).
    const byKey = {};
    for (const f of c.fields) byKey[f.key] = f;
    assert.strictEqual(byKey.loan_amount.status, 'match', 'loan_amount matches (525450 both sides)');
    assert.strictEqual(byKey.as_is_value.status, 'match', 'as-is matches (CX.ASISVALUE)');
    assert.strictEqual(byKey.arv.status, 'match', 'ARV matches (std 356 propertyAppraisedValueAmount)');
    assert.strictEqual(byKey.deal_type.status, 'match', 'deal_type derived from program → flip, matches Fix and Flip');
    assert.strictEqual(byKey.accrual_type.status, 'match', 'accrual Drawn → non_dutch matches');
    ok('the live compare matches money + derived-deal-type + accrual across the real columns');

    // 3. A money change opens a BLOCKING finding → the gate is not clear.
    await client.query(`UPDATE applications SET loan_amount = 525000 WHERE id = $1`, [app.id]);
    const c2 = await recon.computeFindings(app.id, client);
    assert.strictEqual(c2.summary.clear, false, 'a money mismatch un-clears the gate');
    assert.ok(c2.summary.openBlockingKeys.includes('loan_amount'), 'loan_amount is an open blocker');
    const gate = await recon.isClear(app.id, client);
    assert.strictEqual(gate.clear, false, 'isClear agrees the findings tab is not clear');
    ok('a money change opens a blocking finding and un-clears the term-sheet gate');

    await client.query('ROLLBACK');
    console.log(`\nWO-B Encompass reconcile DB — ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL test-encompass-reconcile-db:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
