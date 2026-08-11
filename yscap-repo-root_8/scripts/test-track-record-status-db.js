'use strict';
/**
 * RICH PER-LINE VERIFICATION STATUSES — real HTTP, real Postgres.
 * (owner-directed 2026-08-10, #40; db/519.)
 *
 * What must hold, and each was a decision:
 *   §1  Only "Fully verified" (status 'verified') sets is_verified — the real
 *       experience gate. It counts.
 *   §2  A fully-verified line moved to any non-counting outcome is a REVOKE:
 *       refused without a reason, applied with one, and it stops counting.
 *   §3  Every new outcome (not_verified / rejected / the two "unable to verify"
 *       reasons) stores, and NONE of them counts.
 *   §4  GOING FORWARD ONLY: a legacy 'limited' row that already had is_verified
 *       keeps counting — nothing sweeps it.
 *   §5  db/485's guard still returns a verified line to pending on a MATERIAL
 *       edit, and the widened CHECK still refuses an unknown value.
 *   §6  Only a COUNTING status is processor-gated; a review annotation is not.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('SKIP track-record verification statuses (no DATABASE_URL)');
  process.exit(0);
}
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const { countBorrowersExperience } = require('../src/lib/experience');
const tag = `trstatus_${process.pid}`;

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const C = require('../src/lib/crypto');

  const mkStaff = async (role, name) => {
    const s = (await db.query(
      `INSERT INTO staff_users (email, full_name, role, is_active) VALUES ($1,$2,$3,true) RETURNING id, token_version`,
      [`${tag}_${role}@example.com`, name, role])).rows[0];
    return C.signJwt({ sub: s.id, kind: 'staff', role, tv: s.token_version || 0 });
  };
  const underwriter = await mkStaff('underwriter', 'TR Status UW');
  // A draw_coordinator has see_all_files (so it can SEE this file-less borrower)
  // but NOT sign_off_conditions — so a COUNTING verify is refused while a
  // non-counting review annotation is allowed. (A loan_officer would 403 on the
  // borrower-visibility check first, for the wrong reason.)
  const noSignoff = await mkStaff('draw_coordinator', 'TR Status DC');
  const callAs = (token) => (path, opts) => fetch(`${base}${path}`, {
    ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(opts && opts.headers) },
  });
  const call = callAs(underwriter);

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('TRStatus','Tester',$1) RETURNING id`,
    [`${tag}@example.com`])).rows[0].id;

  // A flip with a completed, in-window exit (so the #112 gate lets it verify).
  const mkLine = async (label) => {
    const ADDR = { line1: `${label} Test St`, city: 'Lakewood', state: 'NJ', zip: '08701' };
    return (await db.query(
      `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price, sale_price, purchase_date, sale_date)
       VALUES ($1,$2::jsonb,'flip',200000,320000,'2024-02-01','2025-06-15') RETURNING id`,
      [borrowerId, JSON.stringify(ADDR)])).rows[0].id;
  };
  const rowOf = async (id) => (await db.query(
    'SELECT verification_status, is_verified FROM track_records WHERE id=$1', [id])).rows[0];
  const verifiedCount = async () => (await countBorrowersExperience([borrowerId], db, { verifiedOnly: true })).total;
  const verify = (id, body, token) => (token ? callAs(token) : call)(
    `/api/staff/track-records/${id}/verify`, { method: 'POST', body: JSON.stringify(body) });

  console.log('\n§1  "Fully verified" sets is_verified and counts');
  const a = await mkLine('A');
  {
    const r = await verify(a, { status: 'verified' });
    ok(r.status === 200, 'verify → 200');
    const row = await rowOf(a);
    ok(row.verification_status === 'verified' && row.is_verified === true, 'stored verified + is_verified=true');
    ok((await verifiedCount()) === 1, 'the borrower now has 1 counting deal');
  }

  console.log('\n§2  a fully-verified line moved to a non-counting outcome is a REVOKE');
  {
    const noReason = await verify(a, { status: 'rejected' });
    ok(noReason.status === 400, 'reject without a reason is refused (400)');
    const withReason = await verify(a, { status: 'rejected', reason: 'not the borrower’s deal' });
    ok(withReason.status === 200, 'reject with a reason is applied');
    const row = await rowOf(a);
    ok(row.verification_status === 'rejected' && row.is_verified === false, 'now rejected + is_verified=false');
    ok((await verifiedCount()) === 0, 'and it no longer counts');
  }

  console.log('\n§3  every new outcome stores, and none of them counts');
  for (const status of ['not_verified', 'rejected', 'unable_docs', 'unable_mismatch']) {
    const id = await mkLine(status);
    const r = await verify(id, { status });
    const row = await rowOf(id);
    ok(r.status === 200 && row.verification_status === status && row.is_verified === false,
      `${status} → stored, is_verified=false`);
  }
  ok((await verifiedCount()) === 0, 'after four reviewed-but-not-counting lines, still 0 counting');

  console.log('\n§4  GOING FORWARD: a legacy "limited" row that already had is_verified keeps counting');
  {
    const e = await mkLine('E');
    await verify(e, { status: 'verified' });                 // is_verified=true via the route
    // Simulate the legacy back book: status 'limited' with is_verified still true.
    // The db/485 guard leaves is_verified alone on a non-material update.
    await db.query(`UPDATE track_records SET verification_status='limited' WHERE id=$1`, [e]);
    const row = await rowOf(e);
    ok(row.verification_status === 'limited' && row.is_verified === true, 'legacy limited row keeps is_verified=true');
    ok((await verifiedCount()) === 1, 'the legacy limited row still counts — nothing swept it');
  }

  console.log('\n§5  the guard still resets on a material edit; the CHECK still bites');
  {
    const f = await mkLine('F');
    await verify(f, { status: 'verified' });
    await db.query(`UPDATE track_records SET purchase_price=250000 WHERE id=$1`, [f]); // material
    const row = await rowOf(f);
    ok(row.is_verified === false && row.verification_status === 'pending',
      'a material edit returns the verified line to pending (db/485)');
    let threw = false;
    try { await db.query(`UPDATE track_records SET verification_status='bogus' WHERE id=$1`, [f]); }
    catch (e) { threw = /verification_status/.test(String(e.message)) || e.code === '23514'; }
    ok(threw, 'an unknown verification_status is refused by the widened CHECK');
  }

  console.log('\n§6  only a COUNTING status needs sign-off permission; an annotation does not');
  {
    const g = await mkLine('G');
    const gate = await verify(g, { status: 'verified' }, noSignoff);
    ok(gate.status === 403, 'a staffer without sign-off cannot Fully verify — 403');
    const annotate = await verify(g, { status: 'not_verified' }, noSignoff);
    ok(annotate.status === 200 && (await rowOf(g)).verification_status === 'not_verified',
      'but they CAN record a non-counting review outcome');
  }

  console.log('\n§7  a QUIET revoke needs no reason and does NOT notify the borrower (owner 2026-08-11)');
  {
    const notifCount = async () => (await db.query(
      `SELECT count(*)::int AS n FROM notifications WHERE borrower_id=$1 AND type='track_record_unverified'`,
      [borrowerId])).rows[0].n;
    const h = await mkLine('H');
    // A LOUD revoke DOES notify.
    await verify(h, { status: 'verified' });
    const before = await notifCount();
    const loud = await verify(h, { status: 'pending', reason: 'wrong borrower' });
    ok(loud.status === 200, 'a loud revoke is applied');
    ok((await notifCount()) === before + 1, 'the LOUD revoke wrote a borrower notification');

    // A QUIET revoke: no reason required, and no notification.
    await verify(h, { status: 'verified' });
    ok((await rowOf(h)).is_verified === true, 're-verified for the quiet test');
    const beforeQuiet = await notifCount();
    const quiet = await verify(h, { status: 'pending', silent: true });   // NO reason
    ok(quiet.status === 200, 'a quiet revoke needs no reason — 200 (not the 400 a loud revoke gives)');
    const body = await quiet.json().catch(() => ({}));
    ok(body.silent === true && body.revoked === true, 'the response reports it as a silent revoke');
    const row = await rowOf(h);
    ok(row.verification_status === 'pending' && row.is_verified === false,
      'the line is back to pending and no longer counts');
    ok((await notifCount()) === beforeQuiet, 'the QUIET revoke wrote NO borrower notification');
  }

  // Cleanup.
  await db.query(`DELETE FROM notifications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
  await db.query(`DELETE FROM track_records WHERE borrower_id=$1`, [borrowerId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`${tag}_%@example.com`]);

  await new Promise((r) => server.close(r));
  await db.pool.end().catch(() => {});
  console.log(fail ? `\nFAILED — ${fail} check(s)\n` : `\nPASSED\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
