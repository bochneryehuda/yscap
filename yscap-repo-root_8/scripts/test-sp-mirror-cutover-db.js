'use strict';
/* DB-gated tests for the Phase-4 cutover drain (src/lib/sp-mirror-queue.js
 * drainClaimed). The real byte upload (mirrorRow) is STUBBED — this proves the
 * claim → mirror → persist wiring maps outcomes to the right terminal/retry state:
 * success → DONE (+backed_up_at), transient → FAILED+backoff (DEAD at cap),
 * permanent-at-cap → DEAD, throttle → PENDING without consuming the retry budget,
 * and a vanished row → DEAD(document_gone). Nothing here touches SharePoint.
 * Run: DATABASE_URL=... node scripts/test-sp-mirror-cutover-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-mirror-cutover-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const backup = require('../src/lib/sharepoint-backup');
const q = require('../src/lib/sp-mirror-queue');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
let APP, BOR;
const realMirrorRow = backup.mirrorRow;

async function seed({ status = 'PENDING', attempts = 0 } = {}) {
  const r = await db.query(
    `INSERT INTO documents (filename, storage_provider, storage_ref, size_bytes, sha256, application_id,
        sharepoint_backup_attempts, sharepoint_mirror_status, created_at)
     VALUES ($1,'local',$2,10,$3,$4,$5,$6, now() - interval '6 hours') RETURNING id`,
    [`cut_${Math.random().toString(36).slice(2)}.pdf`, `s/${Math.random()}`, 'a'.repeat(64), APP, attempts, status]);
  return r.rows[0].id;
}
const st = async (id) => (await db.query(
  `SELECT sharepoint_mirror_status s, sharepoint_backup_attempts a, sharepoint_dead_reason d,
          sharepoint_next_attempt_at na, sharepoint_backed_up_at b, sharepoint_locked_by lb
     FROM documents WHERE id=$1`, [id])).rows[0];

(async () => {
  BOR = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('C','U',$1) RETURNING id`,
    [`cut_${process.pid}@example.test`])).rows[0].id;
  APP = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [BOR])).rows[0].id;

  // ---- 1. success → DONE ----------------------------------------------------
  backup.mirrorRow = async () => ({ ok: true });               // stub: upload succeeds
  const okDoc = await seed({ status: 'PENDING' });
  const r1 = await q.drainClaimed(50, { holder: 'D1' });
  assert.ok(r1.claimed >= 1 && r1.mirrored >= 1, 'drain claimed and mirrored at least one');
  const a1 = await st(okDoc);
  assert.strictEqual(a1.s, 'DONE'); assert.ok(a1.b, 'backed_up_at stamped'); assert.strictEqual(a1.lb, null, 'lease released');
  ok('drainClaimed: a successful mirror → DONE (+backed_up_at, lease released)');

  // ---- 2. transient failure → FAILED + backoff, DEAD at the cap --------------
  backup.mirrorRow = async () => { const e = new Error('graph 503'); e.status = 503; throw e; };
  const tDoc = await seed({ status: 'PENDING' });
  await q.drainClaimed(50, { holder: 'D2' });
  const a2 = await st(tDoc);
  assert.strictEqual(a2.s, 'FAILED'); assert.ok(new Date(a2.na) > new Date(), 'backoff scheduled');
  ok('drainClaimed: a transient (503) mirror failure → FAILED with a future next_attempt_at');

  const tCap = await seed({ status: 'FAILED', attempts: 7 });   // claim → attempts 8 = cap
  await q.drainClaimed(50, { holder: 'D2b' });
  const a2b = await st(tCap);
  assert.strictEqual(a2b.s, 'DEAD'); assert.strictEqual(a2b.d, 'transient_exhausted');
  ok('drainClaimed: a transient failure at the attempt cap → DEAD(transient_exhausted)');

  // ---- 3. permanent at cap → DEAD -------------------------------------------
  backup.mirrorRow = async () => { const e = new Error('bad request'); e.status = 400; throw e; };
  const pDoc = await seed({ status: 'FAILED', attempts: 7 });
  await q.drainClaimed(50, { holder: 'D3' });
  const a3 = await st(pDoc);
  assert.strictEqual(a3.s, 'DEAD'); assert.ok(/permanent_http_400|transient_exhausted/.test(a3.d), 'DEAD with a recorded reason');
  ok('drainClaimed: a permanent (400) failure at the cap → DEAD');

  // ---- 4. throttle storm → PENDING, NEVER consumes the budget or dead-letters -
  backup.mirrorRow = async () => { const e = new Error('too many requests'); e.status = 429; throw e; };
  const thDoc = await seed({ status: 'PENDING', attempts: 0 });
  for (let i = 0; i < 12; i++) {                              // simulate a sustained throttling episode
    await q.drainClaimed(50, { holder: 'D4' });
    await db.query(`UPDATE documents SET sharepoint_next_attempt_at=now() WHERE id=$1 AND sharepoint_mirror_status='PENDING'`, [thDoc]);
  }
  const a4 = await st(thDoc);
  assert.strictEqual(a4.s, 'PENDING', 'still PENDING after 12 throttles — a rate-limited doc is NEVER dead-lettered');
  assert.ok(Number(a4.a) <= 1, `a throttle does not consume the retry budget (attempts stayed ${a4.a}, not climbing to the cap)`);
  ok('drainClaimed: a throttle storm never consumes the budget or dead-letters a good document');

  // ---- 4b. a THROWN DB error while loading the row is retryable, not gone -----
  backup.mirrorRow = async () => ({ ok: true });
  const realEnrich2 = backup.enrichedRowById;
  const blipDoc = await seed({ status: 'PENDING' });
  backup.enrichedRowById = async (id) => { if (String(id) === String(blipDoc)) throw new Error('ECONNRESET'); return realEnrich2(id); };
  await q.drainClaimed(50, { holder: 'D4b' });
  backup.enrichedRowById = realEnrich2;
  const a4b = await st(blipDoc);
  assert.strictEqual(a4b.s, 'FAILED', 'a transient enrich error → FAILED (retryable)');
  assert.notStrictEqual(a4b.d, 'document_gone', 'a DB blip is NOT misclassified as a permanent document_gone dead-letter');
  ok('drainClaimed: a thrown DB error loading a doc is retryable, not a permanent dead-letter');

  // ---- 5. vanished row → DEAD(document_gone) ---------------------------------
  backup.mirrorRow = async () => ({ ok: true });
  const goneDoc = await seed({ status: 'PENDING' });
  // delete it AFTER claim by stubbing enrichedRowById to return null for it
  const realEnrich = backup.enrichedRowById;
  backup.enrichedRowById = async (id) => (String(id) === String(goneDoc) ? null : realEnrich(id));
  await q.drainClaimed(50, { holder: 'D5' });
  backup.enrichedRowById = realEnrich;
  const a5 = await st(goneDoc);
  assert.strictEqual(a5.s, 'DEAD'); assert.strictEqual(a5.d, 'document_gone');
  ok('drainClaimed: a row that vanished mid-flight → DEAD(document_gone), never a silent stall');

  backup.mirrorRow = realMirrorRow;
  await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]);
  console.log(`\nAll ${n} cutover-drain checks passed.`);
  process.exit(0);
})().catch(async (e) => {
  backup.mirrorRow = realMirrorRow;
  console.error('FAIL', e && e.message, e && e.stack);
  try { if (APP) { await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]); await db.query(`DELETE FROM applications WHERE id=$1`, [APP]); } if (BOR) await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]); } catch (_) {}
  process.exit(1);
});
