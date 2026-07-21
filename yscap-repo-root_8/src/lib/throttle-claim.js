'use strict';
/**
 * Atomic "claim a send once per period" — the shared throttle used by the
 * notification digests and the per-file event emails (doc-accepted, all-caught-up,
 * nudge, appraisal-received).
 *
 * The naive `INSERT … SELECT … WHERE NOT EXISTS … RETURNING` is NOT atomic under
 * READ COMMITTED: two concurrent transactions each take a snapshot that does not
 * see the other's uncommitted row, so BOTH pass NOT EXISTS and BOTH insert — the
 * classic non-atomic-upsert race. In production this bit during deploy overlap /
 * scale-out (two instances ran the digest dispatcher at once) and double-sent.
 *
 * A single-statement CTE advisory lock does NOT fix it: the statement's snapshot
 * is taken BEFORE the CTE acquires the lock, so a waiter still reads a pre-insert
 * snapshot (verified empirically). The correct pattern is to take the advisory
 * lock as its OWN statement inside an explicit transaction, so the following
 * INSERT runs under a FRESH snapshot that sees a prior winner's committed row.
 * `pg_advisory_xact_lock` auto-releases at COMMIT/ROLLBACK.
 *
 * Returns the new audit_log row id (truthy) to the SINGLE winner, or null to
 * everyone else. Fails CLOSED (null) on any DB error — a throttle that can't
 * prove it won does not send.
 *
 *   claimOncePerPeriod({ action, entityId, interval })            // per-file
 *   claimOncePerPeriod({ action, interval })                      // global (entityId null)
 *   claimOncePerPeriod({ action, entityId, interval, actorKind, actorId, entityType, detail })
 */
const db = require('../db');

async function claimOncePerPeriod({ action, entityId = null, interval, actorKind = 'system', actorId = null, entityType = 'application', detail = {} }) {
  if (!action || !interval) return null;
  const key = `${action}:${entityId == null ? '__global__' : entityId}`;
  let client;
  try {
    client = await db.getClient();
  } catch (_) { return null; }
  try {
    await client.query('BEGIN');
    // Serialize claimants on (action, entity) BEFORE the read — a separate
    // statement so the INSERT below gets a post-lock snapshot.
    // hashtextextended returns a 64-bit hash; a 32-bit hashtext collision would silently serialize
    // two unrelated (action, entity) pairs (audit finding 2026-07-21). Bumped to 64-bit.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    const q = entityId == null
      ? await client.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           SELECT $1, $2, $3, $4, NULL, $5::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action=$3 AND entity_id IS NULL AND created_at > now() - $6::interval)
           RETURNING id`,
          [actorKind, actorId, action, entityType, JSON.stringify(detail || {}), interval])
      : await client.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           SELECT $1, $2, $3, $4, $5::uuid, $6::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action=$3 AND entity_id=$5::uuid AND created_at > now() - $7::interval)
           RETURNING id`,
          [actorKind, actorId, action, entityType, entityId, JSON.stringify(detail || {}), interval]);
    await client.query('COMMIT');
    return q.rows[0] ? q.rows[0].id : null;
  } catch (_) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    return null; // fail closed
  } finally {
    try { client.release(); } catch (_e) { /* ignore */ }
  }
}

module.exports = { claimOncePerPeriod };
