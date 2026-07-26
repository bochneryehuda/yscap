'use strict';
/* DB-gated regression test for the #86 change-request protection (audit G3).
 * A freshly-APPROVED economics change must not be clobbered by a STALE ClickUp
 * pull. The OLD guard compared the approval time to the task's whole-task
 * `date_updated`, so an UNRELATED ClickUp edit (a note/status) bumped that
 * timestamp past the approval and silently dropped the protection. The fix
 * decides staleness by VALUE + our own outbound write journal instead, so an
 * unrelated edit is irrelevant. This test drives the fix's exact query + value
 * comparison against seeded rows. Needs DATABASE_URL; skips cleanly otherwise.
 * Run: DATABASE_URL=... node scripts/test-clickup-cr-protect-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-clickup-cr-protect-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const CR = require('../src/lib/change-requests');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };

// Replica of the fix's decision (src/clickup/ingest.js #86): which present
// governed fields should be PROTECTED (portal value kept) for this pull.
async function protectedFields(appId, cols) {
  const present = CR.GOVERNED_FIELDS.filter((k) => k in cols && cols[k] != null);
  if (!present.length) return [];
  const approved = await db.query(
    `SELECT DISTINCT ON (cr.field) cr.field, cr.new_value
       FROM change_requests cr
      WHERE cr.application_id=$1 AND cr.status='approved' AND cr.field = ANY($2)
        AND NOT EXISTS (
          SELECT 1 FROM clickup_write_log w
           WHERE w.application_id=cr.application_id AND w.field_key=cr.field
             AND w.changed=true AND w.blocked=false AND w.created_at > cr.decided_at)
      ORDER BY cr.field, cr.decided_at DESC`,
    [appId, present]);
  const out = [];
  for (const cr of approved.rows) {
    if (CR.normalizeValue(cr.field, cols[cr.field]) === CR.normalizeValue(cr.field, cr.new_value)) continue;
    out.push(cr.field);
  }
  return out;
}

(async () => {
  // --- seed a throwaway borrower + application + approved change_request ---
  const bor = (await db.query(
    `INSERT INTO borrowers (first_name, last_name, email) VALUES ('CR','Protect',$1) RETURNING id`,
    [`crprotect_${process.pid}@example.test`])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [bor])).rows[0].id;
  // Approved: purchase_price 400000 -> 450000, decided an hour ago.
  await db.query(
    `INSERT INTO change_requests (application_id, field, field_label, old_value, new_value, status, decided_at)
     VALUES ($1,'purchase_price','Purchase price','400000','450000','approved', now() - interval '1 hour')`,
    [app]);

  // 1) THE BUG SCENARIO — stale ClickUp still shows the OLD value; an unrelated
    //    edit would have bumped date_updated, but we don't use it. Must PROTECT.
  let p = await protectedFields(app, { purchase_price: 400000 });
  assert.deepStrictEqual(p, ['purchase_price'], 'stale pull (old value) is protected regardless of task mtime');
  ok('stale ClickUp value (still the pre-approval number) is PROTECTED — the unrelated-edit bug is gone');

  // 2) ClickUp already reflects the approved value → nothing to protect (no-op).
  p = await protectedFields(app, { purchase_price: 450000 });
  assert.deepStrictEqual(p, [], 'a pull that already equals the approved value is not protected');
  ok('once ClickUp shows the approved value, protection stops (no re-push loop)');

  // 3) our outbound push LANDED (write journal) → a later DIFFERENT ClickUp value
  //    is a genuine new edit and must WIN (not protected).
  await db.query(
    `INSERT INTO clickup_write_log (application_id, task_id, field_key, changed, blocked, created_at)
     VALUES ($1,'task-x','purchase_price', true, false, now())`, [app]);
  p = await protectedFields(app, { purchase_price: 500000 });
  assert.deepStrictEqual(p, [], 'after our push landed, a genuine newer ClickUp edit wins');
  ok('after our push is journaled as landed, a genuine later ClickUp edit is NOT blocked');

  // 4) a field with NO approved CR is never touched.
  p = await protectedFields(app, { as_is_value: 123456 });
  assert.deepStrictEqual(p, [], 'a field without an approved change request is not protected');
  ok('fields without an approved change request are never protected');

  // cleanup
  await db.query(`DELETE FROM change_requests WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM clickup_write_log WHERE application_id=$1`, [app]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [app]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bor]);

  console.log(`\nAll ${n} CR-protection checks passed — an approved economics change survives a stale/unrelated ClickUp pull.`);
  process.exit(0);
})().catch((e) => { console.error('FAIL', e && e.message); process.exit(1); });
