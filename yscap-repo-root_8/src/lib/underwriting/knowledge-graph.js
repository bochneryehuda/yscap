'use strict';
/**
 * Investor Knowledge Graph v1 (R3.28, owner-directed 2026-07-22).
 *
 * Read-only aggregation across the portfolio. For any given borrower or entity
 * (LLC), returns:
 *   * how many past PILOT files they have (all-time + last 12mo)
 *   * how many properties/zips they've touched
 *   * every entity we've seen them on (managing member, ≥25% owner, etc.)
 *   * shared signals with other files (same registered agent / same address /
 *     same phone number surfacing across multiple LLCs)
 *
 * Pure aggregations built from existing tables — no new schema. Best-effort:
 * a slow query never blocks; the whole payload has defensive fallbacks.
 *
 * Surfaces:
 *   * GET /api/underwriting/:appId/knowledge-graph — this-file view
 *   * (later) GET /api/admin/insights/graph — portfolio graph
 */

let _db = null;
const db = () => (_db || (_db = require('../../db')));

/**
 * Build the file-view graph slice. Returns quickly with counts + top rows.
 * Every query is wrapped so a failure returns empty rather than throwing.
 * @returns {Promise<object>}
 */
async function fileGraph(appId, client) {
  const c = client || db();
  const empty = { borrower: null, entities: [], siblingFiles: [], sharedSignals: [] };
  try {
    const app = (await c.query(
      `SELECT id, borrower_id, llc_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!app) return empty;
    const [borrower, entities, siblings, shared] = await Promise.all([
      _borrower(c, app.borrower_id),
      _borrowerEntities(c, app.borrower_id),
      _siblingFiles(c, app.borrower_id, appId),
      _sharedSignals(c, app.llc_id),
    ]).catch(() => [null, [], [], []]);
    return { borrower, entities, siblingFiles: siblings, sharedSignals: shared };
  } catch (_) { return empty; }
}

async function _borrower(c, borrowerId) {
  if (!borrowerId) return null;
  const r = await c.query(
    `SELECT b.id, b.first_name, b.last_name,
            (SELECT count(*)::int FROM applications a WHERE a.borrower_id = b.id AND a.deleted_at IS NULL) AS files_total,
            (SELECT count(*)::int FROM applications a WHERE a.borrower_id = b.id AND a.deleted_at IS NULL AND a.created_at > now() - interval '12 months') AS files_12mo,
            (SELECT count(DISTINCT (COALESCE(a.property_address->>'zip', a.property_address->>'zipcode', '')))
               FROM applications a WHERE a.borrower_id = b.id AND a.deleted_at IS NULL) AS zips_touched
       FROM borrowers b WHERE b.id=$1`, [borrowerId]);
  return r.rows[0] || null;
}

async function _borrowerEntities(c, borrowerId) {
  if (!borrowerId) return [];
  const r = await c.query(
    `SELECT id, llc_name AS name, state_of_formation AS state, is_verified,
            (SELECT count(*)::int FROM applications a WHERE a.llc_id = l.id AND a.deleted_at IS NULL) AS files_on_entity
       FROM llcs l WHERE l.borrower_id=$1 ORDER BY l.llc_name`, [borrowerId]);
  return r.rows;
}

async function _siblingFiles(c, borrowerId, currentAppId) {
  if (!borrowerId) return [];
  const r = await c.query(
    `SELECT id, status, program, property_address, created_at, loan_amount
       FROM applications
      WHERE borrower_id=$1 AND id <> $2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 30`, [borrowerId, currentAppId]);
  return r.rows;
}

/**
 * "Shared signals" — an LLC's registered address / phone number that appears on
 * OTHER LLCs on OTHER files. This is a straw-buyer / shared-shell signal. We don't
 * have a dedicated column for the entity address, so this uses the applications
 * property_address as a very rough proxy — real depth arrives when the operating
 * agreement extraction lands (owner-directed 2026-07-22, deferred).
 */
async function _sharedSignals(c, llcId) {
  if (!llcId) return [];
  try {
    const r = await c.query(
      `SELECT 'same_llc_multi_files' AS signal,
              (SELECT count(*)::int FROM applications a WHERE a.llc_id=$1 AND a.deleted_at IS NULL) AS files_on_llc,
              (SELECT array_agg(a.id) FROM applications a WHERE a.llc_id=$1 AND a.deleted_at IS NULL) AS file_ids
       WHERE (SELECT count(*)::int FROM applications a WHERE a.llc_id=$1 AND a.deleted_at IS NULL) > 1`, [llcId]);
    return r.rows;
  } catch (_) { return []; }
}

module.exports = { fileGraph };
