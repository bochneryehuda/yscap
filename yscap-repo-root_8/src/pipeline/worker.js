'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — durable document-processing WORKER loop.
 *
 * Drains db/307's document_pipeline_jobs via the job-queue DAL. Designed to run in a
 * SEPARATE Render Background Worker process (src/pipeline/worker-main.js) — NOT in the
 * web request path, so no OCR/AI/underwriting ever runs inside an HTTP request.
 *
 * Off by default: startWorker() is a no-op unless cfg.pipeline.workerEnabled is true, so
 * merging this changes nothing and everyone stays on Pipeline V1.
 *
 * The per-job work itself is an INJECTED `processor(job, ctx)` function. This module owns
 * only the durable state machine (reap → claim → process → complete/fail with retry/backoff
 * + attempt ledger); the real per-stage processing (packet control, routed extraction,
 * evidence grounding, …) is registered by later Phase-1 PRs. Until then the default
 * `shadowNoopProcessor` records an 'intake' stage and completes — it touches no V1 data.
 */
const os = require('os');
const jq = require('./job-queue');

function makeHolderId() {
  return `${os.hostname()}:${process.pid}:${Date.now().toString(36)}`;
}

/**
 * A placeholder processor: proves the machine end-to-end without doing any real document
 * work. Records the intake stage and returns completed. Replaced by real stage processors
 * in later Phase-1 PRs (packet control → router → evidence grounding → …).
 */
async function shadowNoopProcessor(job, { db }) {
  await jq.recordStage(db, job.id, 'intake', 'completed', { shadow: true, note: 'shadow no-op — real stages land in later PRs' });
  return { status: 'completed', result: { shadow: true } };
}

/**
 * One drain pass: reap dead leases, claim a batch, process each job, persist the outcome.
 * Every job is independently guarded — a throwing processor fails THAT job (retryable) and
 * never breaks the batch. Returns a counts summary. Safe to call repeatedly.
 */
async function runOnce(db, { holder = makeHolderId(), limit = 5, leaseSeconds = 300, processor = shadowNoopProcessor } = {}) {
  const summary = { reaped: 0, claimed: 0, completed: 0, failed: 0, cancelled: 0 };
  const reaped = await jq.reapExpiredLeases(db);
  summary.reaped = reaped.length;

  const jobs = await jq.claimBatch(db, { holder, limit, leaseSeconds });
  summary.claimed = jobs.length;

  for (const job of jobs) {
    // Cancellation requested between enqueue and claim → stop cleanly.
    if (job.cancel_requested) {
      await jq.markCancelled(db, job.id, holder);
      summary.cancelled += 1;
      await jq.recordAttempt(db, job.id, { attemptNo: job.attempts, outcome: 'cancelled' });
      continue;
    }
    const startedAt = Date.now();
    let outcome;
    try {
      outcome = await processor(job, { db, jq, holder });
    } catch (e) {
      outcome = { status: 'failed', retryable: true, error: (e && e.message) ? String(e.message).slice(0, 500) : 'processor threw' };
    }
    const latencyMs = Date.now() - startedAt;
    const o = outcome || {};
    if (o.status === 'completed') {
      const landed = await jq.complete(db, job.id, holder, {
        result: o.result || {}, costCents: o.costCents || 0, latencyMs, modelVersion: o.modelVersion || null,
      });
      if (landed) summary.completed += 1;
      await jq.recordAttempt(db, job.id, { attemptNo: job.attempts, outcome: 'succeeded', provider: o.provider || null, latencyMs, costCents: o.costCents || 0 });
    } else {
      // Default backoff: exponential on attempts, capped at 1h, unless the processor set one.
      const backoff = o.delaySeconds != null ? o.delaySeconds : Math.min(3600, Math.pow(2, Math.max(0, job.attempts)) * 15);
      const res = await jq.fail(db, job.id, holder, {
        retryable: o.retryable !== false, error: o.error || null, delaySeconds: backoff,
        costCents: o.costCents || 0, latencyMs,
      });
      if (res.landed) summary.failed += 1;
      await jq.recordAttempt(db, job.id, {
        attemptNo: job.attempts, outcome: res.terminal ? 'terminal' : 'retryable',
        error: o.error || null, provider: o.provider || null, latencyMs, costCents: o.costCents || 0,
      });
    }
  }
  return summary;
}

/**
 * Start the polling worker. No-op (returns a disabled handle) unless cfg.pipeline.workerEnabled.
 * Returns { enabled, stop() }. Each tick runs one drain pass; ticks never overlap (a slow pass
 * defers the next). Errors in a pass are swallowed + logged so the loop never dies.
 */
function startWorker({ db, cfg, holder, intervalMs = 3000, processor = shadowNoopProcessor, log = console } = {}) {
  const conf = (cfg && cfg.pipeline) || {};
  if (!conf.workerEnabled) return { enabled: false, stop() {} };
  const myHolder = holder || makeHolderId();
  const limit = Math.max(1, conf.workerConcurrency || 2);
  const leaseSeconds = Math.max(30, conf.jobLeaseSeconds || 300);
  let stopped = false;
  let running = false;
  let timer = null;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const s = await runOnce(db, { holder: myHolder, limit, leaseSeconds, processor });
      if (s.claimed || s.reaped || s.failed) {
        log.log(`[pipeline-worker ${myHolder}] claimed=${s.claimed} completed=${s.completed} failed=${s.failed} reaped=${s.reaped} cancelled=${s.cancelled}`);
      }
    } catch (e) {
      log.error(`[pipeline-worker ${myHolder}] drain pass error: ${(e && e.message) || e}`);
    } finally { running = false; }
  };

  timer = setInterval(tick, Math.max(500, intervalMs));
  if (timer.unref) timer.unref();
  log.log(`[pipeline-worker ${myHolder}] started — concurrency ${limit}, lease ${leaseSeconds}s, every ${intervalMs}ms`);
  return {
    enabled: true,
    holder: myHolder,
    /**
     * Stop claiming new work. Returns a PROMISE that resolves once the in-flight drain pass has
     * finished, so a caller shutting the process down can WAIT for real completion instead of
     * guessing with a timer. (The standalone worker service does exactly that on SIGTERM; the web
     * service never calls stop(), so its behaviour is unchanged.)
     *
     * Back-compat: callers that ignore the return value behave exactly as before.
     */
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      if (!running) return Promise.resolve();
      // Poll rather than plumb a deferred through every path — the pass sets `running=false` in a
      // `finally`, so this always settles. Bounded by the caller's own shutdown budget.
      return new Promise((resolve) => {
        const iv = setInterval(() => { if (!running) { clearInterval(iv); resolve(); } }, 100);
        if (iv.unref) iv.unref();     // never let the watcher itself hold the process open
      });
    },
  };
}

module.exports = { runOnce, startWorker, shadowNoopProcessor, makeHolderId, _jq: jq };
