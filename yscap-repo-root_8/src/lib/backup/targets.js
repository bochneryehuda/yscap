'use strict';
/**
 * Connection-target helpers — PURE, and shared by the backup, restore and verify tools so the
 * guard that stands between a restore and somebody's production database has exactly ONE
 * definition. A second copy of "is this the live database?" that drifts is how a drill ends up
 * wiping the wrong thing.
 *
 * Deliberately dependency-free (no `pg`, no config, no DB), so it loads and is testable anywhere.
 */

/**
 * PURE — turn a postgres URL into the PG* environment `pg_dump`/`pg_restore` read.
 *
 * The connection string is NEVER passed on the command line: everything in `argv` is visible to
 * anyone who can run `ps` on the box, and this string contains the password to the whole company.
 * The environment of a process is not.
 */
function pgEnvFromUrl(url) {
  const u = new URL(url);
  const database = decodeURIComponent((u.pathname || '').replace(/^\//, ''));
  if (!database) throw new Error('that database URL has no database name in it');
  return {
    PGHOST: decodeURIComponent(u.hostname),
    PGPORT: u.port || '5432',
    PGUSER: decodeURIComponent(u.username || ''),
    PGPASSWORD: decodeURIComponent(u.password || ''),
    PGDATABASE: database,
    // Managed Postgres (Render included) presents a certificate this container has no root for, and
    // the connection must still be ENCRYPTED — 'require' gives encryption without chain
    // verification, matching how src/db.js already connects.
    PGSSLMODE: process.env.PGSSLMODE || (u.searchParams.get('sslmode') || 'require'),
    PGCONNECT_TIMEOUT: '30',
  };
}

/**
 * PURE — are these two URLs the same database?
 *
 * Compared on host + port + database name ONLY. A different username, password or query string is
 * the SAME data behind a different login, and treating it as "somewhere else" is exactly how a
 * restore lands on production.
 */
function isSameDatabase(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    return x.hostname === y.hostname && (x.port || '5432') === (y.port || '5432') && x.pathname === y.pathname;
  } catch (_) {
    return false;        // unparseable — the caller's other guards decide
  }
}

/**
 * PURE — does this look like a database that exists to be thrown away?
 *
 * The restore DRILL drops every schema in its target, so a name that does not announce itself as
 * scratch is treated as somebody's real data and refused. Deliberately a NAME check: it is the one
 * signal an operator controls completely, and it fails safe (an unclear name is refused, never
 * assumed disposable).
 *
 * THE WORD LIST IS DELIBERATELY SHORT, and "restore" is deliberately NOT on it. The restore runbook
 * tells an operator to restore into a NEW database during an incident, and the obvious name for
 * that database is something like `yscap_restore` — which is real, freshly recovered data and the
 * last thing that should look disposable to a job whose first act is to delete everything in its
 * target. (A drill run against a database named `..._restore_target` wiped exactly that during
 * testing.) "test" and "temp" are off the list for the same reason: a test or staging environment
 * usually holds data somebody cares about. `BACKUP_VERIFY_FORCE=1` is the deliberate override.
 */
function looksLikeScratch(url) {
  try {
    const name = new URL(url).pathname.replace(/^\//, '').toLowerCase();
    if (!name) return false;
    return /(^|[_-])(verify|scratch|drill|throwaway|disposable)([_-]|$)/.test(name);
  } catch (_) { return false; }
}

module.exports = { pgEnvFromUrl, isSameDatabase, looksLikeScratch };
