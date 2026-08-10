'use strict';
/**
 * DELETE A TRACK-RECORD LINE FROM THE STAFF CENTER (owner-directed #32).
 *
 * The staff DELETE endpoint (`DELETE /api/staff/track-records/:id`) existed but
 * had NO UI caller until #32 wired the "Delete this line" button + the
 * `staffDeleteTrackRecord` api method. This proves the now-live path: access
 * control (canSeeBorrowerId — a staffer who cannot see the borrower is refused),
 * the row is removed, and the borrower's experience tier is recomputed.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
if (!process.env.DATABASE_URL) { console.log('SKIP (no DATABASE_URL)'); process.exit(0); }

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const C = require('../src/lib/crypto');
const { RECENT_EXIT_SQL } = require('../src/lib/experience');
const tag = `trdel_${process.pid}`;

let pass = 0; let fail = 0;
const ok = (cond, what) => { if (cond) { pass++; console.log(`  ok  ${what}`); } else { fail++; console.error(`  FAIL ${what}`); } };

(async () => {
  await ensureSchema();
  const app = require('../src/server');
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const admin = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Del Admin','super_admin') RETURNING id, token_version`,
    [`deladmin+${tag}@x.test`])).rows[0];
  const adminTok = C.signJwt({ sub: admin.id, kind: 'staff', role: 'super_admin', tv: admin.token_version || 0 });

  // A loan officer with NO link to the borrower — must be refused (the destructive
  // path has to be access-gated, since #32 just made it reachable from the UI).
  const lo = (await db.query(
    `INSERT INTO staff_users (email, full_name, role) VALUES ($1,'Del LO','loan_officer') RETURNING id, token_version`,
    [`dello+${tag}@x.test`])).rows[0];
  const loTok = C.signJwt({ sub: lo.id, kind: 'staff', role: 'loan_officer', tv: lo.token_version || 0 });

  const call = (tok, method, path) => fetch(`${base}/api/staff${path}`, { method, headers: { authorization: `Bearer ${tok}` } });

  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Del','Case',$1) RETURNING id`,
    [`delcase+${tag}@x.test`])).rows[0].id;

  // A flip with a recent sale. db/485's trigger forces every INSERT to
  // unverified/pending, so — exactly like a real reviewer pressing Verify — a
  // second UPDATE that touches NO material column makes it verified and sticks;
  // then it counts toward the tier and the recompute is observable on delete.
  const recent = new Date(); recent.setMonth(recent.getMonth() - 6);
  const saleDate = recent.toISOString().slice(0, 10);
  const trId = (await db.query(
    `INSERT INTO track_records (borrower_id, property_address, deal_type, purchase_price, sale_price, sale_date)
     VALUES ($1,$2::jsonb,'flip',100000,180000,$3) RETURNING id`,
    [borrowerId, JSON.stringify({ oneLine: '5 Delete Dr, Lakewood, NJ 08701' }), saleDate])).rows[0].id;
  await db.query(`UPDATE track_records SET is_verified=true, verification_status='verified' WHERE id=$1`, [trId]);
  await db.query(
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true AND (${RECENT_EXIT_SQL})) WHERE id=$1`,
    [borrowerId]);
  const tierBefore = Number((await db.query(`SELECT tier FROM borrowers WHERE id=$1`, [borrowerId])).rows[0].tier);
  ok(tierBefore === 1, `tier is 1 with a verified recent flip on file (got ${tierBefore})`);

  console.log('\n1. A staffer who cannot see the borrower is refused');
  {
    const r = await call(loTok, 'DELETE', `/track-records/${trId}`);
    ok(r.status === 403, `an unrelated loan officer gets 403 (got ${r.status})`);
    const still = (await db.query(`SELECT 1 FROM track_records WHERE id=$1`, [trId])).rows[0];
    ok(!!still, 'the line is still there after the refused delete');
  }

  console.log('\n2. A staffer who can see the borrower deletes it, tier recomputes');
  {
    const r = await call(adminTok, 'DELETE', `/track-records/${trId}`);
    ok(r.status === 200, `super-admin delete succeeds (got ${r.status})`);
    const gone = (await db.query(`SELECT 1 FROM track_records WHERE id=$1`, [trId])).rows[0];
    ok(!gone, 'the line is gone from the record');
    const tierAfter = Number((await db.query(`SELECT tier FROM borrowers WHERE id=$1`, [borrowerId])).rows[0].tier);
    ok(tierAfter === 0, `tier recomputed down to 0 after the delete (got ${tierAfter})`);
  }

  console.log('\n3. Deleting an already-gone line 404s');
  {
    const r = await call(adminTok, 'DELETE', `/track-records/${trId}`);
    ok(r.status === 404, `a second delete of the same id 404s (got ${r.status})`);
  }

  server.close();
  console.log(`\n${fail ? 'FAILED' : 'OK'}  staff delete a track-record line — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE FAILED:', e); process.exit(1); });
