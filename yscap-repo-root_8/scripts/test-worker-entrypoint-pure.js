'use strict';
/**
 * The standalone document-worker entrypoint's CONTRACT (owner defect #7, 2026-07-26).
 *
 * Two of the three rules in src/worker.js fail SILENTLY if broken — the service would look like it
 * booted fine and simply never do the work, or would do damage nobody sees until a deploy. So they
 * are pinned here rather than left to review:
 *
 *   1. It must NOT run migrations. The web service owns the schema; two services racing the same
 *      migration chain on a deploy is a real corruption hazard. The entrypoint must call
 *      `waitForDb()` and never `ensureSchema()`.
 *   2. It must HOLD THE EVENT LOOP OPEN with a REF'd handle. src/pipeline/worker.js unref()s its
 *      polling timer (correct for the web service, where HTTP holds the loop open). A standalone
 *      process with only an unref'd timer finds nothing keeping it alive and EXITS IMMEDIATELY —
 *      "started fine", processes nothing, no error anywhere.
 *   3. SIGTERM must stop the worker and release the keepalive so Render's deploy/scale-down drains
 *      cleanly instead of killing jobs mid-flight (a job killed mid-flight sits on its lease).
 *
 * Pure: no DB, no network. Every dependency is stubbed through require.cache, so running this
 * never starts a real worker or touches a real database.
 */
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// --- install stubs for everything src/worker.js requires, BEFORE requiring it ---
const calls = { waitForDb: 0, ensureSchema: 0, startPipelineWorker: 0, stop: 0 };

function stub(relPath, exports) {
  const full = require.resolve(path.join(ROOT, relPath));
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return full;
}

stub('src/config', {
  pipeline: { workerEnabled: true, v2ReadEnabled: false },
});
stub('src/db', { query: async () => ({ rows: [] }) });
stub('src/migrate-boot', {
  waitForDb: async () => { calls.waitForDb++; },
  // If the entrypoint ever calls this, the test FAILS loudly — that is the whole point.
  ensureSchema: async () => { calls.ensureSchema++; },
  bootstrapAdmin: async () => {},
});
const workerHandle = { enabled: true, holder: 'test', stop() { calls.stop++; } };
stub('src/pipeline/start', {
  startPipelineWorker() { calls.startPipelineWorker++; return workerHandle; },
});

// Quiet the entrypoint's console during the run, but keep errors visible.
const realLog = console.log;
console.log = () => {};

(async function main() {
  const worker = require(path.join(ROOT, 'src/worker.js'));

  // Measure what Node ACTUALLY uses to decide whether to stay alive. process.getActiveResourcesInfo()
  // counts only REF'd resources — an unref'd timer does not appear — which is precisely the
  // distinction this test exists to enforce. (process._getActiveHandles() is the wrong instrument:
  // it does not report timers at all on modern Node, so it would pass whether or not the keepalive
  // was ref'd, i.e. it would happily green-light the exact bug we are guarding against.)
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const refdBefore = timers();

  await worker.main();

  const refdAfter = timers();
  console.log = realLog;

  // (1) migrations
  ok(calls.waitForDb === 1, `waits for the DB (waitForDb called ${calls.waitForDb}x, expected 1)`);
  ok(calls.ensureSchema === 0,
    `NEVER runs migrations (ensureSchema called ${calls.ensureSchema}x, expected 0) — the web service owns the schema`);

  // (2) the keepalive — the hazard that would make the service exit immediately and silently
  ok(calls.startPipelineWorker === 1, 'starts the pipeline worker exactly once');
  ok(refdAfter > refdBefore,
    `holds the event loop open with a REF'd timer (ref'd timers ${refdBefore} → ${refdAfter}) — `
    + 'without this the standalone process exits immediately and processes nothing');

  // (3) graceful shutdown
  process.emit('SIGTERM');
  await new Promise((r) => setImmediate(r));
  ok(calls.stop === 1, `SIGTERM stops the worker (stop called ${calls.stop}x, expected 1)`);
  const refdAfterTerm = timers();
  ok(refdAfterTerm <= refdBefore,
    `SIGTERM releases the keepalive so the process can exit (ref'd timers back to ${refdAfterTerm})`);

  // A second SIGTERM must not double-stop (Render can send more than one).
  process.emit('SIGTERM');
  await new Promise((r) => setImmediate(r));
  ok(calls.stop === 1, `a second SIGTERM is ignored (stop still ${calls.stop}x)`);

  // The entrypoint must not auto-run on require — otherwise importing it anywhere (like here)
  // would start a real worker.
  ok(typeof worker.main === 'function', 'exports main() for testing without auto-starting');

  console.log(`test-worker-entrypoint-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log = realLog; console.error(e); process.exit(1); });
