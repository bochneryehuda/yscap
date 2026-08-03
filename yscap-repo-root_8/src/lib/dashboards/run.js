'use strict';

/**
 * Running a dashboard query — the part that keeps a user-authored question from hurting
 * the site.
 *
 * THE FAILURE THIS EXISTS TO PREVENT: `src/db.js` runs ONE pool sized `DB_POOL_MAX`
 * (default 10), and `authenticate()` queries the database on EVERY authenticated request.
 * So a handful of slow dashboard cards holding connections does not degrade the
 * dashboard — it stops people signing in. Ten leaked clients 503 the whole app, which
 * scripts/test-audit-hardening-db.js calls out as the one bug that could take the service
 * down. A reporting feature must therefore never draw from that pool.
 *
 * Five guards, in order of how much they save you:
 *   1. ITS OWN SMALL POOL. Dashboards get `DASHBOARD_POOL_MAX` (default 4) connections of
 *      their own. Whatever happens in here, the loan officers keep working.
 *   2. READ ONLY TRANSACTION. `BEGIN READ ONLY` means even a catastrophic compiler bug
 *      that somehow emitted a write gets refused by the server (25006), not executed.
 *   3. STATEMENT TIMEOUT via SET LOCAL. `SET LOCAL` is released at COMMIT — a plain `SET`
 *      would persist on a pooled connection and silently apply to whoever gets it next.
 *   4. ROW CAPS in the compiler, so nothing streams a table into a browser.
 *   5. ONE-AT-A-TIME-ISH per person, so one user opening a 12-card dashboard cannot
 *      occupy every connection at once.
 *
 * `date` columns must come back as 'YYYY-MM-DD' STRINGS here exactly as they do in
 * src/db.js — that parser is a deliberate fix for the whole "every date is off by a day"
 * class, and a second pool without it would quietly reintroduce it on this surface only.
 */

const { Pool, types } = require('pg');
const cfg = require('../../config');
const { describeError, sslConfig } = require('../../db');

// Same type parser as src/db.js (OID 1082 = date). Set on the module, so it applies to
// this pool too — pg's type parsers are global, but stating it here documents the
// dependency instead of relying on load order.
types.setTypeParser(1082, (v) => v);

const POOL_MAX = Math.max(1, Math.min(8, parseInt(process.env.DASHBOARD_POOL_MAX || '4', 10) || 4));
const BUDGET_MS = Math.max(1000, Math.min(30000, parseInt(process.env.DASHBOARD_TIMEOUT_MS || '8000', 10) || 8000));
/**
 * MUST STAY ABOVE THE PER-REQUEST WORKER COUNT in routes/dashboards.js (3). Set equal to it,
 * one dashboard load consumes the person's entire allowance, so anything overlapping — a
 * second tab, the card editor's 400 ms live preview, the reload that follows a save — is
 * refused and paints "Too many dashboard cards loading at once" on cards that are perfectly
 * fine. The cap is here to stop ONE person occupying the small pool, not to serialise their
 * own page. If the worker count ever rises, raise this with it.
 */
const MAX_PER_USER = Math.max(1, parseInt(process.env.DASHBOARD_MAX_CONCURRENT || '8', 10) || 8);

let pool = null;
function getPool() {
  if (pool) return pool;
  const conn = process.env.DASHBOARD_DATABASE_URL || cfg.databaseUrl || process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: conn,
    ssl: sslConfig(),
    max: POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // Shows up in pg_stat_activity, so "what is hammering the database" is answerable
    // without guessing.
    application_name: 'pilot-dashboards',
  });
  pool.on('error', (e) => console.error('[dashboards] idle client error:', describeError(e)));
  return pool;
}

// ---------------------------------------------------------------------------
// Per-person concurrency
// ---------------------------------------------------------------------------
const inflight = new Map();

async function withSlot(staffId, fn) {
  const key = String(staffId || 'anon');
  const n = inflight.get(key) || 0;
  if (n >= MAX_PER_USER) {
    const e = new Error('Too many dashboard cards loading at once — give it a moment.');
    e.status = 429;
    throw e;
  }
  inflight.set(key, n + 1);
  try {
    return await fn();
  } finally {
    const m = (inflight.get(key) || 1) - 1;
    if (m <= 0) inflight.delete(key); else inflight.set(key, m);
  }
}

/**
 * Run one compiled query. Never leaks a client: the release is in a `finally`, which is
 * the difference between a slow page and a dead app.
 */
async function run({ text, values }, { staffId, budgetMs = BUDGET_MS } = {}) {
  return withSlot(staffId, async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN READ ONLY');
      const ms = Math.max(500, Math.min(30000, Number(budgetMs) || BUDGET_MS));
      // Integers we computed and clamped ourselves — never anything a person typed.
      await client.query(`SET LOCAL statement_timeout = ${ms}`);
      await client.query('SET LOCAL lock_timeout = 1000');
      await client.query('SET LOCAL idle_in_transaction_session_timeout = 5000');
      const r = await client.query({ text, values });
      await client.query('COMMIT');
      return r;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* the connection is going back anyway */ }
      if (e && e.code === '57014') {
        const t = new Error('This card took too long. Narrow the dates or add a filter.');
        t.status = 408; t.code = 'card_timeout';
        throw t;
      }
      if (e && e.code === '25006') {
        // Cannot happen unless the compiler emitted a write. Loud on purpose.
        console.error('[dashboards] a dashboard query attempted a WRITE — this is a compiler bug:', text.slice(0, 400));
        const t = new Error('That card could not be run.');
        t.status = 500;
        throw t;
      }
      throw e;
    } finally {
      client.release();
    }
  });
}

async function close() {
  if (pool) { const p = pool; pool = null; try { await p.end(); } catch (_) { /* shutting down */ } }
}

module.exports = { run, close, getPool, POOL_MAX, BUDGET_MS, MAX_PER_USER, _inflight: inflight };
