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

  // AN IDLE POOL MUST NOT BE THE ONLY THING KEEPING A PROCESS ALIVE. This one
  // line is what stops `npm test` hanging, and it cost main a red build and a
  // skipped deploy on 2026-09-02 (run 4343: `test-db` ran 60 minutes and was
  // killed by the step timeout, so `deploy` and `schema-push` skipped and
  // nothing published).
  //
  // WHAT ACTUALLY HAPPENS, measured rather than guessed. Requiring the
  // long-term module calls `settings/store.keepWarm()`, which re-reads the
  // company settings every LT_SETTINGS_REFRESH_MS (15s) on a timer that is
  // CAREFULLY `unref`'d — its own comment says it "must never hold a process
  // open, least of all a test runner's". The timer indeed does not. The QUERY
  // it makes does: every tick borrows a client from this pool, and each borrow
  // restarts that client's 30-second idle countdown, so the pooled socket is
  // never reaped. A live TCP handle keeps Node's event loop alive whether or
  // not any timer is `unref`'d. Every database suite that boots the app
  // therefore finished its assertions, closed its server, ended RTL's pool —
  // and then sat there forever. The probe found exactly one surviving handle: a
  // socket to Postgres opened by this pool.
  //
  // That is the general lesson worth keeping: `unref`'ing a timer is not enough
  // when the work inside it takes a ref'd handle.
  //
  // `allowExitOnIdle` says "when every client is idle, do not hold the process
  // open". It changes NOTHING on a server — an HTTP listener holds the loop
  // open, so the warm-up keeps ticking exactly as before — and it changes
  // nothing for a script that still has work in flight, because a client
  // running a query is not idle. It only lets a process that is genuinely
  // finished finish. `scripts/test-lt-pool-exit-db.js` proves it by starting
  // this module the way the app does and requiring the process to EXIT.
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
