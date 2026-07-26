'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — durable document-processing job queue.
 *
 * The data-access layer over db/307's document_pipeline_{jobs,stages,attempts,artifacts}.
 * Every function takes a query-able `db` (the shared pool, a pooled client, or a throwaway
 * Pool in tests) as its first argument, so the same code runs in the web process (enqueue)
 * and in the separate Render Background Worker (claim/process).
 *
 * The claim/lease/reaper/fenced-write mechanics mirror the proven pattern in
 * src/lib/sp-mirror-queue.js:
 *   - claimBatch(): one atomic `FOR UPDATE SKIP LOCKED` statement flips ready jobs to
 *     'processing', increments attempts, and stamps a fresh lease — BEFORE any external
 *     work. N concurrent workers never collide or head-of-line-block.
 *   - reapExpiredLeases(): a job whose worker died (lease expired) goes back to
 *     'failed_retryable' (re-claimable) or, at the attempt cap, 'failed_terminal' +
 *     dead_letter. This is what makes a crash / redeploy safe (safe restart).
 *   - complete()/fail() are FENCED on (lease_owner, status='processing'), so a job
 *     reclaimed out from under a slow worker is never clobbered by the slow worker.
 *
 * This module NEVER runs OCR/AI/underwriting itself — it only moves rows through the
 * durable state machine. The actual per-stage processing is injected by the worker.
 */

const READY_STATUSES = ['queued', 'failed_retryable'];

/**
 * Idempotent enqueue. Returns { id, created }. A second enqueue for the same
 * (document_id, pipeline_version) — or the same idempotency_key — adopts the existing
 * job instead of spawning a duplicate (the db/307 partial-unique indexes enforce this).
 */
async function enqueue(db, {
  documentId = null, loanId = null, pipelineVersion = 'v2', documentFamily = null,
  idempotencyKey = null, maxAttempts = null, payload = {},
} = {}) {
  // Fast path: adopt an existing live job for this document+version.
  if (documentId) {
    const found = await db.query(
      `SELECT id FROM document_pipeline_jobs WHERE document_id = $1 AND pipeline_version = $2 LIMIT 1`,
      [documentId, pipelineVersion]);
    if (found.rows[0]) return { id: found.rows[0].id, created: false };
  }
  if (idempotencyKey) {
    const found = await db.query(`SELECT id FROM document_pipeline_jobs WHERE idempotency_key = $1 LIMIT 1`, [idempotencyKey]);
    if (found.rows[0]) return { id: found.rows[0].id, created: false };
  }
  try {
    const ins = await db.query(
      `INSERT INTO document_pipeline_jobs
         (document_id, loan_id, pipeline_version, document_family, idempotency_key, max_attempts, payload)
       VALUES ($1,$2,$3,$4,$5, COALESCE($6, 5), $7::jsonb)
       RETURNING id`,
      [documentId, loanId, pipelineVersion, documentFamily, idempotencyKey, maxAttempts, JSON.stringify(payload || {})]);
    return { id: ins.rows[0].id, created: true };
  } catch (e) {
    // A concurrent enqueue won the unique index between our check and insert — adopt it.
    if (e && e.code === '23505') {
      const key = documentId ? `document_id = $1 AND pipeline_version = $2` : `idempotency_key = $1`;
      const args = documentId ? [documentId, pipelineVersion] : [idempotencyKey];
      const r = await db.query(`SELECT id FROM document_pipeline_jobs WHERE ${key} LIMIT 1`, args);
      if (r.rows[0]) return { id: r.rows[0].id, created: false };
    }
    throw e;
  }
}

/**
 * Atomically claim up to `limit` ready jobs for `holder`, stamping a lease. Returns the
 * claimed rows. Ready = queued|failed_retryable, run_after<=now, not dead_letter, not
 * cancel_requested. Oldest-first, fewest-attempts-first.
 */
