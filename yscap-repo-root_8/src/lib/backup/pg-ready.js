'use strict';

/**
 * Wait for a Postgres server that is still coming up — and REFUSE to wait for
 * one that never will.
 *
 * WHY THIS EXISTS. The weekly restore drill failed on 2026-08-16 with *"the
 * database system is in recovery mode"*. Nothing was wrong with any backup: that
 * is Postgres SQLSTATE **57P03**, which a server sends while it is starting up
 * or replaying its write-ahead log — after a restart, a failover, or routine
 * maintenance. It clears on its own, usually in seconds. But every database
 * connection in the backup system connected exactly once and gave up, so a
 * momentary restart anywhere in that window turned the one check that proves
 * the backups work into a red alert that says nothing about the backups.
 *
 * The vault (object storage) has retried since it was written; the DATABASE side
 * never did. That asymmetry is the whole defect.
 *
 * THE RULE THAT MATTERS IS WHAT WE REFUSE TO WAIT FOR. Waiting is only correct
 * for a condition that resolves ITSELF. A wrong password, a database that does
 * not exist, a revoked login — none of those improve by being asked again, and
 * retrying them turns an instant, accurate *"the password is wrong"* into ten
 * minutes of silence followed by a timeout that blames the clock. So the
 * transient set is a CLOSED LIST, and anything not on it fails immediately with
 * its own message intact.
 *
 * IT NEVER MAKES ANYTHING SAFER OR LESS SAFE. It hands back a live client and
 * changes nothing about what the caller then does with it — in particular the
 * drill's two guards (never the live database, never a target that does not look
 * disposable) run BEFORE this is ever called, and must stay there.
 */

const { Client } = require('pg');

/** Postgres codes that mean "ask again shortly", and nothing else. */
const TRANSIENT_CODES = new Set([
  '57P03', // cannot_connect_now  — "the database system is in recovery mode" / "is starting up"
  '57P01', // admin_shutdown      — the server is going away (restart/maintenance)
  '57P02', // crash_shutdown      — it crashed and is about to recover
  '53300', // too_many_connections — someone else's spike, not our credentials
  '08006', // connection_failure
  '08001', // sqlclient_unable_to_establish_connection
  '08004', // sqlserver_rejected_establishment_of_sqlconnection
]);

/** Socket-level failures that a starting server also produces, before it can speak Postgres. */
const TRANSIENT_SYSCALLS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

/**
 * Is this error worth waiting out?
 *
 * PURE and defensive: an error object we cannot read is NOT assumed transient,
 * because "wait ten minutes then fail" is a worse answer than the real error.
 * `ENOTFOUND` is deliberately ABSENT — a hostname that does not resolve is
 * almost always a wrong or unset URL, and waiting on it hides a typo.
 */
function isTransientPgStartup(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.code && TRANSIENT_CODES.has(String(err.code))) return true;
  if (err.code && TRANSIENT_SYSCALLS.has(String(err.code))) return true;
  // Some drivers/proxies surface the startup state as text with no SQLSTATE.
  const m = String(err.message || '').toLowerCase();
  if (/in recovery mode|is starting up|the database system is shutting down/.test(m)) return true;
  return false;
}

/** Plain-language reason, for an alert a non-developer reads. */
function describeWait(err) {
  const m = String((err && err.message) || '').toLowerCase();
  if (/in recovery mode|is starting up/.test(m) || String((err && err.code) || '') === '57P03') {
    return 'the database was still starting up';
  }
  if (String((err && err.code) || '') === '53300') return 'the database had no connection slots free';
  return 'the database was not reachable yet';
}

/**
 * Connect, waiting out a server that is still coming up.
 *
 * Returns a CONNECTED client — the caller owns it and must `end()` it. On a
 * permanent error it rethrows immediately, unchanged. On a transient one it
 * retries until `timeoutMs`, then throws an error that says plainly that the
 * database never became ready, which is a different sentence from "the backup
 * is broken" and must stay that way.
 */
async function connectWhenReady(url, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 10 * 60 * 1000;
  const ssl = opts.ssl;
  const log = opts.log || (() => {});
  const now = opts.now || (() => Date.now());
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const makeClient = opts.makeClient || ((u, s) => new Client({ connectionString: u, ssl: s }));

  const started = now();
  let attempt = 0;
  let lastErr = null;

  for (;;) {
    attempt += 1;
    const client = makeClient(url, ssl);
    try {
      await client.connect();
      if (attempt > 1) {
        log(`the database accepted a connection after ${Math.round((now() - started) / 1000)}s (attempt ${attempt})`);
      }
      return client;
    } catch (e) {
      // Never leak the half-open socket of a failed attempt.
      try { await client.end(); } catch (_) { /* it never connected */ }
      if (!isTransientPgStartup(e)) throw e;
      lastErr = e;

      const elapsed = now() - started;
      // Back off gently: a recovering server usually returns in seconds, and
      // hammering it while it replays its log helps nobody.
      const waitMs = Math.min(15000, 1000 * Math.pow(2, Math.min(attempt - 1, 4)));
      if (elapsed + waitMs >= timeoutMs) {
        const mins = Math.round(timeoutMs / 60000);
        const err = new Error(
          `the database never became ready — ${describeWait(lastErr)}, and it was still not accepting `
          + `connections after ${mins} minute${mins === 1 ? '' : 's'}. This says nothing about whether the `
          + `backups are good; it means the check could not run. (${lastErr.message})`);
        err.code = 'BACKUP_DB_NOT_READY';
        err.cause = lastErr;
        throw err;
      }
      log(`${describeWait(e)} — waiting ${Math.round(waitMs / 1000)}s and trying again (attempt ${attempt})`);
      await sleep(waitMs);
    }
  }
}

module.exports = {
  isTransientPgStartup, describeWait, connectWhenReady, TRANSIENT_CODES, TRANSIENT_SYSCALLS,
};
