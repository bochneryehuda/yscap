'use strict';
/* DB-gated tests for the SharePoint mirror observability + dead-letter surface
 * (Phase 3, src/lib/sp-mirror-queue.js). Proves the health snapshot counts, the
 * dead-letter/expired-lease lists, the fenced DEAD->PENDING requeue, the
 * OWNER-REQUIRED "every dead-letter doc gets a Sync-review card" guarantee
 * (idempotent, feeds the same sync_review_queue surface, skips docs already
 * carded), and the deduped dead-letter alert.
 * Run: DATABASE_URL=... node scripts/test-sp-mirror-observability-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-mirror-observability-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const q = require('../src/lib/sp-mirror-queue');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let APP, BOR;

async function seed({ status = 'PENDING', attempts = 0, dead = null, lease = null, backedUp = false, ageHours = 5 } = {}) {
  const r = await db.query(
    `INSERT INTO documents (filename, storage_provider, storage_ref, size_bytes, sha256, application_id,
        sharepoint_backup_attempts, sharepoint_mirror_status, sharepoint_dead_reason,
        sharepoint_lease_expires_at, sharepoint_backed_up_at, sharepoint_backup_error, created_at)
     VALUES ($1,'local',$2,10,$3,$4,$5,$6,$7,$8,$9,$10, now() - ($11 || ' hours')::interval) RETURNING id`,
    [`obs_${Math.random().toString(36).slice(2)}.pdf`, `s/${Math.random()}`, 'a'.repeat(64), APP,
     attempts, status, dead, lease, backedUp ? new Date() : null,
     status === 'DEAD' ? 'permanent: bad request' : null, String(ageHours)]);
  return r.rows[0].id;
}
const openCard = async (id) => (await db.query(
  `SELECT count(*)::int c FROM sync_review_queue WHERE task_id=$1 AND field_key='sharepoint_doc' AND status='open'`,
  [`spdoc:${id}`])).rows[0].c;

(async () => {
  BOR = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('O','B',$1) RETURNING id`,
    [`obs_${process.pid}@example.test`])).rows[0].id;
  APP = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [BOR])).rows[0].id;

  // ---- 1. health snapshot counts per state ----------------------------------
  await seed({ status: 'PENDING' });
  await seed({ status: 'FAILED', attempts: 3 });
  await seed({ status: 'DONE', backedUp: true });
  await seed({ status: 'DONE', backedUp: true });
  const dead1 = await seed({ status: 'DEAD', attempts: 8, ageHours: 20 });
  await seed({ status: 'SKIPPED' });
  const orphan = await seed({ status: 'IN_PROGRESS', attempts: 1, lease: new Date(Date.now() - 60000) }); // expired lease

  const snap = await q.healthSnapshot();
  assert.ok(snap.pending >= 1 && snap.failed >= 1 && snap.done >= 2 && snap.dead >= 1 && snap.skipped >= 1,
    `per-state counts populated: ${JSON.stringify(snap)}`);
  assert.ok(snap.orphaned_leases >= 1, 'orphaned (expired) lease counted');
  assert.ok(snap.oldest_claimable_secs >= 0 && snap.max_attempts >= 3, 'oldest-claimable + attempt distribution present');
  ok('healthSnapshot returns per-state counts, orphaned-lease count, oldest-claimable age, attempt max');

  // ---- 2. dead-letter + expired-lease lists ---------------------------------
  const dl = await q.deadLetterList(100);
  assert.ok(dl.some((r) => String(r.id) === String(dead1)), 'dead-letter list includes the DEAD doc');
  assert.ok(dl.every((r) => 'dead_reason' in r && 'attempts' in r), 'dead-letter rows carry reason + attempts');
  const el = await q.expiredLeaseList(100);
  assert.ok(el.some((r) => String(r.id) === String(orphan)), 'expired-lease list includes the orphaned IN_PROGRESS doc');
  ok('deadLetterList and expiredLeaseList surface the page-worthy rows with context');

  // ---- 3. every DEAD doc gets a Sync-review card (OWNER REQUIREMENT) ---------
  assert.strictEqual(await openCard(dead1), 0, 'no card yet');
  const carded = await q.cardDeadLetter();
  assert.ok(carded >= 1, 'cardDeadLetter opened at least one card');
  assert.strictEqual(await openCard(dead1), 1, 'the DEAD doc now has exactly one open Sync-review card');
  // idempotent: a second pass opens no new card (queueReview dedups per doc)
  const carded2 = await q.cardDeadLetter();
  assert.strictEqual(await openCard(dead1), 1, 'still exactly one card after a second pass (idempotent)');
  assert.ok(!carded2 || carded2 === 0, 'no duplicate cards on re-run');
  ok('cardDeadLetter cards EVERY dead-letter doc into Sync review (manual-review preserved), idempotently');

  // ---- 4. requeue is fenced to DEAD and re-arms legacy columns --------------
  const notDead = await seed({ status: 'FAILED', attempts: 3 });
  assert.strictEqual(await q.requeueDead(notDead), null, 'requeue refuses a non-DEAD row');
  const requeued = await q.requeueDead(dead1);
  assert.ok(requeued && String(requeued.id) === String(dead1), 'requeue returns the DEAD row');
  const after = (await db.query(
    `SELECT sharepoint_mirror_status s, sharepoint_backup_attempts a, sharepoint_dead_reason d,
            sharepoint_backup_error e FROM documents WHERE id=$1`, [dead1])).rows[0];
  assert.strictEqual(after.s, 'PENDING'); assert.strictEqual(Number(after.a), 0);
  assert.strictEqual(after.d, null); assert.strictEqual(after.e, null);
  ok('requeueDead: DEAD -> PENDING, resets attempts + clears dead_reason/error, refuses non-DEAD (fenced)');

  // ---- 5. deduped dead-letter alert ------------------------------------------
  await db.query(`DELETE FROM sync_locks WHERE lock_key='sp-fsm-dead-alert'`).catch(() => {});
  const a1 = await q.checkDeadLetterAlert();     // dead>=? there's still `orphan` + any DEAD
  // ensure at least one dead exists for a deterministic alert
  const deadX = await seed({ status: 'DEAD', attempts: 8 });
  await db.query(`DELETE FROM sync_locks WHERE lock_key='sp-fsm-dead-alert'`).catch(() => {});
  const b1 = await q.checkDeadLetterAlert();
  assert.strictEqual(b1.alerted, true, 'first alert of an episode fires');
  const b2 = await q.checkDeadLetterAlert();
  assert.strictEqual(b2.alerted, false, 'same episode does not re-alert (deduped, restart-proof)');
  ok('checkDeadLetterAlert fires once per dead-letter episode and dedups thereafter');
  void a1; void deadX;

  await db.query(`DELETE FROM sync_review_queue WHERE task_id LIKE 'spdoc:%' AND task_id IN (SELECT 'spdoc:'||id FROM documents WHERE application_id=$1)`, [APP]).catch(() => {});
  await db.query(`DELETE FROM sync_locks WHERE lock_key='sp-fsm-dead-alert'`).catch(() => {});
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]);
  console.log(`\nAll ${n} mirror-observability checks passed.`);
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL', e && e.message, e && e.stack);
  try { if (APP) { await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]); await db.query(`DELETE FROM applications WHERE id=$1`, [APP]); } if (BOR) await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]); } catch (_) {}
  process.exit(1);
});