async function claimBatch(db, { limit = 5, holder, leaseSeconds = 300 } = {}) {
  if (!holder) throw new Error('claimBatch requires a holder id');
  const { rows } = await db.query(
    `WITH claimable AS (
       SELECT id FROM document_pipeline_jobs
        WHERE status = ANY($2)
          AND dead_letter = false
          AND cancel_requested = false
          AND run_after <= now()
        ORDER BY attempts ASC, run_after ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
     )
     UPDATE document_pipeline_jobs j
        SET status = 'processing',
            attempts = j.attempts + 1,
            lease_owner = $1,
            lease_expires_at = now() + make_interval(secs => $4),
            heartbeat_at = now(),
            updated_at = now()
       FROM claimable c WHERE j.id = c.id
     RETURNING j.id, j.document_id, j.loan_id, j.pipeline_version, j.document_family,
               j.attempts, j.max_attempts, j.cancel_requested, j.payload`,
    [holder, READY_STATUSES, limit, leaseSeconds]);
  return rows;
}

/** Extend the lease while processing (fenced on holder). Returns true if we still own it. */
async function heartbeat(db, id, holder, leaseSeconds = 300) {
  const { rowCount } = await db.query(
    `UPDATE document_pipeline_jobs
        SET lease_expires_at = now() + make_interval(secs => $3), heartbeat_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'processing'`,
    [id, holder, leaseSeconds]);
  return rowCount > 0;
}

/**
 * Reap dead workers: 'processing' jobs whose lease expired go back to 'failed_retryable'
 * (re-claimable) or, at the attempt cap, 'failed_terminal' + dead_letter. Returns reaped rows.
 */
async function reapExpiredLeases(db) {
  const { rows } = await db.query(
    `UPDATE document_pipeline_jobs
        SET status = CASE WHEN attempts >= max_attempts THEN 'failed_terminal' ELSE 'failed_retryable' END,
            dead_letter = (attempts >= max_attempts),
            last_error = COALESCE(last_error, 'lease expired (worker died)'),
            run_after = now(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
      WHERE status = 'processing' AND lease_expires_at < now()
      RETURNING id, status, dead_letter`);
  return rows;
}

/** Mark a claimed job completed (fenced on holder). Returns true if the write landed. */
async function complete(db, id, holder, { result = {}, costCents = 0, latencyMs = null, modelVersion = null } = {}) {
  const { rowCount } = await db.query(
    `UPDATE document_pipeline_jobs
        SET status = 'completed', result = $3::jsonb,
            provider_cost_cents = provider_cost_cents + COALESCE($4,0),
            latency_ms = $5, model_version = COALESCE($6, model_version),
            last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'processing'`,
    [id, holder, JSON.stringify(result || {}), costCents, latencyMs, modelVersion]);
  return rowCount > 0;
}

/**
 * Mark a claimed job failed (fenced on holder). retryable=true and under the attempt cap →
 * 'failed_retryable' with a backoff (run_after = now + delaySeconds). Otherwise (terminal, or
 * attempts>=max) → 'failed_terminal' + dead_letter. Returns { landed, terminal }.
 */
async function fail(db, id, holder, { retryable = true, error = null, delaySeconds = 0, costCents = 0, latencyMs = null } = {}) {
  const { rows } = await db.query(
    `UPDATE document_pipeline_jobs
        SET status = CASE WHEN $3 = true AND attempts < max_attempts THEN 'failed_retryable' ELSE 'failed_terminal' END,
            dead_letter = NOT ($3 = true AND attempts < max_attempts),
            last_error = $4,
            run_after = now() + make_interval(secs => GREATEST(0, $5)),
            provider_cost_cents = provider_cost_cents + COALESCE($6,0),
            latency_ms = COALESCE($7, latency_ms),
            lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'processing'
      RETURNING dead_letter AS terminal`,
    [id, holder, retryable, error, delaySeconds, costCents, latencyMs]);
  return { landed: rows.length > 0, terminal: rows[0] ? rows[0].terminal : null };
}

