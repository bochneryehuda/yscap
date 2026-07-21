'use strict';
/* DB-gated tests for the SharePoint mirror claim-queue (src/lib/sp-mirror-queue.js).
 * Proves: atomic claim (PENDING/FAILED -> IN_PROGRESS, attempts++, lease/holder),
 * exclusion of terminal/pre-settle/superseded-regen/non-local rows, no double-claim,
 * lease reaper (PENDING below cap / DEAD at cap), fenced outcome persistence,
 * dual-write reconcile (and that it never stomps IN_PROGRESS), shadow-compare parity
 * with the legacy pendingBatch, and SQL-derive == JS deriveStatus parity.
 * Run: DATABASE_URL=... node scripts/test-sp-mirror-queue-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-mirror-queue-db (no DATABASE_URL)'); process.exit(0); }

const assert = require('assert');
const db = require('../src/db');
const q = require('../src/lib/sp-mirror-queue');
const state = require('../src/lib/sp-mirror-state');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const has = (rows, id) => rows.some((r) => String(r.id) === String(id));

let APP, BOR;
async function seed({ docKind = null, isCurrent = true, ageHours = 7, provider = 'local',
                      backedUp = false, skipped = null, attempts = 0, status = 'PENDING', ref = true } = {}) {
  const r = await db.query(
    `INSERT INTO documents
       (filename, doc_kind, is_current, storage_provider, storage_ref, size_bytes, sha256,
        application_id, sharepoint_backup_attempts, sharepoint_backed_up_at, sharepoint_skipped_reason,
        sharepoint_mirror_status, created_at)
     VALUES ($1,$2,$3,$4,$5,10,$6,$7,$8,$9,$10,$11, now() - ($12 || ' hours')::interval)
     RETURNING id`,
    [`q_${docKind || 'null'}_${Math.random().toString(36).slice(2)}.pdf`, docKind, isCurrent, provider,
     ref ? `seed/${Math.random().toString(36).slice(2)}` : null, 'a'.repeat(64), APP, attempts,
     backedUp ? new Date() : null, skipped, status, String(ageHours)]);
  return r.rows[0].id;
}

(async () => {
  BOR = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Q','Q',$1) RETURNING id`,
    [`qtest_${process.pid}@example.test`])).rows[0].id;
  APP = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [BOR])).rows[0].id;

  // ---- 1. claim selection: only PENDING/FAILED, gated rows -------------------
  const pending = await seed({ status: 'PENDING' });
  const failed = await seed({ status: 'FAILED', attempts: 2 });
  const done = await seed({ status: 'DONE', backedUp: true });
  const dead = await seed({ status: 'DEAD', attempts: 8 });
  // Realistic settled row: the settle passes stamp BOTH backed_up_at AND
  // skipped_reason (never one without the other), so pendingBatch excludes it.
  const skippedRow = await seed({ status: 'SKIPPED', skipped: 'never mirrored', backedUp: true });
  const presettle = await seed({ status: 'PENDING', ageHours: 0 });            // inside 3s settle window
  const nonlocal = await seed({ status: 'PENDING', provider: 's3' });          // not local bytes
  const noref = await seed({ status: 'PENDING', ref: false });                 // no storage_ref
  const supersededRegen = await seed({ status: 'PENDING', docKind: 'track_record_html', isCurrent: false });
  const exhausted = await seed({ status: 'FAILED', attempts: 8 });             // attempts >= MAX

  const claimed = await q.claimBatch(100, { holder: 'H1' });
  assert.ok(has(claimed, pending) && has(claimed, failed), 'PENDING and FAILED are claimed');
  for (const [id, why] of [[done, 'DONE'], [dead, 'DEAD'], [skippedRow, 'SKIPPED'], [presettle, 'pre-settle'],
                           [nonlocal, 'non-local'], [noref, 'no storage_ref'],
                           [supersededRegen, 'superseded regen'], [exhausted, 'attempts>=MAX']]) {
    assert.ok(!has(claimed, id), `${why} row is NOT claimed`);
  }
  ok('claimBatch claims only gated PENDING/FAILED rows; excludes terminal/pre-settle/non-local/superseded/exhausted');

  // ---- 2. claim mutates the row: IN_PROGRESS + attempts++ + lease + holder ---
  const row = (await db.query(
    `SELECT sharepoint_mirror_status s, sharepoint_backup_attempts a, sharepoint_locked_by lb,
            sharepoint_lease_expires_at lease FROM documents WHERE id=$1`, [pending])).rows[0];
  assert.strictEqual(row.s, 'IN_PROGRESS');
  assert.strictEqual(Number(row.a), 1, 'attempts incremented at claim (0 -> 1)');
  assert.strictEqual(row.lb, 'H1');
  assert.ok(row.lease && new Date(row.lease) > new Date(), 'lease is in the future');
  ok('claim writes IN_PROGRESS + attempts++ + lease + holder BEFORE any external call');

  // ---- 3. no double-claim: a freshly-claimed (unexpired) row is not reclaimed -
  const again = await q.claimBatch(100, { holder: 'H2' });
  assert.ok(!has(again, pending) && !has(again, failed), 'already-claimed rows with live leases are skipped');
  ok('a live-lease IN_PROGRESS row is never double-claimed');

  // ---- 4. lease reaper: expired lease -> PENDING (below cap) / DEAD (at cap) --
  await db.query(`UPDATE documents SET sharepoint_lease_expires_at = now() - interval '1 min' WHERE id IN ($1,$2)`,
    [pending, failed]);
  // push `failed` to the cap so it should DEAD on reclaim
  await db.query(`UPDATE documents SET sharepoint_backup_attempts = 8 WHERE id=$1`, [failed]);
  const reaped = await q.reapExpiredLeases();
  assert.ok(has(reaped, pending) && has(reaped, failed), 'both expired leases reclaimed');
  const st = async (id) => (await db.query(`SELECT sharepoint_mirror_status s, sharepoint_dead_reason d FROM documents WHERE id=$1`, [id])).rows[0];
  assert.strictEqual((await st(pending)).s, 'PENDING', 'below cap -> PENDING');
  const fx = await st(failed);
  assert.strictEqual(fx.s, 'DEAD'); assert.strictEqual(fx.d, 'lease_exhausted');
  ok('reaper reclaims expired leases: below cap -> PENDING, at cap -> DEAD(lease_exhausted)');

  // ---- 5. fenced persistOutcome: wrong holder no-ops; right holder writes -----
  const claim2 = await q.claimBatch(1, { holder: 'OWNER' });
  const cid = claim2[0] && claim2[0].id;
  assert.ok(cid, 'claimed a row to persist against');
  const wrong = await q.persistOutcome(cid, 'IMPOSTOR', { status: 'DONE' });
  assert.strictEqual(wrong, false, 'wrong holder cannot write (fencing)');
  const done2 = await q.persistOutcome(cid, 'OWNER', { status: 'DONE' });
  assert.strictEqual(done2, true, 'owning holder writes DONE');
  assert.strictEqual((await st(cid)).s, 'DONE');
  ok('persistOutcome is fenced on locked_by — only the owning worker can transition the row');

  // ---- 6. persistOutcome FAILED/DEAD set next_attempt_at + dead_reason --------
  await seed({ status: 'PENDING' });                       // fresh claimable row for this step
  const claim3 = await q.claimBatch(1, { holder: 'W3' });
  const c3 = claim3[0].id;
  await q.persistOutcome(c3, 'W3', state.decideAfterAttempt(503, {}, 3, 0, { rng: () => 0.5 }));
  const r3 = (await db.query(`SELECT sharepoint_mirror_status s, sharepoint_next_attempt_at na, sharepoint_locked_by lb FROM documents WHERE id=$1`, [c3])).rows[0];
  assert.strictEqual(r3.s, 'FAILED'); assert.ok(new Date(r3.na) > new Date(), 'backoff scheduled in the future');
  assert.strictEqual(r3.lb, null, 'lease released on FAILED');
  ok('persistOutcome writes FAILED with a future next_attempt_at and releases the lease');

  // ---- 7. reconcile dual-write: derives status from legacy cols, spares IN_PROGRESS
  const legacyDone = await seed({ status: 'PENDING', backedUp: true });        // legacy says DONE, status stale PENDING
  await seed({ status: 'PENDING' });                                           // fresh claimable row for the live lease
  const activeLease = await q.claimBatch(1, { holder: 'LIVE' });               // an IN_PROGRESS row
  const activeId = activeLease[0].id;
  const fixed = await q.reconcileStatus();
  assert.ok(fixed >= 1, 'reconcile corrected at least the stale row');
  assert.strictEqual((await st(legacyDone)).s, 'DONE', 'stale PENDING with backed_up_at -> DONE');
  assert.strictEqual((await st(activeId)).s, 'IN_PROGRESS', 'reconcile never stomps an active IN_PROGRESS lease');
  ok('reconcileStatus dual-writes status from legacy columns and never touches an active lease');

  // ---- 7b. reconcile NEVER resurrects a terminal DEAD to a claimable state ----
  // A permanent/auth/collision DEAD is set BELOW the attempt cap; the legacy
  // columns can't represent that, so a naive re-derive would revert it to FAILED
  // (claimable) and drop it from the dead-letter. Guard: DEAD only moves forward.
  const permDead = await db.query(
    `UPDATE documents SET sharepoint_mirror_status='DEAD', sharepoint_dead_reason='permanent_http_403',
        sharepoint_backup_attempts=2, sharepoint_backed_up_at=NULL, sharepoint_skipped_reason=NULL
      WHERE id=$1 RETURNING id`, [(await seed({ status: 'PENDING' }))]).then((r) => r.rows[0].id);
  // a DEAD row the legacy path LATER mirrored (backed_up_at set) SHOULD move to DONE
  const deadThenMirrored = await db.query(
    `UPDATE documents SET sharepoint_mirror_status='DEAD', sharepoint_dead_reason='transient_exhausted',
        sharepoint_backup_attempts=8, sharepoint_backed_up_at=now()
      WHERE id=$1 RETURNING id`, [(await seed({ status: 'PENDING' }))]).then((r) => r.rows[0].id);
  // a fresh insert whose status is still NULL (not yet reconciled) MUST be derived
  // — the DEAD guard must be NULL-safe (COALESCE), not a 3-valued-logic trap.
  const nullStatus = await db.query(
    `UPDATE documents SET sharepoint_mirror_status=NULL, sharepoint_backup_attempts=1
      WHERE id=$1 RETURNING id`, [(await seed({ status: 'PENDING' }))]).then((r) => r.rows[0].id);
  await q.reconcileStatus();
  assert.strictEqual((await st(permDead)).s, 'DEAD', 'a below-cap permanent DEAD stays DEAD (not resurrected to FAILED)');
  assert.strictEqual((await st(deadThenMirrored)).s, 'DONE', 'a DEAD row the legacy path mirrored moves FORWARD to DONE');
  assert.strictEqual((await st(nullStatus)).s, 'FAILED', 'a NULL-status fresh row IS reconciled (NULL-safe DEAD guard), attempts=1 -> FAILED');
  ok('reconcileStatus never resurrects a terminal DEAD; DEAD advances only to DONE/SKIPPED; NULL status is still derived');

  // ---- 8. SQL-derive parity == JS deriveStatus for the full matrix -----------
  const matrix = [
    { sharepoint_backed_up_at: new Date() },
    { sharepoint_skipped_reason: 'x' },
    { sharepoint_backup_attempts: 8 },
    { sharepoint_backup_attempts: 3 },
    {},
  ];
  for (const m of matrix) {
    const sqlDerived = (await db.query(
      `SELECT (${q.deriveStatusSql()}) AS s
         FROM (SELECT $1::timestamptz AS sharepoint_backed_up_at, $2::text AS sharepoint_skipped_reason,
                      $3::int AS sharepoint_backup_attempts) t`,
      [m.sharepoint_backed_up_at || null, m.sharepoint_skipped_reason || null, m.sharepoint_backup_attempts || 0])).rows[0].s;
    assert.strictEqual(sqlDerived, state.deriveStatus(m).status, `SQL derive == JS derive for ${JSON.stringify(m)}`);
  }
  ok('DERIVE_STATUS_SQL matches state.deriveStatus() for every branch (no divergence)');

  // ---- 9. shadow compare: FSM invents nothing; legacy-only is only backoff/in-flight
  const cmp = await q.shadowCompare({ log: false });
  assert.strictEqual(cmp.onlyFsm.length, 0, `FSM must invent no work; fsm-only=${JSON.stringify(cmp.onlyFsm)}`);
  assert.strictEqual(cmp.unexpectedLegacyOnly.length, 0,
    `no unexpected legacy-only; got=${JSON.stringify(cmp.unexpectedLegacyOnly)}`);
  assert.ok(cmp.agree, 'shadow claim sets agree (modulo FSM backoff/in-flight holds)');
  // c3 is FAILED with a future next_attempt_at (backoff) and legacy would still
  // pick it — it must be classified EXPECTED, not a divergence.
  assert.ok(cmp.expectedLegacyOnly.includes(String(c3)),
    'a FAILED row in backoff is legacy-claimable but correctly held by the FSM (expected, not divergence)');
  ok('shadowCompare: FSM invents no work, and legacy-only rows are exactly the FSM backoff/in-flight holds');

  // ---- 10. concurrency: two simultaneous claimers get DISJOINT rows ----------
  const freshIds = [];
  for (let i = 0; i < 12; i++) freshIds.push(await seed({ status: 'PENDING' }));
  const [claimA, claimB] = await Promise.all([
    q.claimBatch(50, { holder: 'CA' }),
    q.claimBatch(50, { holder: 'CB' }),
  ]);
  const idsA = new Set(claimA.map((r) => String(r.id)));
  const idsB = claimB.map((r) => String(r.id));
  const overlap = idsB.filter((id) => idsA.has(id));
  assert.strictEqual(overlap.length, 0, `SKIP LOCKED: no row claimed by both workers; overlap=${JSON.stringify(overlap)}`);
  // every fresh row ended up IN_PROGRESS exactly once (claimed by exactly one holder)
  const claimedFresh = (await db.query(
    `SELECT count(*)::int c FROM documents WHERE id = ANY($1::uuid[])
      AND sharepoint_mirror_status='IN_PROGRESS' AND sharepoint_locked_by IN ('CA','CB')`, [freshIds])).rows[0].c;
  assert.strictEqual(claimedFresh, freshIds.length, 'every fresh row was claimed exactly once across the two workers');
  ok('SKIP LOCKED: two concurrent claimers get strictly disjoint rows — no double-claim under contention');

  await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [APP]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]);
  console.log(`\nAll ${n} mirror-queue checks passed.`);
  process.exit(0);
})().catch(async (e) => {
  console.error('FAIL', e && e.message, e && e.stack);
  try { if (APP) { await db.query(`DELETE FROM documents WHERE application_id=$1`, [APP]); await db.query(`DELETE FROM applications WHERE id=$1`, [APP]); } if (BOR) await db.query(`DELETE FROM borrowers WHERE id=$1`, [BOR]); } catch (_) {}
  process.exit(1);
});
