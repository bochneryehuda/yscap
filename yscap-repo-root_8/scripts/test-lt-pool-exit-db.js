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
 * to `false`, moved into a branch that does not run, or overridden by a second
 * pool somewhere else. It also says nothing about the only thing anybody cares
 * about, which is whether a process that has finished its work can finish.
 *
 * So this suite ASKS THE QUESTION DIRECTLY: it starts a real child process the
 * way the application starts one, gives it nothing else to keep it alive, and
 * requires it to EXIT. A child still running at the deadline is killed and the
 * suite fails with the elapsed time.
 *
 * Each case checks THREE things, because "the child exited" on its own is a
 * result a crash produces too:
 *   · it printed the marker that says its database work really happened,
 *   · it exited with status 0,
 *   · it exited inside the budget.
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
const BUDGET_MS = Number(process.env.LT_POOL_EXIT_BUDGET_MS || 20000);

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
      db.query('SELECT 1').then(() => {
        console.log('QUERIED');
        const t = setInterval(() => { db.query('SELECT 1').catch(() => {}); }, 200);
        if (t.unref) t.unref();
      }).catch((e) => { console.log('QUERY-FAILED ' + (e && e.message)); process.exit(3); });
    `;
    const a = await runChild(minimal, BUDGET_MS);
    ok(/QUERIED/.test(a.out), 'the pool really answered a query in the child (not a crash before the work)');
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
      store.keepWarm();
      console.log('WARMING');
    `;
    const b = await runChild(warm, BUDGET_MS);
    ok(/WARMING/.test(b.out), 'the settings warm-up really started in the child');
    ok(!b.timedOut, `a child running the long-term settings warm-up EXITS (took ${b.ms}ms, budget ${BUDGET_MS}ms)`);
    ok(b.code === 0, `it exits cleanly (code ${b.code}${b.signal ? ', signal ' + b.signal : ''})`
      + (b.err ? ` — stderr: ${b.err.trim().slice(0, 200)}` : ''));

    // ---- 3. THE BUDGET IS A REAL DEADLINE, NOT A FORMALITY ------------------
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
