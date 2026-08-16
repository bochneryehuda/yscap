'use strict';

// =============================================================================
// REFUSE TO RUN SCHEMA-MUTATING TESTS AGAINST A DATABASE THAT MIGHT BE REAL
// =============================================================================
//
// Two suites in this folder — `test-schema-drift-db.js` and
// `test-schema-snapshot-db.js` — prove the drift check works by BREAKING the
// schema on purpose: `ALTER TABLE borrowers ADD COLUMN`, dropping a foreign
// key, dropping a column default. Every one is wrapped in `BEGIN … ROLLBACK`
// with a `finally`, so no durable change is possible even if the process is
// killed (Postgres rolls back a lost connection server-side).
//
// THAT IS NOT THE HAZARD. `ALTER TABLE` takes an ACCESS EXCLUSIVE lock for the
// life of the transaction, so pointing these at a live database would stall
// every read and write on `borrowers` — the busiest table in the system —
// until the rollback. Nothing durable is lost and the site is unusable while it
// runs. An audit found the only protection was a sentence in a comment saying
// "never production".
//
// THE RULE IS PROOF OF DISPOSABILITY, NOT ABSENCE OF DANGER — the same posture
// `src/lib/backup/targets.js` takes for the restore drill, and for the same
// reason: an unclear answer must be refused, never assumed safe.
//
//   • a LOCAL host is allowed — a developer's own Postgres, and CI's service
//     container, are both `localhost`. Production is a remote managed host and
//     can never look local by accident;
//   • a remote host is allowed ONLY if the database NAME announces itself as
//     disposable. A name is the one signal an operator controls completely;
//   • anything else is refused, with the reason and the override printed.
//
// WHY NOT REUSE `targets.looksLikeScratch`: it deliberately excludes the word
// "test" ("a test or staging environment usually holds data somebody cares
// about") because its caller DELETES EVERYTHING in the target. That is the
// right rule there and the wrong one here — CI's database is `yscap_test`, so
// borrowing it would refuse the one database these suites are built for. Two
// different questions deserve two different predicates, and conflating them
// would either break CI or weaken a backup guard.
//
// PURE: no database, no network, no filesystem. Never throws from the checker
// itself — `assertDisposable` is the only part that exits.

/** Hosts that cannot be a managed production database. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * A name that announces itself as disposable. Broader than the backup drill's
 * list — `test` and `ci` are in — because nothing here deletes anything; the
 * cost of a false allow is a lock, not lost data.
 */
const DISPOSABLE_NAME = /(^|[_-])(test|tests|ci|scratch|verify|drill|tmp|temp|throwaway|disposable)([_-]|$)/;

/**
 * May a schema-mutating test run against this connection string?
 *
 * Returns `{ ok, reason }`. UNPARSEABLE IS REFUSED: a URL we cannot read is a
 * database we cannot vouch for, and guessing is the one thing this must not do.
 */
function disposableTarget(url) {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'no DATABASE_URL' };
  }
  let u;
  try {
    u = new URL(url);
  } catch (_) {
    return { ok: false, reason: 'DATABASE_URL could not be parsed, so it cannot be vouched for' };
  }
  const host = (u.hostname || '').toLowerCase();
  const name = decodeURIComponent(u.pathname || '').replace(/^\//, '').toLowerCase();

  if (LOCAL_HOSTS.has(host)) {
    return { ok: true, reason: `local host (${host}) — not a managed database` };
  }
  // NO HOST AT ALL is a unix-socket connection — local by definition — but only
  // when it actually names a database. `postgres://` on its own names nothing
  // and connects to nowhere; reading it as "a local socket, therefore safe" was
  // the first cut, and the test caught it. An input that is not a usable
  // connection string is not evidence of anything.
  if (!host) {
    return name
      ? { ok: true, reason: 'unix socket — local by definition' }
      : { ok: false, reason: 'no host and no database name — not a usable connection string' };
  }
  if (!name) {
    return { ok: false, reason: `remote host "${host}" and no database name to judge` };
  }
  if (DISPOSABLE_NAME.test(name)) {
    return { ok: true, reason: `the database name "${name}" announces itself as disposable` };
  }
  return {
    ok: false,
    reason: `remote host "${host}" and the database name "${name}" does not look disposable`,
  };
}

/**
 * Refuse to continue unless the target is provably disposable.
 *
 * It EXITS 0, not 1. A suite declining to run is the same class of event as the
 * self-skip every `*-db.js` here already performs without a database — it is
 * not a failure of the code under test, and turning it into one would mean a
 * developer with a production URL in their shell could not run `npm test` at
 * all. The refusal is printed loudly so it can never be mistaken for a pass of
 * the assertions.
 *
 * `SCHEMA_DB_TESTS_FORCE=1` is the deliberate override, for the case where a
 * remote scratch database has an unhelpful name.
 */
function assertDisposable(suite, url) {
  const v = disposableTarget(url === undefined ? process.env.DATABASE_URL : url);
  if (v.ok) return true;
  if (process.env.SCHEMA_DB_TESTS_FORCE === '1') {
    console.log(`${suite}: target is not provably disposable (${v.reason}) — `
      + 'running anyway because SCHEMA_DB_TESTS_FORCE=1');
    return true;
  }
  console.log('');
  console.log(`::warning::${suite}: REFUSING TO RUN — ${v.reason}.`);
  console.log('   This suite proves the drift check works by altering the schema on purpose');
  console.log('   (inside a transaction that is always rolled back). That takes an exclusive');
  console.log('   lock on real tables, so it must only ever point at a throwaway database.');
  console.log('   Use a local Postgres, or a database whose name says it is disposable');
  console.log('   (…_test, …_ci, …_scratch). Override with SCHEMA_DB_TESTS_FORCE=1.');
  console.log('');
  return false;
}

module.exports = { disposableTarget, assertDisposable, _internals: { LOCAL_HOSTS, DISPOSABLE_NAME } };
