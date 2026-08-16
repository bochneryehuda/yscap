'use strict';
/**
 * LENDER PRICE — durable L2 store for the ineligible (disqualify) workflow (db/555).
 *
 * The client keeps kickoff state + the cached result in an in-memory Map (L1, in
 * client.js). This module is the DURABLE L2 (Postgres, LT's own pool) so that
 * state SURVIVES a reboot / deploy / crash / instance-move — the exact failure
 * the A-to-Z Lender Price parity audit flagged: a restart wiped the Map, so a
 * client mid-poll got "unknown search key" and had to re-run the whole search.
 *
 * BEST-EFFORT BY DESIGN. Every call is wrapped so a database hiccup (or an
 * unmigrated / unreachable DB) degrades to the exact in-memory-only behavior the
 * client had before: writes are fire-and-forget, and a failed read returns null
 * (an L1 miss stays an L1 miss). The pricing path NEVER hard-depends on this.
 * Off switch: LP_DISQUALIFY_DURABLE=0.
 *
 * LT-only. No RTL imports; uses LT's OWN pool (src/longterm/db.js), lazily, with
 * a test injection hook.
 */

let _db = null;
let _dbTried = false;
// Lazily resolve LT's own pool. A require failure (e.g. no config) leaves _db
// null and the whole module quietly no-ops.
function db() {
  if (_db) return _db;
  if (_dbTried) return null;
  _dbTried = true;
  try { _db = require('../db'); } catch (_) { _db = null; }
  return _db;
}
// Test hook: inject a { query } (e.g. a pg Pool) so the DB path can be exercised
// against a throwaway database without the module's own pool/config.
function _setDb(d) { _db = d || null; _dbTried = true; }

function enabled() { return process.env.LP_DISQUALIFY_DURABLE !== '0' && !!db(); }

// Upsert a kickoff. Mirrors the L1 §27.4 rule: a concurrent second kickoff for
// the SAME body must NOT overwrite the first's requestId (COALESCE keeps it);
// the TTL is refreshed. Never throws.
async function persist(key, { url, body, requestId, expiresAt }) {
  if (!enabled()) return false;
  try {
    await db().query(
      `INSERT INTO lt_lp_disqualify_search (search_key, url, body, request_id, expires_at)
         VALUES ($1, $2, $3::jsonb, $4, $5)
       ON CONFLICT (search_key) DO UPDATE SET
         request_id = COALESCE(lt_lp_disqualify_search.request_id, EXCLUDED.request_id),
         expires_at = EXCLUDED.expires_at,
         updated_at = now()`,
      [key, url, JSON.stringify(body == null ? null : body), requestId || null, new Date(expiresAt).toISOString()]);
    return true;
  } catch (_e) { return false; }
}

// Materialize the parsed result (once the async computation is ready) so another
// instance serves it from cache without a re-download. Never throws.
async function saveResult(key, result, rawSummary) {
  if (!enabled()) return false;
  try {
    await db().query(
      `UPDATE lt_lp_disqualify_search
          SET result = $2::jsonb, raw_summary = $3::jsonb, ready_at = now(), updated_at = now()
        WHERE search_key = $1`,
      [key, JSON.stringify(result == null ? null : result), rawSummary == null ? null : JSON.stringify(rawSummary)]);
    return true;
  } catch (_e) { return false; }
}

// Load a non-expired kickoff (for L1 rehydrate after a restart). Returns the same
// shape the L1 entry uses, or null on a miss / any error.
async function load(key) {
  if (!enabled()) return null;
  try {
    const r = await db().query(
      `SELECT url, body, request_id, result, raw_summary, expires_at
         FROM lt_lp_disqualify_search
        WHERE search_key = $1 AND expires_at > now()
        LIMIT 1`, [key]);
    if (!r.rows || !r.rows.length) return null;
    const row = r.rows[0];
    return {
      url: row.url,
      body: row.body,                 // pg parses jsonb → object
      requestId: row.request_id || null,
      result: row.result || null,
      rawSummary: row.raw_summary || null,
      expiresAt: new Date(row.expires_at).getTime(),
    };
  } catch (_e) { return null; }
}

// Delete expired rows. Never throws; returns the count removed (0 on any error).
async function prune() {
  if (!enabled()) return 0;
  try {
    const r = await db().query('DELETE FROM lt_lp_disqualify_search WHERE expires_at <= now()');
    return (r && r.rowCount) || 0;
  } catch (_e) { return 0; }
}

module.exports = { enabled, persist, saveResult, load, prune, _setDb };
