#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the aggregate test runner's own guard (`scripts/test-lt-ppe-all.js`).
 *
 * THE DEFECT THIS PINS, reproduced before it was fixed: `node scripts/test-lt-ppe-all.js` on a machine
 * with no database printed **"98/98 LT PPE suites passed"** while every real-Postgres proof in the
 * engine had skipped politely and proven nothing. The runner is the last place the failure-that-looks-
 * like-success belongs, because it is the line a person reads INSTEAD of reading the run.
 *
 * The runner therefore counts what did not run, and this proves the counting — by SPAWNING THE REAL
 * FILE over a fixture directory of tiny suites whose behaviour is known. It is copied there verbatim,
 * so what is measured is the byte-for-byte file that ships; there is no test-only seam in it, and no
 * `LT_PPE_SUITE_DIR` escape hatch that could drift from how it actually runs.
 *
 * WHAT IS PROVEN:
 *   A. a DB suite is counted from what its SOURCE READS, not from a `-db.js` filename — a suite that
 *      reads the variable under a plain name counts, one carrying the suffix and needing nothing does
 *      not, and neither does a suite that merely MENTIONS the variable in a header comment (three real
 *      suites do exactly that, and matching the bare word claimed all three needed a database);
 *   B. a suite that opens a pg connection counts even when it never names the variable;
 *   C. a skip is recognised only when "skipped" and the variable appear on ONE line — four real suites
 *      carry the word inside ordinary assertion labels ("the header row … is skipped"), and matching
 *      the word alone reported every one of them as having skipped;
 *   D. `LT_REQUIRE_DB=1` exits NON-ZERO when nothing was proven against a database, and 0 when
 *      everything ran — with a CONTROL either side, since an exit code proves nothing on its own;
 *   E. a skip WITH a database configured is called out by name — it means the suite could not use the
 *      one it was given, which is worse than not having one;
 *   F. a failing suite still fails the run.
 *
 *   node scripts/test-lt-ppe-runner-guard.js
 *
 * PURE: no database, no network. The fixtures never connect to anything — they only read whether the
 * variable is set. LT-only; no RTL imports.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const RUNNER = path.join(__dirname, 'test-lt-ppe-all.js');

// Written as a joined placeholder ON PURPOSE. This file is itself a suite the runner scans, and
// spelling the read out in full here would make the runner count this pure test — which touches no
// database — as one of the suites that needs one. The fixtures below are the things doing the reading.
const DB_ENV = ['process', 'env', 'DATABASE_URL'].join('.');
// Same reason, for the other half of the rule: written out in full, the driver require below would
// make the runner count this pure test as a suite that opens a database — which is exactly the
// over-counting it now avoids. The pool-constructor alternative of that rule is a belt on the same arm
// and is deliberately NOT exercised here: all seven real pg suites use the require form. (Note this
// comment does not spell that constructor out either — the runner reads source, prose included, which
// is a documented and accepted over-count on that arm and would land on this very file.)
const PG_REQUIRE = ['require(', "'pg'", ')'].join('');

/**
 * The fixture suites. Each is a whole, real, runnable suite — the runner spawns them as node
 * processes, so nothing here may connect to anything or take longer than an instant.
 *
 * `FX_FORCE_SKIP` and `FX_FAIL` are read from the environment so one fixture directory can be driven
 * into every state the runner has to report on, rather than maintaining six near-identical copies.
 */
