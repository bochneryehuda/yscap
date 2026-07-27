'use strict';
/*
 * Part 2 — DB-gated test for the Encompass borrower-profile enrichment writes.
 *
 * Proves the owner's hard rules with a REAL database: enrichment is ADDITIVE and
 * DEDUPED — it adds a prior-deal address / LLC only when ABSENT, NEVER replaces
 * or edits an existing track-record row or LLC, marks what it adds unverified,
 * and matches borrowers CONSERVATIVELY (linked application, or exactly one
 * name+DOB match — never on ambiguity). And it only ever adds the property of a
 * loan that actually CLOSED (owner-directed 2026-07-27) — an in-flight file's
 * subject property stays off, and one added before the rule existed comes off.
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

// `funded` defaults to a real, past funding date — these fixtures stand for
// CLOSED deals. Pass funded:null for a loan that is still in flight.
const loanFor = (first, last, dob, addr, llcName, funded = '2024-03-15') => ({
  applications: [{ borrower: { firstName: first, lastName: last, birthDate: dob } }],
  property: { streetAddress: addr.street, city: addr.city, state: addr.state, postalCode: addr.zip },
  ...(funded ? { closingDocument: { fundingDate: funded } } : {}),
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
    // Isolate the enrichment pass to just this test's fixtures: clear the snapshot
    // table WITHIN the rolled-back transaction so the global summary counters
    // (matched / addressesAdded / llcsAdded) are deterministic even if the target
    // DB already holds committed encompass_loan_snapshot rows. Rolled back at the end.
    await client.query('DELETE FROM encompass_loan_snapshot');
    const suffix = Buffer.from(String(process.pid)).toString('hex');
    const b = (await client.query(
      `INSERT INTO borrowers (first_name,last_name,email,date_of_birth)
         VALUES ('Yehuda','Bochner',$1,'1985-03-10') RETURNING id`, [`enrich+${suffix}@example.com`])).rows[0];

    const A = { street: '12 Churchill Lane', city: 'Brooklyn', state: 'NY', zip: '11230' };
    const B = { street: '400 Ocean Parkway', city: 'Brooklyn', state: 'NY', zip: '11218' };

    // The A property is ALREADY on the profile from ClickUp — GEOCODED + ABBREVIATED
    // ("12 Churchill Ln, …, USA") with the OLD simple address_key, i.e. a DIFFERENT
    // spelling than Encompass sends ("12 Churchill Lane, …"). This is the exact
    // cross-source case the owner named ("don't add it twice"): enrichment must
    // dedupe A against it via the strong canon and NOT re-add it, NOR touch it.
    const clickupA = { formatted_address: '12 Churchill Ln, Brooklyn, NY 11230, USA' };
    const trExisting = (await client.query(
      `INSERT INTO track_records (borrower_id, property_address, is_verified, origin, address_key, notes)
       VALUES ($1,$2::jsonb, true, 'portal', $3, 'original human record') RETURNING id`,
      [b.id, JSON.stringify(clickupA), enrich._internals.addrKey(clickupA)])).rows[0];
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

    // ── CLOSED DEALS ONLY (owner-directed 2026-07-27) ──────────────────────
    // C = the property the borrower is buying RIGHT NOW (a live Encompass file,
    // no funding date). D = another live file whose enrichment row a human has
    // since worked on. Both already sit on the track record from before the rule
    // existed, written exactly the way this pass used to write them.
    const C = { street: '900 Live Street', city: 'Brooklyn', state: 'NY', zip: '11204' };
    const D = { street: '77 Worked Way', city: 'Monsey', state: 'NY', zip: '10952' };
    const seed = async (a, extra) => (await client.query(
      `INSERT INTO track_records (borrower_id, property_address, is_verified, origin, inferred, address_key, notes, purchase_price)
       VALUES ($1,$2::jsonb,false,'encompass',true,$3,'Added from Encompass history; unverified',$4) RETURNING id`,
      [b.id, JSON.stringify({ ...a, oneLine: `${a.street}, ${a.city}, ${a.state} ${a.zip}`, formatted_address: `${a.street}, ${a.city}, ${a.state} ${a.zip}` }),
        enrich._internals.normAddr(a.street + ', ' + a.city + ', ' + a.state + ' ' + a.zip), extra || null])).rows[0];
    const trLive = await seed(C, null);
    const trWorked = await seed(D, 425000);   // a human filled in what they paid

    // The live files themselves, plus a REFINANCE of the already-closed B that is
    // still in underwriting — B must stay on the record (a closed loan backs it).
    await snap('G-C-live', loanFor('Yehuda', 'Bochner', '1985-03-10', C, null, null));
    await snap('G-D-live', loanFor('Yehuda', 'Bochner', '1985-03-10', D, null, null));
    await snap('G-B-refi', loanFor('Yehuda', 'Bochner', '1985-03-10', B, null, null));

    const s3 = await enrich.enrichAllOnce({ dbc: client });
    assert.strictEqual(s3.addressesAdded, 0, 'no in-flight property is added');
    assert.strictEqual(s3.addressesSkippedNotClosed, 3, 'all three unclosed loans are held back');
    ok('a property whose loan has not closed is never added to the track record');

    assert.strictEqual(
      (await client.query(`SELECT count(*)::int n FROM track_records WHERE id=$1`, [trLive.id])).rows[0].n, 0,
      'the live subject property is off the track record');
    assert.strictEqual(s3.addressesRemovedNotClosed, 1, 'exactly one row was taken back');
    assert.strictEqual((await client.query(
      `SELECT count(*)::int n FROM audit_log WHERE action='encompass_track_record_removed_not_closed' AND entity_id=$1`,
      [b.id])).rows[0].n, 1, 'the removal is on the audit trail');
    ok('a property added before the deal closed is taken back OFF the record, and the removal is audited');

    const worked = (await client.query(`SELECT purchase_price FROM track_records WHERE id=$1`, [trWorked.id])).rows[0];
    assert.ok(worked && Number(worked.purchase_price) === 425000, 'the row a human worked on is untouched');
    ok('a line somebody has worked on is never deleted, even when its loan is still in flight');

    const bStill = (await client.query(
      `SELECT count(*)::int n FROM track_records WHERE borrower_id=$1 AND origin='encompass'`, [b.id])).rows[0].n;
    assert.strictEqual(bStill, 2, 'the closed property B and the worked-on line D remain');
    ok('a property backed by a CLOSED loan stays put even when a refinance of it is in flight');

    // OUR FILE HAS THE LAST WORD. E is the subject of a PILOT file that is still
    // in underwriting — even with a funding date sitting in Encompass, the deal
    // is not done until our team says it is, so the property waits.
    const E = { street: '31 Our File Road', city: 'Lakewood', state: 'NJ', zip: '08701' };
    const liveApp = (await client.query(
      `INSERT INTO applications (borrower_id, status) VALUES ($1,'underwriting') RETURNING id`, [b.id])).rows[0];
    await snap('G-E-inflight', loanFor('Yehuda', 'Bochner', '1985-03-10', E, null, '2024-08-01'), liveApp.id);

    const s4 = await enrich.enrichAllOnce({ dbc: client });
    assert.strictEqual(s4.addressesAdded, 0, 'the in-underwriting subject property is not added');
    assert.strictEqual(
      (await client.query(`SELECT count(*)::int n FROM track_records WHERE borrower_id=$1 AND address_key=$2`,
        [b.id, enrich._internals.normAddr(`${E.street}, ${E.city}, ${E.state} ${E.zip}`)])).rows[0].n, 0,
      'nothing was written for it');
    ok('the subject property of a file still in underwriting stays off — our status outranks any Encompass field');

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
