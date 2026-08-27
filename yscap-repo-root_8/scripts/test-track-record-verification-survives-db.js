'use strict';
/**
 * A VERIFICATION SURVIVES A WRITER THAT CHANGES NOTHING IT WAS MADE AGAINST
 * (db/636) — the ROOT CAUSE behind "three verified projects, two on the export".
 *
 * db/635 proved a verification can be dropped in silence and made the drop leave
 * a trace. That is the diagnosis. THIS is the cure, and the defect it closes is
 * a FLIP-FLOP: db/485 compares NEW to OLD, so two writers that disagree about
 * one material column un-verify a line on every pass — writer A moves a date,
 * the guard drops the verification, writer B moves it back, and the guard drops
 * it again. The row ends up byte-identical to what a named human approved, its
 * verification is gone, and NO HUMAN EDITED ANYTHING. That is the shape of the
 * 2026-08-26 incident: verified at 20:25:07, gone by the 20:43:39 export, and
 * the row today still holds the exact dates it was verified with.
 *
 * So the claims are:
 *   · a verification RECORDS the values it was made against (there was no such
 *     record, which is why the question could never be asked);
 *   · a row returned to those values keeps — or gets back — its verification,
 *     and the export therefore carries it (the owner's ask, end to end);
 *   · a row that genuinely differs still un-verifies, exactly as before;
 *   · a verification can never be INVENTED;
 *   · db/493, db/500, db/501 and db/516 all still hold.
 *
 * REAL POSTGRES: every claim is about what a trigger does inside a statement.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-track-record-verification-survives-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';

const crypto = require('crypto');
const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const ADDR = { line1: '3017 Market St', city: 'Jenkins Township', state: 'PA', zip: '18640',
  oneLine: '3017 Market St, Jenkins Township, PA 18640' };

async function line(borrowerId, extra = {}) {
  const cols = { property_address: JSON.stringify(ADDR), deal_type: 'fix-and-hold',
    purchase_price: 152000, purchase_date: '2026-02-10', rent_amount: 2450,
    rent_date: '2026-04-16', ...extra };
  const keys = Object.keys(cols);
  return (await db.query(
    `INSERT INTO track_records (borrower_id, ${keys.join(',')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
    [borrowerId, ...keys.map((k) => cols[k])])).rows[0].id;
}
const verify = (id, who = null) => db.query(
  `UPDATE track_records SET verification_status='verified', is_verified=true,
          verified_at=now(), verified_by=$2, updated_at=now() WHERE id=$1`, [id, who]);
const state = async (id) => (await db.query(
  `SELECT is_verified, verification_status, verified_by, verified_at FROM track_records WHERE id=$1`, [id])).rows[0];
const snaps = async (id) => (await db.query(
  `SELECT verified_by, verification_status, material FROM track_record_verifications
    WHERE track_record_id=$1 ORDER BY id`, [id])).rows;
/* THE SEED IS READ OUT OF THE MIGRATION, never retyped. A copy here could pass
   while db/636's own seed is broken — and a seeded snapshot that cannot match
   what the guard reads leaves the whole back book losing verifications exactly
   as before, silently. */
const SEED_SQL = (() => {
  const sql = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'db',
      '636_a_verification_survives_a_writer_that_changes_nothing_it_was.sql'), 'utf8');
  // The SEED is the one that selects FROM track_records; the guard's own INSERT
  // (which references NEW) is not a statement this suite can run.
  const i = sql.indexOf('INSERT INTO track_record_verifications\n       (track_record_id');
  if (i < 0) throw new Error('could not find db/636 seed statement');
  const j = sql.indexOf(';', sql.indexOf('FROM track_records t', i));
  if (j < 0) throw new Error('could not find the end of db/636 seed statement');
  const stmt = sql.slice(i, j + 1);
  if (!/SELECT t\.id/.test(stmt)) throw new Error('extracted the wrong statement from db/636');
  return stmt;
})();

const audits = async (id, action) => (await db.query(
  `SELECT detail FROM audit_log WHERE action=$2 AND entity_id=$1 ORDER BY created_at`, [id, action]
)).rows.map((r) => r.detail);