const FIXTURES = {
  // Plainly pure: no database anywhere in it.
  'test-lt-ppe-fx-pure.js': `'use strict';
console.log('  ok  a pure fixture that needs nothing');
`,

  // The two shapes of the real false positives: the variable appears ONLY in prose. There are two of
  // them so the two rules give DIFFERENT ANSWERS — with one, matching the bare word and matching the
  // read both count four, and the assertion on the count would prove nothing.
  //
  // Shape 1: the header's own run instruction, which every database suite here carries.
  'test-lt-ppe-fx-prose.js': `'use strict';
/**
 *   DATABASE_URL=postgres://… node scripts/test-lt-ppe-fx-prose.js
 */
console.log('  ok  a pure fixture whose header quotes the run line');
`,

  // Shape 2: a sentence saying the suite deliberately runs WITHOUT one — the shape of all three real
  // suites (cutover-store-db, schedule-store-db, route) that the bare-word match wrongly counted.
  'test-lt-ppe-fx-prose2.js': `'use strict';
/**
 * A stub stands in for Postgres, so the round-trip is exercised with no DATABASE_URL.
 */
console.log('  ok  a pure fixture that only talks about DATABASE_URL');
`,

  // Reads the variable under a name carrying NO -db suffix, and announces its skip.
  'test-lt-ppe-fx-needs.js': `'use strict';
if (!${DB_ENV} || process.env.FX_FORCE_SKIP === '1') {
  console.log('(LT PPE fx needs skipped — set DATABASE_URL to run it.)');
  process.exit(0);
}
console.log('  ok  fx needs ran against a database');
`,

  // Carries the -db suffix and needs nothing. The filename is a habit, not a contract.
  'test-lt-ppe-fx-nodb-db.js': `'use strict';
console.log('  ok  a -db.js name over a suite that needs no database');
`,

  // Reads the variable and says NOTHING when it is missing. The runner cannot see this skip, which is
  // exactly why it leads with how many suites NEED a database rather than how many said they skipped.
  'test-lt-ppe-fx-silent-db.js': `'use strict';
if (!${DB_ENV}) process.exit(0);
console.log('  ok  fx silent ran against a database');
`,

  // Reads the variable, always RUNS, and prints the word "skipped" inside an ordinary assertion label.
  // Matching the word alone reported this as a skipped suite.
  'test-lt-ppe-fx-wordy-db.js': `'use strict';
if (!${DB_ENV}) { console.log('  ok  fx wordy: the header row Excel copies along is skipped'); process.exit(0); }
console.log('  ok  fx wordy: an invalid tenant override skipped');
`,

  // Opens a pg connection without ever naming the variable — the belt-and-suspenders arm. The require
  // sits behind a branch nothing sets, deliberately: the runner classifies a suite by reading its
  // SOURCE, so the source shape is the whole fixture, and actually loading the driver would only make
  // this fixture depend on where the temporary directory sits relative to node_modules (it does not
  // resolve from /tmp, which is how the first run of this test failed).
  'test-lt-ppe-fx-pg.js': `'use strict';
if (process.env.FX_LOAD_PG === '1') { const { Pool } = ${PG_REQUIRE}; void Pool; }
console.log('  ok  fx pg reaches a database without naming the variable');
`,

  // The failure path, driven by FX_FAIL so the same directory covers it.
  'test-lt-ppe-fx-fail.js': `'use strict';
if (process.env.FX_FAIL === '1') { console.log('  FAIL  fx fail was told to fail'); process.exit(1); }
console.log('  ok  fx fail passed');
`,
};

