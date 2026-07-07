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

async function enqueueClickupPush(appId) {
  if (!appId || !cfg.clickupSyncEnabled) return;
  try {
    // Dedup: don't pile up jobs for the same app if it's edited rapidly — one
    // queued/processing job already covers the latest state (push reads live data).
    await db.query(
      `INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, run_after)
       SELECT 'application', $1, 'clickup', 'push', 'update', 'queued', now()
        WHERE NOT EXISTS (
          SELECT 1 FROM sync_queue WHERE target='clickup' AND direction='push'
            AND entity_type='application' AND entity_id=$1 AND status IN ('queued','processing'))`,
      [appId]);
  } catch (_) { /* best-effort — the dirty-sweep backs this up */ }
}

module.exports = { enqueueClickupPush };
