#!/usr/bin/env node
'use strict';
/**
 * LT PPE - THE RUNNER'S DATABASE CLAIM MUST BE EARNED (§2.81).
 *
 * OFFLINE: pure. No database, no vendor call. It runs the REAL aggregate runner against a stand-in
 * suite directory, so what is asserted is what a person would actually read.
 *
 * ⛔ REPRODUCED 2026-08-18 — the tenth instance of this runner's own class. The scratch Postgres
 * crashed mid-run. Nineteen suites failed, twenty-five ECONNREFUSED lines scrolled past, and the
 * summary read:
 *
 *     136/150 LT PPE suites passed
 *     ✓ all 31 database-backed suites ran against a real Postgres.
 *
 * Both sentences are literally true about what they measure and together they are a lie about what a
 * reader is asking. The reassurance was guarded on `skipped.length`, and `skipped` only ever collected
 * suites that PASSED while announcing a skip — a suite that FAILED to connect could never be in it. So
 * the one sentence whose entire purpose is to say "your database coverage is real" said exactly that
 * about coverage that had not happened.
 *
 * AND THE SHARPER HALF: `LT_REQUIRE_DB=1` — the flag CI sets to GUARANTEE database coverage — computed
 * its `unproven` count from that same list. With the database down, `unproven` was 0 and the flag was
 * satisfied. The run failed for other reasons that day; a suite that swallowed its connection error and
 * exited 0 would have made it pass outright.
 *
 * THE ONE ASYMMETRY THAT MAKES THIS SAFE: only a FAILING suite is ever called `unreachable`. Several
 * suites here deliberately assert on connection-failure wording while proving something fails closed,
 * and reclassifying a PASSING suite on the strength of a string in its output is the match-a-word trap
 * `skipLine` already documents. Section D proves that directly.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const scan = require(path.join(SCRIPTS, 'lt-suite-scan'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const says = (out, re, what) => ok(re.test(out), `${what}\n      --- runner said ---\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
const silent = (out, re, what) => ok(!re.test(out), `${what}\n      --- runner said ---\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);

// ---------------------------------------------------------------------------
// A stand-in suite directory. The runner globs `test-lt-ppe-*` out of ITS OWN directory, so the whole
// runner + the shared scan module are copied into a temp dir and pointed at fake suites. Running the
// real one would take ten minutes and would depend on a database — which is the thing under test.
// ---------------------------------------------------------------------------
function stage(suites) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-runner-'));
  for (const f of ['test-lt-ppe-all.js', 'lt-suite-scan.js']) {
    fs.copyFileSync(path.join(SCRIPTS, f), path.join(dir, f));
  }
  for (const [name, body] of Object.entries(suites)) fs.writeFileSync(path.join(dir, name), body, 'utf8');
  return dir;
}

// A stand-in suite the scanner counts as database-backed: it must NAME the environment variable in its
// own source, which is `needsDb`'s rule — read from the source, never from the filename.
//
// ⛔ THE TOKEN IS ASSEMBLED, NOT SPELLED, and that is honesty rather than evasion. `needsDb` reads
// SOURCE, so writing it whole here would make THIS suite count as database-backed — and it needs no
// database at all. It would then be classified `proved`, and the runner's own count would claim one
// more suite had proven something against a real Postgres than actually had: the exact defect this file
// exists to close, committed by the file that closes it. The generated fixture still carries the real
// token, so the scanner sees precisely what it is meant to see.
const DB_ENV_TOKEN = `process.env.${'DATABASE'}_URL`;
const dbSuite = (body) => `#!/usr/bin/env node\n'use strict';\nconst _dbUrl = ${DB_ENV_TOKEN};\n${body}\n`;

const PROVES = dbSuite("console.log('ok - proved against a real Postgres (3 assertions)');\nprocess.exit(0);");
const UNREACHABLE = dbSuite("console.log('FAIL - store\\n  connect ECONNREFUSED /tmp/pgrun/.s.PGSQL.5439');\nprocess.exit(1);");
const ANNOUNCES_SKIP = dbSuite("console.log('skipped — set DATABASE_URL to run it');\nprocess.exit(0);");
const FAILS_ON_ITS_OWN = dbSuite("console.log('FAIL - store (1 passed, 2 failed)\\n  B3 the row was written');\nprocess.exit(1);");
const PURE_OK = "#!/usr/bin/env node\n'use strict';\nconsole.log('OFFLINE: all passed (2 passed, 0 failed)');\nprocess.exit(0);\n";

function run(suites, env = {}) {
  const dir = stage(suites);
  const r = spawnSync(process.execPath, [path.join(dir, 'test-lt-ppe-all.js')], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://x@localhost:1/none', LT_REQUIRE_DB: '', ...env },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return { out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status };
}

const REASSURANCE = /✓ all \d+ database-backed suites ran against a real Postgres/;

// ---------------------------------------------------------------------------
// A - THE REPRODUCTION. A database-backed suite that could not connect must not be covered by the ✓.
// ---------------------------------------------------------------------------
{
  const { out, code } = run({
    'test-lt-ppe-fake-a.js': PROVES,
    'test-lt-ppe-fake-b.js': UNREACHABLE,
    'test-lt-ppe-fake-c.js': PURE_OK,
  });
  silent(out, REASSURANCE,
    'A1 THE FIX: the runner does NOT claim every database-backed suite ran, when one could not reach a database');
  says(out, /proved NOTHING against a database/, 'A2 …it says so plainly instead');
  says(out, /test-lt-ppe-fake-b\.js — unreachable/, 'A3 …names the suite');
  says(out, /could not reach a database at all/, 'A4 …and says what to check, since DATABASE_URL was set');
  says(out, /1 of 2 did prove something/, 'A5 …with the honest partial figure beside it, never rounded up');
  eq(code, 1, 'A6 the run still fails, as it did before — this changes the REPORT, not the verdict');
}

// ---------------------------------------------------------------------------
// B - THE FLAG MEANS WHAT IT SAYS. `LT_REQUIRE_DB=1` exists to guarantee coverage in CI.
// ---------------------------------------------------------------------------
{
  const { out } = run({ 'test-lt-ppe-fake-a.js': PROVES, 'test-lt-ppe-fake-b.js': UNREACHABLE }, { LT_REQUIRE_DB: '1' });
  says(out, /LT_REQUIRE_DB=1 and 1 suite\(s\) did not prove anything against a database/,
    'B1 the require-db gate counts a suite that could not connect — it used to count only announced skips');

  // A suite that FAILS FOR ITS OWN REASONS is unproven too: from here we cannot tell whether it reached
  // the database, and "is the coverage real" is answered no while any of it is red.
  const own = run({ 'test-lt-ppe-fake-a.js': PROVES, 'test-lt-ppe-fake-d.js': FAILS_ON_ITS_OWN }, { LT_REQUIRE_DB: '1' });
  says(own.out, /LT_REQUIRE_DB=1 and 1 suite\(s\) did not prove anything/,
    'B2 …and a database suite that failed for its own reasons, because we cannot claim it got that far');
  says(own.out, /may still have reached the database/,
    'B3 …stated as the uncertainty it is, not as an outage we did not measure');
}

// ---------------------------------------------------------------------------
// C - A CLEAN RUN IS UNCHANGED. If the reassurance stopped appearing when it is true, every future
//     reader would learn to ignore this block — which is the defect one step further on.
// ---------------------------------------------------------------------------
{
  const { out, code } = run({ 'test-lt-ppe-fake-a.js': PROVES, 'test-lt-ppe-fake-e.js': PROVES, 'test-lt-ppe-fake-c.js': PURE_OK });
  says(out, REASSURANCE, 'C1 every database-backed suite proving something still earns the ✓');
  says(out, /✓ all 2 database-backed suites/, 'C2 …counting the ones that PROVED, not the ones that existed');
  silent(out, /proved NOTHING/, 'C3 …with no warning invented on a clean run');
  eq(code, 0, 'C4 …and the run passes');

  // The announced-skip case still reports, and now through the same one definition.
  const sk = run({ 'test-lt-ppe-fake-a.js': PROVES, 'test-lt-ppe-fake-f.js': ANNOUNCES_SKIP });
  silent(sk.out, REASSURANCE, 'C5 an announced skip still suppresses the reassurance');
  says(sk.out, /test-lt-ppe-fake-f\.js — skipped/, 'C6 …and is named with its own reason');

  // No DATABASE_URL at all: the pre-existing branch, untouched.
  const nodb = run({ 'test-lt-ppe-fake-a.js': PROVES }, { DATABASE_URL: '' });
  says(nodb.out, /need a REAL Postgres and DATABASE_URL is not set/,
    'C7 the no-database branch is byte-for-byte the message it always was');
  silent(nodb.out, REASSURANCE, 'C8 …and claims nothing');
}

// ---------------------------------------------------------------------------
// D - THE ASYMMETRY. A PASSING suite is never reclassified by a string in its output — several suites
//     here assert on connection-failure wording while proving something fails closed.
// ---------------------------------------------------------------------------
{
  const ASSERTS_ON_THE_WORDING = dbSuite(
    "console.log('ok - lt ppe store fail-closed (9 assertions)\\n  an ECONNREFUSED is reported, never swallowed');\nprocess.exit(0);",
  );
  const { out, code } = run({ 'test-lt-ppe-fake-a.js': PROVES, 'test-lt-ppe-fake-g.js': ASSERTS_ON_THE_WORDING });
  says(out, REASSURANCE,
    'D1 a suite that PASSES while quoting a connection error is proof, not an outage — the match-a-word trap, closed');
  eq(code, 0, 'D2 …and the run passes');

  // The classifier's own truth table, directly.
  eq(scan.classifyDbRun('x', { status: 0, stdout: 'ECONNREFUSED everywhere' }).status, 'proved',
    'D3 the rule is exit-code FIRST — the signature can only ever explain a failure that already happened');
  eq(scan.classifyDbRun('x', { status: 1, stdout: 'ECONNREFUSED' }).status, 'unreachable', 'D4 …and it does explain one');
  eq(scan.classifyDbRun('x', { status: 1, stdout: 'FAIL - B3 the row' }).status, 'failed', 'D5 …without over-claiming on an ordinary failure');
  eq(scan.classifyDbRun('x', { status: 0, stdout: 'skipped — set DATABASE_URL to run it' }).status, 'skipped', 'D6 …and an announced skip is still its own thing');

  // The signature is read on stderr too: a crashing pg client usually throws there.
  eq(scan.classifyDbRun('x', { status: 1, stdout: '', stderr: 'Error: connect ECONNREFUSED' }).status, 'unreachable',
    'D7 stderr counts — a thrown connection error rarely reaches stdout');

  // And the roll-up refuses to answer "all proved" about an empty set.
  eq(scan.dbCoverage([]).allProved, false, 'D8 no database-backed suites at all is not "all of them proved"');
  eq(scan.dbCoverage([{ file: 'a', status: 'proved' }]).allProved, true, 'D9 …while one that did is');
}

console.log(failures.length
  ? `FAIL - lt ppe runner db claim (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe runner db claim (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
