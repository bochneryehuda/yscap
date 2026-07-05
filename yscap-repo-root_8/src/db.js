/** Postgres pool. Uses DATABASE_URL from Render. */
const { Pool } = require('pg');
const cfg = require('./config');

if (!cfg.databaseUrl) {
  // The single most common production failure: the service is deployed but no
  // database is attached, so DATABASE_URL is empty. Say so loudly and clearly
  // instead of letting pg fail with an opaque "connect ECONNREFUSED 127.0.0.1".
  console.error(
    '[db] FATAL: DATABASE_URL is not set. The portal cannot reach a database. ' +
    'On Render, attach the Postgres instance (render.yaml provisions "ys-capital-db") ' +
    'and set DATABASE_URL in the service environment, then redeploy.');
}

// SSL: Render (and most managed Postgres) present a certificate that Node does
// not have in its trust store, so we don't verify the chain in production.
// Locally we connect without SSL. Allow an explicit override via PGSSLMODE.
function sslConfig() {
  const mode = (process.env.PGSSLMODE || '').toLowerCase();
  if (mode === 'disable' || mode === 'off') return false;
  if (mode === 'require' || mode === 'prefer' || mode === 'no-verify') return { rejectUnauthorized: false };
  return cfg.env === 'production' ? { rejectUnauthorized: false } : false;
}

const pool = new Pool({
  connectionString: cfg.databaseUrl,
  ssl: sslConfig(),
  // Fail a stuck connection attempt in a bounded time instead of hanging the
  // request forever (e.g. while the DB is still spinning up after a deploy).
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECT_TIMEOUT_MS || '10000', 10),
  idleTimeoutMillis: 30000,
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
});

// An idle client can emit 'error' (server restart, network blip). Without a
// listener this throws at the process level and can take the service down.
// Log and let the pool recycle the client.
pool.on('error', (e) => console.error('[db] idle client error:', describeError(e)));

/**
 * Turn a pg/Node connection error into something actionable. Node 18+ raises an
 * AggregateError (empty .message) when every address for a host fails, which is
 * exactly why the logs showed "database unavailable:" with nothing after it.
 * Unwrap it so the real cause (ECONNREFUSED / ENOTFOUND / SSL / auth) is visible.
 */
function describeError(e) {
  if (!e) return 'unknown error';
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code) parts.push(`code=${e.code}`);
  if (e.errno && e.errno !== e.code) parts.push(`errno=${e.errno}`);
  if (e.address) parts.push(`address=${e.address}${e.port ? ':' + e.port : ''}`);
  if (e.severity) parts.push(`severity=${e.severity}`);
  if (e.detail) parts.push(`detail=${e.detail}`);
  // AggregateError: the useful information lives in .errors, not .message.
  if (Array.isArray(e.errors) && e.errors.length) {
    parts.push('causes=[' + e.errors.map((x) => describeError(x)).join(' | ') + ']');
  }
  const s = parts.filter(Boolean).join(' ');
  return s || (e.name ? e.name : String(e));
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
  describeError,
};
