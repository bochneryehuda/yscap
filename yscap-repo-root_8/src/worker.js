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
// UPPER BOUND on shutdown, not the mechanism. We now AWAIT the worker's in-flight drain pass
// (stop() returns a promise); this timer only stops us hanging if that never settles. It was 5s,
// which was both too short to let a real read finish AND based on a false premise — a single
// document read is bounded at ~150s, so no timer inside Render's 30s window can "let it finish".
// The honest design is: ask the worker to stop, wait for it, and cap the wait.
const SHUTDOWN_GRACE_MS = 20000;

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
  //
  // waitForDb RESOLVES `{ok:false, error}` after its retry budget — it NEVER rejects (its own
  // header says so). So a try/catch around it is dead code: with a wrong DATABASE_URL this would
  // have printed "database reachable", started the worker, and idled forever draining nothing,
  // with no health check on a Render worker to notice. That is precisely the "started fine,
  // processes nothing, no error anywhere" state this service exists to eliminate — so the RESULT
  // must be checked, not the absence of a throw.
  const db = require('./db');
  let ready = null;
  try { ready = await require('./migrate-boot').waitForDb(); }
  catch (e) { ready = { ok: false, error: (e && e.message) || String(e) }; }   // belt and braces
  if (!ready || ready.ok !== true) {
    console.error(`[worker] could not reach the database: ${(ready && ready.error) || 'unknown error'}. `
      + 'Exiting so the platform restarts this service rather than leaving it up and idle.');
    process.exit(1);
  }
  console.log('[worker] database reachable (schema is owned by the web service — not migrating)');

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
    clearInterval(keepalive);           // (3) release the loop so the process can exit on its own

    // Ask the worker to stop and WAIT for the in-flight pass, capped by the grace budget. Closing
    // the pool while a job is mid-write would make its completion write throw, stranding the job in
    // 'processing' on a 300s lease and burning a retry attempt — the exact "killed mid-flight"
    // outcome this shutdown path exists to prevent. Whichever settles first wins.
    //
    // Closing the pool is NOT optional: its idle sockets are themselves ref'd handles, so without
    // it the process sits there until the platform SIGKILLs it (verified against a real database —
    // it was still running long after SIGTERM).
    let stopping = Promise.resolve();
    try { if (handle && typeof handle.stop === 'function') stopping = Promise.resolve(handle.stop()); }
    catch (e) { console.warn(`[worker] stop() failed: ${(e && e.message) || e}`); }

    const cap = new Promise((r) => { const t = setTimeout(r, SHUTDOWN_GRACE_MS); if (t.unref) t.unref(); });
    Promise.race([stopping.catch(() => {}), cap])
      .then(() => (db && db.pool && db.pool.end ? db.pool.end() : null))
      .then(() => console.log('[worker] database pool closed — exiting.'))
      .catch((e) => console.warn(`[worker] pool close failed: ${(e && e.message) || e}`));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejected promise in a background job must not take the whole reader down.
  process.on('unhandledRejection', (r) => console.error('[worker] unhandled rejection:', r));
  // An uncaught EXCEPTION is different: installing a handler OVERRIDES Node's default exit, so
  // without the explicit exit below a process that has corrupted itself would log one line and then
  // run forever — claiming and failing jobs, with no health check on a worker service to notice.
  // Combined with the ref'd keepalive there would be NO condition under which this process is ever
  // replaced. Log it, then die and let the platform start a clean one.
  process.on('uncaughtException', (e) => {
    console.error('[worker] uncaught exception — exiting so the platform replaces this process:', e);
    process.exit(1);
  });
}

// Exported for the contract test; only auto-runs when this file IS the entrypoint, so requiring it
// from a test never starts a real worker.
if (require.main === module) {
  main().catch((e) => { console.error('[worker] fatal:', e); process.exit(1); });
}
module.exports = { main, KEEPALIVE_MS, SHUTDOWN_GRACE_MS };
