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
  trustpoint_import: {
    label: 'TrustPoint Draw Entry', role: 'draw_coordinator', pointer: null,
    internalStatus: null, gate: 'funded', assigns: false,
    helper: 'A submitted draw on a TrustPoint-administered file (Blue Lake physical) needs to be entered into TrustPoint by hand.',
  },
  trinity_inspection_order: {
    label: 'Trinity Inspection Order', role: 'draw_coordinator', pointer: null,
    internalStatus: null, gate: 'funded', assigns: false,
    helper: 'A portal draw on a physical-inspection file (non-Blue-Lake) needs its inspection ordered from Trinity by hand.',
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
  // A submitted draw doesn't exist in TrustPoint until a human enters it — the borrower's
  // money clock is running, so this hand-off gets the tightest draw SLA.
  trustpoint_import: 24,
  // Same clock pressure: the borrower asked for money and nothing moves until the
  // Trinity inspection is ordered.
  trinity_inspection_order: 24,
};
function slaHoursFor(t) { return SLA_HOURS[t] || null; }

function typeConfig(t) { return TYPES[t] || null; }

// Plain-language outcome labels the recipient picks when sending a file back.
const OUTCOME_LABELS = [
  'Finished processing', 'Finished loan setup', 'Finished CTC',
  'Cleared conditions', 'Added conditions', 'Cleared exception',
  'Finished closing', 'Finished draw setup', 'Entered in TrustPoint',
  'Inspection ordered', 'Reviewed', 'Sent back — needs more',
];

// ---------------------------------------------------------------------------
// Destination candidates for a role (the person picker when nobody is assigned).
// ---------------------------------------------------------------------------
async function candidatesForRole(role, client = db) {
  if (!role) return [];
  const r = await client.query(
    `SELECT id, full_name, role FROM staff_users WHERE is_active = true AND is_external = false AND role = $1 ORDER BY full_name`, [role]);
  return r.rows;
}
/** Every active INTERNAL staffer — the exception picker ("submit to whoever you
    want"). External TPO brokers (db/472) are never a hand-off target. */
async function allActiveStaff(client = db) {
  const r = await client.query(
    `SELECT id, full_name, role FROM staff_users WHERE is_active = true AND is_external = false ORDER BY full_name`);
  return r.rows;
}

