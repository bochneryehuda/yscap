'use strict';
/*
 * WO-B / WO-C — DB-gated test for the Encompass reconcile service's LIVE query
 * and the "pull one Encompass value into our column" write path.
 *
 * computeFindings runs a real SELECT over applications + llcs + borrowers (and
 * product_registrations + encompass_sync_resolutions). A pure test mocks the DB,
 * so it can never catch a wrong-column bug — exactly how two phantom columns
 * (a.deal_type, l.name) slipped past the pure test the first time. This exercises
 * the real query against a real schema so a column that doesn't exist throws HERE
 * instead of in production — including the 2026-07-26 additions (a.units,
 * a.property_address, the borrowers JOIN for the identity comparison).
 *
 * Owner-directed 2026-07-26: the section passes only when EVERY field matches, so
 * a file with un-entered/incomparable fields is never "clear" — this test asserts
 * field-level behavior + the gate mechanics, not a full-file clear (the pure test
 * covers the everything-matches → clear path with a complete fixture).
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in
 * a transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-encompass-reconcile-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const recon = require('../src/encompass/reconcile');
const identity = require('../src/clickup/identity');
const cfg = require('../src/config');
const C = require('../src/lib/crypto');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// Test SSNs (never real). Borrower is stored via the ssn_hash COLUMN path;
// co-borrower is stored via ssn_encrypted with NO hash column, to exercise the
// decrypt-fallback in _effectiveSsnHash. The Encompass side carries the SAME
// keyed HMAC the reader scrub would have produced (identity.ssnHash) + last-4.
const B_SSN = '123456789', CB_SSN = '987654321';
const B_HASH = identity.ssnHash(B_SSN, cfg.ssnMatchKey);
const CB_HASH = identity.ssnHash(CB_SSN, cfg.ssnMatchKey);

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const email = 'encrecon+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,cell_phone,ssn_hash,ssn_last4)
         VALUES ('Enc','Recon',$1,'1985-03-10','555-123-4567',$2,'6789') RETURNING id`, [email, B_HASH])).rows[0];
    const llc = (await client.query(
      `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,'ABC Holdings LLC') RETURNING id`, [b.id])).rows[0];
    const email2 = 'enccorecon+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    // Co-borrower: ssn_encrypted but NO ssn_hash column → exercises the
    // decrypt-fallback path in computeFindings (_effectiveSsnHash).
    const cb = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth,cell_phone,ssn_encrypted,ssn_last4)
         VALUES ('Coe','Recon',$1,'1990-07-15','555-987-6543',$2,'4321') RETURNING id`, [email2, C.encryptSSN(CB_SSN)])).rows[0];

    // The Encompass loan we "pulled" (full loan shape: customFields[] + standard
    // props + the applications[].borrower identity subtree + subject property).
    const loan = {
      baseLoanAmount: '525450.0000', purchasePriceAmount: '450500.0000',
      propertyAppraisedValueAmount: '750000.0000', loanAmortizationTermMonths: 12,
      requestedInterestRatePercent: '8.0', maturityDate: '2027-06-22', loanNumber: 'YSCAP-DBT',
      property: { propertyType: 'Single Family', financedNumberOfUnits: 2, streetAddress: '12 Main St', city: 'Brooklyn', state: 'NY', postalCode: '11230' },
      applications: [{
        borrower: { firstName: 'Enc', lastName: 'Recon', birthDate: '1985-03-10', emailAddressText: email, mobilePhone: '(555) 123-4567', _ssnHash: B_HASH, _ssnLast4: '6789' },
        coBorrower: { firstName: 'Coe', lastName: 'Recon', birthDate: '1990-07-15', emailAddressText: email2, mobilePhone: '(555) 987-6543', _ssnHash: CB_HASH, _ssnLast4: '4321' },
      }],
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
         (borrower_id, llc_id, co_borrower_id, ys_loan_number, property_address, units, program, loan_type,
          loan_amount, purchase_price, as_is_value, arv, rehab_budget, rate_pct, term,
          property_type, rehab_type, accrual_type, encompass_extra,
          encompass_last_pulled_at)
       VALUES ($1,$2,$4,'YSCAP-DBT',
               '{"street":"12 Main St","city":"Brooklyn","state":"NY","zip":"11230"}'::jsonb, 2,
               'Fix & Flip w/ Construction','Purchase',
               525450, 450500, 500000, 750000, 120000, 8.0, '12',
               'SFR', 'Cosmetic', 'non_dutch', $3::jsonb, now())
       RETURNING id`, [b.id, llc.id, JSON.stringify(loan), cb.id])).rows[0];

    // 1. The real query runs without throwing (the phantom-column guard) and reads the loan.
    //    This now also exercises a.units / a.property_address + the borrowers JOIN.
    const c = await recon.computeFindings(app.id, client);
    assert.strictEqual(c.found, true, 'the application was found');
    assert.strictEqual(c.hasLoan, true, 'the pulled loan is read from encompass_extra');
    ok('computeFindings runs the real applications+llcs+borrowers SELECT without a phantom-column throw');

    // 2. Economics matches from both sides (columns + extracted loan).
    const byKey = {};
    for (const f of c.fields) byKey[f.key] = f;
    assert.strictEqual(byKey.loan_amount.status, 'match', 'loan_amount matches (525450 both sides)');
    assert.strictEqual(byKey.as_is_value.status, 'match', 'as-is matches (CX.ASISVALUE)');
    assert.strictEqual(byKey.arv.status, 'match', 'ARV matches (std 356 propertyAppraisedValueAmount)');
    assert.strictEqual(byKey.deal_type.status, 'match', 'deal_type derived from program → flip, matches Fix and Flip');
    assert.strictEqual(byKey.accrual_type.status, 'match', 'accrual Drawn → non_dutch matches');
    assert.strictEqual(byKey.ys_loan_number.status, 'match', 'loan number is now MATCHED (YSCAP-DBT both sides)');
    assert.strictEqual(byKey.units.status, 'match', 'units 2 vs Encompass field 16 (2) matches');
    ok('the live compare matches money + derived-deal-type + accrual + loan# + units across the real columns');

    // 2b. The borrower identity + subject-address rows are present and match.
    assert.ok(byKey.id_borrower_name, 'the identity comparison is surfaced');
    assert.strictEqual(byKey.id_borrower_name.status, 'match', 'borrower name matches (Enc Recon)');
    assert.strictEqual(byKey.id_dob.status, 'match', 'date of birth matches (1985-03-10)');
    assert.strictEqual(byKey.id_email.status, 'match', 'email matches');
    assert.strictEqual(byKey.id_phone.status, 'match', 'phone matches (digits, ignoring formatting)');
    assert.strictEqual(byKey.id_property_address.status, 'match', 'subject property address matches (canonical)');
    assert.strictEqual(byKey.id_borrower_name.writable, false, 'identity is compare-only (never overwrite borrower PII from a read)');
    ok('borrower identity + subject address are compared, matched, and never writable');

    // 2b-SSN. SSN is compared by the one-way keyed HMAC, displayed masked, and is
    //   PII-safe: the raw number and the hash NEVER appear in the field output.
    assert.ok(byKey.id_ssn, 'the SSN comparison is surfaced');
    assert.strictEqual(byKey.id_ssn.status, 'match', 'borrower SSN matches (hash column path)');
    assert.strictEqual(byKey.id_ssn.writable, false, 'SSN is compare-only (never overwrite from a read)');
    assert.strictEqual(byKey.id_ssn.gate, require('../src/lib/integrations/encompass-field-map').GATE.BLOCK, 'SSN is BLOCK-gated (must match to pass)');
    assert.strictEqual(byKey.id_ssn.ours, '•••-••-6789', 'SSN is displayed masked (last-4 only), never the full number');
    assert.strictEqual(byKey.id_ssn.theirs, '•••-••-6789', 'Encompass SSN is displayed masked too');
    const idJson = JSON.stringify(byKey.id_ssn) + JSON.stringify(byKey.id_coborrower_ssn || {});
    assert.ok(!idJson.includes(B_SSN) && !idJson.includes(CB_SSN), 'the raw SSN never appears in the field output');
    assert.ok(!idJson.includes(B_HASH) && !idJson.includes(CB_HASH), 'the SSN hash never leaves the server (not in the field output)');
    ok('SSN is compared by one-way HMAC, displayed masked, and neither the raw SSN nor the hash leaks');

    // 2c. The CO-BORROWER identity is compared too — matched via the coBorrower
    //     representation AND via the 2nd-borrower-pair representation.
    assert.strictEqual(byKey.id_coborrower_name.status, 'match', 'co-borrower name matches (Coe Recon)');
    assert.strictEqual(byKey.id_coborrower_dob.status, 'match', 'co-borrower DOB matches (1990-07-15)');
    assert.strictEqual(byKey.id_coborrower_email.status, 'match', 'co-borrower email matches');
    assert.strictEqual(byKey.id_coborrower_phone.status, 'match', 'co-borrower phone matches');
    // Co-borrower SSN matches via the DECRYPT-FALLBACK (cb has ssn_encrypted, no ssn_hash column).
    assert.ok(byKey.id_coborrower_ssn, 'the co-borrower SSN comparison is surfaced');
    assert.strictEqual(byKey.id_coborrower_ssn.status, 'match', 'co-borrower SSN matches (derived from ssn_encrypted when the hash column is null)');
    assert.strictEqual(byKey.id_coborrower_ssn.ours, '•••-••-4321', 'co-borrower SSN displayed masked');
    // Same co-borrower expressed as a SECOND borrower pair (applications[1].borrower).
    const loan2 = JSON.parse(JSON.stringify(loan));
    delete loan2.applications[0].coBorrower;
    loan2.applications.push({ borrower: { firstName: 'Coe', lastName: 'Recon', birthDate: '1990-07-15', emailAddressText: email2, mobilePhone: '(555) 987-6543', _ssnHash: CB_HASH, _ssnLast4: '4321' } });
    await client.query(`UPDATE applications SET encompass_extra=$2::jsonb WHERE id=$1`, [app.id, JSON.stringify(loan2)]);
    const cPair = {}; for (const f of (await recon.computeFindings(app.id, client)).fields) cPair[f.key] = f;
    assert.strictEqual(cPair.id_coborrower_name.status, 'match', 'co-borrower matches via the 2nd-borrower-pair representation too');
    assert.strictEqual(cPair.id_coborrower_dob.status, 'match', 'co-borrower DOB matches via the 2nd-pair representation');
    await client.query(`UPDATE applications SET encompass_extra=$2::jsonb WHERE id=$1`, [app.id, JSON.stringify(loan)]); // restore
    ok('the co-borrower is compared and matched via BOTH the coBorrower and the 2nd-borrower-pair representations');

    // 2d. A DIFFERENT Encompass SSN → id_ssn mismatch → not-passing (blocks the gate).
    const loanWrongSsn = JSON.parse(JSON.stringify(loan));
    loanWrongSsn.applications[0].borrower._ssnHash = identity.ssnHash('111223333', cfg.ssnMatchKey);
    loanWrongSsn.applications[0].borrower._ssnLast4 = '3333';
    await client.query(`UPDATE applications SET encompass_extra=$2::jsonb WHERE id=$1`, [app.id, JSON.stringify(loanWrongSsn)]);
    const cWrong = await recon.computeFindings(app.id, client);
    const wrongSsn = cWrong.fields.find((f) => f.key === 'id_ssn');
    assert.strictEqual(wrongSsn.status, 'mismatch', 'a different Encompass SSN mismatches');
    assert.strictEqual(wrongSsn.theirs, '•••-••-3333', 'the mismatched Encompass SSN is still shown masked');
    assert.ok(cWrong.summary.notPassingKeys.includes('id_ssn'), 'an SSN mismatch is not-passing (holds the term sheet)');
    await client.query(`UPDATE applications SET encompass_extra=$2::jsonb WHERE id=$1`, [app.id, JSON.stringify(loan)]); // restore
    ok('a differing Social Security number mismatches, stays masked, and un-passes the section');

    // 2e. A file with NO SSN on EITHER side gets no SSN row at all → SSN never
    //     falsely blocks a genuinely SSN-less file (only a present-or-one-sided SSN compares).
    const emailNo = 'encnossn+' + Buffer.from(String(process.pid)).toString('hex') + '@example.com';
    const bNoSsn = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('No','Ssn',$1) RETURNING id`, [emailNo])).rows[0];
    const loanNoSsn = { loanNumber: 'YS-NOSSN', applications: [{ borrower: { firstName: 'No', lastName: 'Ssn' } }] };
    const appNoSsn = (await client.query(
      `INSERT INTO applications (borrower_id, ys_loan_number, encompass_extra, encompass_last_pulled_at)
         VALUES ($1,'YS-NOSSN',$2::jsonb, now()) RETURNING id`, [bNoSsn.id, JSON.stringify(loanNoSsn)])).rows[0];
    const cNoSsn = await recon.computeFindings(appNoSsn.id, client);
    assert.ok(!cNoSsn.fields.find((f) => f.key === 'id_ssn'), 'no SSN on either side → no id_ssn row');
    assert.ok(!cNoSsn.summary.notPassingKeys.includes('id_ssn'), 'SSN never blocks a file that has no SSN anywhere');
    ok('a file with no SSN on either side gets no SSN comparison row (no false block)');

    // Re-read after restoring so later steps see the original loan.
    for (const k in byKey) delete byKey[k];
    for (const f of (await recon.computeFindings(app.id, client)).fields) byKey[f.key] = f;

    // 3. A money change opens a finding → the field is not-passing and the gate blocks.
    await client.query(`UPDATE applications SET loan_amount = 525000 WHERE id = $1`, [app.id]);
    const c2 = await recon.computeFindings(app.id, client);
    assert.strictEqual(c2.fields.find((f) => f.key === 'loan_amount').status, 'mismatch', 'loan_amount now differs');
    assert.ok(c2.summary.notPassingKeys.includes('loan_amount'), 'loan_amount is not-passing');
    assert.strictEqual(c2.summary.clear, false, 'a money mismatch un-passes the section');
    assert.strictEqual((await recon.isClear(app.id, client)).clear, false, 'isClear agrees the section does not pass');
    ok('a money change opens a finding and un-passes the term-sheet gate');

    // 4. Pull the Encompass value into our column (WO-C) → our column is updated,
    //    the FIELD matches again, and a "replaced" resolution row is recorded.
    const rep = await recon.replaceField(app.id, 'loan_amount', null, client);
    assert.strictEqual(rep.ok, true, 'replaceField succeeded');
    assert.strictEqual(rep.wrote, 525450, 'wrote the Encompass value into our column');
    const col = (await client.query(`SELECT loan_amount FROM applications WHERE id=$1`, [app.id])).rows[0];
    assert.strictEqual(Number(col.loan_amount), 525450, 'applications.loan_amount now equals Encompass');
    const after = await recon.computeFindings(app.id, client);
    assert.strictEqual(after.fields.find((f) => f.key === 'loan_amount').status, 'match', 'the field matches again once pulled');
    const resn = (await client.query(`SELECT resolution FROM encompass_sync_resolutions WHERE application_id=$1 AND field_key='loan_amount'`, [app.id])).rows[0];
    assert.strictEqual(resn.resolution, 'replaced', 'a "replaced" resolution row was recorded');
    // a compute-only field, and an identity field, are NOT writable.
    assert.strictEqual((await recon.replaceField(app.id, 'final_initial_loan', null, client)).reason, 'not_writable', 'a compute-only field cannot be pulled');
    assert.strictEqual((await recon.replaceField(app.id, 'id_borrower_name', null, client)).reason, 'not_writable', 'an identity field cannot be pulled');
    ok('replaceField pulls one Encompass value into our column and refuses non-writable fields (compute-only + identity)');

    // 5. Enum coercion: our 'dutch' vs Encompass 'Drawn' → pulling writes our token 'non_dutch'.
    await client.query(`UPDATE applications SET accrual_type = 'dutch' WHERE id = $1`, [app.id]);
    assert.strictEqual((await recon.computeFindings(app.id, client)).fields.find((f) => f.key === 'accrual_type').status, 'mismatch', 'accrual now differs');
    const repAcc = await recon.replaceField(app.id, 'accrual_type', null, client);
    assert.strictEqual(repAcc.ok, true, 'accrual replace succeeded');
    assert.strictEqual(repAcc.wrote, 'non_dutch', 'Encompass "Drawn" → our "non_dutch" token');
    assert.strictEqual((await client.query(`SELECT accrual_type FROM applications WHERE id=$1`, [app.id])).rows[0].accrual_type, 'non_dutch', 'accrual column updated to our vocabulary');

    // 6. A writable field Encompass did not return → no_encompass_value (never a garbage write).
    const noVal = await recon.replaceField(app.id, 'assignment_fee', null, client);
    assert.strictEqual(noVal.ok, false);
    assert.strictEqual(noVal.reason, 'no_encompass_value', 'refused a field with no Encompass value');
    ok('replace coerces an enum to our vocabulary and refuses a field Encompass has no value for');

    // 7. The term-sheet issuance gate (WO-E): a file with any open mismatch blocks,
    //    and a file with NO Encompass loan pulled is dormant (never blocked).
    await client.query(`UPDATE applications SET purchase_price = 999999 WHERE id = $1`, [app.id]);
    const gBlock = await recon.issuanceGate(app.id, client);
    assert.strictEqual(gBlock.block, true, 'a blocking mismatch makes the issuance gate block');
    assert.ok(gBlock.openBlockingKeys.includes('purchase_price'), 'the not-passing field is reported');
    const app2 = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    assert.strictEqual((await recon.issuanceGate(app2.id, client)).block, false, 'a file with no pulled Encompass loan is never blocked (dormant)');
    ok('the WO-E issuance gate blocks on an open mismatch and is dormant with no Encompass loan');

    await client.query('ROLLBACK');
    console.log(`\nWO-B/C/E Encompass reconcile DB — ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL test-encompass-reconcile-db:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
