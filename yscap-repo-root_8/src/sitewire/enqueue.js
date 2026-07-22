'use strict';
/**
 * Outbound Sitewire push enqueue — reuses sync_queue as the durable OUTBOX
 * (target='sitewire'). A funded file's "Request a draw" click enqueues 'push_file'
 * (the birth push); a reallocation change-request enqueues 'reallocation'. Merges into
 * an existing queued job for the same file+op so rapid re-clicks coalesce. Best-effort:
 * the worker's reconcile pass is the catch-all backstop.
 */
const db = require('../db');
const switches = require('../lib/integrations/switches'); // runtime on/off (env default unless flipped)

async function enqueueSitewirePush(appId, op = 'push_file', payload = {}) {
  if (!appId || !switches.on('SITEWIRE_ENABLED')) return;
  const body = JSON.stringify(payload || {});
  // Serialize the read-modify-write on this (app, op) key so a race between two concurrent enqueues
  // can't both fall through the UPDATE and insert a duplicate queued row (audit finding
  // 2026-07-21). Wrap the merge+insert in a transaction with a per-key advisory lock; the second
  // caller blocks until the first commits, then its UPDATE finds the queued row and short-circuits.
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`sw-enqueue:${appId}:${op}`]);
    const merged = await client.query(
      `UPDATE sync_queue SET payload = COALESCE(payload,'{}'::jsonb) || $3::jsonb, updated_at=now()
        WHERE target='sitewire' AND direction='push' AND entity_type='application'
          AND entity_id=$1 AND op=$2 AND status='queued' RETURNING id`,
      [appId, op, body]);
    if (merged.rowCount === 0) {
      await client.query(
        `INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, payload, run_after)
         VALUES ('application', $1, 'sitewire', 'push', $2, 'queued', $3::jsonb, now())`,
        [appId, op, body]);
    }
    await client.query('COMMIT');
  } catch (_) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    /* best-effort; reconcile backstops */
  } finally {
    client.release();
  }
}

module.exports = { enqueueSitewirePush };