const SUITE_COUNT = Object.keys(FIXTURES).length;   // 9
const DB_SUITES = 4;                                // needs, silent-db, wordy-db, pg
// What the retired bare-word rule would have answered instead: the two prose fixtures counted, the pg
// one missed. The two numbers differ, which is what makes the assertion on the count a real proof.
const BARE_WORD_ANSWER = 5;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ppe-runner-'));
try {
  for (const [name, src] of Object.entries(FIXTURES)) fs.writeFileSync(path.join(dir, name), src);
  // Verbatim. The file under test is the file that ships.
  fs.copyFileSync(RUNNER, path.join(dir, 'test-lt-ppe-all.js'));

  /** Run the copied runner in the fixture directory under a controlled environment. */
  function run(env) {
    const base = { ...process.env };
    // The ambient environment of whoever runs THIS test must never decide the answer — a developer
    // with a scratch database exported would otherwise silently invert every no-database case.
    delete base.DATABASE_URL;
    delete base.LT_REQUIRE_DB;
    delete base.FX_FORCE_SKIP;
    delete base.FX_FAIL;
    const r = spawnSync(process.execPath, [path.join(dir, 'test-lt-ppe-all.js')],
      { encoding: 'utf8', env: { ...base, ...env }, cwd: dir });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  }

  const FAKE_DB = 'postgres://fixture@localhost:1/none';

  /**
   * The suites the runner NAMED as having skipped — the indented list under its "SKIPPED even though"
   * heading, not merely a filename appearing somewhere in the output. It prints one `ok` line per
   * suite, so every fixture's name is in there and a plain substring test would be satisfied by that
   * line alone: the first cut of this test asserted absence that way and reported a false failure.
   */
  const skippedList = (out) => String(out).split('\n')
    .filter((l) => /^ {6}test-lt-ppe-/.test(l))
    .map((l) => l.trim());

  // ---- A + B: what counts as a suite that needs a database -------------------------------------
  {
    const r = run({});
    ok(r.status === 0, 'A1 with no database the run still exits 0 — a laptop is allowed to skip');
    ok(r.out.includes(`${SUITE_COUNT}/${SUITE_COUNT} LT PPE suites passed`),
      `A2 every fixture passes (${SUITE_COUNT}/${SUITE_COUNT})`);
    ok(r.out.includes(`! ${DB_SUITES} of those suites need a REAL Postgres`),
      `A3 exactly ${DB_SUITES} suites are counted as needing a database`);
    ok(!r.out.includes(`! ${BARE_WORD_ANSWER} of those`),
      'A4 a prose-only mention of the variable is NOT a suite that needs a database');
    ok(/UNVERIFIED by this run/.test(r.out),
      'A5 it says plainly that the database proofs did not execute');
  }

  // ---- C + D + E: the require switch, and what a skip means ------------------------------------
  {
    const r = run({ LT_REQUIRE_DB: '1' });
    ok(r.status === 1, 'D1 LT_REQUIRE_DB=1 with no database FAILS the run');
    ok(r.out.includes(`${DB_SUITES} suite(s) did not prove anything against a database`),
      'D2 and it names how many suites proved nothing');
  }
  {
    // CONTROL: the same fixtures, the same switch, a database configured — must pass.
    const r = run({ LT_REQUIRE_DB: '1', DATABASE_URL: FAKE_DB });
    ok(r.status === 0, 'D3 CONTROL — with a database configured the same run passes');
    ok(r.out.includes(`✓ all ${DB_SUITES} database-backed suites ran against a real Postgres.`),
      'D4 and it confirms every database-backed suite ran');
    ok(skippedList(r.out).length === 0,
      'C1 a suite whose assertion label merely contains "skipped" is NOT reported as skipped');
    ok(!/SKIPPED even though/.test(r.out), 'C2 nothing is reported as skipped when nothing skipped');
  }
  {
    const r = run({ LT_REQUIRE_DB: '1', DATABASE_URL: FAKE_DB, FX_FORCE_SKIP: '1' });
    ok(r.status === 1, 'E1 a suite that skips DESPITE a database fails the run');
    ok(r.out.includes('1 suite(s) SKIPPED even though DATABASE_URL is set'),
      'E2 and that is called out as the worse case, with a count');
    const named = skippedList(r.out);
    ok(named.includes('test-lt-ppe-fx-needs.js'), 'E3 the skipping suite is named individually');
    ok(named.length === 1, 'E4 and only that one — the wordy label is still not a skip');
  }

  // ---- F: an actual failure still fails ---------------------------------------------------------
  {
    const r = run({ FX_FAIL: '1' });
    ok(r.status === 1, 'F1 a failing suite fails the run');
    ok(r.out.includes(`${SUITE_COUNT - 1}/${SUITE_COUNT} LT PPE suites passed`),
      'F2 and the pass count is honest about it');
    ok(/ FAIL  test-lt-ppe-fx-fail\.js/.test(r.out), 'F3 the failing suite is named');
  }
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a scratch dir left behind is not a failure */ }
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe runner guard (${n} assertions)`}`);
assert.strictEqual(failures, 0);
