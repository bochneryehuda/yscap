'use strict';

/**
 * THE PURCHASING WORKFLOW (owner-directed 2026-07-26).
 *
 * Where a file goes AFTER the closer signs off investor delivery — unless it was
 * TABLE FUNDED, in which case it was sold right at closing and never lands here.
 *
 *   investor delivery signed off + NOT table funded  → purchasing ('outstanding')
 *   investor delivery signed off + table funded      → sold at closing, no purchasing
 *
 * The desk shows what is still outstanding, with per-file NOTES ("what you're
 * still missing") and TASKS. Reads are best-effort shaped so a missing sub-part
 * never blanks the screen.
 *
 * Schema: db/348_purchasing_workflow.sql.
 */

const db = require('../db');

// ---------------------------------------------------------------------------
// ENTER purchasing. Called when investor delivery is signed off on a file that
// was NOT table funded. Idempotent — a file already in purchasing keeps its
// original entered_at and its status (never resurrects a completed row here).
// Runs on the caller's client so it can join the sign-off transaction.
// ---------------------------------------------------------------------------
async function enterPurchasing(client, appId, actorId) {
  const c = client || db;
  const r = await c.query(
    `INSERT INTO purchasing_workflow (application_id, status, entered_by, updated_by)
     VALUES ($1, 'outstanding', $2::uuid, $2::uuid)
     ON CONFLICT (application_id) DO NOTHING
     RETURNING *`,
    [appId, actorId || null]);
  return r.rows[0] || null;
}

// A file that is table funded (or whose investor delivery was un-signed) should
// not be sitting in purchasing. Only removes a row that is still OUTSTANDING —
// a completed purchasing record is history and is never deleted.
async function withdrawFromPurchasing(client, appId) {
  const c = client || db;
  const r = await c.query(
    `DELETE FROM purchasing_workflow
      WHERE application_id=$1 AND status='outstanding' RETURNING *`, [appId]);
  return r.rows[0] || null;
}

async function getPurchasing(appId, client) {
  const c = client || db;
  // The advice document's filename rides along so the desk can link it without a
  // second round trip. LEFT JOIN — the pointer may be null, or point at a document
  // that was since deleted (the FK is ON DELETE SET NULL, but a stale read is
  // still possible mid-transaction).
  const r = await c.query(
    `SELECT p.*, d.filename AS purchase_advice_filename, d.created_at AS purchase_advice_uploaded_at
       FROM purchasing_workflow p
       LEFT JOIN documents d ON d.id = p.purchase_advice_document_id
      WHERE p.application_id=$1`, [appId]);
  return r.rows[0] || null;
}

