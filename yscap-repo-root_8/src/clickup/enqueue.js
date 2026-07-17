/**
 * Outbound push enqueue — a portal change to an application enqueues a ClickUp
 * push so it propagates within a few seconds (drained by pushOutboxOnce every
 * ~4s).
 *
 * NOTE (WO-5 / F-M3): there is NO dirty-sweep backstop anymore (it was retired
 * to a no-op). So an enqueue that fails to persist is a lost push. Until the
 * enqueue is made transactional with the caller's write (WO-5 phase 2), a
 * failure here is at least made LOUD and traceable — logged and recorded as a
 * `clickup_enqueue_failed` audit_log row (PII-free) so a lost push is
 * discoverable, never silent.
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
// opts.humanEditKeys: the subset of `only` that a HUMAN typed directly into an
// authenticated portal form (owner-directed 2026-07-15 night: "we need to be
// able to edit every single ClickUp field from PILOT including DOB"). The
// outbound DOB gate blocks AUTOMATED changes pending review — but a staff
// member typing the DOB IS the human decision the gate exists to demand, so
// these keys ride the queue and bypass that one gate (still journaled,
// no-op-suppressed, breaker-limited like every write). Merged as a union so a
// human edit is never lost when jobs coalesce.
async function enqueueClickupPush(appId, only = [], opts = {}) {
  if (!appId || !cfg.clickupSyncEnabled) return;
  const keys = Array.isArray(only) ? [...new Set(only.map(String).filter(Boolean))] : [];
  if (!keys.length) return;
  const keysJson = JSON.stringify(keys);
  const humanKeys = Array.isArray(opts.humanEditKeys) ? [...new Set(opts.humanEditKeys.map(String).filter(Boolean))] : [];
  const humanJson = JSON.stringify(humanKeys);
  try {
    // Merge the changed-field set into an existing QUEUED job (union), so rapid
    // successive edits accumulate into ONE scoped push (push reads live data at
    // drain time, so only the field SET needs to survive). We deliberately do NOT
    // merge into a 'processing' job: the drainer snapshots payload.only when it
    // grabs the job, so a field merged after that snapshot would be marked done
    // without ever being pushed. Letting it fall through to a fresh INSERT below
    // guarantees the new field gets its own queued job (there is no dirty-sweep
    // backstop, so a lost merge would be a permanently lost push).
    const merged = await db.query(
      `UPDATE sync_queue
          SET payload = jsonb_build_object('only', to_jsonb(ARRAY(
                SELECT DISTINCT e FROM (
                  SELECT jsonb_array_elements_text(COALESCE(payload->'only','[]'::jsonb)) AS e
                  UNION
                  SELECT jsonb_array_elements_text($2::jsonb) AS e
                ) u WHERE e IS NOT NULL AND e <> '')),
              'humanEditKeys', to_jsonb(ARRAY(
                SELECT DISTINCT e FROM (
                  SELECT jsonb_array_elements_text(COALESCE(payload->'humanEditKeys','[]'::jsonb)) AS e
                  UNION
                  SELECT jsonb_array_elements_text($3::jsonb) AS e
                ) u WHERE e IS NOT NULL AND e <> ''))),
              updated_at = now()
        WHERE target='clickup' AND direction='push' AND entity_type='application'
          AND entity_id=$1 AND status='queued'
        RETURNING id`,
      [appId, keysJson, humanJson]);
    if (merged.rowCount > 0) return;
    await db.query(
      `INSERT INTO sync_queue (entity_type, entity_id, target, direction, op, status, payload, run_after)
       VALUES ('application', $1, 'clickup', 'push', 'update', 'queued', jsonb_build_object('only', $2::jsonb, 'humanEditKeys', $3::jsonb), now())`,
      [appId, keysJson, humanJson]);
  } catch (e) {
    // WO-5 (F-M3): do NOT swallow — there is no backstop sweep, so a swallowed
    // failure loses this edit's push forever with zero trace. Make it loud and
    // discoverable. Detail is PII-free: the changed field KEYS (column names) and
    // the error, never any borrower value.
    console.error('[clickup-enqueue] FAILED to enqueue push for app', appId, 'keys', keysJson, '—', e.message);
    try {
      await db.query(
        `INSERT INTO audit_log (actor_kind, action, entity_type, entity_id, detail)
         VALUES ('system', 'clickup_enqueue_failed', 'application', $1, $2)`,
        [appId, JSON.stringify({ keys, error: String(e.message).slice(0, 300) })]);
    } catch (_) { /* if even the audit write fails, the console.error above is the last resort */ }
  }
}

// Enqueue a SCOPED push of ONE checklist condition's status to its ClickUp
// dropdown. Self-gating: no-ops unless the item is mapped (clickup_field_id set)
// AND its file is linked to a ClickUp task — so it is safe to wire at every
// checklist status-transition site. The logical key `checklist:<fieldId>` routes
// through the same changed-fields-only push, so it can never rewrite the task.
async function enqueueChecklistStatusPush(itemId) {
  if (!itemId || !cfg.clickupSyncEnabled) return;
  try {
    const r = await db.query(
      `SELECT ci.application_id, ci.clickup_field_id
         FROM checklist_items ci JOIN applications a ON a.id = ci.application_id
        WHERE ci.id=$1 AND ci.clickup_field_id IS NOT NULL
          AND a.clickup_pipeline_task_id IS NOT NULL AND a.deleted_at IS NULL`, [itemId]);
    const row = r.rows[0];
    if (!row) return;                       // unmapped item / unlinked file → no-op
    await enqueueClickupPush(row.application_id, [`checklist:${row.clickup_field_id}`]);
  } catch (_) { /* best-effort */ }
}

module.exports = { enqueueClickupPush, enqueueChecklistStatusPush };
