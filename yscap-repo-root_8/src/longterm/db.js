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
});

// An idle client can emit 'error' (server restart, network blip). Without a
// listener this throws at the process level; log and let the pool recycle.
pool.on('error', (e) => console.error('[lt-db] idle client error:', (e && e.message) || e));

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
