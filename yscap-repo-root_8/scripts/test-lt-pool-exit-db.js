'use strict';
/**
 * AN IDLE DATABASE POOL MUST NOT KEEP A FINISHED PROCESS ALIVE.
 *
 * =============================================================================
 * THE INCIDENT THIS SUITE EXISTS FOR
 * =============================================================================
 *
 * On 2026-09-02 main went red and STAYED red, and nothing published. Run 4343's
 * `test-db` job ran its "Run the tests" step for exactly sixty minutes and was
 * killed by the step timeout, so `deploy` and `schema-push` skipped. There was
 * no failing assertion anywhere in the log — the last suite printed
 * "14 passed, 0 failed" and then the log went quiet apart from one line every
 * five minutes from a background worker. `npm test` had simply stopped.
 *
 * The cause, found by probing the live process rather than by reading the diff:
 * requiring the long-term module calls `settings/store.keepWarm()`, which
 * re-reads the company settings every fifteen seconds. That timer is carefully
 * `unref`'d — its own comment says it "must never hold a process open, least of
 * all a test runner's" — and the timer indeed does not. The QUERY inside it
 * does. Every tick borrows a client from Long-Term's pool, and each borrow
 * restarts that client's thirty-second idle countdown, so the pooled socket is
 * never reaped; a live TCP handle keeps Node's event loop alive no matter how
 * many timers are `unref`'d. The suite had closed its HTTP server and ended
 * RTL's pool, and one Postgres socket nobody owned held it open forever.
 *
 * NOT EVERY app-booting suite hung, and the exceptions are the tell. Measured
 * over five of them with the fix removed: three hung, two exited cleanly — and
 * the two that survived end with an unconditional `process.exit()`. So the
 * ones that hung are exactly the ones that rely on a NATURAL exit, which is
 * most of them, and which is the correct behaviour to protect.
 *
 * `allowExitOnIdle` on Long-Term's pool is the fix: "when every client is idle,
 * do not hold the process open".
 *
 * =============================================================================
 * WHY THIS IS A BEHAVIOURAL SUITE AND NOT A GREP
 * =============================================================================
 *
 * The tempting guard is one line — read `src/longterm/db.js` and assert the
 * string `allowExitOnIdle` appears in it. That guard cannot fail for the right
 * reason: it passes for a pool option that has been renamed, mis-spelled, set
 * to `false`, or moved into a branch that does not run. It also says nothing
 * about the only thing anybody cares about, which is whether a process that has
 * finished its work can finish.
 *
 * So this suite ASKS THE QUESTION DIRECTLY: it starts a real child process the
 * way the application starts one, gives it nothing else to keep it alive, and
 * requires it to EXIT. A child still running at the deadline is killed and the
 * suite fails with the elapsed time.
 *
 * A BEHAVIOURAL SUITE STILL ONLY COVERS WHAT ITS CHILDREN REQUIRE, and the
 * pre-merge audit proved that the hard way. The first version of this file had
 * two children — one requiring `src/longterm/db.js`, one requiring
 * `settings/store.js` — and CLAIMED that made it proof against "a second pool
 * somewhere else". It was not: a second pool added to `src/longterm/index.js`,
 * with no `allowExitOnIdle`, reintroduced the incident EXACTLY (the real db
 * suite hung and was killed at 45 seconds) while this file reported 7 of 7. A
 * plain ref'd `setInterval` in the same file did the same. Neither module was
 * inside either child's require graph — and `src/longterm/index.js` is
 * precisely the module the server mounts.
 *
 * Hence case 3, which requires WHAT THE APPLICATION REQUIRES rather than a
 * model of it. It is the case that actually holds the claim in this header, and
 * it is why the claim now names what the children reach instead of promising
 * something no child could see.
 *
 * Each case checks THREE things, because "the child exited" on its own is a
 * result a crash produces too:
 *   · it printed a marker carrying a VALUE ONLY THE DATABASE COULD HAVE
 *     RETURNED, so the child is known to have made a real round trip,
 *   · it exited with status 0,
 *   · it exited inside the budget.
 *
 * The marker carries a value on purpose. The first version printed a bare word
 * after the module's `query` export resolved, and the audit showed that a
 * stubbed `query` — a pool that never opens a socket at all — satisfied it. A
 * marker that a no-op can print proves nothing about the thing being guarded.
 *
 * DB-gated: without a database this skips, like every other *-db suite.
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { skipUnlessDb } = require('./lib/db-gate');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';

const ROOT = path.join(__dirname, '..');

/**
 * The budget.
 *
 * A correctly-behaving child exits as soon as its query settles — measured at
 * well under two seconds on CI-sized hardware. Twenty seconds is chosen to be
 * far above that and still far below `keepWarm`'s own fifteen-second steady
 * interval doubled, so a child that is genuinely held open cannot slip through
 * by getting lucky with timer alignment.
 */
