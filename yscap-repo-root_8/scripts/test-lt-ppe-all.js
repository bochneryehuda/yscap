'use strict';
/**
 * LT PPE — aggregate test runner. Runs every scripts/test-lt-ppe-*.js suite sequentially and fails on
 * the first failure. ONE command to verify the whole Product & Pricing Engine locally, and the single
 * entry `npm test` invokes to cover the whole PPE family — so a new `test-lt-ppe-*` suite is picked up
 * with no edit to the chain. (An earlier version of this header said it was deliberately kept OUT of
 * package.json; that was stale — the chain names it, which is what makes the glob mean anything.
 * `check-lt-suite-coverage.js` now proves that, and fails if the chain ever stops invoking it.)
 *
 * IT COUNTS WHAT DID NOT RUN, and that is the point of this file rather than a bare loop.
 *
 * Twelve of these suites need a REAL Postgres — they are the ones that prove the things a stub cannot:
 * that the ownership check actually refuses another tenant, that a grid write is atomic, that BIGINT
 * arrives as a STRING, that the publish gate refuses an unmeasured sheet. Each of them SKIPS politely
 * when DATABASE_URL is unset and exits 0, which is right for a laptop and is exactly how this runner
 * came to print **"98/98 LT PPE suites passed"** on a machine with no database at all — a green line
 * over a run in which not one real-Postgres proof executed. That is the failure that looks like
 * success, which is the class this whole workstream keeps finding, and a test runner is the last place
 * it should live.
 *
 * So the summary now says what RAN and what only reported itself green:
 *   · a suite that READS the variable, or opens a pg connection, is a DB suite — counted whether or
 *     not it announces itself;
 *   · a suite that PRINTS a skip is named individually — including with a database configured, where a
 *     skip means it could not use the one it was given, which is worse than not having one;
 *   · `LT_REQUIRE_DB=1` makes an unproven run a FAILURE, which is what CI should set.
 *
 *   node scripts/test-lt-ppe-all.js
 *   DATABASE_URL=postgres://… LT_REQUIRE_DB=1 node scripts/test-lt-ppe-all.js
 *
 * LT-only.
 */

const path = require('path');
const { spawnSync } = require('child_process');
// ONE definition of what a suite is, which of them need a database, and how a skip is announced —
// shared with `check-lt-suite-coverage.js`, which had to know the same things. A checker carrying its
// own copy would be the third statement of a rule whose two existing copies are exactly what let
// eleven suites fall out of every runner.
const scan = require('./lt-suite-scan');

const dir = __dirname;
const suites = scan.ppeSuites(dir);

// Both of these now live in `lt-suite-scan` so the runner and the coverage gate cannot disagree about
// which suites need a database or what a skip looks like. Their full reasoning is in that module.
const needsDb = (file) => scan.needsDb(dir, file);
const skipLine = scan.skipLine;

const hasDb = !!process.env.DATABASE_URL;
const requireDb = process.env.LT_REQUIRE_DB === '1';

let failed = 0;
const dbSuites = [];
const skipped = [];
const dbRuns = [];   // one classification per database-backed suite (§2.81)
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const okRun = r.status === 0;
  if (!okRun) failed += 1;
  if (needsDb(f)) {
    dbSuites.push(f);
    // CLASSIFIED HERE, from the outcome we already hold. The summary below used to ask only "did any
    // suite ANNOUNCE a skip", which a suite that FAILED to connect can never do (§2.81).
    dbRuns.push(scan.classifyDbRun(f, r));
  }
  const tail = (r.stdout || '').trim().split('\n').pop() || '';
  if (okRun && skipLine(r.stdout)) skipped.push(f);
  console.log(`${okRun ? '  ok  ' : ' FAIL '} ${f}${okRun && tail ? `  — ${tail}` : ''}`);
  if (!okRun) console.log((r.stdout || '') + (r.stderr || ''));
}

const passed = suites.length - failed;
console.log(`\n${passed}/${suites.length} LT PPE suites passed`);

const coverage = scan.dbCoverage(dbRuns);

if (dbSuites.length) {
  if (!hasDb) {
    // Never a footnote. Without a database the most important proofs in this engine did not run, and
    // the line above says "passed" about them.
    console.log(`\n  ! ${dbSuites.length} of those suites need a REAL Postgres and DATABASE_URL is not set.`);
    console.log('    They exited green having proven nothing about the database: ownership, atomicity,');
    console.log('    the driver\'s string types and the publish gate are all UNVERIFIED by this run.');
    console.log('    Re-run with DATABASE_URL set — and set LT_REQUIRE_DB=1 to make this a failure.');
  } else if (!coverage.allProved) {
    // ⛔ THE REASSURANCE IS EARNED, NOT ASSUMED (§2.81). This branch used to fire only when a suite
    // ANNOUNCED a skip — so a suite that FAILED to connect was invisible, and on 2026-08-18 the runner
    // printed "✓ all 31 database-backed suites ran against a real Postgres" under twenty-five
    // ECONNREFUSED lines. Now every database-backed suite must have actually PASSED, and whatever did
    // not is named with the reason it did not count.
    console.log(`\n  ! ${coverage.unproven.length} of ${coverage.total} database-backed suite(s) proved NOTHING against a database:`);
    for (const r of coverage.unproven) console.log(`      ${r.file} — ${r.status}: ${r.why}`);
    if (coverage.unreachable) {
      console.log(`    ${coverage.unreachable} of those could not reach a database at all — DATABASE_URL is set, so check that the server is up.`);
    }
    console.log(`    ${coverage.proved} of ${coverage.total} did prove something. Ownership, atomicity, the driver's`);
    console.log('    string types and the publish gate are UNVERIFIED for the rest of this run.');
  } else {
    console.log(`\n  ✓ all ${coverage.proved} database-backed suites ran against a real Postgres.`);
  }
}

// WHAT "UNPROVEN" MEANS, and it is the second half of the same defect. This used to be `skipped.length`
// with a database configured — so `LT_REQUIRE_DB=1`, the flag whose whole job is to GUARANTEE database
// coverage in CI, was satisfied by a run in which every database suite failed to connect.
const unproven = hasDb ? coverage.unproven.length : dbSuites.length;
if (requireDb && unproven) {
  console.log(`\n  ✗ LT_REQUIRE_DB=1 and ${unproven} suite(s) did not prove anything against a database.`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