(async () => {
  const sfx = crypto.randomBytes(4).toString('hex');
  let borrowerId, staffId;
  try {
    /* APPLY THE MIGRATIONS RATHER THAN TRUST THE AMBIENT DATABASE. db/485, 493,
       500, 501, 516 and 635 EACH re-create track_record_verify_guard() on every
       boot, and db/636 wins only because it is numbered last — so what has to be
       proven here is that the chain CONVERGES on this file's definition, not that
       some earlier run happened to leave a good function behind. Without this the
       suite grades whatever is already in the database: a mutation of db/636 was
       caught by test-track-record-phase1-db (which does call ensureSchema) while
       this suite reported all-passed against the previous, unmutated function. */
    await ensureSchema();
    borrowerId = (await db.query(
      `INSERT INTO borrowers (first_name, last_name, email)
       VALUES ('Survive', 'Guard', $1) RETURNING id`, [`survive+${sfx}@example.test`])).rows[0].id;
    staffId = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, password_hash)
       VALUES ($1,'Rev Iewer','processor','x') RETURNING id`, [`rev+${sfx}@example.test`])).rows[0].id;

    // ── A. a verification records what it was made against ───────────────────
    console.log('\nA. a verification records the values it was made against');
    {
      const id = await line(borrowerId);
      ok((await snaps(id)).length === 0, 'A1 an unverified line has no verification on file');
      await verify(id, staffId);
      const s = await snaps(id);
      ok(s.length === 1, 'A2 verifying records exactly one verification');
      /* Read through a null-safe row: with the snapshot write removed, A3–A5 must
         FAIL, not throw. A crashing assertion stops the battery where it stands
         and reports a pass rate that means nothing — the repo's own warning that
         "a crashing test also fails and looks like proof". */
      const s0 = s[0] || {};
      const mat = s0.material || {};
      ok(String(s0.verified_by) === String(staffId), 'A3 …attributed to the person who made it');
      ok(mat.purchase_date === '2026-02-10', 'A4 …carrying the material values as they stood');
      ok(s.length === 1 && !('is_verified' in mat) && !('updated_at' in mat),
        'A5 …and NOT the guard’s own outputs, which always differ');
    }

    // ── B. THE FLIP-FLOP — the reported defect ───────────────────────────────
    console.log('\nB. two writers that move a column and move it back cannot destroy a verification');
    {
      const id = await line(borrowerId);
      await verify(id, staffId);

      // Writer A moves a material column. The row now differs from the review.
      await db.query(`UPDATE track_records SET rent_date='2025-10-01', updated_at=now() WHERE id=$1`, [id]);
      const mid = await state(id);
      ok(mid.is_verified === false, 'B1 writer A’s change drops it — db/485 is unchanged and still correct');
      ok((await audits(id, 'track_record_verification_dropped')).length === 1,
        'B2 …and db/635 records the drop');

      // Writer B moves it back. Nobody edited anything; the row is what was approved.
      await db.query(`UPDATE track_records SET rent_date='2026-04-16', updated_at=now() WHERE id=$1`, [id]);
      const back = await state(id);
      ok(back.is_verified === true, 'B3 writer B’s reversal PUTS THE VERIFICATION BACK');
      ok(back.verification_status === 'verified', 'B4 …with its status');
      ok(String(back.verified_by) === String(staffId), 'B5 …still attributed to the human who made it');

      const r = await audits(id, 'track_record_verification_restored');
      ok(r.length === 1, 'B6 the restore is audited — it is never silent');
      ok(r[0] && String(r[0].verifiedBy) === String(staffId), 'B7 …naming whose verification came back');
      ok((await snaps(id)).length === 1,
        'B8 a restore does not record a NEW verification — no human acted');
    }

    // ── C. a real change still un-verifies ───────────────────────────────────
    console.log('\nC. a line that genuinely differs from the review stays unverified');
    {
      const id = await line(borrowerId);
      await verify(id, staffId);
      await db.query(`UPDATE track_records SET purchase_price=999000, updated_at=now() WHERE id=$1`, [id]);
      ok((await state(id)).is_verified === false, 'C1 a real edit drops it');
      // A SECOND unrelated write must not rescue it — the row still differs.
      await db.query(`UPDATE track_records SET rent_amount=2451, updated_at=now() WHERE id=$1`, [id]);
      ok((await state(id)).is_verified === false, 'C2 …and a later write does not rescue a row that still differs');
      ok((await audits(id, 'track_record_verification_restored')).length === 0, 'C3 …nothing is restored');
    }

    // ── D. a verification is never invented ──────────────────────────────────
    console.log('\nD. a verification can never be invented');
    {
      const id = await line(borrowerId);           // never verified, so no snapshot
      await db.query(`UPDATE track_records SET rent_date='2025-10-01', updated_at=now() WHERE id=$1`, [id]);
      await db.query(`UPDATE track_records SET rent_date='2026-04-16', updated_at=now() WHERE id=$1`, [id]);
      const s = await state(id);
      ok(s.is_verified === false, 'D1 a line nobody verified is not verified by moving a value back and forth');
      ok((await audits(id, 'track_record_verification_restored')).length === 0, 'D2 …and nothing is restored');
    }

    // ── E. the export carries the line — the owner's ask, end to end ─────────
    console.log('\nE. the verified-only export carries a line whose verification came back');
    {
      const b2 = (await db.query(
        `INSERT INTO borrowers (first_name, last_name, email)
         VALUES ('Export', 'Survive', $1) RETURNING id`, [`exps+${sfx}@example.test`])).rows[0].id;
      const a = await line(b2, { property_address: JSON.stringify({ ...ADDR, line1: '1 First St', oneLine: '1 First St, X, PA 18640' }) });
      const bl = await line(b2, { property_address: JSON.stringify({ ...ADDR, line1: '2 Second St', oneLine: '2 Second St, X, PA 18640' }) });
      const c = await line(b2);                     // the third project — 3017 Market St
      for (const id of [a, bl, c]) await verify(id, staffId);

      const EXPORT = require('../src/lib/track-record/export-doc');
      const before = await EXPORT.buildBorrowerTrackRecordExport([b2], { scope: 'verified', borrowerName: 'Export Survive' });
      ok(before.rows === 3, 'E1 all three verified projects export');

      // The flip-flop, on the third line only.
      await db.query(`UPDATE track_records SET rent_date='2025-10-01', updated_at=now() WHERE id=$1`, [c]);
      const dropped = await EXPORT.buildBorrowerTrackRecordExport([b2], { scope: 'verified', borrowerName: 'Export Survive' });
      ok(dropped.rows === 2, 'E2 while it genuinely differs it is held back (and NAMED — db/635’s sibling fix)');
      ok((dropped.heldBack || []).length === 1, 'E3 …and the document says so rather than going quietly short');

      await db.query(`UPDATE track_records SET rent_date='2026-04-16', updated_at=now() WHERE id=$1`, [c]);
      const after = await EXPORT.buildBorrowerTrackRecordExport([b2], { scope: 'verified', borrowerName: 'Export Survive' });
      ok(after.rows === 3, 'E4 THE REPORTED DEFECT: once the row is what was approved, all three export again');
      ok((after.heldBack || []).length === 0, 'E5 …with nothing held back');
    }

    // ── F. every rule the guard already enforced still holds ─────────────────
    console.log('\nF. db/493, db/500, db/501 and db/516 are unchanged');
    {
      // db/493 — a re-spelling of the same place is a repair.
      const id = await line(borrowerId);
      await verify(id, staffId);
      await db.query(
        `UPDATE track_records SET property_address=$2::jsonb, updated_at=now() WHERE id=$1`,
        [id, JSON.stringify({ ...ADDR, line1: '3017 Market Street',
          oneLine: '3017 Market Street, Jenkins Township, PA 18640' })]);
      ok((await state(id)).is_verified === true, 'F1 db/493 re-spelling still does not un-verify');

      /* db/500 — a pillar WITHDRAWN is material. `pillars_met` is DERIVED (db/500
         recomputes it from track_record_pillars), so it is driven here exactly the
         way production drives it; setting it on track_records by hand writes
         nothing and would have tested the fixture rather than the rule. This is
         the case db/636 could most easily have broken: if pillars_met were left
         out of the snapshot, withdrawing a pillar would RESTORE the verification
         instead of dropping it. */
      const p = await line(borrowerId);
      // The three pillar rows already exist — trg_track_record_create_pillars mints
      // them with the line — so they are CONFIRMED here, not inserted.
      await db.query(
        `UPDATE track_record_pillars SET human_verdict='confirmed', updated_at=now()
          WHERE track_record_id=$1`, [p]);
      ok((await db.query(`SELECT pillars_met FROM track_records WHERE id=$1`, [p])).rows[0].pillars_met === true,
        'F2a (staged) three confirmed pillars make the line pillars-met');
      await verify(p, staffId);
      await db.query(
        `UPDATE track_record_pillars SET human_verdict='rejected', updated_at=now()
          WHERE track_record_id=$1 AND pillar='exit'`, [p]);
      ok((await state(p)).is_verified === false, 'F2 db/500 a withdrawn pillar still un-verifies');
      ok((await audits(p, 'track_record_verification_restored')).length === 0,
        'F2b …and db/636 does NOT restore it — the evidence it stood on is gone');

      /* F2c-e — THE ORDER PRODUCTION ACTUALLY USES, and the one F2 above cannot see.
         F2 confirms the pillars BEFORE verifying, so the snapshot holds
         pillars_met=true and withdrawing makes NEW differ from it — the drop comes
         from the snapshot MISMATCH, not from db/500's withdrawal rule, so that
         fixture passes even with the rule removed. It passed for the wrong reason.

         In production a reviewer verifies the line FIRST and the three pillar
         checks are completed afterwards, so the snapshot holds pillars_met=FALSE.
         Rejecting a pillar then returns the column to the very value the snapshot
         carries — the row MATCHES what was approved — and without the explicit
         withdrawal guard db/636 restores the verification on the exact statement
         that took its evidence away. This is the shape that shipped broken and was
         caught by test-track-record-phase1-db; it is asserted here too, because
         this is the suite somebody edits when they change the snapshot rule. */
      const q = await line(borrowerId);
      await verify(q, staffId);
      ok((await db.query(`SELECT pillars_met FROM track_records WHERE id=$1`, [q])).rows[0].pillars_met === false,
        'F2c (staged) the line is verified BEFORE any pillar is answered — snapshot holds pillars_met=false');
      await db.query(
        `UPDATE track_record_pillars SET human_verdict='confirmed', updated_at=now()
          WHERE track_record_id=$1`, [q]);
      ok((await state(q)).is_verified === true,
        'F2d finishing the pillar work does not un-verify the line being finished (db/500 is asymmetric)');
      await db.query(
        `UPDATE track_record_pillars SET human_verdict='rejected', updated_at=now()
          WHERE track_record_id=$1 AND pillar='ownership'`, [q]);
      ok((await state(q)).is_verified === false,
        'F2e …and withdrawing one re-opens it, even though pillars_met now MATCHES the snapshot');
      ok((await audits(q, 'track_record_verification_restored')).length === 0,
        'F2f …with nothing restored — a match here is a coincidence of timing, not proof');

      // db/501 — the transaction-local entity-backfill fill.
      const e = await line(borrowerId);
      await verify(e, staffId);
      const llc = (await db.query(
        `INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`,
        [borrowerId, `Survive Holdings ${sfx}`])).rows[0].id;
      const cx = await db.getClient();
      try {
        await cx.query('BEGIN');
        await cx.query(`SET LOCAL pilot.track_record_entity_backfill = 'on'`);
        await cx.query(`UPDATE track_records SET llc_id=$2, updated_at=now() WHERE id=$1`, [e, llc]);
        await cx.query('COMMIT');
      } finally { cx.release(); }
      ok((await state(e)).is_verified === true, 'F3 db/501 the entity backfill still does not un-verify');

      // db/516 — a bare-string address reshaped to the canonical object.
      const s = await line(borrowerId, { property_address: JSON.stringify(ADDR.oneLine) });
      await verify(s, staffId);
      await db.query(
        `UPDATE track_records SET property_address=$2::jsonb, updated_at=now() WHERE id=$1`,
        [s, JSON.stringify({ oneLine: ADDR.oneLine })]);
      ok((await state(s)).is_verified === true, 'F4 db/516 a storage-shape repair still does not un-verify');
    }

    // ── G. the existing book is seeded ───────────────────────────────────────
    console.log('\nG. a line verified before db/636 existed gets its snapshot from the seed');
    {
      const id = await line(borrowerId);
      await verify(id, staffId);
      await db.query(`DELETE FROM track_record_verifications WHERE track_record_id=$1`, [id]);
      ok((await snaps(id)).length === 0, 'G1 (staged) the line is verified with no verification on file');

      await db.query(SEED_SQL);
      ok((await snaps(id)).length === 1, 'G2 the seed records its current values as what was verified');

      await db.query(SEED_SQL);
      ok((await snaps(id)).length === 1, 'G3 …and a second boot adds nothing');

      // And the seeded snapshot is live: the flip-flop is now survivable here too.
      await db.query(`UPDATE track_records SET rent_date='2025-10-01', updated_at=now() WHERE id=$1`, [id]);
      await db.query(`UPDATE track_records SET rent_date='2026-04-16', updated_at=now() WHERE id=$1`, [id]);
      ok((await state(id)).is_verified === true, 'G4 the back book is protected from the next flip-flop');
    }
  } catch (e) {
    fail++; console.error('  FAIL unexpected error:', e && e.message);
  } finally {
    try {
      if (borrowerId) await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
      if (staffId) await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]);
    } catch (_) {}
    await db.pool.end().catch(() => {});
  }
  console.log(fail ? `\n${fail} failing` : '\nall passed');
  process.exit(fail ? 1 : 0);
})();
