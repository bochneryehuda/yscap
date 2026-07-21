'use strict';
/* End-to-end lifecycle test for the SharePoint mirror state machine (all phases).
 * Exercises the OWNER-FACING go-live control and the full document lifecycle in one
 * run against a live Postgres, with the Graph upload (mirrorRow) stubbed:
 *   1. the admin go-live toggle: DB-backed flags drive fsmMode off→shadow→on→off
 *      (instant rollback), default off with no override.
 *   2. a full 'on' pass via fsmPass: PENDING docs are claimed + mirrored → DONE;
 *      a permanently-failing doc → DEAD and is carded into Sync review; requeuing
 *      it from the dead-letter puts it back to PENDING and it then mirrors → DONE.
 * Run: DATABASE_URL=... node scripts/test-sp-mirror-e2e-lifecycle-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-mirror-e2e-lifecycle-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const flags = require('../src/lib/flags');
const backup = require('../src/lib/sharepoint-backup');
const q = require('../src/lib/sp-mirror-queue');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let APP, BOR;
const realMirrorRow = backup.mirrorRow;
const st = async (id) => (await db.query(`SELECT sharepoint_mirror_status s, sharepoint_backed_up_at b FROM documents WHERE id=$1`, [id])).rows[0];
const openCard = async (id) => (await db.query(
  `SELECT count(*)::int c FROM sync_review_queue WHERE task_id=$1 AND field_key='sharepoint_doc' AND status='open'`, [`spdoc:${id}`])).rows[0].c;
async function seed() {
  const r = await db.query(
    `INSERT INTO documents (filename, storage_provider, storage_ref, size_bytes, sha256, application_id,
        sharepoint_mirror_status, created_at)
     VALUES ($1,'local',$2,10,$3,$4,'PENDING', now() - interval '6 hours') RETURNING id`,
    [`e2e_${Math.random().toString(36).slice(2)}.pdf`, `s/${Math.random()}`, 'a'.repeat(64), APP]);
  return r.rows[0].id;
}

(async () => {
  await flags.clearFlag('SHAREPOINT_MIRROR_FSM_ON').catch(() => {});
  await flags.clearFlag('SHAREPOINT_MIRROR_FSM_SHADOW').catch(() => {});
  await flags.refresh();
  BOR = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('E','2',$1) RETURNING id`, [`e2e_${process.pid}@example.test`])).rows[0].id;
  APP = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [BOR])).rows[0].id;

  // ---- 1. the go-live toggle (instant rollback control) ----------------------
  delete process.env.SHAREPOINT_MIRROR_FSM;
  assert.strictEqual(q.fsmMode(), 'off', 'default with no override + no env is off');
  await flags.setFlag('SHAREPOINT_MIRROR_FSM_SHADOW', true, null, 'e2e'); await flags.refresh();
  assert.strictEqual(q.fsmMode(), 'shadow', 'flipping WATCH-ONLY on → shadow');
  await flags.setFlag('SHAREPOINT_MIRROR_FSM_ON', true, null, 'e2e'); await flags.refresh();
  assert.strictEqual(q.fsmMode(), 'on', 'flipping LIVE on → on (takes precedence)');
  await flags.setFlag('SHAREPOINT_MIRROR_FSM_ON', false, null, 'e2e'); await flags.refresh();
  assert.strictEqual(q.fsmMode(), 'shadow', 'rollback: LIVE off → back to shadow');
  await flags.setFlag('SHAREPOINT_MIRROR_FSM_SHADOW', false, null, 'e2e'); await flags.refresh();
  assert.strictEqual(q.fsmMode(), 'off', 'rollback: WATCH-ONLY off → off (fully rolled back, instantly)');
  ok('go-live toggle: admin flags drive off→shadow→on and roll back instantly, default off');

  // ---- 2. full 'on' lifecycle: good docs mirror, a bad doc dead-letters+cards -
  const good1 = await seed(), good2 = await seed(), bad = await seed();
  backup.mirrorRow = async (row) => {
    if (String(row.id) === String(bad)) { const e = new Error('permanent: bad request'); e.status = 400; throw e; }
    return { ok: true };
  };
  // go live
  await flags.setFlag('SHAREPOINT_MIRROR_FSM_ON', true, null, 'e2e'); await flags.refresh();
  assert.strictEqual(q.fsmMode(), 'on');
  // drive passes until the bad doc exhausts to DEAD (permanent needs confirmations + cap)
  for (let i = 0; i < 10; i++) {
    await q.fsmPass();
    await db.query(`UPDATE documents SET sharepoint_next_attempt_at=now() WHERE sharepoint_mirror_status IN ('PENDING','FAILED')`);
  }
  assert.strictEqual((await st(good1)).s, 'DONE', 'good doc 1 mirrored → DONE');
  assert.strictEqual((await st(good2)).s, 'DONE', 'good doc 2 mirrored → DONE');
  assert.ok((await st(good1)).b && (await st(good2)).b, 'DONE docs carry backed_up_at');
  const badSt = await st(bad);
  assert.strictEqual(badSt.s, 'DEAD', 'the permanently-failing doc → DEAD (dead-letter)');
  assert.strictEqual(await openCard(bad), 1, 'the dead-letter doc is carded into Sync review for a human');
  ok('on-lifecycle: good docs mirror to DONE; a permanent failure dead-letters and is carded for manual review');

  // ---- 3. requeue the dead-letter → it retries and (now succeeding) mirrors ---
  backup.mirrorRow = async () => ({ ok: true });               // the cause is "fixed"
  const requeued = await q.requeueDead(bad);
  assert.ok(requeued, 'requeueDead returned the row');
  assert.strictEqual((await st(bad)).s, 'PENDING', 'requeued dead-letter → PENDING');
  for (let i = 0; i < 3; i++) { await q.fsmPass(); await db.query(`UPDATE documents SET sharepoint_next_attempt_at=now() WHERE sharepoint_mirror_status IN ('PENDING','FAILED')`); }
  assert.strictEqual((await st(bad)).s, 'DONE', 'after requeue + fix, the doc mirrors → DONE');
  ok('requeue: a dead-letter doc requeued from admin retries and mirrors once the cause is fixed');

  // ---- 4. health snapshot reflects the finished state ------------------------
  const snap = await q.healthSnapshot();
  assert.ok(snap.done >= 3, `health shows the mirrored docs (done=${snap.done})`);
  ok('health snapshot reflects the completed lifecycle');

  // cleanup
  await flags.clearFlag('SHAREPOINT_MIRROR_FSM_ON').catch(() => {});
  await flags.clearFlag('SHAREPOINT_MIRROR_FSM_SHADOW').catch(() => {});
  backup.mirrorRow = realMirrorRow;
  await db.query(`DELETE FROM sync_review_queue WHERE task_id LIKE 'spdoc:%' AND task_id IN (SELECT 'spdoc:'||id FROM documents WHERE application_id=$1)`, [APP]).catch(() => {});
  await db.query(`DELETE FROM sync_locks WHERE lock_key='sp-fsm-dead-alert'`).catch(() => {});
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]);
  console.log(`\nAll ${n} end-to-end lifecycle checks passed.`);
  process.exit(0);
})().catch(async (e) => {
  backup.mirrorRow = realMirrorRow;
  try { await flags.clearFlag('SHAREPOINT_MIRROR_FSM_ON'); await flags.clearFlag('SHAREPOINT_MIRROR_FSM_SHADOW'); } catch (_) {}
  console.error('FAIL', e && e.message, e && e.stack);
  try { if (APP) { await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]); await db.query(`DELETE FROM applications WHERE id=$1`, [APP]); } if (BOR) await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]); } catch (_) {}
  process.exit(1);
});
