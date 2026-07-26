'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — durable-job QUEUE + WORKER mechanics
 * (src/pipeline/job-queue.js + src/pipeline/worker.js) over db/307.
 *
 * DB-gated (SKIPs without DATABASE_URL). Proves the guarantees the background worker
 * relies on, by injecting a test processor into worker.runOnce:
 *   - idempotent enqueue (same idempotency_key adopts the existing job);
 *   - a completed job records the attempt + intake stage and clears its lease;
 *   - a retryable failure re-queues with a lease cleared and is re-claimable;
 *   - hitting the attempt cap dead-letters (failed_terminal) and is NOT re-claimed;
 *   - a throwing processor is treated as a retryable failure (never breaks the batch);
 *   - requestCancel → the worker marks the job cancelled;
 *   - a dead worker's expired lease is reaped back to failed_retryable;
 *   - heartbeat extends the lease (fenced on holder); stats() counts by status.
 * All jobs use document_id=NULL (no fixtures) + a per-pid pipeline_version marker for
 * isolation + cleanup. Autocommit; cleans up in finally.
 *
 *   DATABASE_URL=postgres://… node scripts/test-pipeline-queue-db.js
 */
const R = require('path').resolve(__dirname, '..');
const jq = require(R + '/src/pipeline/job-queue');
const worker = require(R + '/src/pipeline/worker');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

if (!process.env.DATABASE_URL) { console.log('SKIP test-pipeline-queue-db (no DATABASE_URL)'); process.exit(0); }

