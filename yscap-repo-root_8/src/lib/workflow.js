'use strict';

/**
 * THE WORKFLOW (owner-directed 2026-07-21) — submission hand-offs + personal
 * work queues.
 *
 * A loan officer clicks a plain Submit button inside a file; the file drops onto
 * the right downstream person's personal WORKFLOW queue AND the file's status is
 * set automatically (the workflow drives the status — see applyInternalStatus in
 * src/routes/staff.js). Every recipient sees their own ordered "up next" list
 * with timestamps + aging, and a history of what they finished / sent back.
 *
 * This module is PURE data logic — the config map, the destination resolver, and
 * the queue/history/closing DB helpers. It NEVER moves a status or sends a
 * notification: the staff route layer does that (it holds the status door + the
 * notify helpers), so there is no circular dependency.
 */

const db = require('../db');

// ---------------------------------------------------------------------------
// The submission chain. submission_type → destination + the ClickUp internal
// status the workflow sets automatically. `pointer` is the applications column
// that remembers the assigned person (mirrors processor_id) so a re-submit of the
// same kind routes back to the same person. `internalStatus` values are the exact
// lowercase EXTERNAL_FOR keys the ClickUp status dropdown already pushes
// (src/clickup/status.js) — case/space-insensitive on ClickUp's side.
// ---------------------------------------------------------------------------
const TYPES = {
  loan_setup: {
    label: 'Loan Setup', role: 'processor', pointer: 'processor_id',
    internalStatus: 'assigned to processor', gate: 'completeness', assigns: true,
    helper: 'Sends this file to the processor to set it up, and moves the file to Loan Setup.',
  },
  processing: {
    label: 'Processing', role: 'processor', pointer: 'processor_id',
    internalStatus: 'workflow', gate: null, assigns: true,
    helper: 'Sends this file to the processor to work, and moves the file to Processing.',
  },
  condition_clearing: {
    label: 'Condition Clearing', role: 'processor', pointer: 'processor_id',
    internalStatus: 'waiting for docs', gate: 'conditions', assigns: true,
    helper: 'Sends this file to the processor to clear the remaining conditions.',
  },
  clear_to_close: {
    label: 'Clear to Close', role: 'processor', pointer: 'processor_id',
    internalStatus: 'delegated ctc submission', gate: 'ctc', assigns: true,
    helper: 'Submits this file for clear-to-close. The processor signs it off — you only mark your side done.',
  },
  closing: {
    label: 'Closing', role: 'closer', pointer: 'closer_id',
    internalStatus: 'scheduling closing', gate: null, assigns: true, needsEstClosing: true,
    helper: 'Sends this file to the closer with your estimated closing date, and opens the closing steps.',
  },
  draw_setup: {
    label: 'Draw Setup', role: 'draw_coordinator', pointer: null,
    internalStatus: null, gate: 'funded', assigns: false,
    helper: 'Sends this funded file to the draw coordinator to set up construction draws.',
  },
  post_closing: {
    label: 'Post-Closing / Investor Delivery', role: null, pointer: null,
    internalStatus: 'in purchase review', gate: 'funded', assigns: false, requiresPick: true,
    helper: 'Sends this funded file for post-closing conditions, diligence, and delivery to the investor.',
  },
  exception: {
    label: 'Exception', role: null, pointer: null,
    internalStatus: null, gate: 'recipient', assigns: false, requiresPick: true,
    helper: 'Sends this file to a specific person you choose to clear an exception.',
  },
  escalation: {
    label: 'Escalate to Super Admin', role: 'super_admin', pointer: null,
    internalStatus: null, gate: null, assigns: false,
    helper: 'Sends this file to a super admin to review or re-review.',
  },
};
const TYPE_KEYS = Object.keys(TYPES);

// Service-level target per hand-off, in BUSINESS-ish hours (we keep it simple —
// wall-clock hours from when it lands in the queue). Drives the on-time /
// at-risk / overdue read and the overdue nudge (db/213). Tunable here.
const SLA_HOURS = {
  loan_setup: 24, processing: 48, condition_clearing: 48, clear_to_close: 24,
  closing: 72, draw_setup: 48, post_closing: 72, exception: 24, escalation: 24,
};
function slaHoursFor(t) { return SLA_HOURS[t] || null; }

