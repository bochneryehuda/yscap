#!/usr/bin/env node
'use strict';
/**
 * SUPER-ADMIN: remove an entity from a borrower profile — real HTTP against a real
 * Postgres (owner-directed 2026-08-10 "clean up ones added by error").
 *
 * Proves, through the actual doors:
 *   · a NON-super-admin (a loan officer) is refused on both the preview and the
 *     remove — the hard super_admin gate;
 *   · the preview NAMES the consequences (deleted vs transferred, verified, the
 *     files it vests, the documents it holds) BEFORE anything is removed;
 *   · a removal with no reason is refused;
 *   · a SOLE-OWNER entity is DELETED — its document slots, members and documents
 *     go with it (CASCADE), every file that vested to it is un-vested (SET NULL),
 *     the whole entity is snapshotted into entity_removals, and the action is
 *     audited;
 *   · a CO-OWNED entity is TRANSFERRED, not deleted — it stays, its primary
 *     pointer moves to the remaining owner, and it leaves only THIS profile;
 *   · an entity that is not on this profile is refused (409).
 *
 * Leaves its rows behind (runs against the live server, not a transaction) and
 * cleans them up in finally. Skips without DATABASE_URL.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-entity-remove-route-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const http = require('http');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');

function call(server, method, p, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ method, path: p, port: server.address().port, host: '127.0.0.1',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`,
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } },
      (res) => { let b = ''; res.on('data', (c) => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null })); });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const like = `er-%-${sfx}@test.local`;
  let pass = 0, fail = 0;
  const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log(`FAIL ${m}`); } };
  const tok = (id, role) => C.signJwt({ sub: id, kind: 'staff', role, tv: 0 });

  try {
    const staff = async (key, role) => (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,$2,$3,true,false,'x',0) RETURNING id`,
      [`er-${key}-${sfx}@test.local`, `${role} ${key}`, role])).rows[0].id;
    const superId = await staff('super', 'super_admin');
    const loId = await staff('lo', 'loan_officer');
    const superT = tok(superId, 'super_admin');
    const loT = tok(loId, 'loan_officer');

    const borrower = async (key) => (await db.query(
      `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Test',$1,$2) RETURNING id`,
      [key, `er-b${key}-${sfx}@test.local`])).rows[0].id;
    const A = await borrower('A');
    const B = await borrower('B');

    const mkEntity = async (borrowerId, name, verified) => (await db.query(
      `INSERT INTO llcs (borrower_id, llc_name, is_verified) VALUES ($1,$2,$3) RETURNING id`,
      [borrowerId, name, !!verified])).rows[0].id;

    // ---- E1: sole-owner of A, verified, vesting on a file, with a slot+member+doc.
    const e1 = await mkEntity(A, `Alpha Holdings ${sfx} LLC`, true);
    const app1 = (await db.query(
      `INSERT INTO applications (borrower_id, llc_id, status, ys_loan_number)
       VALUES ($1,$2,'file_intake',$3) RETURNING id`, [A, e1, `ERX-${sfx}`])).rows[0].id;
    const slot1 = (await db.query(
      `INSERT INTO checklist_items (scope, llc_id, label, status) VALUES ('llc',$1,'Operating agreement','outstanding') RETURNING id`,
      [e1])).rows[0].id;
    const mem1 = (await db.query(
      `INSERT INTO llc_members (llc_id, full_name, ownership_pct) VALUES ($1,'Jane Owner',50) RETURNING id`, [e1])).rows[0].id;
    const doc1 = (await db.query(
      `INSERT INTO documents (borrower_id, llc_id, filename, storage_provider, storage_ref, uploaded_by_kind, is_current)
       VALUES ($1,$2,'oa.pdf','local','er-ref-1',$3,true) RETURNING id`, [A, e1, 'staff'])).rows[0].id;
    // A SET-NULL back-reference (a row that POINTS AT e1 from another table) — must
    // be captured in the snapshot for recovery AND unhooked by the delete (LOW-2).
    const tixKey = `er-tix-${sfx}`;
    await db.query(`INSERT INTO clickup_task_index (task_id, llc_id) VALUES ($1,$2)`, [tixKey, e1]);

    // ---- E2: primary A, co-owned by B (llc_borrowers) → transfer case.
    const e2 = await mkEntity(A, `Beta Holdings ${sfx} LLC`, false);
    await db.query(`INSERT INTO llc_borrowers (llc_id, borrower_id) VALUES ($1,$2)`, [e2, A]);
    await db.query(`INSERT INTO llc_borrowers (llc_id, borrower_id) VALUES ($1,$2)`, [e2, B]);

    // 1) The super_admin gate — a loan officer is refused on both doors.
    const loPrev = await call(server, 'GET', `/api/staff/borrowers/${A}/llcs/${e1}/removal-preview`, loT);
    ok(loPrev.status === 403, `a loan officer cannot preview a removal (got ${loPrev.status})`);
    const loRem = await call(server, 'POST', `/api/staff/borrowers/${A}/llcs/${e1}/remove`, loT, { reason: 'x' });
    ok(loRem.status === 403, `a loan officer cannot remove an entity (got ${loRem.status})`);
    // …and nothing happened.
    ok((await db.query(`SELECT 1 FROM llcs WHERE id=$1`, [e1])).rowCount === 1, 'the entity is untouched after the refused attempts');

    // 2) The preview names the consequences.
    const prev = await call(server, 'GET', `/api/staff/borrowers/${A}/llcs/${e1}/removal-preview`, superT);
    ok(prev.status === 200 && prev.body.action === 'deleted', 'preview: a sole-owner entity would be DELETED');
    const codes = (prev.body.warnings || []).map((w) => w.code);
    ok(codes.includes('verified'), 'preview warns it is verified');
    ok(codes.includes('vesting_live'), 'preview warns it vests a live file');
    ok(codes.includes('documents'), 'preview warns documents will be removed');
    ok(prev.body.vesting && prev.body.vesting.some((v) => String(v.id) === String(app1)), 'preview lists the vesting file');

    // 3) A removal with no reason is refused.
    const noReason = await call(server, 'POST', `/api/staff/borrowers/${A}/llcs/${e1}/remove`, superT, {});
    ok(noReason.status >= 400 && noReason.status < 500, `no reason → refused (got ${noReason.status})`);
    ok((await db.query(`SELECT 1 FROM llcs WHERE id=$1`, [e1])).rowCount === 1, 'still there after the no-reason attempt');

    // 4) The DELETE.
    const del = await call(server, 'POST', `/api/staff/borrowers/${A}/llcs/${e1}/remove`, superT, { reason: 'Added to the wrong borrower by mistake' });
    ok(del.status === 200 && del.body.action === 'deleted', `super_admin deletes the sole-owner entity (got ${del.status})`);
    ok((await db.query(`SELECT 1 FROM llcs WHERE id=$1`, [e1])).rowCount === 0, 'the entity row is gone');
    ok((await db.query(`SELECT 1 FROM checklist_items WHERE id=$1`, [slot1])).rowCount === 0, 'its document slot cascaded away');
    ok((await db.query(`SELECT 1 FROM documents WHERE id=$1`, [doc1])).rowCount === 0, 'its document cascaded away');
    ok((await db.query(`SELECT 1 FROM llc_members WHERE id=$1`, [mem1])).rowCount === 0, 'its member cascaded away');
    const app1After = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [app1])).rows[0];
    ok(app1After && app1After.llc_id === null, 'the file it vested was un-vested (llc_id SET NULL)');
    const snap = (await db.query(`SELECT * FROM entity_removals WHERE llc_id=$1`, [e1])).rows[0];
    ok(snap && snap.action === 'deleted' && snap.reason.length > 0, 'a snapshot row was written with the reason');
    ok(snap && snap.entity_snapshot && snap.entity_snapshot.entity && snap.entity_snapshot.entity.llc_name,
      'the snapshot captured the entity row for recovery');
    ok(snap && snap.affected && snap.affected.backReferences
      && (snap.affected.backReferences.clickupTaskIndex || []).includes(tixKey),
      'the snapshot records the SET-NULL back-references for recovery (LOW-2)');
    const tixAfter = (await db.query(`SELECT llc_id FROM clickup_task_index WHERE task_id=$1`, [tixKey])).rows[0];
    ok(tixAfter && tixAfter.llc_id === null, 'the back-referencing row was unhooked (llc_id SET NULL), not deleted');
    ok((await db.query(
      `SELECT 1 FROM audit_log WHERE action='entity_removed_from_profile' AND entity_id=$1`, [e1])).rowCount === 1,
      'the removal was audited');

    // 5) The TRANSFER — a co-owned entity survives and moves off THIS profile.
    const prev2 = await call(server, 'GET', `/api/staff/borrowers/${A}/llcs/${e2}/removal-preview`, superT);
    ok(prev2.status === 200 && prev2.body.action === 'transferred', 'preview: a co-owned entity would be TRANSFERRED');
    ok(prev2.body.transferTo && String(prev2.body.transferTo.id) === String(B), 'preview names the owner it moves to');
    const xfer = await call(server, 'POST', `/api/staff/borrowers/${A}/llcs/${e2}/remove`, superT, { reason: 'Belongs on the co-borrower profile' });
    ok(xfer.status === 200 && xfer.body.action === 'transferred', 'the co-owned entity is transferred, not deleted');
    const e2row = (await db.query(`SELECT borrower_id FROM llcs WHERE id=$1`, [e2])).rows[0];
    ok(e2row && String(e2row.borrower_id) === String(B), 'the entity survives and its primary pointer moved to B');
    ok((await db.query(`SELECT 1 FROM llc_borrowers WHERE llc_id=$1 AND borrower_id=$2`, [e2, A])).rowCount === 0,
      'A\'s ownership link was dropped');

    // 6) An entity not on this profile is refused (E2 is now B's, so removing it "from A" is 409).
    const wrong = await call(server, 'POST', `/api/staff/borrowers/${A}/llcs/${e2}/remove`, superT, { reason: 'x' });
    ok(wrong.status === 409, `removing an entity that is not on this profile → 409 (got ${wrong.status})`);
  } catch (e) {
    fail++; console.log('FAIL threw', e && e.stack || e);
  } finally {
    // Cleanup: entities cascade from borrowers; entity_removals has no FK in, so clear it explicitly.
    await db.query(`DELETE FROM clickup_task_index WHERE task_id LIKE $1`, [`er-tix-%${sfx}`]).catch(() => {});
    await db.query(`DELETE FROM entity_removals WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [`er-b%-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE borrower_id IN (SELECT id FROM borrowers WHERE email LIKE $1)`, [`er-b%-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE email LIKE $1`, [`er-b%-${sfx}@test.local`]).catch(() => {});
    await db.query(`DELETE FROM audit_log WHERE actor_id IN (SELECT id FROM staff_users WHERE email LIKE $1)`, [like]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [like]).catch(() => {});
    server.close();
    await db.pool.end().catch(() => {});
  }

  console.log(`test-entity-remove-route-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