(async function main() {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const fs = require('fs');
  const VER = 'testq-' + process.pid;            // isolation + cleanup marker (pipeline_version)
  const HOLD = 'holder-' + process.pid;
  const load = async (id) => (await pool.query('SELECT * FROM document_pipeline_jobs WHERE id=$1', [id])).rows[0];
  const enq = (opts) => jq.enqueue(pool, Object.assign({ pipelineVersion: VER }, opts));
  try {
    await pool.query(fs.readFileSync(R + '/db/307_document_pipeline_jobs.sql', 'utf8'));

    // 1) Idempotent enqueue via idempotency_key.
    const a = await enq({ idempotencyKey: VER + '-k1', payload: { n: 1 } });
    const b = await enq({ idempotencyKey: VER + '-k1', payload: { n: 2 } });
    ok(a.created === true && b.created === false && a.id === b.id, 'enqueue adopts existing job for same idempotency_key');

    // 2) Complete path (processor records the intake stage + a cost).
    const c = await enq({ idempotencyKey: VER + '-done' });
    let s = await worker.runOnce(pool, { holder: HOLD, limit: 50, processor: async (job, { db }) => {
      await jq.recordStage(db, job.id, 'intake', 'completed', {});
      return { status: 'completed', result: { ok: 1 }, costCents: 3 };
    } });
    ok(s.claimed >= 2 && s.completed >= 2, 'runOnce claims + completes ready jobs');
    const cj = await load(c.id);
    ok(cj.status === 'completed' && cj.lease_owner === null && cj.provider_cost_cents === 3, 'completed job: status/lease/cost');
    const att = (await pool.query('SELECT count(*)::int n FROM document_pipeline_attempts WHERE job_id=$1', [c.id])).rows[0].n;
    const stg = (await pool.query("SELECT status FROM document_pipeline_stages WHERE job_id=$1 AND stage_key='intake'", [c.id])).rows[0];
    ok(att === 1 && stg && stg.status === 'completed', 'completed job recorded 1 attempt + intake stage');

    // 3) Retryable failure → re-claimable; attempt cap → dead-letter.
    const r = await enq({ idempotencyKey: VER + '-retry', maxAttempts: 3 });
    const failProc = async () => ({ status: 'failed', retryable: true, error: 'boom', delaySeconds: 0 });
    await worker.runOnce(pool, { holder: HOLD, limit: 1, processor: failProc });   // attempt 1
    let rj = await load(r.id);
    ok(rj.status === 'failed_retryable' && rj.attempts === 1 && rj.dead_letter === false && rj.lease_owner === null, 'retryable fail #1 → failed_retryable, lease cleared');
    await worker.runOnce(pool, { holder: HOLD, limit: 50, processor: failProc });   // attempt 2
    rj = await load(r.id);
    ok(rj.attempts === 2 && rj.status === 'failed_retryable', 're-claimed after backoff (attempt 2)');
    await worker.runOnce(pool, { holder: HOLD, limit: 50, processor: failProc });   // attempt 3 == max → terminal
    rj = await load(r.id);
    ok(rj.attempts === 3 && rj.status === 'failed_terminal' && rj.dead_letter === true, 'attempt cap → failed_terminal + dead_letter');
    const s2 = await worker.runOnce(pool, { holder: HOLD, limit: 50, processor: failProc });
    const stillDead = (await load(r.id)).status;
    ok(stillDead === 'failed_terminal', 'dead-lettered job is NOT re-claimed');

    // 4) Throwing processor → retryable failure.
    const t = await enq({ idempotencyKey: VER + '-throw', maxAttempts: 5 });
    await worker.runOnce(pool, { holder: HOLD, limit: 50, processor: async () => { throw new Error('kaboom'); } });
    const tj = await load(t.id);
    ok(tj.status === 'failed_retryable' && /kaboom/.test(tj.last_error || ''), 'throwing processor → retryable fail with error captured');

    // 5) Cancel a queued job → cancelled immediately; the worker never claims it.
    const k = await enq({ idempotencyKey: VER + '-cancel' });
    ok((await jq.requestCancel(pool, k.id)) === true, 'requestCancel returns true for a queued job');
    ok((await load(k.id)).status === 'cancelled', 'queued job is cancelled immediately');
    const sc = await worker.runOnce(pool, { holder: HOLD, limit: 50, processor: async () => ({ status: 'completed' }) });
    ok((await load(k.id)).status === 'cancelled', 'cancelled job is NOT claimed/processed by the worker');
    void sc;

    // 6) Lease reaper: a dead worker's expired lease is reclaimed.
    const l = await enq({ idempotencyKey: VER + '-lease', maxAttempts: 5 });
    const claimed = await jq.claimBatch(pool, { holder: 'dead-worker', limit: 1, leaseSeconds: 300 });
    ok(claimed.some((j) => j.id === l.id), 'claimBatch leased the job to a (soon-dead) worker');
    await pool.query("UPDATE document_pipeline_jobs SET lease_expires_at = now() - interval '1 minute' WHERE id=$1", [l.id]);
    const reaped = await jq.reapExpiredLeases(pool);
    ok(reaped.some((x) => x.id === l.id), 'reaper reclaimed the expired-lease job');
    ok((await load(l.id)).status === 'failed_retryable', 'reaped job (under cap) → failed_retryable');

    // 7) Heartbeat (fenced on holder).
    const h = await enq({ idempotencyKey: VER + '-hb' });
    const hc = await jq.claimBatch(pool, { holder: HOLD, limit: 1, leaseSeconds: 60 });
    ok(hc.some((j) => j.id === h.id), 'claimed for heartbeat test');
    ok((await jq.heartbeat(pool, h.id, HOLD, 300)) === true, 'heartbeat extends lease for the owner');
    ok((await jq.heartbeat(pool, h.id, 'someone-else', 300)) === false, 'heartbeat by a non-owner is refused');

    // 8) stats() counts by status for this version.
    const st = await jq.stats(pool, { pipelineVersion: VER });
    ok(typeof st.completed === 'number' && st.failed_terminal >= 1 && st.cancelled >= 1, 'stats() returns per-status counts');
  } finally {
    await pool.query('DELETE FROM document_pipeline_jobs WHERE pipeline_version = $1', [VER]).catch(() => {});
    await pool.end();
  }
  console.log(`test-pipeline-queue-db: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
