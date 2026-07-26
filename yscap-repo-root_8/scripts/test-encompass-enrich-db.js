'use strict';
/*
 * Part 2 — DB-gated test for the Encompass borrower-profile enrichment writes.
 *
 * Proves the owner's hard rules with a REAL database: enrichment is ADDITIVE and
 * DEDUPED — it adds a prior-deal address / LLC only when ABSENT, NEVER replaces
 * or edits an existing track-record row or LLC, marks what it adds unverified,
 * and matches borrowers CONSERVATIVELY (linked application, or exactly one
 * name+DOB match — never on ambiguity).
 *
 * Requires DATABASE_URL with migrations applied; SKIPs cleanly otherwise. Runs in
 * a transaction and ROLLS BACK — leaves no rows behind.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-encompass-enrich-db (no DATABASE_URL)'); process.exit(0); }
const assert = require('assert');
const { Pool } = require('pg');
const enrich = require('../src/encompass/enrich');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const loanFor = (first, last, dob, addr, llcName) => ({
  applications: [{ borrower: { firstName: first, lastName: last, birthDate: dob } }],
  property: { streetAddress: addr.street, city: addr.city, state: addr.state, postalCode: addr.zip },
  customFields: llcName ? [{ fieldName: 'CX.LLCNAME', value: llcName }, { fieldName: 'CX.LLCSTATE', value: addr.state }] : [],
});

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  const snap = async (guid, raw, appId) => client.query(
    `INSERT INTO encompass_loan_snapshot (encompass_loan_guid, loan_number, raw, application_id, pulled_at)
     VALUES ($1,$2,$3::jsonb,$4, now())`, [guid, guid, JSON.stringify(raw), appId || null]);
  try {
    await client.query('BEGIN');
    const suffix = Buffer.from(String(process.pid)).toString('hex');
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Yehuda','Bochner',$1,'1985-03-10') RETURNING id`, [`enrich+${suffix}@example.com`])).rows[0];

    const A = { street: '12 Churchill Lane', city: 'Brooklyn', state: 'NY', zip: '11230' };
    const B = { street: '400 Ocean Parkway', city: 'Brooklyn', state: 'NY', zip: '11218' };
    const keyA = enrich._internals.addrKey(enrich._internals.subjectAddress(loanFor('Yehuda', 'Bochner', '1985-03-10', A)));

    // A property + an LLC ALREADY on the profile (a human/ClickUp record we must NOT touch).
    const trExisting = (await client.query(
      `INSERT INTO track_records (borrower_id, property_address, is_verified, origin, address_key, notes)
       VALUES ($1,'{"oneLine":"12 Churchill Lane"}'::jsonb, true, 'portal', $2, 'original human record') RETURNING id`,
      [b.id, keyA])).rows[0];
    await client.query(`INSERT INTO llcs (borrower_id, llc_name, is_verified, origin) VALUES ($1,'Existing LLC', true, 'portal')`, [b.id]);

    // Two Encompass loans for this borrower: one already-present (skip), one new (add).
    await snap('G-A', loanFor('Yehuda', 'Bochner', '1985-03-10', A, 'Existing LLC'));
    await snap('G-B', loanFor('Yehuda', 'Bochner', '1985-03-10', B, 'New Holdings LLC'));

    const s1 = await enrich.enrichAllOnce({ dbc: client });
    assert.strictEqual(s1.matched, 2, 'both loans matched the borrower by name+DOB');
    assert.strictEqual(s1.addressesAdded, 1, 'only the NEW address was added');
    assert.strictEqual(s1.llcsAdded, 1, 'only the NEW LLC was added');
    ok('enrichment adds only what is absent (1 new address, 1 new LLC; the present ones skipped)');

    // The pre-existing human record is UNTOUCHED.
    const exN = (await client.query(`SELECT origin, is_verified, notes FROM track_records WHERE id=$1`, [trExisting.id])).rows[0];
    assert.strictEqual(exN.origin, 'portal', 'existing track record origin unchanged');
    assert.strictEqual(exN.is_verified, true, 'existing track record still verified (not reset)');
    assert.strictEqual(exN.notes, 'original human record', 'existing track record not overwritten');
    const exLlc = (await client.query(`SELECT origin, is_verified FROM llcs WHERE borrower_id=$1 AND lower(btrim(llc_name))='existing llc'`, [b.id])).rows[0];
    assert.strictEqual(exLlc.origin, 'portal', 'existing LLC not replaced');
    ok('the pre-existing property + LLC are NEVER replaced or edited');

    // The new records are unverified/inferred and tagged encompass.
    const added = (await client.query(`SELECT origin, is_verified, inferred FROM track_records WHERE borrower_id=$1 AND origin='encompass'`, [b.id])).rows;
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].is_verified, false, 'added track record is UNVERIFIED (never inflates experience)');
    assert.strictEqual(added[0].inferred, true);
    const addedLlc = (await client.query(`SELECT is_verified FROM llcs WHERE borrower_id=$1 AND origin='encompass'`, [b.id])).rows;
    assert.strictEqual(addedLlc.length, 1);
    assert.strictEqual(addedLlc[0].is_verified, false, 'added LLC is unverified');
    ok('added records are origin=encompass, unverified/inferred');

    // Idempotent — a second pass adds nothing.
    const s2 = await enrich.enrichAllOnce({ dbc: client });
    assert.strictEqual(s2.addressesAdded, 0, 're-run adds no duplicate address');
    assert.strictEqual(s2.llcsAdded, 0, 're-run adds no duplicate LLC');
    const trCount = (await client.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1`, [b.id])).rows[0].n;
    assert.strictEqual(trCount, 2, 'still exactly 2 track records (1 human + 1 Encompass) — no duplicates');
    ok('the pass is idempotent — running again creates no duplicates');

    // Conservative matching — a second borrower with the SAME name+DOB makes it ambiguous → no match.
    await client.query(`INSERT INTO borrowers (first_name,last_name,email,date_of_birth) VALUES ('Yehuda','Bochner',$1,'1985-03-10')`, [`dup+${suffix}@example.com`]);
    const amb = await enrich.matchBorrower(client, { first: 'Yehuda', last: 'Bochner', dob: '1985-03-10' }, null);
    assert.strictEqual(amb, null, 'two borrowers share name+DOB → never guess (no match)');
    // But a loan LINKED to a specific application still matches that app's borrower.
    const app = (await client.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b.id])).rows[0];
    const linked = await enrich.matchBorrower(client, { first: 'Nobody', last: 'Here', dob: null }, app.id);
    assert.strictEqual(linked && linked.borrowerId, b.id, 'a linked application resolves the borrower directly');
    assert.strictEqual(linked.how, 'linked_application');
    ok('matching is conservative: ambiguous name+DOB → skip; a linked application → resolve');

    await client.query('ROLLBACK');
    console.log(`\nPart 2 Encompass enrichment DB — ${passed} checks passed`);
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('FAIL test-encompass-enrich-db:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
