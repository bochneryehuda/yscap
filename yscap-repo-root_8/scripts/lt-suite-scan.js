'use strict';
/**
 * LT — the ONE definition of "what is a Long-Term test suite, which of them need a database, and how
 * does one announce that it skipped".
 *
 * WHY THIS IS A MODULE AND NOT THREE COPIES. The membership of the LT suite family is currently stated
 * in two places — `package.json`'s test chain names 59 of them by hand, and `test-lt-ppe-all.js` globs
 * the `test-lt-ppe-*` ones — and the two together have already gone stale: ELEVEN suites on disk are
 * executed by neither, ~167 assertions guarding nothing, including one covering a module that was wired
 * into a live route the day before. A checker that retyped either rule would be a third copy and the
 * next thing to drift, so the runner, the family runner and the coverage gate all read these.
 *
 * PURE: filesystem reads only, no DB, no network. LT-only; no RTL imports.
 */
const fs = require('fs');
const path = require('path');

// The family, and the PPE sub-family the aggregate runner covers. Both are matched on the FILENAME
// because that is what a directory listing gives you; everything about a suite's BEHAVIOUR is read
// from its source below.
const SUITE_RE = /^test-lt-.*\.(js|mjs)$/;
const PPE_SUITE_RE = /^test-lt-ppe-.*\.(js|mjs)$/;

// The aggregate runners are not themselves suites — they run suites. Naming them here keeps every
// consumer from re-deriving "except the runner itself" and getting it subtly different.
const AGGREGATE_RUNNERS = ['test-lt-ppe-all.js'];

/** Every LT suite filename in `dir`, sorted, excluding the aggregate runners. */
function discover(dir) {
  return fs.readdirSync(dir).filter((f) => SUITE_RE.test(f) && !AGGREGATE_RUNNERS.includes(f)).sort();
}

/** The suites `test-lt-ppe-all.js` covers by its glob — derived here so nothing retypes it. */
function ppeSuites(dir) {
  return discover(dir).filter((f) => PPE_SUITE_RE.test(f));
}

