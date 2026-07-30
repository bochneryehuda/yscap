/**
 * The inbound portal-edit guard, end to end against a real Postgres
 * (owner-directed 2026-07-28: a change you make must never silently bounce back;
 * a real two-sided conflict must go to manual review, never a silent overwrite).
 *
 * Proves:
 *   A. STALE ClickUp (only the file changed): the guard KEEPS the file's value
 *      (strips it from the inbound UPDATE `cols`) and does NOT raise a review.
 *   B. TWO-SIDED conflict (both changed): the guard KEEPS the file's value AND
 *      parks a `portal_edit_conflict` review naming both values.
 *   C. Resolve "Keep the PILOT value": returns a plain outcome (and enqueues a
 *      re-push when the sync is on).
 *   D. Resolve "Use ClickUp's value": applies ClickUp's value onto the file
 *      (offline via the row's stored diffs — no live ClickUp needed).
 *
 * Requires DATABASE_URL; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-portal-edit-guard-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const db = require('../src/db');
const guard = require('../src/lib/inbound-portal-edit-guard');
const fileReview = require('../src/lib/sync-file-review');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

async function mkApp(borrowerId, taskId, cols) {
  const c = Object.assign({ loan_type: null, program: null, purchase_price: null }, cols);
  return (await db.query(
    `INSERT INTO applications (borrower_id, status, loan_type, program, purchase_price, clickup_pipeline_task_id, property_address)
     VALUES ($1,'underwriting',$2,$3,$4,$5,'{"line1":"1 A St","city":"Newark","state":"NJ","zip":"07102"}'::jsonb)
     RETURNING id`, [borrowerId, c.loan_type, c.program, c.purchase_price, taskId])).rows[0].id;
}
async function mkSnapshot(taskId, borrowerId, appId, appFields) {
  await db.query(
    `INSERT INTO clickup_task_index (task_id, kind, borrower_id, application_id, match_status, snapshot, snapshot_at, last_seen)
     VALUES ($1,'rtl_file',$2,$3,'linked',$4,now(),now())
     ON CONFLICT (task_id) DO UPDATE SET snapshot=EXCLUDED.snapshot, snapshot_at=now()`,
    [taskId, borrowerId, appId, JSON.stringify({ app: appFields })]);
}
const openReview = async (appId, reason) => (await db.query(
  `SELECT * FROM sync_review_queue WHERE application_id=$1 AND reason=$2 AND status='open' ORDER BY id DESC LIMIT 1`,
  [appId, reason])).rows[0];

(async () => {
  const sfx = `${process.pid}-${Math.floor(Math.random() * 1e6)}`;
  const borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Guard','Test',$1) RETURNING id`,
    [`peg-${sfx}@test.local`])).rows[0].id;
  const staffId = (await db.query(
    `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
     VALUES ($1,'Owner','super_admin',true,false,'x',0) RETURNING id`, [`peg-staff-${sfx}@test.local`])).rows[0].id;
  try {
    // ---- A. STALE ClickUp: only the file changed (loan_type edited to Fix & Hold;
    // ClickUp still shows the old Fix & Flip). The pull carries the stale value.
    const taskA = `peg-A-${sfx}`;
    const appA = await mkApp(borrowerId, taskA, { loan_type: 'Fix & Hold' });
    await mkSnapshot(taskA, borrowerId, appA, { loan_type: 'Fix & Flip' });   // last-seen ClickUp
    const colsA = { loan_type: 'Fix & Flip', purchase_price: null };          // incoming (stale)
    const outA = await guard.applyInboundPortalEditGuard({ appId: appA, cols: colsA, taskId: taskA, borrowerId });
    assert(colsA.loan_type === null, 'A: the file\'s edited loan_type is KEPT (stripped from the inbound UPDATE)');
    assert(Array.isArray(outA.kept) && outA.kept.includes('loan_type'), 'A: the guard reports it kept loan_type');
    assert(!(await openReview(appA, 'portal_edit_conflict')), 'A: no review is raised for a stale-ClickUp keep (silent self-heal)');

    // ---- B. TWO-SIDED conflict: the file changed program to Fix & Hold, and
    // ClickUp changed it to a DIFFERENT value (Bridge). Keep ours + review.
    const taskB = `peg-B-${sfx}`;
    const appB = await mkApp(borrowerId, taskB, { program: 'Fix & Hold' });
    await mkSnapshot(taskB, borrowerId, appB, { program: 'Fix & Flip' });     // last-seen ClickUp
    const colsB = { program: 'Bridge' };                                      // incoming (independently changed)
    await guard.applyInboundPortalEditGuard({ appId: appB, cols: colsB, taskId: taskB, borrowerId });
    assert(colsB.program === null, 'B: the file\'s program is KEPT (stripped) on a two-sided conflict');
    const revB = await openReview(appB, 'portal_edit_conflict');
    assert(!!revB, 'B: a portal_edit_conflict review is parked');
    assert(revB && /Program: Bridge/.test(revB.clickup_value || '') && /Program: Fix & Hold/.test(revB.portal_value || ''),
      'B: the review names ClickUp\'s value AND the file\'s value');

    // ---- C. Resolve "Keep the PILOT value" — returns an outcome, doesn't throw.
    const resC = await fileReview.applyFileReviewAction({
      row: revB, action: 'keep_portal_value', actorId: staffId, isAdmin: true });
    assert(resC && /kept the file's value/.test(resC.note || ''), 'C: keep_portal_value returns a plain outcome');

    // ---- D. Resolve "Use ClickUp's value" — applies ClickUp's value offline.
    // A file with NO ClickUp task id + a null-task review row makes the accept use
    // the row's stored diffs (no live ClickUp call). Use purchase_price (no enum
    // sanitizer) so the applied value is unambiguous.
    const appD = await mkApp(borrowerId, null, { purchase_price: 400000 });
    const revD = (await db.query(
      `INSERT INTO sync_review_queue (application_id, borrower_id, task_id, direction, field_key, reason,
          clickup_value, portal_value, raw_value, source, status)
       VALUES ($1,$2,NULL,'inbound','portal_edit_conflict','portal_edit_conflict',
          'Purchase price: 450000','Purchase price: 400000',$3,'clickup','open') RETURNING *`,
      [appD, borrowerId, JSON.stringify({ changes: [{ field: 'purchase_price', label: 'Purchase price', from: '400000', to: '450000' }] })])).rows[0];
    const resD = await fileReview.applyFileReviewAction({
      row: revD, action: 'accept_clickup_value', actorId: staffId, isAdmin: true });
    const ppD = (await db.query(`SELECT purchase_price FROM applications WHERE id=$1`, [appD])).rows[0];
    assert(Number(ppD.purchase_price) === 450000, `D: accept_clickup_value put ClickUp's 450000 on the file (got ${ppD && ppD.purchase_price})`);
    assert(resD && /updated the file from ClickUp/.test(resD.note || ''), 'D: accept_clickup_value returns a plain outcome');

    // cleanup
    await db.query(`DELETE FROM sync_review_queue WHERE application_id = ANY($1::uuid[])`, [[appA, appB, appD]]).catch(() => {});
    await db.query(`DELETE FROM clickup_task_index WHERE task_id = ANY($1)`, [[taskA, taskB]]).catch(() => {});
    await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [borrowerId]).catch(() => {});
    await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]).catch(() => {});
    await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
  } catch (e) {
    console.error('FAIL unexpected error:', e && e.stack || e);
    failures++;
  } finally {
    await db.pool.end().catch(() => {});
  }
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
  process.exit(failures ? 1 : 0);
})();
