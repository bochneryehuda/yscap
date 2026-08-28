'use strict';
/**
 * A VERIFICATION THE DATABASE DROPS ON ITS OWN LEAVES A TRACE (db/635).
 *
 * WHAT THIS IS ABOUT. On 2026-08-26 a loan team verified a borrower's third
 * project at 20:25:07, exported the investor package at 20:43:39 and got two
 * projects, then verified the SAME line again at 22:06:33 — with no
 * `unverify_track_record` row anywhere in between, because the only thing in
 * this system that can clear `is_verified` without one is the db/485 guard and
 * it recorded nothing at all. Nobody could learn a line had fallen out, and
 * nobody afterwards could establish which writer had touched the row.
 *
 * SO THE CLAIMS HERE ARE IN TWO HALVES, and the second half is the one that
 * matters most: db/635 must RECORD a real drop, and it must not have changed
 * ANY of the four rules the guard already enforced. This file is the proof that
 * copying db/516's function verbatim actually preserved db/493's re-spelling
 * exemption, db/516's storage-shape exemption and db/501's transaction-local
 * entity-backfill hole — a retyped guard is exactly how db/497 "silently
 * reverted three unrelated rules".
 *
 * REAL POSTGRES, because every claim is about what a trigger does inside a
 * statement; nothing here can be observed from JavaScript.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-verify-trace-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const crypto = require('crypto');
const db = require('../src/db');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const ADDR = { line1: '3017 Market St', city: 'Jenkins Township', state: 'PA', zip: '18640',
  oneLine: '3017 Market St, Jenkins Township, PA 18640' };

/** A line, verified the way the verify route verifies one: insert (which the guard
 *  always lands as pending), then set the verification with no material change. */