function typeConfig(t) { return TYPES[t] || null; }

// Plain-language outcome labels the recipient picks when sending a file back.
const OUTCOME_LABELS = [
  'Finished processing', 'Finished loan setup', 'Finished CTC',
  'Cleared conditions', 'Added conditions', 'Cleared exception',
  'Finished closing', 'Finished draw setup', 'Reviewed', 'Sent back — needs more',
];

// ---------------------------------------------------------------------------
// Destination candidates for a role (the person picker when nobody is assigned).
// ---------------------------------------------------------------------------
async function candidatesForRole(role, client = db) {
  if (!role) return [];
  const r = await client.query(
    `SELECT id, full_name, role FROM staff_users WHERE is_active = true AND role = $1 ORDER BY full_name`, [role]);
  return r.rows;
}
/** Every active staffer — the exception picker ("submit to whoever you want"). */
async function allActiveStaff(client = db) {
  const r = await client.query(
    `SELECT id, full_name, role FROM staff_users WHERE is_active = true ORDER BY full_name`);
  return r.rows;
}

// ---------------------------------------------------------------------------
// % of conditions cleared (staff side) — powers the condition-clearing gate and
// the Submit panel helper text. Mirrors advancementBlockers' condition predicate:
// required document/condition checklist items + the first-class conditions rows.
// 0 conditions → 100% (nothing to clear).
// ---------------------------------------------------------------------------
async function conditionsClearedPct(appId, client = db) {
  const ci = await client.query(
    `SELECT
        count(*) FILTER (WHERE item_kind IN ('document','condition') AND COALESCE(is_required,true) = true) AS total,
        count(*) FILTER (WHERE item_kind IN ('document','condition') AND COALESCE(is_required,true) = true
                         AND (signed_off_at IS NOT NULL OR status = 'satisfied')) AS cleared
       FROM checklist_items WHERE application_id = $1`, [appId]);
  const uw = await client.query(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE status NOT IN ('open','borrower_responded')) AS cleared
       FROM conditions WHERE application_id = $1`, [appId]);
  const total = Number(ci.rows[0].total) + Number(uw.rows[0].total);
  const cleared = Number(ci.rows[0].cleared) + Number(uw.rows[0].cleared);
  const pct = total === 0 ? 1 : cleared / total;
  return { total, cleared, pct };
}

// ---------------------------------------------------------------------------
// Live items on a file (one per type currently open/in-progress) — the Submit
// panel uses this to show "already in <name>'s workflow".
// ---------------------------------------------------------------------------
async function fileLiveItems(appId, client = db) {
  const r = await client.query(
    `SELECT w.*, s.full_name AS to_name
       FROM workflow_items w
       LEFT JOIN staff_users s ON s.id = w.to_staff_id
      WHERE w.application_id = $1 AND w.status IN ('open','in_progress')
      ORDER BY w.received_at DESC`, [appId]);
  return r.rows;
}

// The file's full workflow timeline (append-only events) for the file page.
async function fileTimeline(appId, client = db) {
  const r = await client.query(
    `SELECT e.*, a.full_name AS actor_name, f.full_name AS from_name, t.full_name AS to_name
       FROM workflow_events e
       LEFT JOIN staff_users a ON a.id = e.actor_staff_id
       LEFT JOIN staff_users f ON f.id = e.from_staff_id
       LEFT JOIN staff_users t ON t.id = e.to_staff_id
      WHERE e.application_id = $1
      ORDER BY e.created_at DESC`, [appId]);
  return r.rows;
}

// ---------------------------------------------------------------------------
// SUBMIT — supersede any live item of the same type, insert the new hand-off,
// and log the 'submitted' event. Runs on the caller's transaction client.
// Returns the new workflow_items row.
// ---------------------------------------------------------------------------
async function submitItem(client, {
  appId, submissionType, fromStaffId, toStaffId, toRole, note, priority, estClosingDate, auto,
}) {
  const slaHours = slaHoursFor(submissionType);
  // A re-submit supersedes the prior live hand-off of the same type (keeps the
  // partial-unique index happy + records the supersede in history).
  const superseded = await client.query(
    `UPDATE workflow_items
        SET status = 'cancelled', updated_at = now()
      WHERE application_id = $1 AND submission_type = $2 AND status IN ('open','in_progress')
      RETURNING id`, [appId, submissionType]);
  for (const row of superseded.rows) {
    await client.query(
      `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, actor_staff_id, submission_type, note)
       VALUES ($1,$2,'cancelled',$3,$4,'Superseded by a newer submission')`,
      [row.id, appId, fromStaffId || null, submissionType]);
  }
  const ins = await client.query(
    `INSERT INTO workflow_items
       (application_id, submission_type, from_staff_id, to_staff_id, to_role, status, note, priority,
        est_closing_date, received_at, sla_hours, due_at, auto)
     VALUES ($1,$2,$3,$4,$5,'open',$6,$7,$8, now(), $9::int,
             CASE WHEN $9::int IS NULL THEN NULL ELSE now() + ($9::int * interval '1 hour') END, $10)
     RETURNING *`,
    [appId, submissionType, fromStaffId || null, toStaffId || null, toRole || null,
     note ? String(note).slice(0, 1000) : null, Number.isFinite(priority) ? Math.round(priority) : 0,
     estClosingDate || null, slaHours, !!auto]);
  const item = ins.rows[0];
  await client.query(
    `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, actor_staff_id, from_staff_id, to_staff_id, submission_type, note)
     VALUES ($1,$2,'submitted',$3,$3,$4,$5,$6)`,
    [item.id, appId, fromStaffId || null, toStaffId || null, submissionType, note ? String(note).slice(0, 1000) : null]);
  return item;
}

// PICK UP — a recipient starts working an item (open → in_progress).
async function pickItem(client, itemId, actorId) {
  const r = await client.query(
    `UPDATE workflow_items SET status='in_progress', picked_up_at=COALESCE(picked_up_at, now()), updated_at=now()
      WHERE id=$1 AND status='open' RETURNING *`, [itemId]);
  const item = r.rows[0];
  if (item) {
    await client.query(
      `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, actor_staff_id, submission_type)
       VALUES ($1,$2,'picked_up',$3,$4)`, [item.id, item.application_id, actorId || null, item.submission_type]);
  }
  return item;
}

// RETURN — finished; send the file back to whoever submitted it, with an outcome
// label + optional note. The item leaves the live queue but stays in history.
async function returnItem(client, itemId, actorId, outcomeLabel, note) {
  const r = await client.query(
    `UPDATE workflow_items
        SET status='returned', outcome_label=$2, note=COALESCE($3, note), returned_at=now(), updated_at=now()
      WHERE id=$1 AND status IN ('open','in_progress') RETURNING *`,
    [itemId, outcomeLabel ? String(outcomeLabel).slice(0, 120) : null, note ? String(note).slice(0, 1000) : null]);
  const item = r.rows[0];
  if (item) {
    await client.query(
      `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, actor_staff_id, from_staff_id, to_staff_id, submission_type, outcome_label, note)
       VALUES ($1,$2,'returned',$3,$4,$5,$6,$7,$8)`,
      [item.id, item.application_id, actorId || null, actorId || null, item.from_staff_id,
       item.submission_type, item.outcome_label, note ? String(note).slice(0, 1000) : null]);
  }
  return item;
}

// ---------------------------------------------------------------------------
// The personal queue. tab: 'next' (live, ordered) | 'history' (what I did).
// sort: 'received' (default) | 'priority' | 'aging'. Scoped to a single staffer
// (routed to me by to_staff_id). The route wraps this — it never leaks another
// person's files because a hand-off carries its own to_staff_id.
// ---------------------------------------------------------------------------
const SORTS = {
  received: 'w.priority DESC, w.received_at ASC, w.id',
  priority: 'w.priority DESC, w.received_at ASC, w.id',
  aging: 'w.received_at ASC, w.id',
};
async function listQueue(staffId, { tab = 'next', sort = 'received', type = null } = {}, client = db) {
  if (tab === 'history') {
    // Everything this person finished / sent back / acted on, newest first.
    const params = [staffId];
    let typeClause = '';
    if (type && TYPES[type]) { params.push(type); typeClause = ` AND e.submission_type = $${params.length}`; }
    const r = await client.query(
      `SELECT e.id, e.event_type, e.submission_type, e.outcome_label, e.note, e.created_at,
              e.application_id, w.received_at,
              a.ys_loan_number, a.property_address, a.status AS app_status,
              b.first_name, b.last_name,
              fr.full_name AS from_name, t.full_name AS to_name
         FROM workflow_events e
         JOIN workflow_items w ON w.id = e.workflow_item_id
         JOIN applications a ON a.id = e.application_id
         JOIN borrowers b ON b.id = a.borrower_id
         LEFT JOIN staff_users fr ON fr.id = e.from_staff_id
         LEFT JOIN staff_users t  ON t.id = e.to_staff_id
        WHERE e.actor_staff_id = $1
          AND e.event_type IN ('returned','picked_up','submitted')
          ${typeClause}
        ORDER BY e.created_at DESC
        LIMIT 300`, params);
    return r.rows;
  }
  // The live "up next" queue.
  const params = [staffId];
  let typeClause = '';
  if (type && TYPES[type]) { params.push(type); typeClause = ` AND w.submission_type = $${params.length}`; }
  const orderBy = SORTS[sort] || SORTS.received;
  const r = await client.query(
    `SELECT w.id, w.application_id, w.submission_type, w.status, w.priority, w.note,
            w.est_closing_date, w.received_at, w.picked_up_at, w.to_role, w.due_at, w.auto,
            EXTRACT(EPOCH FROM (now() - w.received_at)) AS age_seconds,
            -- on-time / at-risk (past 75% of the SLA window) / overdue (past due)
            CASE WHEN w.due_at IS NULL THEN NULL
                 WHEN now() >= w.due_at THEN 'overdue'
                 WHEN now() >= w.received_at + (w.due_at - w.received_at) * 0.75 THEN 'at_risk'
                 ELSE 'ok' END AS sla_state,
            a.ys_loan_number, a.property_address, a.status AS app_status,
            b.first_name, b.last_name,
            fr.full_name AS from_name
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users fr ON fr.id = w.from_staff_id
      WHERE w.to_staff_id = $1
        AND w.status IN ('open','in_progress')
        AND a.deleted_at IS NULL
        ${typeClause}
      ORDER BY ${orderBy}`, params);
  return r.rows;
}

// Recipients with overdue live items — for the scheduled aging nudge (db/213).
// Returns [{ to_staff_id, full_name, email, overdue }]. Best-effort read.
async function overdueByRecipient(client = db) {
  const r = await client.query(
    `SELECT w.to_staff_id, s.full_name, s.email, count(*)::int AS overdue
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id AND a.deleted_at IS NULL
       JOIN staff_users s ON s.id = w.to_staff_id AND s.is_active = true
      WHERE w.status IN ('open','in_progress') AND w.due_at IS NOT NULL AND now() >= w.due_at
      GROUP BY w.to_staff_id, s.full_name, s.email`);
  return r.rows;
}

// Nav badge + KPI tiles: how many live items are routed to me, by state + type.
async function queueCounts(staffId, client = db) {
  const r = await client.query(
    `SELECT
        count(*) FILTER (WHERE w.status='open')        AS open,
        count(*) FILTER (WHERE w.status='in_progress') AS in_progress,
        count(*)                                       AS total
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id
      WHERE w.to_staff_id = $1 AND w.status IN ('open','in_progress') AND a.deleted_at IS NULL`, [staffId]);
  const byType = await client.query(
    `SELECT submission_type, count(*) AS n
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id
      WHERE w.to_staff_id = $1 AND w.status IN ('open','in_progress') AND a.deleted_at IS NULL
      GROUP BY submission_type`, [staffId]);
  const counts = { open: Number(r.rows[0].open), inProgress: Number(r.rows[0].in_progress), total: Number(r.rows[0].total), byType: {} };
  for (const row of byType.rows) counts.byType[row.submission_type] = Number(row.n);
  return counts;
}

// ---------------------------------------------------------------------------
// Closing sub-workflow: estimated → ready_for_docs → wire_sent → fully_closed →
// fully_reconciled. The route drives the linked ClickUp status via the status
// door (fully_closed → funded). Here we just record the stage + timestamps.
// ---------------------------------------------------------------------------
const CLOSING_STAGES = ['estimated', 'ready_for_docs', 'wire_sent', 'fully_closed', 'fully_reconciled'];
const CLOSING_STAGE_AT = {
  ready_for_docs: 'ready_for_docs_at', wire_sent: 'wire_sent_at',
  fully_closed: 'fully_closed_at', fully_reconciled: 'fully_reconciled_at',
};
// The ClickUp internal status each closing stage maps to (null = leave status).
const CLOSING_STAGE_STATUS = {
  ready_for_docs: 'active closing',
  wire_sent: 'active closing',
  fully_closed: 'closed (6-email funded)',
  fully_reconciled: 'closed reconciled',
};

async function getClosing(appId, client = db) {
  const r = await client.query(`SELECT * FROM closing_workflow WHERE application_id=$1`, [appId]);
  return r.rows[0] || null;
}

// Create/refresh the closing row at 'estimated' with the estimated closing date.
async function openClosing(client, { appId, workflowItemId, estClosingDate, actorId }) {
  const r = await client.query(
    `INSERT INTO closing_workflow (application_id, workflow_item_id, stage, est_closing_date, updated_by)
     VALUES ($1,$2,'estimated',$3,$4)
     ON CONFLICT (application_id) DO UPDATE
        SET workflow_item_id = EXCLUDED.workflow_item_id,
            est_closing_date = COALESCE(EXCLUDED.est_closing_date, closing_workflow.est_closing_date),
            updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`, [appId, workflowItemId || null, estClosingDate || null, actorId || null]);
  return r.rows[0];
}

// Advance the closing stage; stamps the matching timestamp. Returns the row +
// the ClickUp internal status the caller should apply (or null).
async function advanceClosing(client, appId, stage, actorId) {
  if (!CLOSING_STAGES.includes(stage)) { const e = new Error('bad closing stage'); e.code = 'bad_stage'; throw e; }
  const atCol = CLOSING_STAGE_AT[stage];
  const sets = [`stage = $2`, `updated_by = $3`, `updated_at = now()`];
  // Qualify the column in the ON CONFLICT SET's COALESCE — an unqualified name is
  // ambiguous (it also appears in the INSERT column list).
  if (atCol) sets.push(`${atCol} = COALESCE(closing_workflow.${atCol}, now())`);
  const r = await client.query(
    `INSERT INTO closing_workflow (application_id, stage, updated_by${atCol ? ', ' + atCol : ''})
     VALUES ($1,$2,$3${atCol ? ', now()' : ''})
     ON CONFLICT (application_id) DO UPDATE SET ${sets.join(', ')}
     RETURNING *`, [appId, stage, actorId || null]);
  return { row: r.rows[0], internalStatus: CLOSING_STAGE_STATUS[stage] || null };
}

module.exports = {
  TYPES, TYPE_KEYS, typeConfig, OUTCOME_LABELS, SLA_HOURS, slaHoursFor,
  candidatesForRole, allActiveStaff,
  conditionsClearedPct, fileLiveItems, fileTimeline,
  submitItem, pickItem, returnItem, listQueue, queueCounts, overdueByRecipient,
  CLOSING_STAGES, getClosing, openClosing, advanceClosing,
};
