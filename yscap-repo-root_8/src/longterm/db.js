'use strict';

// Long-Term's OWN Postgres pool.
//
// Per the charter (docs/LONG-TERM-LOANS-SEPARATION-CHARTER.md §4), Long-Term opens
// its own pool rather than sharing src/db.js. It connects to the SAME database as
// RTL, but this separate pool keeps the two products decoupled and makes moving
// Long-Term to its own database later a trivial change. LT code only ever names
// lt_* tables in SQL (enforced by the separation gate).

const { Pool, types } = require('pg');
const cfg = require('./config');

// Match RTL's date handling exactly: return `date` columns (OID 1082) as the raw
// 'YYYY-MM-DD' string, never a JS Date (which shifts the calendar day across
// timezones). setTypeParser is process-global on the pg module and setting it to
// identity is idempotent — identical to src/db.js.
types.setTypeParser(1082, (v) => v);

if (!cfg.databaseUrl) {
  console.error('[lt-db] DATABASE_URL is not set — the Long-Term module cannot reach a database.');
}

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: cfg.sslConfig(),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  idleTimeoutMillis: 30000,
  // A side build with no live traffic needs only a small pool.
  max: parseInt(process.env.LT_DB_POOL_MAX || '5', 10),
  /* ⛔ AN IDLE CONNECTION MUST NOT, BY ITSELF, HOLD THIS PROCESS OPEN.
   *
   * An open TCP socket is a live libuv handle, so ONE connection resting in this
   * pool is enough to stop Node ever exiting — silently, with nothing failing.
   * That is not hypothetical: it is what stopped the test run three times.
   *
   * WHAT HAPPENED, measured. `index.js` warms the company settings at require
   * time and re-reads them every 15s (`settings/store.js keepWarm`), so every
   * process that so much as requires the Long-Term module now opens a connection
   * HERE. `idleTimeoutMillis` is 30s and would have closed it — but the 15s
   * re-read touches the connection first, so it is never idle long enough to time
   * out. A suite ends, closes its server, ends RTL's pool (`src/db`, which is not
   * this pool) and then waits on this socket until the runner's clock kills the
   * step. On CI the chain stalled inside `scripts/test-draw-findings-public.js`
   * SEVEN MINUTES IN, with its 14 of 14 assertions PASSED, and the ~1,300 suites
   * behind it never ran. Reproduced locally against a real database; proved by
   * removing the warm loop and watching the same suite exit.
   *
   * THE SAME LESSON THE SYNC WORKER ALREADY LEARNED, one layer down.
   * `sync/worker.js` unrefs its timers on the argument that a real server is held
   * open by its HTTP listener, so nothing that merely LOADS this module should be
   * held open by our background work. A timer was never the only handle that
   * background work creates; it also creates this socket. Applying the rule at the
   * pool makes it hold for every reader, present and future, rather than for one
   * caller who remembered.
   *
   * `allowExitOnIdle` is pg-pool's own switch for exactly this and does the whole
   * job: it unrefs a client when it is RELEASED back to the pool and unrefs the
   * idle-timeout timer with it, and pg-pool re-refs the client when it is next
   * acquired (`pg-pool/index.js:161`). So an in-flight query always holds the
   * process open — a script that awaits a query can never exit before its answer
   * arrives — and only a connection nobody is using stops voting on whether this
   * process lives. A live server is unaffected: its listener is what keeps it up.
   *
   * Guarded by `scripts/test-lt-process-exits-db.js`, which requires this module
   * in a child process and fails if that child cannot exit by itself. */
  allowExitOnIdle: true,
});

// An idle client can emit 'error' (server restart, network blip). Without a
// listener this throws at the process level; log and let the pool recycle.
pool.on('error', (e) => console.error('[lt-db] idle client error:', (e && e.message) || e));

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