async function setPurchasingStatus(client, appId, status, actorId) {
  const c = client || db;
  const done = status === 'complete';
  const r = await c.query(
    `UPDATE purchasing_workflow
        SET status=$2,
            completed_at = CASE WHEN $2='complete' THEN COALESCE(completed_at, now()) ELSE NULL END,
            completed_by = CASE WHEN $2='complete' THEN $3::uuid ELSE NULL END,
            updated_at=now(), updated_by=$3::uuid
      WHERE application_id=$1 RETURNING *`,
    [appId, done ? 'complete' : 'outstanding', actorId || null]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// Notes — "what you're still missing", newest first.
// ---------------------------------------------------------------------------
async function readNotes(appId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT n.id, n.body, n.created_at, n.author_staff_id, s.full_name AS author_name
       FROM purchasing_notes n LEFT JOIN staff_users s ON s.id = n.author_staff_id
      WHERE n.application_id=$1 ORDER BY n.created_at DESC LIMIT 200`, [appId]);
  return r.rows;
}

async function addNote(client, appId, body, actorId) {
  const c = client || db;
  const r = await c.query(
    `INSERT INTO purchasing_notes (application_id, author_staff_id, body)
     VALUES ($1,$2::uuid,$3) RETURNING *`,
    [appId, actorId || null, String(body).slice(0, 4000)]);
  return r.rows[0];
}

// ---------------------------------------------------------------------------
// Tasks — a flat, checkable to-do list per file.
// ---------------------------------------------------------------------------
async function readTasks(appId, client) {
  const c = client || db;
  const r = await c.query(
    `SELECT t.id, t.label, t.done, t.done_by, t.done_at, t.sort_order, t.created_at,
            s.full_name AS done_by_name
       FROM purchasing_tasks t LEFT JOIN staff_users s ON s.id = t.done_by
      WHERE t.application_id=$1 ORDER BY t.done, t.sort_order, t.created_at`, [appId]);
  return r.rows;
}

async function addTask(client, appId, label, actorId, sortOrder) {
  const c = client || db;
  const r = await c.query(
    `INSERT INTO purchasing_tasks (application_id, label, created_by, sort_order)
     VALUES ($1,$2,$3::uuid,COALESCE($4,100)) RETURNING *`,
    [appId, String(label).slice(0, 500), actorId || null,
     Number.isFinite(Number(sortOrder)) ? Number(sortOrder) : null]);
  return r.rows[0];
}

// $3 is cast to ::uuid: a bare parameter inside CASE WHEN…THEN resolves to text
// and the uuid column write throws (the closing checklist hit exactly that).
async function setTaskDone(client, taskId, done, actorId) {
  const c = client || db;
  const r = await c.query(
    `UPDATE purchasing_tasks
        SET done=$2,
            done_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
            done_at = CASE WHEN $2 THEN now() ELSE NULL END
      WHERE id=$1 RETURNING *`,
    [taskId, !!done, actorId || null]);
  return r.rows[0] || null;
}

async function deleteTask(client, taskId) {
  const c = client || db;
  await c.query(`DELETE FROM purchasing_tasks WHERE id=$1`, [taskId]);
}

// ---------------------------------------------------------------------------
// The per-file purchasing payload the desk renders. Best-effort per sub-part.
// ---------------------------------------------------------------------------
async function getPurchasingWorkspace(appId, client) {
  const c = client || db;
  const safe = async (fn, fallback) => { try { return await fn(); } catch (_) { return fallback; } };
  // The STATUS read is deliberately NOT swallowed: returning inPurchasing:false on
  // a transient DB error would tell the desk this file is not in purchasing, which
  // is a lie the caller cannot tell apart from the truth. Notes/tasks may degrade
  // to empty — a missing list reads as "nothing yet", which is survivable.
  const row = await getPurchasing(appId, c);
  const notes = await safe(() => readNotes(appId, c), []);
  const tasks = await safe(() => readTasks(appId, c), []);
  const conditions = await safe(() => readConditions(appId, c), []);
  // The file's current documents, so the desk can point at which one IS the
  // purchase advice without a second round trip. Newest first — the advice is
  // re-issued post closing and again post purchase, so the newest is usually it.
  // The document currently POINTED AT is always included even if it has since
  // been superseded — otherwise the picker would show "none selected" while the
  // line beneath it still named the old file.
  const documents = await safe(async () => (await c.query(
    `SELECT d.id, d.filename, d.doc_kind, d.created_at, d.is_current FROM documents d
      WHERE d.application_id=$1
        AND (COALESCE(d.is_current, true) = true
             OR d.id = (SELECT p.purchase_advice_document_id FROM purchasing_workflow p
                         WHERE p.application_id=$1))
      ORDER BY d.created_at DESC LIMIT 200`, [appId])).rows, []);
  return {
    application_id: appId,
    purchasing: row,
    inPurchasing: !!row,
    notes,
    tasks,
    conditions,
    documents,
    openTasks: tasks.filter((t) => !t.done).length,
    openConditions: conditions.filter((x) => x.status === 'open').length,
  };
}

// ---------------------------------------------------------------------------
// PURCHASING CONDITIONS — what the buyer still needs before they will purchase.
// Post-closing and desk-owned: never borrower-visible, which is exactly why they
// live in their own table instead of checklist_items (see db/350).
// ---------------------------------------------------------------------------
const CONDITION_STATUSES = ['open', 'cleared', 'waived'];

async function readConditions(appId, client) {
  const c = client || db;
  return (await c.query(
    `SELECT pc.*, cb.full_name AS created_by_name, rb.full_name AS resolved_by_name
       FROM purchasing_conditions pc
       LEFT JOIN staff_users cb ON cb.id = pc.created_by
       LEFT JOIN staff_users rb ON rb.id = pc.resolved_by
      WHERE pc.application_id=$1
      ORDER BY (pc.status = 'open') DESC, pc.sort_order, pc.created_at`, [appId])).rows;
}

async function addCondition(client, appId, label, detail, actorId, sortOrder) {
  const c = client || db;
  return (await c.query(
    `INSERT INTO purchasing_conditions (application_id, label, detail, created_by, sort_order)
     VALUES ($1,$2,$3,$4::uuid,$5) RETURNING *`,
    [appId, String(label).slice(0, 300), detail ? String(detail).slice(0, 2000) : null,
     actorId || null, Number.isFinite(sortOrder) ? Math.round(sortOrder) : 0])).rows[0];
}

/* Resolving is reversible: setting it back to 'open' CLEARS who resolved it, so a
 * reopened condition never keeps a stale signature — the same discipline the
 * platform's other sign-off surfaces use. */
async function setConditionStatus(client, condId, status, actorId, note) {
  const c = client || db;
  if (!CONDITION_STATUSES.includes(status)) throw new Error('unknown purchasing condition status');
  const done = status !== 'open';
  return (await c.query(
    `UPDATE purchasing_conditions
        SET status=$2,
            resolved_at     = CASE WHEN $4 THEN now()      ELSE NULL END,
            resolved_by     = CASE WHEN $4 THEN $3::uuid   ELSE NULL END,
            resolution_note = CASE WHEN $4 THEN $5         ELSE NULL END
      WHERE id=$1 RETURNING *`,
    [condId, status, actorId || null, done, note ? String(note).slice(0, 2000) : null])).rows[0] || null;
}

async function deleteCondition(client, condId) {
  const c = client || db;
  return (await c.query(`DELETE FROM purchasing_conditions WHERE id=$1 RETURNING id`, [condId])).rows[0] || null;
}

/* PURCHASE ADVICE — a date and the current advice document. Re-issued post
 * closing and again post purchase, so this is an ordinary update, not a
 * write-once. Only keys actually present in `patch` are touched, so setting the
 * date never clears the document and vice versa. */
async function setPurchaseAdvice(client, appId, patch, actorId) {
  const c = client || db;
  const sets = [];
  const vals = [appId];
  if ('date' in patch) { vals.push(patch.date || null); sets.push(`purchase_advice_date=$${vals.length}::date`); }
  if ('documentId' in patch) { vals.push(patch.documentId || null); sets.push(`purchase_advice_document_id=$${vals.length}::uuid`); }
  if (!sets.length) return getPurchasing(appId, c);
  vals.push(actorId || null);
  return (await c.query(
    `UPDATE purchasing_workflow
        SET ${sets.join(', ')}, purchase_advice_updated_at=now(), purchase_advice_updated_by=$${vals.length}::uuid
      WHERE application_id=$1 RETURNING *`, vals)).rows[0] || null;
}

module.exports = {
  CONDITION_STATUSES,
  readConditions,
  addCondition,
  setConditionStatus,
  deleteCondition,
  setPurchaseAdvice,
  enterPurchasing,
  withdrawFromPurchasing,
  getPurchasing,
  setPurchasingStatus,
  readNotes,
  addNote,
  readTasks,
  addTask,
  setTaskDone,
  deleteTask,
  getPurchasingWorkspace,
};
