'use strict';

/**
 * THE WORKFLOW, phase two — automation & integration (owner-directed 2026-07-21).
 *
 * The base workflow is manual and one-directional: a person clicks Submit and it
 * drives the status. This layer makes it work TOGETHER with the rest of the file:
 *
 *   · onFunded()          — the moment a file funds, auto-raise the Draw Setup
 *                           hand-off to the draw coordinator (no one has to
 *                           remember). Deduped + best-effort.
 *   · OUTCOME_ACTIONS     — when a hand-off is sent BACK with an outcome, the
 *                           outcome can drive the status forward (e.g. "Finished
 *                           CTC" → clear-to-close). Data-only; the caller (which
 *                           holds the status door) applies it.
 *   · nextStepSuggestions — a PURE decision: given where the file is + how many
 *                           conditions are cleared + whether CTC is ready, what
 *                           should we gently suggest next? The caller notifies.
 *
 * Kept dependency-light on purpose: it uses db + workflow + notify (all plain
 * libs) and NEVER reaches into staff.js, so there's no circular import. Anything
 * that needs the status door or advancementBlockers is computed by the caller in
 * staff.js and passed in.
 */

const db = require('../db');
const workflow = require('./workflow');
const notify = require('./notify');

// ---------------------------------------------------------------------------
// Return-outcome → action. When a recipient sends a file back with one of these
// outcomes, apply the mapped ClickUp internal status (the caller runs the status
// door). null internalStatus = no status change (the outcome is informational or
// the closing sub-workflow owns the status).
// ---------------------------------------------------------------------------
const OUTCOME_ACTIONS = {
  'Finished loan setup': { internalStatus: null },
  'Finished processing': { internalStatus: null },
  // The processor finished the clear-to-close submission → move the file to CTC.
  'Finished CTC': { internalStatus: 'ctc (4-email)' },
  // Closing is driven by the closing sub-workflow (fully_closed → funded), so a
  // "Finished closing" send-back doesn't itself move the status.
  'Finished closing': { internalStatus: null },
  'Cleared conditions': { internalStatus: null },
  'Added conditions': { internalStatus: null },
  'Cleared exception': { internalStatus: null },
  'Finished draw setup': { internalStatus: null },
  'Reviewed': { internalStatus: null },
  'Sent back — needs more': { internalStatus: null },
};
function outcomeAction(label) { return OUTCOME_ACTIONS[label] || null; }

