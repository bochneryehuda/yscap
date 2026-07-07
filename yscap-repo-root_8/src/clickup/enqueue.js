/**
 * Outbound push enqueue — a portal change to an application enqueues a ClickUp
 * push so it propagates within a few seconds (drained by pushOutboxOnce every
 * ~4s), rather than waiting for the dirty-sweep. The sweep remains the reliable
 * catch-all backstop, so a missed enqueue call never loses a change.
 *
 * Safety: this only ever enqueues an UPDATE push. There is NO delete op — a
 * portal deletion never propagates to ClickUp (enforced structurally by the
 * client-layer hard stop + the orchestrator's deleted_at guard).
 */
const db = require('../db');
const cfg = require('../config');

// only: array of logical field keys the edit changed (application/borrower column
// names, or synthetic 'status'/'officer'/'processor'). The push writes ONLY the
// ClickUp fields those keys resolve to, so an edit can never rewrite the rest of
// the task. Callers should always pass the changed keys; an empty set enqueues
// nothing (there's nothing specific to propagate).
async function enqueueClickupPush(appId, only = []) {
  if (!appId || !cfg.clickupSyncEnabled) return;
  const keys = Array.isArray(only) ? [...new Set(only.map(String).filter(Boolean))] : [];
  if (!keys.length) return;
  const keysJson = JSON.stringify(keys);
  try {
    // Merge the changed-field set into an existing queued/processing job (union),
    // so rapid successive edits accumulate into ONE scoped push (push reads live
    // data at drain time, so only the field SET needs to survive).
    const merged = await db.query(
      `UPDATE sync_queue
          SET payload = jsonb_build_object('only', to_jsonb(ARRAY(
                SELECT DISTINCT e FROM (
                  SELECT jsonb_array_elements_text(COALESCE(payload->'only','[]'::jsonb)) AS e
                  UNION
                  SELECT jsonb_array_elements_text($2::jsonb) AS e
                ) u WHERE e IS NOT NULL AND e <> ''))),
              updated_at = now()
        WHERE target='clickup' AND direction='push' AND entity_type='application'
          AND entity_id=$1 AND status IN ('queued','processing')
        RETURNING id`,
      [appId, keysJson]);
    if (merged.rowCount > 0) return;
    await db.query(
      `INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, payload, run_after)
       VALUES ('application', $1, 'clickup', 'push', 'update', 'queued', jsonb_build_object('only', $2::jsonb), now())`,
      [appId, keysJson]);
  } catch (_) { /* best-effort */ }
}

module.exports = { enqueueClickupPush };
