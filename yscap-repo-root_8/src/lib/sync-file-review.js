'use strict';

/**
 * FILE-LEVEL sync review — actions for WHOLE FILES that are stuck, not just a
 * field that is wrong (owner-directed 2026-07-15 night: "any file that you
 * can't sync, that you don't know how to handle, a duplicate that failed the
 * standard duplicate process, something that got stuck — everything goes to
 * manual review, WITH OPTIONS how to resolve it").
 *
 * The rows live in the same sync_review_queue (fieldKey 'file_link' /
 * 'push_job'); what makes them file-level is the RESOLUTION: instead of
 * adopting one side's field value, the reviewer picks an ACTION —
 * create-the-file, link-to-an-existing-file, retry-the-push, archive-the-
 * orphan — and the action runs the SAME guarded machinery the sync itself
 * uses (ingestOne/forceCreate, createForNewFile, the queue's retry). Nothing
 * here bypasses a write guard: there is no "edit ClickUp from the review".
 *
 * REASON_ACTIONS is the single source of truth for which actions each stuck
 * state offers — the endpoint validates against it and the UI renders from
 * copies of it, so a new stuck state = one entry here + a producer + copy.
 */
const db = require('../db');

// reason slug → the actions a reviewer may take on it. 'dismiss' (the plain
// reject endpoint) is always additionally available and not listed here.
const REASON_ACTIONS = {
  // A ClickUp task that could not materialize because identity signals point
  // at more than one file / another borrower's loan number.
  file_not_materialized_ambiguous: ['create_file', 'link_existing'],
  // A fresh ClickUp duplicate deliberately deferred while it still shows the
  // source deal's address. create_file is the same deliberate override as the
  // Control Center force-create.
  file_not_materialized_duplicate_pending: ['create_file', 'link_existing'],
  // The file's linked ClickUp task was DELETED and no live sibling exists.
  task_deleted_needs_decision: ['archive_file', 'keep_file'],
  // An outbound push exhausted its retry budget (dead-lettered).
  push_dead_lettered: ['retry_push'],
  // A portal file older than the auto-recovery window with no ClickUp task.
  file_unlinked_no_task: ['create_task'],
};

// Rows with no ClickUp task (an unlinked FILE) still need a dedup identity in
// the queue's per-task unique index — coalesce(task_id,'') would otherwise
// allow only ONE open row across ALL unlinked files. The synthetic key is
// namespaced so it can never collide with a real ClickUp task id, and
// closeStaleReviews({applicationId}) closes these rows without knowing it.
function syntheticTaskKey(applicationId) { return 'app:' + String(applicationId); }

