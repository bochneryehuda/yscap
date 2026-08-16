'use strict';
/**
 * ONE DEFINITION OF "SKIP THIS SUITE WHEN THERE IS NO DATABASE".
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * `npm test` is ONE chain and BOTH CI jobs run it: `test-db` with a Postgres
 * service and DATABASE_URL, and `test` with NO database at all. So every suite
 * in the chain must survive having no database — a suite that dials one and
 * does not catch takes the whole build down, and with it the deploy, because
 * the deploy job is `needs: test`.
 *
 * That is not hypothetical. It is precisely why a pile of perfectly good DB
 * suites sat OUTSIDE the chain for months: they work, they just cannot run
 * without a database, so nobody could register them. Registering them without
 * this guard reproduced the failure immediately (#1224, first CI run).
 *
 * =============================================================================
 * WHY A PROBE AND NOT A try/catch AROUND ensureSchema()
 * =============================================================================
 *
 * `migrate-boot.ensureSchema()` does NOT throw when the database is
 * unreachable. It retries eight times over roughly 75 seconds, logs
 * "giving up: database unreachable" and then RESOLVES. So the obvious guard —
 * wrapping ensureSchema — catches nothing: the suite sails past it and dies on
 * its first real query, 75 seconds later, with a stack that points at the
 * query rather than at the missing database. Both halves of that are bad: the
 * build is slower by over a minute per suite, and the error names the wrong
 * cause.
 *
 * `SELECT 1` answers in milliseconds and fails immediately, so the skip is both
 * correct and fast.
 *
 * =============================================================================
 * WHY IT CHECKS REACHABILITY AND NOT `process.env.DATABASE_URL`
 * =============================================================================
 *
 * Most of these suites open with
 *
 *   process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://…:5433/yscap'
 *
 * which points a bare local run at the demo socket — genuinely useful, and the
 * reason a developer can just run the file. Testing the variable would read as
 * "always set" and skip nothing; worse, deleting that line to make the variable
 * meaningful would break the local ergonomics the line exists for.
 *
 * Reachability is the honest question anyway: what matters is not whether
 * somebody exported a string, it is whether a database answers.
 */

/**
 * Skip the process cleanly (exit 0) when no database answers.
 *
 * `src/db` is required HERE, lazily, rather than taken as an argument: every
 * caller sets its own `process.env.DATABASE_URL` defaults at module top before
 * requiring it, and by the time this runs that has already happened. Node's
 * module cache means this is the SAME pool the suite itself holds, so the probe
 * tests the connection the suite will actually use — not a second one that
 * could succeed or fail independently.
 *
 * @param {string} label short name for the log line
 */
async function skipUnlessDb(label) {
  const db = require('../../src/db');
  try {
    await db.query('SELECT 1');
  } catch (e) {
    // exit 0, deliberately: "there is no database here" is not a failure of the
    // thing under test, and a non-zero exit would stop the chain — turning a
    // missing service into a red build for every suite behind it.
    console.log(`${label}: SKIPPED — no database (${e && e.message})`);
    process.exit(0);
  }
}

module.exports = { skipUnlessDb };