// ---------------------------------------------------------------------------
// % of conditions cleared (staff side) — powers the condition-clearing gate and
// the Submit panel helper text. Mirrors advancementBlockers' condition predicate:
// required document/condition checklist items + the first-class conditions rows.
// 0 conditions → 100% (nothing to clear).
// ---------------------------------------------------------------------------
async function conditionsClearedPct(appId, client = db) {
  // The four internal WORKFLOW STEPS (LTC/LTV/ARV checked + interest reserves) are
  // hidden from the conditions list, so a human can't sign them off — counting them
  // would peg this percentage below 100% forever. Exclude them here for the same
  // reason `advancementBlockers` does. Kept in sync by the parity test.
  const { WORKFLOW_STEP_CODES } = require('./conditions/workflow-step-codes');
  // The enforced appraisal review counts toward "cleared %" even when is_required=false —
  // mirror advancementBlockers' requiredExemptCodes (post-merge audit finding #4). Without
  // it, flipping the review to optional makes this read 100% cleared and lets the
  // 'conditions' submission type pass while advancementBlockers still blocks CTC.
  const requiredExemptCodes = require('./underwriting/advisory-policy').appraisalReviewEnforced()
    ? ['appraisal_review_cleared'] : [];
  const ci = await client.query(
    `SELECT
        count(*) FILTER (WHERE ci.item_kind IN ('document','condition')
                         AND (COALESCE(ci.is_required,true) = true OR COALESCE(t.code,'') = ANY($3::text[]))) AS total,
        count(*) FILTER (WHERE ci.item_kind IN ('document','condition')
                         AND (COALESCE(ci.is_required,true) = true OR COALESCE(t.code,'') = ANY($3::text[]))
                         AND (ci.signed_off_at IS NOT NULL OR ci.status = 'satisfied')) AS cleared
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id = $1
        AND COALESCE(t.code,'') <> ALL($2::text[])`, [appId, WORKFLOW_STEP_CODES, requiredExemptCodes]);
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
    // An unassigned ROLE item (to_staff_id IS NULL) is CLAIMED by whoever picks it
    // up, so it leaves everyone else's role inbox; an already-assigned item keeps
    // its owner (COALESCE preserves it).
    `UPDATE workflow_items
        SET status='in_progress', to_staff_id=COALESCE(to_staff_id, $2),
            picked_up_at=COALESCE(picked_up_at, now()), updated_at=now()
      WHERE id=$1 AND status='open' RETURNING *`, [itemId, actorId || null]);
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
// AUTO-CLEAR the closer's hand-off when the closing is COMPLETED (owner-directed
// 2026-07-26: "once the reconciliation of a file is done and it's marked as
// completed that file should automatically disappear from the closing workflow").
//
// The closing DESK already hides a completed file, but the closer's WORKFLOW
// queue is driven by `workflow_items`, and nothing ever resolved that row — so a
// finished file sat in their "up next" list forever until someone manually sent
// it back. This resolves the live closing hand-off(s) for the file the same way a
// manual send-back does (status='returned' + a `workflow_events` row), so the
// history still shows what happened and the live queue drops it.
//
// Idempotent: only touches open/in_progress rows, so re-running is a no-op.
// Returns the resolved items (possibly []).
// ---------------------------------------------------------------------------
/* LOCK ORDER (proven by a real-Postgres deadlock probe, 2026-07-26).
 *
 * The submit-to-closing route takes its locks `workflow_items` -> `closing_workflow`
 * (submitItem supersedes the prior live hand-off, THEN openClosing upserts the
 * closing row — and openClosing needs the new item's id, so it cannot be reordered).
 * The completion paths (the stage route and the investor-delivery sign-off) used to
 * take them the other way round: closing_workflow first, then workflow_items via
 * resolveClosingItem. A loan officer re-submitting a file at the same moment the
 * closer completed THAT SAME file deadlocked — Postgres aborted one side (40P01),
 * failing the closer's action. Before the auto-clear the completion paths never
 * touched workflow_items at all, so this inversion was new.
 *
 * Every transaction that will resolve the closing hand-off therefore takes this
 * lock FIRST, before touching closing_workflow, so all paths agree on the order.
 * ORDER BY id makes multi-row acquisition deterministic too. Locking nothing (no
 * live hand-off) is fine — that is the common case and it is a no-op. */
async function lockClosingItems(client, appId) {
  await client.query(
    `SELECT id FROM workflow_items
      WHERE application_id=$1 AND submission_type='closing'
        AND status IN ('open','in_progress')
      ORDER BY id
      FOR UPDATE`, [appId]);
}

/* With `guardResubmit`, only hand-offs that PREDATE the moment this closing became
 * finished are resolved — the SAME guard db/347 and db/349 apply, and it is needed
 * just as much at runtime: `fully_reconciled_at` is sticky (COALESCE) and
 * `investor_delivery_signed_off_at` only clears on an investor-delivery un-sign, so
 * on a file that was completed once `closingIsFinished` stays true FOREVER. Without
 * it, a file legitimately RE-SUBMITTED to closing had its brand-new hand-off
 * silently returned the moment the closer touched anything at all — a TPR tick, an
 * un-sign, any stage move. Without the flag it resolves unconditionally (the manual
 * send-back semantics).
 *
 * The anchor is computed in SQL, never handed in as a JS value: a timestamptz is
 * microsecond-precision and a JS Date is only millisecond, so round-tripping it
 * truncates the anchor BACKWARDS and a hand-off received in the same microsecond
 * window would silently fail to clear.
 *
 * It is GREATEST of all three, NOT COALESCE(purchasing_at, GREATEST(...)).
 * `purchasing_at` is STICKY (advanceClosing writes COALESCE(purchasing_at, now())),
 * so a COALESCE that prefers it freezes the anchor at the FIRST "Send to
 * purchasing" forever: a file re-submitted later could never clear again, however
 * genuinely it was re-completed — the exact "completed file stuck on the closer's
 * Workflow" bug this whole mechanism exists to fix, displaced onto re-submits.
 * Postgres GREATEST ignores NULLs, so a file that never reached purchasing is
 * unaffected. */