// ---------------------------------------------------------------------------
// Funding → auto Draw Setup hand-off. Runs after a file reaches `funded`
// (called from BOTH status doors). Best-effort — never throws into the caller.
//   · Only when there is EXACTLY ONE active draw coordinator (otherwise a human
//     picks — we don't guess who).
//   · Deduped: if the file already has ANY draw_setup hand-off (live or history),
//     we don't create or re-nag.
// Returns the created item, or null when skipped.
// ---------------------------------------------------------------------------
async function onFunded(appId, actorId) {
  try {
    const coords = await workflow.candidatesForRole('draw_coordinator');
    if (coords.length !== 1) return null;   // 0 or many → leave it for a person to route
    const dup = await db.query(
      `SELECT 1 FROM workflow_items WHERE application_id=$1 AND submission_type='draw_setup' LIMIT 1`, [appId]);
    if (dup.rows[0]) return null;
    const client = await db.getClient();
    let item = null;
    try {
      await client.query('BEGIN');
      item = await workflow.submitItem(client, {
        appId, submissionType: 'draw_setup', fromStaffId: actorId || null,
        toStaffId: coords[0].id, toRole: 'draw_coordinator',
        note: 'Auto-created when the file funded.', auto: true,
      });
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { client.release(); }
    await notify.notifyStaff(coords[0].id, {
      type: 'workflow_submitted', title: 'New in your Workflow: Draw Setup',
      body: 'This file just funded — it’s ready for you to set up its construction draws.',
      applicationId: appId, ctaLabel: 'Open my Workflow', link: '/internal/workflow',
    }).catch(() => {});
    return item;
  } catch (_) { return null; }   // automation is best-effort — never break funding
}

// ---------------------------------------------------------------------------
// "What should we suggest next?" — a PURE decision (no DB). The caller gathers
// the state (it holds advancementBlockers + the % helper) and passes it in; we
// return the suggestions to surface. Returns [{ type, submissionType, message }].
//   state: {
//     status,                    // external bucket
//     clearedPct,                // 0..1 of conditions cleared
//     ctcReady,                  // advancementBlockers(clear_to_close) empty
//     hasLiveConditionClearing,  // a condition_clearing item already live?
//     hasLiveClearToClose,       // a clear_to_close item already live?
//     threshold,                 // the condition-clearing threshold (0.80)
//   }
// ---------------------------------------------------------------------------
function nextStepSuggestions(state = {}) {
  const out = [];
  const th = typeof state.threshold === 'number' ? state.threshold : 0.80;
  // Enough conditions cleared while the file is still in processing → offer to
  // submit for Condition Clearing (unless it's already on someone's plate).
  if (state.status === 'processing' && typeof state.clearedPct === 'number'
      && state.clearedPct >= th && !state.hasLiveConditionClearing) {
    out.push({
      type: 'condition_clearing', submissionType: 'condition_clearing',
      message: `${Math.round(state.clearedPct * 100)}% of conditions are cleared — this file is ready to submit for Condition Clearing.`,
    });
  }
  // Everything clears → the file is ready for Clear to Close.
  if (state.ctcReady && state.status !== 'clear_to_close' && state.status !== 'funded'
      && !state.hasLiveClearToClose) {
    out.push({
      type: 'clear_to_close', submissionType: 'clear_to_close',
      message: 'Everything is cleared — this file is ready to submit for Clear to Close.',
    });
  }
  return out;
}

// Does the file already have a LIVE hand-off of this type? (dedup for suggestions)
async function hasLiveItem(appId, submissionType, client = db) {
  const r = await client.query(
    `SELECT 1 FROM workflow_items
      WHERE application_id=$1 AND submission_type=$2 AND status IN ('open','in_progress') LIMIT 1`,
    [appId, submissionType]);
  return !!r.rows[0];
}

// ---------------------------------------------------------------------------
// Super-admin ESCALATION → workflow hand-off (owner-directed 2026-07-21). When a
// registration needs super-admin approval (a Manual Program, or any Standard/Gold
// manual-review EXCEPTION — below the minimum, over the maximum, etc.), raise an
// `escalation` hand-off addressed to the super_admin ROLE so it lands directly in
// every super-admin's Workflow — with the file link, the reason, and a pointer to
// the Escalations box to approve/decline. Own transaction, best-effort; never
// breaks the registration (the manual_program_escalations row is the source of
// truth, this is the surfacing). submitItem supersedes any prior live escalation
// hand-off for the file, so a re-register never stacks duplicates.
// ---------------------------------------------------------------------------
async function onEscalationOpened(appId, { fromStaffId, note } = {}) {
  try {
    const client = await db.getClient();
    let item = null;
    try {
      await client.query('BEGIN');
      item = await workflow.submitItem(client, {
        appId, submissionType: 'escalation', fromStaffId: fromStaffId || null,
        toStaffId: null, toRole: 'super_admin', priority: 1, auto: true,
        note: note || 'A registration needs super-admin approval — review the exception in the Escalations box and approve or decline.',
      });
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { client.release(); }
    return item;
  } catch (_) { return null; }   // best-effort — never break registration
}

// The escalation was decided (approved/declined in the Escalations box) OR the
// file was re-registered as a clean product — take the escalation hand-off off the
// super-admin Workflow so it doesn't linger after it's resolved. Best-effort.
async function closeEscalationWorkflow(appId, outcomeLabel = 'Reviewed') {
  try {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      const live = await client.query(
        `SELECT id, from_staff_id, submission_type FROM workflow_items
          WHERE application_id=$1 AND submission_type='escalation' AND status IN ('open','in_progress')`, [appId]);
      for (const row of live.rows) {
        await client.query(
          `UPDATE workflow_items SET status='cancelled', updated_at=now() WHERE id=$1`, [row.id]);
        await client.query(
          `INSERT INTO workflow_events (workflow_item_id, application_id, event_type, submission_type, note)
           VALUES ($1,$2,'cancelled','escalation',$3)`,
          [row.id, appId, outcomeLabel ? String(outcomeLabel).slice(0, 120) : null]);
      }
      await client.query('COMMIT');
    } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; }
    finally { client.release(); }
  } catch (_) { /* best-effort */ }
}

module.exports = { OUTCOME_ACTIONS, outcomeAction, onFunded, nextStepSuggestions, hasLiveItem, onEscalationOpened, closeEscalationWorkflow };
