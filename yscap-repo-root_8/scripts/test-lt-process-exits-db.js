'use strict';

// =============================================================================
// A PROCESS THAT MERELY LOADS THE LONG-TERM MODULE MUST BE ABLE TO EXIT
// =============================================================================
//
// WHY THIS SUITE EXISTS, and it is not a hypothetical. The full test run was
// killed at its one-hour cap three times, on main as well as on pull requests,
// with NOTHING failing. The chain had stalled seven minutes in, inside
// `scripts/test-draw-findings-public.js`, with that suite's 14 of 14 assertions
// already PASSED — and the ~1,300 suites behind it never ran, so no deploy went
// out. Nothing was slow. One socket was open.
//
// THE SHAPE OF THE FAULT. Long-Term warms the company settings at require time
// and re-reads them every 15s, so any process that requires `src/longterm` opens
// a connection on Long-Term's OWN pool (`src/longterm/db.js`, deliberately not
// `src/db`). An open TCP socket is a live libuv handle, so Node cannot exit while
// it rests there; the pool's 30s idle timeout would have closed it, but the 15s
// re-read touches the connection first, so it never goes idle. A suite that ends
// by letting Node exit — most of them — then waits for ever. The fix is
// `allowExitOnIdle` on that pool; this is what keeps the fix honest.
//
// WHY A CHILD PROCESS AND NOT A HANDLE COUNT. "Which handles are open" is a
// question with a shifting answer, and every version of it I could write here
// passes while the real thing hangs. Whether a process can EXIT is the property
// that actually broke, so it is the property this measures: spawn a child, let it
// do exactly what a test does, and give it a deadline. It fails the way the build
// failed — by running out of time — which is also what makes it readable.
//
// DB-gated: skips cleanly when DATABASE_URL is unset, like the other -db suites.
// PLACED EARLY IN THE CHAIN ON PURPOSE. A regression here costs the whole run, so
// it must be caught in the first minute rather than at minute sixty.

if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-process-exits (no DATABASE_URL)'); process.exit(0); }

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
// GENEROUS ON PURPOSE. The fault this catches is unbounded — the process never
// exits at all — so the deadline only has to separate "finishes" from "never".
// A slow CI runner loading Express and the whole Long-Term tree is nowhere near
// this, and a deadline set close to the real duration is a second stopwatch to
// race. Overridable so a very slow machine can raise it without editing code.
const DEADLINE_MS = Number(process.env.LT_EXIT_DEADLINE_MS || 45000);

let PASS = 0; let FAIL = 0;
const ok = (c, m) => { if (c) { PASS++; console.log('  ok -', m); } else { FAIL++; console.log('  FAIL -', m); } };

/**
 * Run `node -e <src>` and report how it ended: exited by itself, or had to be
 * killed. Never throws — a spawn that fails is a FAIL with a reason, not a stack.
 */
function runChild(src, deadlineMs = DEADLINE_MS) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['-e', src], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, deadlineMs);
    let killed = false;
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ exited: false, code: null, ms: Date.now() - started, out: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exited: !killed, code, ms: Date.now() - started, out });
    });
  });
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

(async () => {
  console.log('a process that loads Long-Term can still exit');

  // ---------------------------------------------------------------------------
  // 1. The minimum case: require the module and do nothing else.
  //
  // This is the one that broke. `src/longterm/index.js` starts the settings warm
  // loop and the sync worker at require time, and neither may hold the process.
  // ---------------------------------------------------------------------------
  {
    const r = await runChild("require('./src/longterm/index.js');");
    ok(r.exited, `requiring the Long-Term module exits by itself (${secs(r.ms)}${r.exited ? '' : ` — KILLED at the ${secs(DEADLINE_MS)} deadline`})`);
    ok(r.exited && r.code === 0, `…and exits 0 (code ${r.code})`);
    if (!r.exited) console.log(String(r.out).split('\n').slice(-6).join('\n'));
  }

  // ---------------------------------------------------------------------------
  // 2. After a real query on Long-Term's own pool.
  //
  // A connection that was never USED could be excused; one that has served a
  // query and gone back to the pool is the state the build hung in.
  // ---------------------------------------------------------------------------
  {
    const r = await runChild(
      "const db = require('./src/longterm/db.js');"
      + "db.query('select 1 as one').then((x) => console.log('rows', x.rows.length))"
      + ".catch((e) => { console.error('QUERY FAILED', e && e.message); process.exitCode = 3; });",
    );
    ok(r.exited, `a query on Long-Term's pool does not pin the process (${secs(r.ms)}${r.exited ? '' : ' — KILLED'})`);
    ok(r.exited && r.code === 0 && /rows 1/.test(r.out),
      `…and the query really ran, so the exit is not a silent failure (code ${r.code})`);
    if (!r.exited || r.code !== 0) console.log(String(r.out).split('\n').slice(-6).join('\n'));
  }

  // ---------------------------------------------------------------------------
  // 3. THE GUARD MUST BE ABLE TO FAIL. A test that only ever watches processes
  //    exit proves nothing about its own deadline, so hold one open deliberately
  //    with an ordinary ref'd timer and require that this suite notices.
  //
  //    ON ITS OWN SHORT DEADLINE. The property being proved is that a pinned
  //    process is REPORTED as pinned, and two seconds proves that as well as
  //    forty-five do — spending the full deadline here would add most of a minute
  //    to every run of a suite whose whole purpose is to protect the clock.
  // ---------------------------------------------------------------------------
  {
    const r = await runChild('setTimeout(() => {}, 600000);', 2000);
    ok(!r.exited, 'a process that IS pinned open is reported as pinned — the deadline bites');
  }

  // ---------------------------------------------------------------------------
  // 4. Say WHY, in the file, so the next person changing the pool is told.
  // ---------------------------------------------------------------------------
  {
    const src = require('fs').readFileSync(path.join(ROOT, 'src/longterm/db.js'), 'utf8');
    ok(/allowExitOnIdle:\s*true/.test(src),
      "src/longterm/db.js still sets allowExitOnIdle — the setting checks 1-3 depend on");
  }

  console.log(`\n${PASS} passed, ${FAIL} failed`);
  if (FAIL) process.exit(1);
})();