async function resolveClosingItem(client, appId, actorId, outcomeLabel, guardResubmit) {
  const label = String(outcomeLabel || 'Closing complete — sent to purchasing').slice(0, 120);
  const r = await client.query(
    `UPDATE workflow_items
        SET status='returned', outcome_label=$2, returned_at=now(), updated_at=now()
      WHERE application_id=$1 AND submission_type='closing'
        AND status IN ('open','in_progress')
        AND ($3::boolean IS NOT TRUE OR received_at <= (
              SELECT GREATEST(cw.purchasing_at, cw.fully_reconciled_at,
                              cw.investor_delivery_signed_off_at)
                FROM closing_workflow cw WHERE cw.application_id = $1))
      RETURNING *`,
    [appId, label, guardResubmit === true]);
  for (const item of r.rows) {
    await client.query(
      `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, actor_staff_id, from_staff_id, to_staff_id, submission_type, outcome_label, note)
       VALUES ($1,$2,'returned',$3,$4,$5,$6,$7,$8)`,
      [item.id, item.application_id, actorId || null, actorId || null, item.from_staff_id,
       item.submission_type, item.outcome_label, 'Closed out automatically when the file was marked complete.']);
  }
  return r.rows;
}

// ---------------------------------------------------------------------------
// IS the closing finished? The closer's work ends when the file is RECONCILED
// and investor delivery is signed off — "and stuff is reconciled that should go
// off of the closing workflow EITHER WAY" (owner-directed 2026-07-26): whether
// the loan was TABLE FUNDED (sold at closing, no purchasing) or handed to the
// purchasing desk, the closing hand-off is done at that same point.
//
// Deliberately NOT reconciled-alone: at that moment the closer still owes the
// investor-delivery sign-off, and clearing then would take the file off their
// desk mid-task.
// ---------------------------------------------------------------------------
function closingIsFinished(cw) {
  return !!(cw && cw.fully_reconciled_at && cw.investor_delivery_signed_off_at);
}

// The ONE chokepoint every closing-completion surface calls (stage advance,
// investor-delivery sign-off). Clears the closer's hand-off once — and only
// once — the closing is genuinely finished. Idempotent + safe to call on every
// closing write.
async function maybeFinishClosing(client, appId, actorId) {
  const c = client || db;
  const cw = (await c.query(
    `SELECT fully_reconciled_at, investor_delivery_signed_off_at, table_funded
       FROM closing_workflow WHERE application_id=$1`, [appId])).rows[0];
  if (!closingIsFinished(cw)) return [];
  const label = cw.table_funded
    ? 'Closing complete — table funded (sold at closing)'
    : 'Closing complete — sent to purchasing';
  // Guarded: a hand-off received AFTER this closing was finished is a genuine
  // RE-SUBMIT and must survive. Same anchor as db/349, evaluated in SQL.
  return resolveClosingItem(c, appId, actorId, label, true);
}

/* The mirror of the auto-clear. Un-signing investor delivery means the closing is
 * no longer finished — the file is pulled back out of purchasing, so without this
 * it would sit on NEITHER queue (off the closer's Workflow because the auto-clear
 * returned it, and off the purchasing desk because it was withdrawn). Reopens the
 * hand-off this same mechanism closed, and ONLY that one: an item a human sent
 * back by hand carries a different outcome label and is left alone. */
