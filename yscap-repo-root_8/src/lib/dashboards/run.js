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

const POOL_MAX = Math.max(1, Math.min(16, parseInt(process.env.DASHBOARD_POOL_MAX || '6', 10) || 6));
const BUDGET_MS = Math.max(1000, Math.min(30000, parseInt(process.env.DASHBOARD_TIMEOUT_MS || '8000', 10) || 8000));

/**
 * How many of ONE person's cards may be in the database at once.
 *
 * THIS NUMBER LIVES BETWEEN TWO OTHERS AND MUST STAY BETWEEN THEM.
 *   · Below the per-request worker count (3, in routes/dashboards.js) and one dashboard load
 *     eats the person's whole allowance, so a second tab — or the editor's 400 ms live
 *     preview, or the reload after a save — is refused and paints "too many cards loading"
 *     over cards that are perfectly fine.
 *   · Above POOL_MAX and it stops being a limit at all: one person occupies every connection
 *     and queues more behind it, and the surplus waits on `connectionTimeoutMillis` rather
 *     than on the statement budget. That failure does not even look like a limit — pg throws
 *     "timeout exceeded when trying to connect", which carries no `status`, so the card
 *     renders that raw driver sentence instead of a plain-English "give it a moment".
 * So it is CLAMPED to the pool rather than merely defaulted, and it can never be configured
 * out of that range.
 */
const MAX_PER_USER = Math.min(POOL_MAX,
  Math.max(1, parseInt(process.env.DASHBOARD_MAX_CONCURRENT || '4', 10) || 4));

// The pool's own wait must not give up sooner than a query is allowed to take, or a busy
// moment surfaces as a connection error rather than as the slow-card timeout it really is.
const CONNECT_MS = Math.max(5000, BUDGET_MS + 2000);

let pool = null;
function getPool() {
  if (pool) return pool;
  const conn = process.env.DASHBOARD_DATABASE_URL || cfg.databaseUrl || process.env.DATABASE_URL;
  pool = new Pool({
    connectionString: conn,
    ssl: sslConfig(),
    max: POOL_MAX,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: CONNECT_MS,
    // "When every client is idle, do not hold the process open." A pooled Postgres
    // socket is a live TCP handle, and this pool's 30s idle window is longer than
    // the interval on which anything re-queries it — so without this, a script or a
    // test that touches a dashboard pays a 30-second exit tax, and one that
    // re-queries inside that window never exits at all. That is the sixty-minute CI
    // hang, verbatim; it was fixed for the two pools created at require time and
    // this one was left, because it is built LAZILY on first use and no guard had
    // ever made a request that reached it (pre-merge audit 2026-09-03: measured
    // 30.09s to exit after a single query, against 0.07s with this set).
    // On the live server it changes nothing — the HTTP listener holds the process.
    allowExitOnIdle: true,
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
const waiting = new Map();

/**
 * How long a card waits for one of its own person's slots before giving up.
 *
 * FLOORED AT THE LONGEST A SLOT CAN BE HELD — the pool wait plus the statement budget —
 * for the same reason CONNECT_MS is floored above it. Set shorter, a person whose own four
 * cards are stuck in the POOL's queue behind other people's load gets their fifth card
 * refused with "too many dashboard cards loading at once", which blames them for a queue
 * they did not cause, while their own four go on to succeed seconds later. Waiting the full
 * hold time means the refusal only ever fires when the person really is the one saturating.
 *
 * NOTE the floor is applied OUTSIDE the 30s ceiling, deliberately: raising
 * DASHBOARD_TIMEOUT_MS raises the longest a slot can be held, and the wait has to follow it
 * or the premature refusal comes straight back. So at the maximum configurable budget (30s)
 * this resolves to 62s rather than 30s. That is the intended trade, not an oversight —
 * a longer spinner beats a wrong error.
 */
const QUEUE_MS = Math.max(CONNECT_MS + BUDGET_MS,
  Math.min(30000, parseInt(process.env.DASHBOARD_QUEUE_MS || '10000', 10) || 10000));
// And how many may be waiting at once, so a runaway client cannot pile up work forever.
const MAX_QUEUED = Math.max(1, MAX_PER_USER * 4);

/**
 * QUEUE, DON'T REFUSE. Being over your own limit for a moment is not an error — it is a
 * dashboard with more cards than slots, which is the normal case. Throwing immediately turned
 * that into a red "Too many dashboard cards loading at once" on cards that were fine, and the
 * person had no way to retry but to reload the page. Waiting for a slot is invisible and
 * correct; only a wait that never ends is worth reporting, and that still gets the plain
 * 429 wording (never a driver message).
 */
async function withSlot(staffId, fn) {
  const key = String(staffId || 'anon');
  if ((inflight.get(key) || 0) >= MAX_PER_USER) {
    if ((waiting.get(key) || 0) >= MAX_QUEUED) {
      const e = new Error('Too many dashboard cards loading at once — give it a moment.');
      e.status = 429;
      throw e;
    }
    waiting.set(key, (waiting.get(key) || 0) + 1);
    try {
      const started = Date.now();
      while ((inflight.get(key) || 0) >= MAX_PER_USER) {
        if (Date.now() - started > QUEUE_MS) {
          const e = new Error('Too many dashboard cards loading at once — give it a moment.');
          e.status = 429;
          throw e;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      const w = (waiting.get(key) || 1) - 1;
      if (w <= 0) waiting.delete(key); else waiting.set(key, w);
    }
  }
  inflight.set(key, (inflight.get(key) || 0) + 1);
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
    // The connect is INSIDE a mapper: pg throws a plain Error with no `code` and no `status`
    // when the pool is saturated ("timeout exceeded when trying to connect"), so left
    // unmapped it is shaped as a 500 and that raw driver sentence is what a person reads on
    // the card. It is a busy moment, not a broken card, and it says so.
    let client;
    try {
      client = await getPool().connect();
    } catch (e) {
      const t = new Error('The dashboard is busy right now — give it a moment and try again.');
      t.status = 429; t.code = 'dashboard_busy';
      console.warn('[dashboards] could not get a connection:', describeError(e));
      throw t;
    }
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

module.exports = { run, close, getPool, POOL_MAX, BUDGET_MS, MAX_PER_USER, QUEUE_MS, _inflight: inflight };
