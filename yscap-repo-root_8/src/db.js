/** Postgres pool. Uses DATABASE_URL from Render. */
const { Pool, types } = require('pg');
const cfg = require('./config');

// ROOT DATE FIX (owner-directed 2026-07-14): node-postgres parses a `date`
// column (OID 1082) into a JS Date at the SERVER's LOCAL midnight. When the
// server TZ is behind UTC (Render runs UTC, but any non-UTC deploy triggers
// this), `res.json` then serializes that Date via toISOString() — which is
// UTC — shifting the calendar day backwards (e.g. an expected_closing of
// 2026-07-18 renders as 2026-07-17). That single parse was the root cause of
// "every date field is off by a day" AND of the ClickUp date drift (the
// outbound push read the local-midnight Date and sent a non-midnight epoch).
// A pure `date` has no time or zone, so the only correct in-JS representation
// is the raw 'YYYY-MM-DD' string. Returning it verbatim eliminates the shift
// on EVERY date column at one chokepoint, and makes the ClickUp toEpochMs()
// take its TZ-safe Date.UTC() string branch. `timestamptz` (OID 1184) is
// unaffected — it keeps its instant-in-time Date semantics.
types.setTypeParser(1082, (v) => v);

if (!cfg.databaseUrl) {
  // The single most common production failure: the service is deployed but no
  // database is attached, so DATABASE_URL is empty. Say so loudly and clearly
  // instead of letting pg fail with an opaque "connect ECONNREFUSED 127.0.0.1".
  console.error(
    '[db] FATAL: DATABASE_URL is not set. The portal cannot reach a database. ' +
    'On Render, attach the Postgres instance (the "yscap" database) ' +
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

/**
 * THE ONE PLACE A FAILED QUERY IS REMEMBERED (owner-directed 2026-08-16: a
 * "server error" must say what it was).
 *
 * 379 route handlers turn a rejected query into `{error:'server error'}` and
 * throw the cause away. Rather than edit 379 catch blocks — a hand-kept list
 * that goes stale on route 380 — the cause is captured HERE, where every one of
 * them passes through, and `lib/http-fail` attaches it to the response. The
 * error is re-thrown untouched, so nothing about how a caller sees a failure
 * changes; only whether anybody can find out what it was.
 *
 * Never throws, never swallows, and outside an HTTP request it is a no-op.
 */
function noteFailure(e, sql) {
  try { require('./lib/http-fail').record(e, sql); } catch (_) { /* reporting must never break a query */ }
  return e;
}
function tracked(promise, sql) {
  return (promise && typeof promise.then === 'function')
    ? promise.catch((e) => { throw noteFailure(e, sql); })
    : promise;
}

// A pooled client is REUSED, so wrap its query exactly once (the symbol guard) —
// stacking a wrapper per checkout would grow one handler per query on a hot client.
const WRAPPED = Symbol('pilot.queryTracked');
function trackClient(client) {
  if (!client || client[WRAPPED]) return client;
  try {
    const orig = client.query.bind(client);
    // Callback form (`client.query(text, params, cb)`) returns undefined and is
    // passed straight through — `tracked` only touches a thenable.
    client.query = (...args) => tracked(orig(...args), typeof args[0] === 'string' ? args[0] : (args[0] && args[0].text));
    Object.defineProperty(client, WRAPPED, { value: true, enumerable: false, configurable: true });
  } catch (_) { /* a client we cannot wrap is still a working client */ }
  return client;
}

module.exports = {
  query: (text, params) => tracked(pool.query(text, params), typeof text === 'string' ? text : (text && text.text)),
  getClient: async () => trackClient(await pool.connect()),
  pool,
  // Exported so a second pool (the dashboards read pool) connects on exactly the same
  // terms as this one. A hand-rolled "is it localhost" heuristic over there would drift
  // from PGSSLMODE and from the production rule the moment either changes.
  sslConfig,
  describeError,
};