async function verifiedLine(borrowerId, addr = ADDR, extra = {}) {
  const cols = { property_address: JSON.stringify(addr), deal_type: 'fix-and-hold',
    purchase_price: 152000, purchase_date: '2026-02-10', rent_amount: 2450,
    rent_date: '2026-04-16', ...extra };
  const keys = Object.keys(cols);
  const r = await db.query(
    `INSERT INTO track_records (borrower_id, ${keys.join(',')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
    [borrowerId, ...keys.map((k) => cols[k])]);
  const id = r.rows[0].id;
  await db.query(
    `UPDATE track_records SET verification_status='verified', is_verified=true,
            verified_at=now(), updated_at=now() WHERE id=$1`, [id]);
  return id;
}

const traces = async (id) => (await db.query(
  `SELECT detail FROM audit_log
    WHERE action='track_record_verification_dropped' AND entity_id=$1
    ORDER BY created_at`, [id])).rows.map((r) => r.detail);

const state = async (id) => (await db.query(
  `SELECT is_verified, verification_status FROM track_records WHERE id=$1`, [id])).rows[0];

(async () => {
  const sfx = crypto.randomBytes(4).toString('hex');
  let borrowerId;
  try {
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email)
       VALUES ('Trace', 'Guard', $1) RETURNING id`, [`trace+${sfx}@example.test`])).rows[0].id;

    // ── A. the drop is recorded, and it names what moved ─────────────────────
    console.log('\nA. a material edit drops the verification AND says so');
    {
      const id = await verifiedLine(borrowerId);
      ok((await state(id)).is_verified === true, 'A1 the line starts verified');

      // The 2026-08-26 edit, reproduced: the purchase and rent dates were moved.
      await db.query(
        `UPDATE track_records SET purchase_date='2025-06-23', rent_date='2025-10-01', updated_at=now()
          WHERE id=$1`, [id]);

      const s = await state(id);
      ok(s.is_verified === false, 'A2 the guard still drops the verification (db/485 unchanged)');
      ok(s.verification_status === 'pending', 'A3 …and returns the line to pending');

      const t = await traces(id);
      ok(t.length === 1, 'A4 exactly one trace is recorded for the drop');
      const d = t[0] || {};
      ok(d.wasVerified === true, 'A5 the trace records that a verification really was lost');
      ok(d.wasStatus === 'verified', 'A6 …and the status it was lost from');
      ok(String(d.borrowerId) === String(borrowerId), 'A7 …and whose record it is');
      ok(d.changed && d.changed.purchase_date && d.changed.rent_date,
        'A8 it NAMES the columns that moved — a trace that says nothing is the defect');
      ok(d.changed.purchase_date.from === '2026-02-10' && d.changed.purchase_date.to === '2025-06-23',
        'A9 …with the value before and after, which is what answers "what happened"');
      ok(!('is_verified' in d.changed) && !('verification_status' in d.changed) && !('updated_at' in d.changed),
        'A10 the guard\'s own outputs are excluded — they always differ here, by construction');
      ok(typeof d.statement === 'string' && /UPDATE track_records/i.test(d.statement),
        'A11 the STATEMENT is recorded — the field that answers WHICH writer did it');
      ok(d.statement.length <= 300, 'A12 …truncated, so a trace can never be unbounded');
    }

    // ── B. nothing to lose, nothing to say ───────────────────────────────────
    console.log('\nB. a drop that removes no standing verification is not recorded');
    {
      const r = await db.query(
        `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price)
         VALUES ($1, $2::jsonb, 'flip', 100000) RETURNING id`, [borrowerId, JSON.stringify(ADDR)]);
      const id = r.rows[0].id;
      ok((await state(id)).is_verified === false, 'B1 a new line is pending (db/485)');
      await db.query(`UPDATE track_records SET purchase_price=120000 WHERE id=$1`, [id]);
      ok((await traces(id)).length === 0,
        'B2 editing a line nobody verified writes no trace — noise, not a record');
    }

    // ── C. a non-material edit is not a drop and is not recorded ─────────────
    console.log('\nC. an edit the guard does not act on is silent');
    {
      const id = await verifiedLine(borrowerId);
      await db.query(`UPDATE track_records SET notes='an internal note', updated_at=now() WHERE id=$1`, [id]);
      ok((await state(id)).is_verified === true, 'C1 the verification survives a non-material edit');
      ok((await traces(id)).length === 0, 'C2 …and nothing is recorded, because nothing was dropped');
    }

    // ── D. the four rules the guard already enforced are unchanged ───────────
    console.log('\nD. db/493, db/516 and db/501 survived being copied verbatim');
    {
      // db/493: a re-spelling of the same place is a repair, not a restatement.
      const a = await verifiedLine(borrowerId);
      await db.query(
        `UPDATE track_records SET property_address=$2::jsonb, updated_at=now() WHERE id=$1`,
        [a, JSON.stringify({ ...ADDR, line1: '3017 Market Street',
          oneLine: '3017 Market Street, Jenkins Township, PA 18640' })]);
      ok((await state(a)).is_verified === true, 'D1 db/493 — a re-spelling still does NOT un-verify');
      ok((await traces(a)).length === 0, 'D2 …and writes no trace');

      // db/516: a bare string reshaped to the canonical object is a repair.
      const b = await verifiedLine(borrowerId, ADDR.oneLine);
      await db.query(
        `UPDATE track_records SET property_address=$2::jsonb, updated_at=now() WHERE id=$1`,
        [b, JSON.stringify(ADDR)]);
      ok((await state(b)).is_verified === true, 'D3 db/516 — a storage-shape repair still does NOT un-verify');

      // db/501: a NULL -> value fill of llc_id under the transaction-local GUC.
      const llcId = (await db.query(
        `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`,
        [borrowerId, `Layback ${sfx} LLC`])).rows[0].id;
      const c = await verifiedLine(borrowerId);
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL pilot.track_record_entity_backfill = 'on'`);
        await client.query(`UPDATE track_records SET llc_id=$2, updated_at=now() WHERE id=$1`, [c, llcId]);
        await client.query('COMMIT');
      } finally { client.release(); }
      ok((await state(c)).is_verified === true, 'D4 db/501 — the entity backfill exemption still holds');
      ok((await traces(c)).length === 0, 'D5 …and writes no trace, because nothing was dropped');

      // …and re-pointing an entity is still a restatement, exemption or not.
      const d = await verifiedLine(borrowerId, ADDR, { llc_id: llcId });
      await db.query(`UPDATE track_records SET llc_id=NULL, updated_at=now() WHERE id=$1`, [d]);
      ok((await state(d)).is_verified === false, 'D6 …while a real entity change still un-verifies');
      ok((await traces(d)).length === 1, 'D7 …and that drop IS recorded');
    }

    // ── E. the trace may never cost the write ────────────────────────────────
    console.log('\nE. an unwritable trace never fails the statement it is recording');
    {
      const id = await verifiedLine(borrowerId);
      const client = await db.pool.connect();
      let dropped = null;
      let threw = null;
      try {
        await client.query('BEGIN');
        // Make the audit insert impossible for the length of this transaction only.
        await client.query(
          `ALTER TABLE audit_log ADD CONSTRAINT tmp_no_trace
             CHECK (action <> 'track_record_verification_dropped') NOT VALID`);
        /* CAUGHT HERE, NOT LEFT TO THE HARNESS. A statement that throws would end
           this file with a stack trace and NO failed assertion — which reads as
           "0 failures" to anything counting them, and is how a mutation of the
           swallow could look like proof that the swallow works. */
        try {
          await client.query(`UPDATE track_records SET purchase_price=999999, updated_at=now() WHERE id=$1`, [id]);
          dropped = (await client.query(
            `SELECT is_verified FROM track_records WHERE id=$1`, [id])).rows[0].is_verified;
        } catch (e) { threw = e.message; }
      } finally { await client.query('ROLLBACK').catch(() => {}); client.release(); }
      ok(threw === null, `E1 an unwritable trace does not fail the write${threw ? ` — threw: ${threw}` : ''}`);
      ok(dropped === false,
        'E2 …and the verification is still dropped, which is the state the rest of the system reads');
    }
  } finally {
    if (borrowerId) {
      await db.query(`DELETE FROM audit_log WHERE entity_type='track_record' AND entity_id IN
                        (SELECT id FROM track_records WHERE borrower_id=$1)`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM llcs WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
      await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    }
    await db.pool.end().catch(() => {});
  }
  console.log(fail ? `\n${fail} failed` : '\nall passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