const BUDGET_MS = (() => {
  const raw = Number(process.env.LT_POOL_EXIT_BUDGET_MS || 20000);
  // CLAMPED, because an override is the one way this guard could be turned off
  // without anybody editing it: a budget of an hour turns "the child never
  // exited" back into the sixty-minute hang this suite exists to catch, with a
  // green step until the job itself dies. The floor stops the opposite mistake.
  if (!Number.isFinite(raw)) return 20000;
  return Math.min(120000, Math.max(2000, Math.trunc(raw)));
})();

let PASS = 0;
let FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  ok - ' + m); } else { FAIL++; console.log('  FAIL - ' + m); } };

/**
 * Run a child that does `body`, and report how it ended.
 *
 * The child is given the SAME DATABASE_URL and is started with `cwd` at the
 * repository root so its requires resolve exactly as the application's do. It
 * is killed at the deadline rather than left behind, so a failing run of this
 * suite cannot itself leak the process it is complaining about.
 */
function runChild(body, budgetMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', body], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const t0 = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, budgetMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, out, err, ms: Date.now() - t0, timedOut });
    });
  });
}

(async () => {
  await skipUnlessDb('lt-pool-exit');

  try {
    // ---- 1. THE MECHANISM, MINIMAL -----------------------------------------
    // Long-Term's pool, one query, then a repeating re-query on an `unref`'d
    // timer — the shape `keepWarm` has, with the cadence tightened so the test
    // is quick and does not depend on any settings table existing. Nothing else
    // in this child holds the event loop: no server, no ref'd timer. If the
    // pool's idle socket keeps a process alive, this child never exits.
    const minimal = `
      const db = require('./src/longterm/db');
      // The marker carries the SERVER's own answer, not a word this child chose:
      // a stubbed \`query\` that never opens a socket cannot produce it.
      db.query("SELECT 'lt-pool-live' AS proof, pg_backend_pid() AS pid").then((r) => {
        const row = (r && r.rows && r.rows[0]) || {};
        console.log('QUERIED ' + row.proof + ' pid=' + row.pid);
        const t = setInterval(() => { db.query('SELECT 1').catch(() => {}); }, 200);
        if (t.unref) t.unref();
      }).catch((e) => { console.log('QUERY-FAILED ' + (e && e.message)); process.exit(3); });
    `;
    const a = await runChild(minimal, BUDGET_MS);
    ok(/QUERIED lt-pool-live pid=\d+/.test(a.out),
      'the pool made a REAL round trip in the child — the marker carries the server\'s own backend pid');
    ok(!a.timedOut, `a child holding only an idle long-term pool EXITS (took ${a.ms}ms, budget ${BUDGET_MS}ms)`);
    ok(a.code === 0, `it exits cleanly (code ${a.code}${a.signal ? ', signal ' + a.signal : ''})`
      + (a.err ? ` — stderr: ${a.err.trim().slice(0, 200)}` : ''));

    // ---- 2. THE PRODUCTION PATH --------------------------------------------
    // `src/longterm/index.js` calls exactly this at require time, so this is the
    // real thing the app does — not a model of it. `keepWarm` retries until a
    // clean read lands and then re-reads for as long as the process lives; the
    // warm-up must keep working AND the process must still be able to end.
    const warm = `
      const store = require('./src/longterm/settings/store');
      const warmth = store.keepWarm();
      // WAIT FOR THE READ, and print something the database returned. A
      // \`keepWarm\` that never queries — or one whose read is stubbed — cannot
      // get here, so this marker says the warm-up really touched the pool.
      Promise.resolve(warmth && warmth.ready).then(() => store.load('company')).then((c) => {
        console.log('WARMED keys=' + Object.keys(c || {}).length);
      }).catch((e) => { console.log('WARM-FAILED ' + (e && e.message)); process.exit(4); });
    `;
    const b = await runChild(warm, BUDGET_MS);
    ok(/WARMED keys=\d+/.test(b.out), 'the settings warm-up really read from the database in the child');
    ok(!b.timedOut, `a child running the long-term settings warm-up EXITS (took ${b.ms}ms, budget ${BUDGET_MS}ms)`);
    ok(b.code === 0, `it exits cleanly (code ${b.code}${b.signal ? ', signal ' + b.signal : ''})`
      + (b.err ? ` — stderr: ${b.err.trim().slice(0, 200)}` : ''));

    // ---- 3. WHAT THE APPLICATION ACTUALLY REQUIRES --------------------------
    // `src/server.js` mounts `src/longterm/index.js`, so THAT is the module a
    // real process loads — and the two children above never reach it. The
    // pre-merge audit put a second pool with no `allowExitOnIdle` in exactly
    // this file and reintroduced the incident in full (the real database suite
    // hung and was killed at 45 seconds) while this suite reported 7 of 7; a
    // plain ref'd `setInterval` here did the same. This case is what closes
    // that: it loads the long-term module whole, so a handle taken ANYWHERE in
    // it — a second pool, a ref'd timer, an open socket in a router — is caught.
    //
    // The marker is the module itself: `index.js` exports an Express router, so
    // requiring it and finding a mountable router proves the module really
    // loaded rather than throwing early.
    const mounted = `
      const lt = require('./src/longterm');
      const router = (lt && lt.router) || lt;
      console.log('MOUNTED router=' + (typeof router === 'function' ? 'yes' : 'no'));
    `;
    const c = await runChild(mounted, BUDGET_MS);
    ok(/MOUNTED router=yes/.test(c.out),
      'the long-term module the server mounts really loaded in the child'
      + (c.err ? ` — stderr: ${c.err.trim().slice(0, 200)}` : ''));
    ok(!c.timedOut, `a child that requires the whole long-term module EXITS (took ${c.ms}ms, budget ${BUDGET_MS}ms)`);
    ok(c.code === 0, `it exits cleanly (code ${c.code}${c.signal ? ', signal ' + c.signal : ''})`);

    // ---- 4. THE BUDGET IS A REAL DEADLINE, NOT A FORMALITY ------------------
    // A `runChild` that never timed anything out would make both cases above
    // pass by construction. This proves the harness kills a child that genuinely
    // will not end, so "it exited" above is a fact about the pool and not about
    // this file.
    const stuck = await runChild(`console.log('STUCK'); setInterval(() => {}, 1000);`, 1500);
    ok(/STUCK/.test(stuck.out) && stuck.timedOut,
      'a control child that really is held open is caught by the deadline');
  } catch (e) {
    console.error('THREW', (e && e.stack) || e);
    FAIL++;
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  // This suite's own process holds RTL's pool (opened by the database gate),
  // which does NOT allow exit on idle — end it rather than relying on it.
  try { await require('../src/db').pool.end(); } catch (_) { /* already gone */ }
  process.exit(FAIL ? 1 : 0);
})();