// A suite that READS the variable needs a database. Read from the SOURCE rather than from a filename
// convention: `-db.js` is a habit, not a contract, and a suite that grows a database section without
// being renamed would otherwise stop being counted the day it starts mattering — while
// `test-lt-ppe-cutover-store-db.js` carries the suffix and needs no database at all.
//
// IT IS THE READ, NOT THE WORD. Matching the bare name counted THREE pure suites whose only mention of
// it is a header line saying they run WITHOUT one, so the summary claimed 14 suites had proven nothing
// against a database when 3 of them never wanted one. Over-reporting is the same failure as
// under-reporting: a number nobody can reconcile stops being read.
//
// The pg arm is the belt to that suspender, for a suite that gets its connection string from somewhere
// else and never names the variable. It can over-count on a source that merely QUOTES the require —
// deliberate: that direction is honest, and unlike a header line it is not a habit of this codebase.
const READS_DB_ENV = /process\.env\.DATABASE_URL/;
const OPENS_PG = /require\(\s*['"]pg['"]\s*\)|new\s+Pool\s*\(/;

function needsDb(dir, file) {
  try {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    return READS_DB_ENV.test(src) || OPENS_PG.test(src);
  } catch (_) { return false; }
}

// What a skipping suite prints, and the pattern needs BOTH halves. Matching "skipped" alone is the
// match-a-word trap this codebase keeps re-learning: several suites print it inside ordinary assertion
// labels ("the header row Excel copies along is skipped", "invalid tenant override skipped"), and with
// a database configured they were all reported as having skipped. A real skip names the thing it wanted
// — `set DATABASE_URL to run it` — so both must appear on the SAME line.
//
// STATED PLAINLY: this can only see a suite that ANNOUNCES its skip. A suite that quietly runs its pure
// half and says nothing about the database half is invisible to it, which is why every summary built on
// this leads with how many suites NEED a database rather than how many said they skipped.
const SKIP_RE = /skipped/i;
const skipLine = (out) => String(out || '').split('\n')
  .some((l) => SKIP_RE.test(l) && /DATABASE_URL/.test(l));

/**
 * DID THIS DATABASE-BACKED SUITE ACTUALLY PROVE ANYTHING AGAINST A DATABASE?
 *
 * ⛔ REPRODUCED 2026-08-18, and it is the tenth instance of this file's own class. The scratch Postgres
 * crashed mid-run. Nineteen suites failed, twenty-five ECONNREFUSED lines went by, and the runner
 * printed:
 *
 *     136/150 LT PPE suites passed
 *     ✓ all 31 database-backed suites ran against a real Postgres.
 *
 * The reassurance fired because it was guarded on `skipped.length`, and `skipped` only ever collected
 * suites that PASSED while announcing a skip — a suite that FAILED to connect was invisible to it. So
 * the one sentence whose entire job is to tell a human "your database coverage is real" said exactly
 * that in a run where a third of it had not happened. Worse, `LT_REQUIRE_DB=1` computed its
 * `unproven` count from the same `skipped` list, so the flag that exists to GUARANTEE database
 * coverage was satisfied by a run in which every database suite failed to connect.
 *
 * FOUR OUTCOMES, and the distinctions are the point:
 *   proved       — exit 0, no announced skip. The only one that counts.
 *   skipped      — exit 0, but it said it could not use the database it was given.
 *   unreachable  — it FAILED and its output carries a database-unreachable signature.
 *   failed       — it failed for its own reasons; it may still have reached the database.
 *
 * ⛔ ONLY A FAILING SUITE IS EVER CALLED `unreachable`. A passing suite is never reclassified on the
 * strength of a string in its output — several suites here deliberately ASSERT on connection-failure
 * wording while proving that something fails closed, and reading their success as an outage is the
 * match-a-word trap the skip rule above already documents. Requiring the non-zero exit first means the
 * signature can only ever explain a failure that already happened, never manufacture one.
 */
const DB_UNREACHABLE_RE = new RegExp([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'could not connect',
  'connection refused',
  'connection terminated',
  'the database system is (?:starting up|shutting down|in recovery)',
  'password authentication failed',
  'role "[^"]*" does not exist',
  'database "[^"]*" does not exist',
  'no pg_hba\\.conf entry',
  'too many clients already',
  'server closed the connection unexpectedly',
].join('|'), 'i');

/**
 * Classify one database-backed suite's run.
 *   { file, status, exitCode, why } — status ∈ proved | skipped | unreachable | failed
 * PURE: it is handed the outcome, it never runs anything.
 */
function classifyDbRun(file, { status, stdout, stderr } = {}) {
  const okRun = status === 0;
  const out = `${stdout || ''}\n${stderr || ''}`;
  if (okRun) {
    return skipLine(out)
      ? { file, status: 'skipped', exitCode: 0, why: 'it announced that it could not use the database it was given' }
      : { file, status: 'proved', exitCode: 0, why: null };
  }
  if (DB_UNREACHABLE_RE.test(out)) {
    return { file, status: 'unreachable', exitCode: status, why: 'it failed and its output names a database it could not reach' };
  }
  return { file, status: 'failed', exitCode: status, why: 'it failed for its own reasons — it may still have reached the database' };
}

/**
 * Roll a set of classifications into the one question a summary may answer:
 * did EVERY database-backed suite prove something against a database?
 *
 * `unproven` is everything that is not `proved`. A suite that failed for its own reasons counts as
 * unproven deliberately: we cannot tell from here whether it got as far as the database, and the honest
 * answer to "is the database coverage real" is no while any of it is red.
 */
function dbCoverage(classifications = []) {
  const rows = Array.isArray(classifications) ? classifications.filter(Boolean) : [];
  const by = (s) => rows.filter((r) => r.status === s);
  const proved = by('proved');
  const unproven = rows.filter((r) => r.status !== 'proved');
  return {
    total: rows.length,
    proved: proved.length,
    skipped: by('skipped').length,
    unreachable: by('unreachable').length,
    failed: by('failed').length,
    unproven,
    allProved: rows.length > 0 && unproven.length === 0,
  };
}

module.exports = {
  SUITE_RE,
  PPE_SUITE_RE,
  AGGREGATE_RUNNERS,
  discover,
  ppeSuites,
  needsDb,
  DB_UNREACHABLE_RE,
  classifyDbRun,
  dbCoverage,
  skipLine,
  _internals: { READS_DB_ENV, OPENS_PG, SKIP_RE },
};
