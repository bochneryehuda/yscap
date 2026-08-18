'use strict';
/**
 * LT PPE — aggregate test runner. Runs every scripts/test-lt-ppe-*.js suite sequentially and fails on
 * the first failure. ONE command to verify the whole Product & Pricing Engine locally, and the single
 * entry point to wire into CI's test chain when this branch is prepped for merge (kept out of
 * package.json for now so the merge-conflict-prone `test` chain is not touched mid-flight).
 *
 * IT COUNTS WHAT DID NOT RUN, and that is the point of this file rather than a bare loop.
 *
 * Eleven of these suites need a REAL Postgres — they are the ones that prove the things a stub cannot:
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

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = __dirname;
const self = path.basename(__filename);
const suites = fs.readdirSync(dir)
  .filter((f) => /^test-lt-ppe-.*\.(js|mjs)$/.test(f) && f !== self)
  .sort();

// A suite that READS the variable needs a database. Read from the SOURCE rather than from a filename
// convention: `-db.js` is a habit, not a contract, and a suite that grows a database section without
// being renamed would otherwise stop being counted the day it starts mattering — while
// `test-lt-ppe-cutover-store-db.js` carries the suffix and needs no database at all.
//
// IT IS THE READ, NOT THE WORD. Matching the bare name counted THREE pure suites (cutover-store-db,
// schedule-store-db, route) whose only mention of it is a header line saying they run WITHOUT one — so
// the summary claimed 14 suites had proven nothing against a database when 3 of them never wanted one.
// Over-reporting is the same failure as under-reporting: a number nobody can reconcile stops being
// read. `process.env.DATABASE_URL` is the actual read and cannot appear in prose by accident.
//
// The pg arm is the belt to that suspender, for a suite that gets its connection string from somewhere
// else and never names the variable. It can over-count on a source that merely QUOTES the require —
// deliberate: that direction is honest, and unlike a header line it is not a habit of this codebase.
const READS_DB_ENV = /process\.env\.DATABASE_URL/;
const OPENS_PG = /require\(\s*['"]pg['"]\s*\)|new\s+Pool\s*\(/;
function needsDb(file) {
  try {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    return READS_DB_ENV.test(src) || OPENS_PG.test(src);
  } catch (_) { return false; }
}

// What a skipping suite prints, and the pattern needs BOTH halves. Matching "skipped" alone is the
// match-a-word trap this codebase keeps re-learning: four suites print it inside ordinary assertion
// labels ("the header row Excel copies along is skipped", "invalid tenant override skipped"), and with
// a database configured they were all reported as having skipped. A real skip here always names the
// thing it wanted — `set DATABASE_URL to run it` — so both must appear on the SAME line.
//
// STATED PLAINLY: this can only see a suite that ANNOUNCES its skip. A suite that quietly runs its pure
// half and says nothing about the database half is invisible to it, which is why the count below leads
// with how many suites NEED a database rather than with how many said they skipped.
const SKIP_RE = /skipped/i;
const skipLine = (out) => String(out || '').split('\n')
  .some((l) => SKIP_RE.test(l) && /DATABASE_URL/.test(l));

const hasDb = !!process.env.DATABASE_URL;
const requireDb = process.env.LT_REQUIRE_DB === '1';

let failed = 0;
const dbSuites = [];
const skipped = [];
for (const f of suites) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8' });
  const okRun = r.status === 0;
  if (!okRun) failed += 1;
  if (needsDb(f)) dbSuites.push(f);
  const tail = (r.stdout || '').trim().split('\n').pop() || '';
  if (okRun && skipLine(r.stdout)) skipped.push(f);
  console.log(`${okRun ? '  ok  ' : ' FAIL '} ${f}${okRun && tail ? `  — ${tail}` : ''}`);
  if (!okRun) console.log((r.stdout || '') + (r.stderr || ''));
}

const passed = suites.length - failed;
console.log(`\n${passed}/${suites.length} LT PPE suites passed`);

if (dbSuites.length) {
  if (!hasDb) {
    // Never a footnote. Without a database the most important proofs in this engine did not run, and
    // the line above says "passed" about them.
    console.log(`\n  ! ${dbSuites.length} of those suites need a REAL Postgres and DATABASE_URL is not set.`);
    console.log('    They exited green having proven nothing about the database: ownership, atomicity,');
    console.log('    the driver\'s string types and the publish gate are all UNVERIFIED by this run.');
    console.log('    Re-run with DATABASE_URL set — and set LT_REQUIRE_DB=1 to make this a failure.');
  } else if (skipped.length) {
    // The worse case: a database WAS configured and a suite skipped anyway — it could not use the one
    // it was given, which no summary should round off to "passed".
    console.log(`\n  ! ${skipped.length} suite(s) SKIPPED even though DATABASE_URL is set — they could not use it:`);
    for (const f of skipped) console.log(`      ${f}`);
  } else {
    console.log(`\n  ✓ all ${dbSuites.length} database-backed suites ran against a real Postgres.`);
  }
}

const unproven = hasDb ? skipped.length : dbSuites.length;
if (requireDb && unproven) {
  console.log(`\n  ✗ LT_REQUIRE_DB=1 and ${unproven} suite(s) did not prove anything against a database.`);
  process.exit(1);
}
process.exit(failed ? 1 : 0);