/** Mark a claimed job cancelled (honors a cancel_requested flag; fenced on holder). */
async function markCancelled(db, id, holder) {
  const { rowCount } = await db.query(
    `UPDATE document_pipeline_jobs
        SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND lease_owner = $2 AND status = 'processing'`,
    [id, holder]);
  return rowCount > 0;
}

/**
 * Request cancellation. A job that is NOT currently being processed (queued /
 * failed_retryable) is cancelled immediately; a job that IS processing only gets the
 * cancel_requested flag — the worker sees it (heartbeat / next boundary) and stops,
 * then markCancelled() finalizes it. Terminal jobs are untouched.
 */
async function requestCancel(db, id) {
  const { rowCount } = await db.query(
    `UPDATE document_pipeline_jobs
        SET cancel_requested = true,
            status = CASE WHEN status IN ('queued','failed_retryable','waiting_provider','manual_review') THEN 'cancelled' ELSE status END,
            lease_owner = CASE WHEN status IN ('queued','failed_retryable','waiting_provider','manual_review') THEN NULL ELSE lease_owner END,
            lease_expires_at = CASE WHEN status IN ('queued','failed_retryable','waiting_provider','manual_review') THEN NULL ELSE lease_expires_at END,
            updated_at = now()
      WHERE id = $1 AND status NOT IN ('completed','failed_terminal','cancelled')`, [id]);
  return rowCount > 0;
}

/** Append to the immutable attempt ledger. */
async function recordAttempt(db, id, { attemptNo, outcome = null, error = null, provider = null, latencyMs = null, costCents = null } = {}) {
  await db.query(
    `INSERT INTO document_pipeline_attempts (job_id, attempt_no, outcome, error, provider, latency_ms, cost_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, attemptNo, outcome, error, provider, latencyMs, costCents]);
}

/** Upsert a per-job stage manifest row. */
async function recordStage(db, id, stageKey, status, detail = {}) {
  await db.query(
    `INSERT INTO document_pipeline_stages (job_id, stage_key, status, started_at, ended_at, detail)
     VALUES ($1,$2,$3, now(),
             CASE WHEN $3 IN ('completed','not_applicable','failed_terminal') THEN now() ELSE NULL END,
             $4::jsonb)
     ON CONFLICT (job_id, stage_key) DO UPDATE
        SET status = EXCLUDED.status,
            ended_at = CASE WHEN EXCLUDED.status IN ('completed','not_applicable','failed_terminal') THEN now() ELSE document_pipeline_stages.ended_at END,
            detail = EXCLUDED.detail`,
    [id, stageKey, status, JSON.stringify(detail || {})]);
}

/** Record a produced artifact (raw provider result, evidence candidates, route record, …). */
async function recordArtifact(db, id, { kind, storageRef = null, sha256 = null, bytes = null, meta = {} } = {}) {
  await db.query(
    `INSERT INTO document_pipeline_artifacts (job_id, kind, storage_ref, sha256, bytes, meta)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [id, kind, storageRef, sha256, bytes, JSON.stringify(meta || {})]);
}

/** Queue depth snapshot for dashboards / health. */
async function stats(db, { pipelineVersion = null } = {}) {
  const { rows } = await db.query(
    `SELECT status, count(*)::int AS n FROM document_pipeline_jobs
      WHERE ($1::text IS NULL OR pipeline_version = $1) GROUP BY status`, [pipelineVersion]);
  const out = { queued: 0, processing: 0, waiting_provider: 0, manual_review: 0, completed: 0, failed_retryable: 0, failed_terminal: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

module.exports = {
  READY_STATUSES,
  enqueue, claimBatch, heartbeat, reapExpiredLeases, complete, fail,
  markCancelled, requestCancel, recordAttempt, recordStage, recordArtifact, stats,
};
