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
 * NOT EVERY app-booting suite hung, and the exceptions are the tell. Measured over
 * THIRTY of them with the fix removed: 5 hung, 25 exited cleanly — about 17%, not
 * the "most" a first sample of five suggested. The ones that hung are exactly the
 * ones that rely on a NATURAL exit; the ones that survive end with an
 * unconditional `process.exit()`. Seventeen per cent is still every build, because
 * `npm test` is an `&&` chain and it stops at the first one.
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
 * Hence case 3, which requires the whole long-term module rather than a model of
 * it — and hence case 4, which requires WHAT THE APPLICATION REQUIRES: case 3 was
 * described that way and was not, because the application requires
 * `src/server.js`, not `src/longterm/index.js`. Case 4 boots the server and serves
 * a request, which is the only way to catch a pool built on FIRST USE rather than
 * at require time — proven by mutation: a pool built lazily on the request path
 * leaves this suite at 11/2, and only case 4 is red.
 *
 * ⛔ IT COVERS THAT SHAPE ONLY WHERE THE SERVED REQUEST REACHES IT, and this said
 * flatly that it covered `src/lib/dashboards/run.js`, "the shape it already has".
 * It did not: case 4 requests `/api/health`, which never calls that module's
 * `getPool()` (measured: 0 calls during the request), so the named example would
 * have sailed through at 13/0 — and that pool really did hold the process for 30
 * seconds after a single query. Naming an example a guard does not cover is how
 * the last one of these went unfixed for a day. The hazard is now closed at the
 * pool itself (`allowExitOnIdle`, see that file), which is the fix; case 4 covers
 * the FAMILY, on whatever the request path touches, which is the guard. Adding a
 * fifth child per lazily-built pool would be a list to keep in sync, and this
 * suite exists because such lists are not kept in sync.
 *
 * Each case checks THREE things, because "the child exited" on its own is a
 * result a crash produces too:
 *   · it printed its marker — and for the two children that assert a round trip
 *     that marker carries a VALUE ONLY THE DATABASE COULD HAVE RETURNED. The
 *     module-loading children prove only that the module loaded, which is all an
 *     exit test needs from them; an earlier version of this line said every case
 *     proved a round trip, and an audit passed one of them with the pool stubbed
 *     so no socket ever opened,
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
const fs = require('fs');
const path = require('path');
const { stripComments } = require('./lib/strip-comments.js');
const { spawn } = require('child_process');
const { skipUnlessDb } = require('./lib/db-gate');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap';

const ROOT = path.join(__dirname, '..');

/**
 * The budget.
 *
 * A correctly-behaving child exits as soon as its work settles. The three that
 * only require a module do so in well under a second (73–642 ms measured). THE
 * FOURTH DOES NOT: it boots the server, listens, and serves a real request, and
 * that costs 3.4–3.8 seconds on an idle machine with a local Postgres. Twenty
 * seconds is chosen to be far above the slowest of them and still far below
 * `keepWarm`'s own fifteen-second steady interval doubled, so a child that is
 * genuinely held open cannot slip through by getting lucky with timer alignment.
 *
 * ⛔ THE FLOOR WAS 2000 AND THIS PARAGRAPH STILL SAID "well under two seconds"
 * AFTER THE FOURTH CHILD LANDED — so the smallest budget the clamp would accept
 * was RED ON A CLEAN TREE (`LT_POOL_EXIT_BUDGET_MS=2000` → the boot child killed
 * at 2010 ms, 11 passed / 2 failed). A guard whose own permitted range contains a
 * false failure teaches the reader to widen the budget, which is the one thing
 * the clamp exists to prevent. The floor is now 8000: comfortably above the
 * slowest healthy child with room for a loaded CI runner, and still an order of
 * magnitude below the sixty-minute hang.
 */
