'use strict';
/**
 * The Pipeline V2 document worker as its OWN process (owner defect #7, 2026-07-26).
 *
 * WHY THIS EXISTS. The document reader used to run inside the web service, so reading a 60-page
 * packet competed with borrower page loads for the same CPU in the same process, and every web
 * deploy restarted the reader mid-job. Splitting it out is the fix: the site stays responsive
 * under a heavy read, and the two can be restarted and scaled independently.
 *
 * THREE THINGS THIS FILE MUST GET RIGHT — each one is a real hazard, not a style preference:
 *
 * 1. IT MUST NOT RUN MIGRATIONS. `migrate-boot` exports `waitForDb` SEPARATELY from `ensureSchema`
 *    precisely so a second service can wait for the database WITHOUT applying schema. The WEB
 *    SERVICE OWNS THE SCHEMA. Two services racing the same migration chain on a deploy is a real
 *    corruption hazard, so this entrypoint calls `waitForDb()` and never `ensureSchema()`.
 *
 * 2. IT MUST HOLD THE EVENT LOOP OPEN ITSELF. `src/pipeline/worker.js` unref()s its polling timer.
 *    That is CORRECT for the web service — the HTTP server holds the loop open, and an unref'd
 *    timer means the worker can never keep a process alive past shutdown. But a standalone worker
 *    has no HTTP server, so with only an unref'd timer Node would find nothing keeping it alive and
 *    EXIT IMMEDIATELY — the service would look like it "started fine" and silently process nothing.
 *    So this entrypoint owns a REF'D keepalive of its own. Do NOT "fix" this by removing the unref
 *    in worker.js; that would break shutdown for the web service instead.
 *
 * 3. IT MUST SHUT DOWN CLEANLY. Render sends SIGTERM on deploy/scale-down. We stop the worker (so
 *    it stops claiming new jobs), clear the keepalive (so the loop can drain), and let in-flight
 *    work finish rather than killing it mid-job — a job killed mid-flight would sit on its lease
 *    until it expired.
 *
 * ADVISORY ONLY: this process writes only the V2 audit tables. It never writes a condition, status,
 * finding, or any change to a real loan file.
 */
const cfg = require('./config');

// How often the keepalive ticks. It does no work — its ONLY job is to be a ref'd handle so Node
// keeps the process alive between the worker's own (unref'd) polls. Long enough to be free.
const KEEPALIVE_MS = 60000;
// How long an in-flight job gets to finish its last write after SIGTERM before we close the pool.
// Render's default shutdown grace is 30s, so stay well inside it.
const SHUTDOWN_GRACE_MS = 5000;

async function main() {
  const started = new Date().toISOString();
  console.log(`[worker] starting (pid ${process.pid}) at ${started}`);

  if (!cfg.pipeline || !cfg.pipeline.workerEnabled) {
    // Deliberately explicit rather than silently idling: a worker service whose switch is off would
    // otherwise look identical to a healthy one that has no jobs, which is exactly the kind of
    // "running but doing nothing" state defect #7 was about.
    console.log('[worker] UW_WORKER_ENABLED is not on — this process has nothing to do. '
      + 'Set UW_WORKER_ENABLED=true on this service to start draining the document queue.');
  }

  // Wait for the database, but do NOT migrate — see (1) above.
  const db = require('./db');
  try {
    await require('./migrate-boot').waitForDb();
    console.log('[worker] database reachable (schema is owned by the web service — not migrating)');
  } catch (e) {
    console.error(`[worker] could not reach the database: ${(e && e.message) || e}`);
    process.exit(1);                    // let Render restart us rather than idle without a DB
  }

  const handle = require('./pipeline/start').startPipelineWorker({ db, cfg, log: console });
  if (!handle || handle.enabled === false) {
    console.log('[worker] worker is disabled — staying up so the service stays healthy, but idle.');
  }

  // (2) the ref'd keepalive. NOT unref'd, on purpose — this is the only thing keeping the process
  // alive between the worker's unref'd polls.
  const keepalive = setInterval(() => {}, KEEPALIVE_MS);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;           // a second SIGTERM must not double-stop
    shuttingDown = true;
    console.log(`[worker] ${signal} received — stopping cleanly; in-flight jobs finish first.`);
    try { if (handle && typeof handle.stop === 'function') handle.stop(); }
    catch (e) { console.warn(`[worker] stop() failed: ${(e && e.message) || e}`); }
    clearInterval(keepalive);           // (3) release the loop so the process can exit on its own

    // Stopping the worker + clearing the keepalive is NOT enough on its own: the pg pool's idle
    // sockets are themselves ref'd handles, so the process would sit there until Render lost
    // patience and SIGKILLed it — the hard kill we are trying to avoid. Verified against a real
    // database: without this the process was still running well after SIGTERM. So close the pool
    // too, after a short grace period that lets an in-flight job finish its last write.
    setTimeout(() => {
      Promise.resolve(db && db.pool && db.pool.end ? db.pool.end() : null)
        .then(() => console.log('[worker] database pool closed — exiting.'))
        .catch((e) => console.warn(`[worker] pool close failed: ${(e && e.message) || e}`));
    }, SHUTDOWN_GRACE_MS).unref();      // unref'd: this timer must not itself keep us alive
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A crash in a background job must not take the whole reader down silently.
  process.on('unhandledRejection', (r) => console.error('[worker] unhandled rejection:', r));
  process.on('uncaughtException', (e) => console.error('[worker] uncaught exception:', e));
}

// Exported for the contract test; only auto-runs when this file IS the entrypoint, so requiring it
// from a test never starts a real worker.
if (require.main === module) {
  main().catch((e) => { console.error('[worker] fatal:', e); process.exit(1); });
}
module.exports = { main, KEEPALIVE_MS, SHUTDOWN_GRACE_MS };