async function reopenClosingItem(client, appId, actorId) {
  const r = await client.query(
    `UPDATE workflow_items
        SET status='open', returned_at=NULL, outcome_label=NULL, updated_at=now()
      WHERE id = (
        -- EXACTLY ONE: uq_wf_live is a partial unique index on
        -- (application_id, submission_type) over the live statuses, so reopening
        -- two of a file's historic completions would violate it. Newest wins.
        SELECT w.id FROM workflow_items w
         WHERE w.application_id=$1 AND w.submission_type='closing' AND w.status='returned'
           AND w.outcome_label LIKE 'Closing complete —%'
           AND NOT EXISTS (
             SELECT 1 FROM workflow_items live
              WHERE live.application_id = w.application_id
                AND live.submission_type = 'closing'
                AND live.status IN ('open','in_progress'))
         ORDER BY w.returned_at DESC NULLS LAST, w.id DESC
         LIMIT 1)
      RETURNING *`, [appId]);
  for (const item of r.rows) {
    await client.query(
      `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, actor_staff_id, from_staff_id, to_staff_id, submission_type, note)
       VALUES ($1,$2,'submitted',$3,$3,$4,$5,$6)`,
      [item.id, item.application_id, actorId || null, item.to_staff_id, item.submission_type,
       'Reopened — investor delivery was un-signed, so the closing is not finished.']);
  }
  return r.rows;
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
      WHERE (w.to_staff_id = $1
             -- Role INBOX (narrowed 2026-07-31, owner-directed per-file
             -- contacts): an UNASSIGNED hand-off addressed to my ROLE shows to
             -- the whole role desk ONLY while the FILE has nobody actively
             -- assigned for that role — a file with its own closer(s)/draw
             -- coordinator(s) is THEIR work, not the desk's. An item WITH a
             -- to_staff_id stays scoped (see the third arm). This is still how
             -- an automated escalation to super_admin lands in every
             -- super-admin's workflow (owner-directed 2026-07-21) — nothing
             -- assigns super_admin rows on files.
             OR (w.to_staff_id IS NULL AND w.to_role = (SELECT role FROM staff_users WHERE id = $1)
                 AND NOT EXISTS (SELECT 1 FROM application_assignees aa
                                    JOIN staff_users sau ON sau.id = aa.staff_id AND sau.is_active = true
                                  WHERE aa.application_id = w.application_id AND aa.role = w.to_role
                                    AND aa.removed_at IS NULL))
             -- MULTIPLE PEOPLE PER ROLE (owner-directed 2026-07-31): every
             -- ACTIVE assignee of the item's role on the FILE sees it — the
             -- second closer works the same closing queue as the primary the
             -- item was addressed to. Their workflow shows only files assigned
             -- to them; picking up an unassigned item still claims it.
             OR (w.to_role IS NOT NULL
                 AND EXISTS (SELECT 1 FROM application_assignees aa
                              WHERE aa.application_id = w.application_id AND aa.role = w.to_role
                                AND aa.staff_id = $1 AND aa.removed_at IS NULL)))
        AND w.status IN ('open','in_progress')
        AND a.deleted_at IS NULL
        ${typeClause}
      ORDER BY ${orderBy}`, params);
  return r.rows;
}

// The roles that HAVE a workflow queue (for the admin/super_admin oversight
// picker). Each is viewed as its OWN separate workflow — never merged together.
const WORKFLOW_ROLES = ['processor', 'closer', 'draw_coordinator', 'underwriter', 'super_admin'];

// ADMIN/SUPER_ADMIN oversight: every live item in ONE role's workflow (all people
// who hold that role + that role's unclaimed inbox). This is a SEPARATE per-workflow
// view (the closer workflow, the processing workflow, the draw workflow…), not a
// merged "everyone" list. Returns the same row shape as the personal queue PLUS
// `to_name`/`to_staff_role` (whose queue each item is in).
async function listByRole(role, { sort = 'received', type = null } = {}, client = db) {
  const params = [role];
  let typeClause = '';
  if (type && TYPES[type]) { params.push(type); typeClause = ` AND w.submission_type = $${params.length}`; }
  const orderBy = SORTS[sort] || SORTS.received;
  const r = await client.query(
    `SELECT w.id, w.application_id, w.submission_type, w.status, w.priority, w.note,
            w.est_closing_date, w.received_at, w.picked_up_at, w.to_role, w.due_at, w.auto,
            EXTRACT(EPOCH FROM (now() - w.received_at)) AS age_seconds,
            CASE WHEN w.due_at IS NULL THEN NULL
                 WHEN now() >= w.due_at THEN 'overdue'
                 WHEN now() >= w.received_at + (w.due_at - w.received_at) * 0.75 THEN 'at_risk'
                 ELSE 'ok' END AS sla_state,
            a.ys_loan_number, a.property_address, a.status AS app_status,
            b.first_name, b.last_name,
            fr.full_name AS from_name, ts.full_name AS to_name, ts.role AS to_staff_role
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id
       JOIN borrowers b ON b.id = a.borrower_id
       LEFT JOIN staff_users fr ON fr.id = w.from_staff_id
       LEFT JOIN staff_users ts ON ts.id = w.to_staff_id
      WHERE w.status IN ('open','in_progress') AND a.deleted_at IS NULL
        AND (ts.role = $1 OR (w.to_staff_id IS NULL AND w.to_role = $1))
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

/**
 * THE OVERDUE FILES THEMSELVES, for one person — so the nudge can NAME them.
 *
 * Owner-directed 2026-08-07, on the "7 files in your Workflow are overdue" email: *"emails like
 * this should have a list of the files and the status of each and every file and whose loan
 * officer in every single file, nicely designed."* A count with a link is not a notification, it
 * is a chore: the reader has to go and re-derive what the email already knew.
 *
 * Ordered by how far past target each hand-off is (worst first), which is the only order that
 * makes the top of the list the thing to do next. Carries the hand-off KIND so the digest can
 * group a draw coordinator's queue separately from a closer's — the owner's *"nicely design every
 * workflow separately"*.
 */
/* IS SOMEBODY ACTUALLY WAITING ON MONEY RIGHT NOW? — the `has_open_draw` column below.
   Owner-directed 2026-08-07: *"the draw coordinator workflows should only be stuff that they need
   to do now. It means stuff that has open draws."* A `draw_setup` hand-off lands the moment a file
   funds and then sits there for months until the borrower first asks for money — so an overdue
   draw queue is mostly files with nothing to do on them, and the two that DO need doing today are
   buried underneath.

   The three signals are deliberately narrow: each one means the COORDINATOR's own hands are
   needed. A finding sitting at 'delivered' is waiting on the BORROWER to accept it, not on the
   desk, so it is not counted. Computed on every row (three cheap correlated EXISTS over at most
   `limit` rows) but only MEANT for the draw hand-offs — every other kind is actionable from the
   moment it is routed, and `email/workflow-queues` only reads it for that family. */
async function overdueItemsFor(staffId, limit = 25, client = db) {
  const r = await client.query(
    `SELECT w.id, w.submission_type, w.status AS item_status, w.due_at, w.created_at,
            a.id AS application_id, a.ys_loan_number, a.property_address, a.status AS file_status,
            lo.full_name AS lo_name,
            EXTRACT(EPOCH FROM (now() - w.due_at)) / 3600.0 AS hours_over,
            -- see the note above this function
            (EXISTS (SELECT 1 FROM portal_draw_requests pdr
                      WHERE pdr.application_id = a.id
                        AND pdr.status IN ('submitted','entered','approved'))
             OR EXISTS (SELECT 1 FROM trinity_inspection_orders tio
                         WHERE tio.application_id = a.id
                           AND tio.status IN ('requested','ordered','report_received'))
             OR EXISTS (SELECT 1 FROM draw_findings df
                         WHERE df.application_id = a.id
                           AND (df.status = 'disputed'
                                OR (df.status = 'accepted'
                                    AND NOT EXISTS (SELECT 1 FROM draw_disbursements dd
                                                     WHERE dd.sitewire_draw_id = df.sitewire_draw_id
                                                       AND dd.funded_status = 'released'))))
            ) AS has_open_draw
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id AND a.deleted_at IS NULL
       LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id AND lo.is_active = true
      WHERE w.to_staff_id = $1
        AND w.status IN ('open','in_progress')
        AND w.due_at IS NOT NULL AND now() >= w.due_at
      ORDER BY w.due_at ASC
      LIMIT $2`, [staffId, limit]);
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
      WHERE (w.to_staff_id = $1
             OR (w.to_staff_id IS NULL AND w.to_role = (SELECT role FROM staff_users WHERE id = $1)
                 AND NOT EXISTS (SELECT 1 FROM application_assignees aa
                                    JOIN staff_users sau ON sau.id = aa.staff_id AND sau.is_active = true
                                  WHERE aa.application_id = w.application_id AND aa.role = w.to_role
                                    AND aa.removed_at IS NULL))
             OR (w.to_role IS NOT NULL
                 AND EXISTS (SELECT 1 FROM application_assignees aa
                              WHERE aa.application_id = w.application_id AND aa.role = w.to_role
                                AND aa.staff_id = $1 AND aa.removed_at IS NULL)))
        AND w.status IN ('open','in_progress') AND a.deleted_at IS NULL`, [staffId]);
  const byType = await client.query(
    `SELECT submission_type, count(*) AS n
       FROM workflow_items w
       JOIN applications a ON a.id = w.application_id
      WHERE (w.to_staff_id = $1
             OR (w.to_staff_id IS NULL AND w.to_role = (SELECT role FROM staff_users WHERE id = $1)
                 AND NOT EXISTS (SELECT 1 FROM application_assignees aa
                                    JOIN staff_users sau ON sau.id = aa.staff_id AND sau.is_active = true
                                  WHERE aa.application_id = w.application_id AND aa.role = w.to_role
                                    AND aa.removed_at IS NULL))
             OR (w.to_role IS NOT NULL
                 AND EXISTS (SELECT 1 FROM application_assignees aa
                              WHERE aa.application_id = w.application_id AND aa.role = w.to_role
                                AND aa.staff_id = $1 AND aa.removed_at IS NULL)))
        AND w.status IN ('open','in_progress') AND a.deleted_at IS NULL
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
const CLOSING_STAGES = ['estimated', 'ready_for_docs', 'wire_sent', 'fully_closed', 'fully_reconciled', 'in_purchasing'];
const CLOSING_STAGE_AT = {
  ready_for_docs: 'ready_for_docs_at', wire_sent: 'wire_sent_at',
  fully_closed: 'fully_closed_at', fully_reconciled: 'fully_reconciled_at',
  in_purchasing: 'purchasing_at',
};
// The ClickUp internal status each closing stage maps to (null = leave status).
const CLOSING_STAGE_STATUS = {
  ready_for_docs: 'active closing',
  wire_sent: 'active closing',
  fully_closed: 'closed (6-email funded)',
  fully_reconciled: 'closed reconciled',
  // Investor delivery + reconciled → the file goes to purchasing / post-closing.
  in_purchasing: 'in purchase review',
};

async function getClosing(appId, client = db) {
  const r = await client.query(`SELECT * FROM closing_workflow WHERE application_id=$1`, [appId]);
  return r.rows[0] || null;
}

// Create/refresh the closing row at 'estimated' with the estimated closing date,
// plus the loan officer's submit answers (investor CTC'd, closing date confirmed
// with all parties). The two flags are captured on the officer's submit and stamp
// _at/_by when set true; a false/omitted flag never clears an existing true.
async function openClosing(client, { appId, workflowItemId, estClosingDate, actorId, investorCtc, closingDateConfirmed }) {
  const setCtc = investorCtc === true;
  const setConf = closingDateConfirmed === true;
  const r = await client.query(
    `INSERT INTO closing_workflow
       (application_id, workflow_item_id, stage, est_closing_date, updated_by,
        investor_ctc, investor_ctc_at, investor_ctc_by,
        closing_date_confirmed, closing_date_confirmed_at, closing_date_confirmed_by)
     VALUES ($1,$2,'estimated',$3,$4::uuid,
        $5, CASE WHEN $5 THEN now() END, CASE WHEN $5 THEN $4::uuid END,
        $6, CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $4::uuid END)
     ON CONFLICT (application_id) DO UPDATE
        SET workflow_item_id = EXCLUDED.workflow_item_id,
            est_closing_date = COALESCE(EXCLUDED.est_closing_date, closing_workflow.est_closing_date),
            investor_ctc = closing_workflow.investor_ctc OR EXCLUDED.investor_ctc,
            investor_ctc_at = COALESCE(closing_workflow.investor_ctc_at, EXCLUDED.investor_ctc_at),
            investor_ctc_by = COALESCE(closing_workflow.investor_ctc_by, EXCLUDED.investor_ctc_by),
            closing_date_confirmed = closing_workflow.closing_date_confirmed OR EXCLUDED.closing_date_confirmed,
            closing_date_confirmed_at = COALESCE(closing_workflow.closing_date_confirmed_at, EXCLUDED.closing_date_confirmed_at),
            closing_date_confirmed_by = COALESCE(closing_workflow.closing_date_confirmed_by, EXCLUDED.closing_date_confirmed_by),
            updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [appId, workflowItemId || null, estClosingDate || null, actorId || null, setCtc, setConf]);
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
  submitItem, pickItem, returnItem, lockClosingItems, resolveClosingItem, reopenClosingItem, maybeFinishClosing, closingIsFinished, listQueue, listByRole, WORKFLOW_ROLES, queueCounts, overdueByRecipient, overdueItemsFor,
  CLOSING_STAGES, getClosing, openClosing, advanceClosing,
};