const BUDGET_MS = (() => {
  const raw = Number(process.env.LT_POOL_EXIT_BUDGET_MS || 20000);
  // CLAMPED, because an override is the one way this guard could be turned off
  // without anybody editing it: a budget of an hour turns "the child never
  // exited" back into the sixty-minute hang this suite exists to catch, with a
  // green step until the job itself dies. The floor stops the opposite mistake.
  if (!Number.isFinite(raw)) return 20000;
  return Math.min(120000, Math.max(8000, Math.trunc(raw)));
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
      // ⛔ 'pipe', NOT 'ignore'. With 'ignore' the child's stdin is /dev/null and reaches EOF
      // at once, so a child held open by `process.stdin.resume()` was invisible to this
      // harness while hanging the real runner, whose stdin is a pipe (post-merge audit).
      // Left open and unwritten, exactly as the runner leaves it.
      stdio: ['pipe', 'pipe', 'pipe'],
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
    // ---- 0. EVERY POOL IN THE PRODUCT IS ACCOUNTED FOR ---------------------
    // The header above explains why this suite is behavioural and not a grep, and
    // that still holds: a string check cannot tell a live option from a renamed,
    // mis-spelled or dead one, and none of the children below is replaced by this.
    //
    // But a behavioural child only ever sees the pools its own require graph and
    // its one request actually touch, and `src/lib/dashboards/run.js` proved that
    // is not all of them — it builds its pool on FIRST USE, no child reached it,
    // and it held a process for a measured 30.09 s after a single query while this
    // suite sat at 13/0 (pre-merge audit 2026-09-03). The children answer "can a
    // process that has finished its work finish"; this answers the different
    // question "is there a pool nobody has thought about", which is the one that
    // let that hole exist. A new pool added tomorrow is caught here on the day it
    // is written rather than on the day somebody notices CI is slow.
    //
    // `src/db.js` IS THE ONE EXCEPTION, and it is named rather than pattern-matched
    // away, with the reason it is safe written next to it — a reason that has
    // already been wrong once (see CLAUDE.md).
    const POOL_EXCEPTIONS = {
      'src/db.js':
        "RTL's pool. Everything that re-queries it on a sub-30s unref'd timer "
        + '(`src/lib/flags.js`, `src/pipeline/worker.js`) is armed only below '
        + "`if (require.main === module)` in `src/server.js`, so it runs only where an "
        + 'HTTP listener already holds the process open. Narrow and fragile: calling '
        + '`flags.start()` from any script reproduces the sixty-minute hang.',
    };
    {
      const walk = (dir, out = []) => {
        for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
          const rel = dir + '/' + e.name;
          if (e.isDirectory()) { walk(rel, out); continue; }
          // ONLY `.js`, which is what `src/` is today (51 non-js files, all assets,
          // JSON, markdown and prisma — none constructs a pool). A `.mjs`, `.cjs` or
          // `.ts` file added tomorrow would be invisible here, so that is stated
          // rather than left as an unexamined edge of a rule about completeness.
          if (e.name.endsWith('.js')) out.push(rel);
        }
        return out;
      };
      // ⛔ PER CONSTRUCTION SITE, AND SPELLED HOW A POOL IS ACTUALLY SPELLED.
      // The first cut of this check did neither, and the post-merge audit walked
      // through both holes with a pool that really did hold a process for 30.07 s:
      //   · it matched the literal `new Pool(` only, so `new pg.Pool({…})` — the
      //     ordinary spelling when nobody destructures the import — was invisible,
      //     while the assertion printed "every pool in src/ is found and checked"
      //     and named three files;
      //   · it tested `allowExitOnIdle` ONCE PER FILE, so a second, unguarded pool
      //     added to a file that already had a guarded one was excused by its
      //     neighbour.
      // Both are the finding this suite's own commit was written to fix — "named as
      // covered and was not" — reintroduced inside the correction. So: every `new`
      // expression whose constructor ENDS in `Pool` is a site, each site's own
      // options object is what is read, and a construction the scanner cannot read
      // is a FAILURE rather than a silent pass.
      // A CONSTRUCTOR ENDING IN `Pool`, UNDER ANY NAME. The first cut required the
      // final identifier to BE `Pool` (or `x.Pool`) while its own comment said
      // "ends in Pool" — so `const { Pool: PgPool } = require('pg'); new PgPool({…})`
      // was invisible, at 22/0, under an assertion reading "every pool CONSTRUCTION
      // SITE in src/ is found". That is the third appearance of "named as covered and
      // was not", this time inside the correction of the correction, which is why the
      // sentinel checks below exist and why the assertion text no longer says
      // "every".
      const NEW_CTOR = /\bnew\s+((?:[A-Za-z_$][\w$]*\s*\.\s*)*[A-Za-z_$][\w$]*)\s*\(/g;
      // Two shapes NOTHING can read from source, so both are refused BY NAME rather
      // than silently passed: a computed constructor that mentions Pool, and `Pool`
      // rebound to a name that does not end in Pool (`const P = Pool`), which would
      // make every `new P(` invisible to the rule above.
      // Found by BALANCING rather than by `[^)]*`, which cannot cross the `)` in
      // `require('pg')` — the sentinel below caught that on the first run of this
      // very rewrite, which is the whole reason the sentinels are here.
      const NEW_COMPUTED_AT = /\bnew\s*\(/g;
      const POOL_ALIAS = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*Pool\s*[;,\n]|Pool\s*:\s*([A-Za-z_$][\w$]*)/;
      // BALANCED STRING-AWARE. This file adopted the string-aware stripper precisely
      // because a regex cannot tell a string from code — and then balanced parentheses
      // with a raw character scan, so `application_name: 'yscap (lt :) audit'` truncated
      // the options and failed a correctly guarded pool. Same mistake, ten lines apart.
      const argsAt = (src, openIdx) => {
        let depth = 0, k = openIdx;
        while (k < src.length) {
          const c = src[k];
          if (c === "'" || c === '"' || c === '`') {
            const q = c; k += 1;
            while (k < src.length) {
              if (src[k] === '\\') { k += 2; continue; }
              if (src[k] === q) { k += 1; break; }
              k += 1;
            }
            continue;
          }
          if (c === '(') depth += 1;
          else if (c === ')') { depth -= 1; if (depth === 0) return src.slice(openIdx, k + 1); }
          k += 1;
        }
        return null;                      // unbalanced: unreadable, never "unguarded"
      };
      // `new (<expr>)(…)` where <expr> mentions Pool. The expression is read by the
      // same balanced scan, so `new (require('pg').Pool)(` — whose inner `)` defeats
      // any `[^)]*` — is seen.
      const computedPoolCtor = (src) => {
        NEW_COMPUTED_AT.lastIndex = 0;
        let m;
        while ((m = NEW_COMPUTED_AT.exec(src))) {
          const expr = argsAt(src, m.index + m[0].length - 1);
          if (expr && /\bPool\b/.test(expr)) return true;
        }
        return false;
      };
      const files = walk('src');
      const sites = [];
      const unreadable = [];
      for (const f of files) {
        const src = stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
        const mentionsPool = /\bPool\b/.test(src);
        if (mentionsPool && computedPoolCtor(src)) unreadable.push(`${f} (computed constructor)`);
        if (mentionsPool) {
          const al = POOL_ALIAS.exec(src);
          const alias = al && (al[1] || al[2]);
          if (alias && !/Pool$/.test(alias)) unreadable.push(`${f} (Pool renamed to \`${alias}\`, which no rule can follow)`);
        }
        NEW_CTOR.lastIndex = 0;
        let m;
        while ((m = NEW_CTOR.exec(src))) {
          const ctor = m[1].replace(/\s/g, '');
          if (!/(^|\.)\w*Pool$/.test(ctor)) continue;
          const args = argsAt(src, m.index + m[0].length - 1);
          if (args === null) { unreadable.push(`${f} (unbalanced parentheses after \`new ${ctor}\`)`); continue; }
          // Options passed as a variable cannot be read here. That is UNREADABLE, not
          // unguarded — the first cut reported it as "does not release the process",
          // which accuses a file of a leak it may not have.
          if (!/\{/.test(args)) { unreadable.push(`${f} (\`new ${ctor}\` options come from a variable, not a literal)`); continue; }
          sites.push({ file: f, ctor, args });
        }
      }
      const byFile = [...new Set(sites.map((x) => x.file))];
      ok(sites.length >= 3 && byFile.length >= 3,
        `the pool construction sites this guard can read are found and read one by one (${sites.length} site(s) in ${byFile.length} file(s): ${byFile.join(', ')})`);
      ok(unreadable.length === 0,
        `and no file builds a pool in a shape this guard cannot read (${unreadable.length ? unreadable.join('; ') : 'none'})`);
      // SENTINELS. The rule above is a regex over source, so its real coverage is
      // whatever these say it is — not whatever the sentence above claims. Each is the
      // spelling that has ALREADY escaped a version of this guard.
      {
        const probe = (text) => {
          NEW_CTOR.lastIndex = 0;
          let hit = 0, mm;
          while ((mm = NEW_CTOR.exec(text))) if (/(^|\.)\w*Pool$/.test(mm[1].replace(/\s/g, ''))) hit += 1;
          return hit;
        };
        for (const [label, text] of [
          ['new Pool({})', 'const a = new Pool({ x: 1 });'],
          ['new pg.Pool({})', 'const a = new pg.Pool({ x: 1 });'],
          ['new PgPool({}) — the rename that escaped', 'const a = new PgPool({ x: 1 });'],
          ['new  Pool\n({}) — odd whitespace', 'const a = new  Pool\n({ x: 1 });'],
        ]) ok(probe(text) === 1, `the site rule sees ${label}`);
        ok(probe('const a = new Widget({ x: 1 });') === 0, 'and does not fire on an unrelated constructor');
        ok(computedPoolCtor("const a = new (require('pg').Pool)({});"),
          'the computed-constructor rule sees `new (require(\'pg\').Pool)(` — its inner `)` defeats any [^)]* pattern');
        ok(!computedPoolCtor('const x = new (Widget)(1);'), 'and does not fire on a computed constructor with no Pool in it');
        ok(argsAt("new Pool({ application_name: 'a) b', max: 2 })", 8) === "({ application_name: 'a) b', max: 2 })",
          'the argument reader is string-aware — a `)` inside an option value does not truncate it');
      }
      for (const site of sites) {
        const guarded = /allowExitOnIdle\s*:\s*true/.test(site.args);
        const excused = Object.prototype.hasOwnProperty.call(POOL_EXCEPTIONS, site.file);
        ok(guarded || excused,
          `the pool at ${site.file} either releases the process when idle, or its file is a NAMED exception with its reason written down`);
        ok(!(guarded && excused),
          `${site.file} is not both guarded and excused — an exception that no longer applies is a stale reason somebody will trust`);
      }
      for (const f of Object.keys(POOL_EXCEPTIONS)) {
        ok(byFile.includes(f), `the named exception ${f} still creates a pool — a stale entry would excuse a file that moved`);
      }
    }

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

    // ---- 4. WHAT THE SERVER ACTUALLY LOADS, AND A REQUEST THROUGH IT --------
    // The three children above reach `src/longterm/**` and nothing else, so two whole
    // families of handle escaped them (post-merge audit):
    //   · a handle taken anywhere in the RTL half — the application requires
    //     `src/server.js`, which loads both products; a second pool at require time
    //     there left this suite at 10/10 while the real db suite showed the exact CI
    //     signature (14 assertions, then killed at 60s);
    //   · a pool created LAZILY on first use rather than at require time, because no
    //     child ever made a REQUEST. That is not hypothetical:
    //     `src/lib/dashboards/run.js` is exactly that shape today.
    // This child does what a database suite does — require the server, listen, make one
    // request, close, end RTL's pool — and then has to exit like any of them.
    const booted = `
      const http = require('http');
      const app = require('./src/server');
      const server = http.createServer(app);
      server.listen(0, async () => {
        const port = server.address().port;
        // One real request through a real router, so a pool built on first use is built.
        let status = 0;
        try {
          const res = await fetch('http://127.0.0.1:' + port + '/api/health');
          status = res.status;
        } catch (e) { status = -1; }
        console.log('SERVED status=' + status);
        server.close();
        try { await require('./src/db').pool.end(); } catch (_) {}
      });
    `;
    const d = await runChild(booted, BUDGET_MS);
    ok(/SERVED status=\d+/.test(d.out),
      `the child really booted the server and served a request (${(d.out.match(/SERVED status=-?\d+/) || ['no marker'])[0]})`
      + (d.err ? ` — stderr: ${d.err.trim().slice(0, 200)}` : ''));
    ok(!d.timedOut, `a child that boots the whole app and serves a request EXITS (took ${d.ms}ms, budget ${BUDGET_MS}ms)`);
    ok(d.code === 0, `it exits cleanly (code ${d.code}${d.signal ? ', signal ' + d.signal : ''})`);

    // ---- 5. THE BUDGET IS A REAL DEADLINE, NOT A FORMALITY ------------------
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