function isActionAllowed(reason, action) {
  const list = REASON_ACTIONS[reason];
  return Array.isArray(list) && list.includes(action);
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function audit(action, entityId, actorId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ($1,$2,$3,'application',$4,$5)`,
      [actorId ? 'staff' : 'system', actorId || null, action, entityId || null,
       detail ? JSON.stringify(detail) : null]);
  } catch (_) { /* audit best-effort */ }
}

/**
 * Apply a reviewer-chosen file-level action. `row` is the OPEN
 * sync_review_queue row (already permission-checked by the route). Returns
 * { note, applicationId? } for the resolution note; throws httpError(4xx) on
 * invalid input and lets 5xx bubbles surface as-is. Marking the row resolved
 * is the CALLER's job (shared with the other resolve endpoints).
 */
async function applyFileReviewAction({ row, action, targetApplicationId, actorId }) {
  if (!isActionAllowed(row.reason, action)) {
    throw httpError(400, `action '${action}' is not available for this row`);
  }

  if (action === 'create_file') {
    // The deliberate human override: materialize the task as its OWN file
    // through the normal ingest (every guard except the duplicate-defer still
    // applies — same as the Control Center force-create).
    if (!row.task_id || row.task_id.startsWith('app:')) throw httpError(409, 'this row has no ClickUp task to create from');
    const sync = require('../sync/clickup-sync');
    const res = await sync.ingestOne(row.task_id, { forceCreate: true });
    if (!res || !res.applicationId) {
      throw httpError(409, `the task still did not materialize (${(res && res.matchStatus) || 'unknown'}) — check the Control Center manual-review queue`);
    }
    await audit('sync_review_force_create', res.applicationId, actorId, { taskId: row.task_id, reviewId: row.id });
    return { note: `created as its own file (${res.applicationId})`, applicationId: res.applicationId };
  }

  if (action === 'link_existing') {
    // Bind the stuck task to a reviewer-chosen EXISTING portal file, then
    // re-ingest so the file fills through the normal COALESCE pull and the
    // portal_stamp push re-points the task at its own file.
    if (!row.task_id || row.task_id.startsWith('app:')) throw httpError(409, 'this row has no ClickUp task to link');
    if (!targetApplicationId) throw httpError(400, 'targetApplicationId is required for link_existing');
    const app = (await db.query(
      `SELECT id, borrower_id, clickup_pipeline_task_id FROM applications WHERE id=$1 AND deleted_at IS NULL`,
      [targetApplicationId])).rows[0];
    if (!app) throw httpError(404, 'target file not found');
    if (app.clickup_pipeline_task_id && app.clickup_pipeline_task_id !== row.task_id) {
      throw httpError(409, 'that file is already linked to a different ClickUp task');
    }
    // The target must be plausibly THIS deal: either the same borrower the
    // task resolved to, or one of the candidate files the matcher surfaced.
    let candidateIds = [];
    try {
      const raw = row.raw_value ? JSON.parse(row.raw_value) : null;
      candidateIds = ((raw && (raw.candidates || (raw.detail && raw.detail.candidates))) || [])
        .map((c) => String(c && c.id != null ? c.id : c));
    } catch (_) { /* raw_value is forensic — unparseable is fine */ }
    const sameBorrower = row.borrower_id && String(app.borrower_id) === String(row.borrower_id);
    if (!sameBorrower && !candidateIds.includes(String(app.id))) {
      throw httpError(409, 'that file belongs to a different borrower and was not a match candidate');
    }
    await db.query(
      `UPDATE applications SET clickup_pipeline_task_id=$2, sync_state='linked', updated_at=now() WHERE id=$1`,
      [app.id, row.task_id]);
    await audit('sync_review_link_existing', app.id, actorId, { taskId: row.task_id, reviewId: row.id });
    // Fill from the task through the normal guarded pull; the unlinked→linked
    // stamp push happens inside ingest. Best-effort — the link itself is done.
    try { await require('../sync/clickup-sync').ingestOne(row.task_id); } catch (e) { console.warn('[sync-file-review] post-link ingest failed:', e.message); }
    return { note: `linked to existing file ${app.id}`, applicationId: app.id };
  }

  if (action === 'archive_file') {
    // Same soft-archive the orphan auto-merge uses: reversible, ClickUp
    // untouched, drops out of every list + sync loop.
    if (!row.application_id) throw httpError(409, 'this row has no portal file to archive');
    const u = await db.query(
      `UPDATE applications SET deleted_at=now(), sync_state='dead', updated_at=now()
        WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [row.application_id]);
    if (!u.rows[0]) throw httpError(409, 'the file is already archived');
    await audit('sync_review_archive_orphan', row.application_id, actorId, { taskId: row.task_id, reviewId: row.id });
    return { note: 'file archived (its ClickUp task was deleted); reversible by an admin', applicationId: row.application_id };
  }

  if (action === 'keep_file') {
    // Keep the portal file even though its task is gone. It stays out of the
    // sync loops (sync_state='manual_review') until a human relinks it — a
    // future ambiguous-task row's link_existing can do exactly that.
    if (!row.application_id) throw httpError(409, 'this row has no portal file to keep');
    await audit('sync_review_keep_orphan', row.application_id, actorId, { taskId: row.task_id, reviewId: row.id });
    return { note: 'file kept in PILOT without a ClickUp task (relink it later via a new task)', applicationId: row.application_id };
  }

  if (action === 'retry_push') {
    // Re-arm the dead-lettered queue job — the push re-runs through every
    // normal guard (journal, no-op suppression, circuit breaker).
    let jobId = null;
    try { const raw = row.raw_value ? JSON.parse(row.raw_value) : null; jobId = raw && raw.jobId; } catch (_) {}
    if (!jobId) throw httpError(409, 'this row does not reference a queue job');
    const u = await db.query(
      `UPDATE sync_queue SET status='queued', attempts=0, run_after=now(), updated_at=now()
        WHERE id=$1 AND status='dead' RETURNING id`, [jobId]);
    if (!u.rows[0]) throw httpError(409, 'the push job is no longer dead-lettered (already retried or completed)');
    await audit('sync_review_retry_push', row.application_id, actorId, { jobId, reviewId: row.id });
    return { note: `push job ${jobId} re-queued`, applicationId: row.application_id };
  }

  if (action === 'create_task') {
    // Give a long-unlinked file its ClickUp task via the one true create path.
    if (!row.application_id) throw httpError(409, 'this row has no portal file');
    const orchestrator = require('../clickup/orchestrator');
    const out = await orchestrator.createForNewFile(row.application_id);
    if (!out || !out.taskId) throw httpError(409, 'ClickUp task creation did not complete — check outbound sync settings and retry');
    await audit('sync_review_create_task', row.application_id, actorId, { taskId: out.taskId, reviewId: row.id });
    return { note: `ClickUp task ${out.taskId} created for the file`, applicationId: row.application_id };
  }

  throw httpError(400, `unknown action '${action}'`);
}

module.exports = { REASON_ACTIONS, isActionAllowed, syntheticTaskKey, applyFileReviewAction };
