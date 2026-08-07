#!/usr/bin/env node
/**
 * A TRACK RECORD IS PENDING REVIEW UNTIL A HUMAN VERIFIES IT.
 *
 * Owner-reported 2026-08-07: "We still have several instances where borrowers are
 * entering track records or staff are entering track records, since it's coming up as
 * verified. There should not even be a single thing where somebody entered their track
 * record that should come up as verified. Every single detail of a track record you need
 * to click on verify, no matter how you enter it. Even if you import, if you export, if
 * you do it manually, it should always be entered as pending review till it is being
 * verified. It needs to be a manual switch to verify them."
 *
 * The DB section SKIPS without DATABASE_URL, like the rest of the suite. Runs in
 * `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

console.log('\n1. The shared stamp is the SAME rule for every actor');
{
  const s = read('../src/routes/borrower.js');
  const fn = s.slice(s.indexOf('function trackRecordEnteredCols'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  // THE ORIGINAL BUG: the status was set only for one kind, so the staff door — whose
  // own comment claimed it landed pending — got no status at all.
  ok(!/kind === 'borrower'/.test(body),
    'no per-actor branch: a helper that takes the actor and then behaves differently is two rules, not one');
  ok(/verification_status: 'pending'/.test(body), 'every create lands pending');
  ok(/is_verified: false/.test(body),
    'and states is_verified explicitly — the column DEFAULT does not apply on an ON CONFLICT DO UPDATE');
  // Both doors must use it.
  ok(/trackRecordEnteredCols\('borrower'\)/.test(s), 'the borrower door uses it');
  ok(/trackRecordEnteredCols\('staff'\)/.test(read('../src/routes/staff.js')), 'the staff door uses it');
}

console.log('\n2. Nothing anywhere inserts a verified track record');
{
  // Every writer, enumerated. An INSERT that hands `is_verified` a true would be the
  // whole bug back again.
  for (const f of ['../src/routes/borrower.js', '../src/routes/staff.js', '../src/clickup/ingest.js',
                   '../src/encompass/enrich.js', '../src/lib/track-record-from-file.js',
                   '../src/lib/track-record-heal.js']) {
    const s = read(f);
    const idx = s.indexOf('INSERT INTO track_records');
    if (idx < 0) { ok(true, `${path.basename(f)} has no track-record INSERT`); continue; }
    const stmt = s.slice(idx, idx + 900);
    ok(!/is_verified[^,)]*true/.test(stmt) && !/,\s*true\s*,\s*'(clickup|encompass)/.test(stmt),
      `${path.basename(f)} does not insert a verified row`);
  }
}

console.log('\n3. The database refuses to be wrong regardless (db/485)');
{
  const sql = read('../db/485_track_record_always_pending.sql');
  ok(/BEFORE INSERT OR UPDATE ON track_records/.test(sql), 'the guard covers INSERT and UPDATE');
  ok(/FOR EACH ROW/.test(sql), 'per row, so a bulk write is covered too');
  ok(/'verified', 'limited'/.test(sql), 'both COUNTING statuses are treated as "claims to be reviewed"');
  // The material list must cover every figure and date the experience math reads.
  for (const col of ['property_address', 'llc_id', 'owned_personally', 'deal_type', 'property_type',
                     'purchase_price', 'sale_price', 'rehab_amount', 'rent_amount', 'refi_amount',
                     'current_value', 'purchase_date', 'sale_date', 'rent_date', 'refi_date']) {
    ok(new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`).test(sql), `a change to ${col} resets the review`);
  }
  // …and must NOT cover the bookkeeping, or a heal un-verifies the whole book.
  for (const col of ['docs_status', 'address_key', 'notes', 'lo_notes', 'origin', 'updated_at']) {
    ok(!new RegExp(`NEW\\.${col}\\s+IS DISTINCT FROM OLD\\.${col}`).test(sql),
      `a change to ${col} does NOT reset it (it is not what a reviewer checked)`);
  }
  ok(/DROP TRIGGER IF EXISTS/.test(sql) && /CREATE OR REPLACE FUNCTION/.test(sql), 'idempotent');
  ok(!/UPDATE track_records\s+SET\s+is_verified\s*=\s*false/i.test(sql),
    'GOING FORWARD ONLY — no sweep un-verifies the back book (that would drop every tier and reopen live conditions)');
}

/* ------------------------------------------------------------------ DB ---- */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\nSKIP the DB section (no DATABASE_URL)');
    console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ track-record verify guard: all pure assertions passed\n');
    process.exit(fails ? 1 : 0);
  }
  const db = require('../src/db');
  console.log('\n4. Against a real database — every path the owner named');
  let bor;
  try {
    bor = (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email)
       VALUES ('Trg','Guard','trg.guard.test@example.com') RETURNING id`)).rows[0];
    const state = async (id) => (await db.query(
      `SELECT is_verified, verification_status, verified_at, verified_by FROM track_records WHERE id=$1`, [id])).rows[0];

    // A writer that ASKS for a verified row cannot have one — this is the belt behind
    // every import present and future.
    const a = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, is_verified, verification_status, verified_at)
       VALUES ($1,'{"oneLine":"1 A St"}'::jsonb,'flip',true,'verified',now()) RETURNING id`, [bor.id])).rows[0];
    let s = await state(a.id);
    ok(s.is_verified === false && s.verification_status === 'pending' && s.verified_at === null,
      'an INSERT that asks to be verified lands PENDING with no stamp');

    // 'limited' counts too, so it is refused the same way.
    const l = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, verification_status, is_verified)
       VALUES ($1,'{"oneLine":"3 C St"}'::jsonb,'limited',true) RETURNING id`, [bor.id])).rows[0];
    ok((await state(l.id)).verification_status === 'pending', "an INSERT asking for 'limited' lands pending too");

    // 'docs' is a legitimate landing state — pending, and waiting on paperwork.
    const d = (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, verification_status)
       VALUES ($1,'{"oneLine":"2 B St"}'::jsonb,'docs') RETURNING id`, [bor.id])).rows[0];
    s = await state(d.id);
    ok(s.verification_status === 'docs' && s.is_verified === false, "a door asking for 'docs' keeps it, unverified");

    // THE MANUAL SWITCH STILL WORKS — this is the one thing that must not break.
    await db.query(`UPDATE track_records SET verification_status='verified', is_verified=true, verified_at=now() WHERE id=$1`, [a.id]);
    s = await state(a.id);
    ok(s.is_verified === true && s.verification_status === 'verified' && s.verified_at !== null,
      'a reviewer pressing Verify works exactly as before');

    // AN IMPORT RE-FILLING A FIGURE ON A VERIFIED LINE — the half no door handled.
    await db.query(`UPDATE track_records SET purchase_price=250000 WHERE id=$1`, [a.id]);
    s = await state(a.id);
    ok(s.is_verified === false && s.verification_status === 'pending' && s.verified_at === null,
      'an import re-filling purchase_price on a VERIFIED line resets it to pending');

    // A NON-MATERIAL write must NOT reset — otherwise the heal pass un-verifies the book.
    await db.query(`UPDATE track_records SET verification_status='verified', is_verified=true, verified_at=now() WHERE id=$1`, [a.id]);
    await db.query(`UPDATE track_records SET docs_status='received', notes='a note', address_key='k', lo_notes='x' WHERE id=$1`, [a.id]);
    s = await state(a.id);
    ok(s.is_verified === true && s.verification_status === 'verified',
      'docs_status / notes / address_key / lo_notes leave the verification alone');

    // Every material column, one at a time — a list with a hole in it is the bug.
    const material = [
      ["sale_date=CURRENT_DATE", 'sale_date'],
      ["deal_type='hold'", 'deal_type'],
      ["sale_price=400000", 'sale_price'],
      ["rehab_amount=50000", 'rehab_amount'],
      ["rent_amount=2500", 'rent_amount'],
      ["refi_amount=300000", 'refi_amount'],
      ["current_value=500000", 'current_value'],
      ["purchase_date=CURRENT_DATE", 'purchase_date'],
      ["rent_date=CURRENT_DATE", 'rent_date'],
      ["refi_date=CURRENT_DATE", 'refi_date'],
      ["property_type='sfr'", 'property_type'],
      ["owned_personally=true", 'owned_personally'],
      ["entity_name='Some LLC'", 'entity_name'],
      [`property_address='{"oneLine":"9 Z St"}'::jsonb`, 'property_address'],
    ];
    for (const [set, col] of material) {
      await db.query(`UPDATE track_records SET verification_status='verified', is_verified=true, verified_at=now() WHERE id=$1`, [a.id]);
      await db.query(`UPDATE track_records SET ${set} WHERE id=$1`, [a.id]);
      const st = await state(a.id);
      ok(st.is_verified === false && st.verification_status === 'pending', `changing ${col} resets the review`);
    }

    // Re-writing the SAME value is not a change, so it must not churn a verified row.
    await db.query(`UPDATE track_records SET verification_status='verified', is_verified=true, verified_at=now() WHERE id=$1`, [a.id]);
    await db.query(`UPDATE track_records SET sale_price=400000 WHERE id=$1`, [a.id]);   // already 400000
    ok((await state(a.id)).is_verified === true,
      're-writing an identical value is not a change (IS DISTINCT FROM), so a verified row is left alone');
  } catch (e) {
    fails++; console.error('  ✗ DB section threw:', e.message);
  } finally {
    try {
      if (bor) {
        await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [bor.id]);
        await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor.id]);
      }
    } catch (_) { /* cleanup is best-effort */ }
  }
  console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ track-record verify guard: all assertions passed\n');
  process.exit(fails ? 1 : 0);
})();
