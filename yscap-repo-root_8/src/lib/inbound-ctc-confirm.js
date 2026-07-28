'use strict';

/**
 * Confirm-gate the CLICKUP → PILOT "Clear to Close" status move (owner-directed
 * 2026-07-27: "whenever ClickUp is changing to Clear to Close and our system is
 * not yet Clear to Close, this should go to manual review to confirm that it
 * should be cleared to close in our system").
 *
 * Clear to Close is a MAJOR milestone — reaching it LOCKS the file's structure
 * (see file-lock.js STRUCTURE_LOCKED) and emails the borrower a "you're clear to
 * close" milestone. Letting a status changed directly in ClickUp advance PILOT
 * to Clear to Close on its own would jump the file past PILOT's own view of where
 * it is. So: when an inbound pull would move a PRE-Clear-to-Close file to Clear
 * to Close, the status change is HELD (PILOT keeps its current status, the
 * borrower is NOT notified) and a review is parked for a human to CONFIRM the
 * move. Confirming applies Clear to Close and notifies the borrower; dismissing
 * keeps PILOT's status. A file already AT or PAST Clear to Close
 * (clear_to_close / funded) is never gated.
 *
 * This mirrors the inbound-economics-freeze pattern: a PURE decision helper, a
 * best-effort guard that MUTATES `cols` (nulls the held fields so their COALESCE
 * keeps the current value) and parks a review, and a confirm applier for the
 * review action. It NEVER throws into the sync and touches ONLY the status
 * fields, ONLY on the pre-CTC → CTC move.
 */

const db = require('../db');
const { STATUS_LABEL } = require('./status-notify');

const CTC = 'clear_to_close';
// A file already at or past Clear to Close — nothing to confirm. (declined /
// withdrawn are NOT here: a ClickUp move to Clear to Close on a terminal file is
// exactly the kind of surprise a human should confirm, so it is gated too.)
const AT_OR_PAST_CTC = new Set(['clear_to_close', 'funded']);

/**
 * PURE — should this inbound status move be HELD for a Clear-to-Close confirm?
 * @param incomingExternal the external status ClickUp would apply (cols.status)
 * @param currentStatus    the file's current external status
 */
function shouldHoldCtc(incomingExternal, currentStatus) {
  if (incomingExternal !== CTC) return false;      // only the move TO Clear to Close
  if (!currentStatus) return false;                // unknown current → don't interfere
  if (AT_OR_PAST_CTC.has(currentStatus)) return false;  // already there / past
  return true;
}

/**
 * Enforce the confirm-gate on an inbound pull for an EXISTING file. MUTATES
 * `cols` (nulls status + internal_status when the move is held, so their COALESCE
 * keeps the current value) and parks / clears the review row. Best-effort — never
 * throws into the sync.
 * @returns {Promise<{held:boolean}>} whether the Clear-to-Close move was held
 *          (the caller uses this to SKIP the inbound borrower status notification
 *          for this pull — otherwise it would announce Clear to Close anyway).
 */
async function applyInboundCtcConfirm({ appId, cols, taskId, borrowerId, client = db }) {
  if (!appId || !cols) return { held: false };
  const review = require('./sync-review');
  const closeStale = (note) => review
    .closeStaleReviews({ applicationId: appId, taskId, fieldKey: 'status_ctc', note })
    .catch(() => {});

  // Not a move to Clear to Close on this pull → nothing to hold. ClickUp is no
  // longer at Clear to Close, so any open "confirm CTC" review is now STALE (its
  // whole premise was "ClickUp wants Clear to Close"). Close it so a reviewer can
  // never confirm a move ClickUp has since reverted (which would wrongly advance +
  // email the borrower, then bounce back on the next pull). Cheap indexed UPDATE
  // that hits 0 rows on the vast majority of pulls — mirrors the economics-freeze
  // close-on-recovery.
  if (cols.status !== CTC) {
    await closeStale('auto-closed — ClickUp is no longer Clear to Close');
    return { held: false };
  }

  let current = null;
  try {
    current = (await client.query(`SELECT status FROM applications WHERE id=$1`, [appId])).rows[0] || null;
  } catch (_) { return { held: false }; }  // can't read the file → don't interfere with the pull
  const curStatus = current && current.status;

  if (!shouldHoldCtc(cols.status, curStatus)) {
    // Already Clear to Close / Funded — nothing to confirm; clear any stale row.
    await closeStale('auto-closed — the file is already Clear to Close / Funded');
    return { held: false };
  }

  const incomingInternal = cols.internal_status || null;
  // HOLD: keep PILOT's current status — both the external bucket and the ClickUp
  // internal mirror — so PILOT is fully unchanged until a human confirms.
  cols.status = null;            // COALESCE keeps the current external status
  cols.internal_status = null;   // COALESCE keeps the current internal status

  try {
    await review.queueReview({
      applicationId: appId, borrowerId: borrowerId || null, taskId,
      direction: 'inbound', fieldKey: 'status_ctc', reason: 'ctc_confirm_needed',
      clickupValue: STATUS_LABEL[CTC], portalValue: STATUS_LABEL[curStatus] || curStatus,
      rawValue: JSON.stringify({ fromStatus: curStatus, internalStatus: incomingInternal }),
      suppressIfRejected: true,   // this fires on every pull while ClickUp says CTC — a dismiss must stick
    });
  } catch (_) { /* queueing is best-effort */ }

  try {
    await client.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, 'clickup_pull_ctc_held', 'application', $1, $2)`,
      [appId, JSON.stringify({ taskId, fromStatus: curStatus })]);
  } catch (_) { /* audit best-effort */ }

  // BASELINE the go-forward status watermark on a held pull (only when it is still
  // NULL — a first-sight file). A held pull SKIPS notifyInboundStatusChange, so
  // without this the watermark would stay NULL and the NEXT real status change
  // (e.g. the file later moving to declined) would be silently baselined instead
  // of emailed. Setting it to the CURRENT (unchanged) status announces nothing now
  // and lets that later change notify normally.
  try {
    await client.query(
      `UPDATE applications SET status_notified_external=$2
        WHERE id=$1 AND status_notified_external IS NULL`, [appId, curStatus]);
  } catch (_) { /* best-effort */ }

  return { held: true };
}

/**
 * CONFIRM the held Clear-to-Close move — the deliberate human decision to advance
 * PILOT to Clear to Close so it matches ClickUp. Sets both status fields AND the
 * go-forward watermark in lock-step (so a later ClickUp echo never re-notifies),
 * then notifies the borrower of the milestone. Returns { fromStatus, alreadyThere }.
 */
async function confirmCtc({ appId, actorId = null, internalStatus = null, taskId = null, client = db }) {
  if (!appId) { const e = new Error('no application on this review'); e.status = 422; e.expose = true; throw e; }
  const cur = (await client.query(
    `SELECT status, clickup_pipeline_task_id FROM applications WHERE id=$1`, [appId])).rows[0];
  if (!cur) { const e = new Error('the file no longer exists'); e.status = 404; e.expose = true; throw e; }
  const fromStatus = cur.status;
  if (AT_OR_PAST_CTC.has(fromStatus)) return { fromStatus, alreadyThere: true };  // already there — no-op

  // RE-READ ClickUp LIVE to confirm it is STILL Clear to Close (like every other
  // review resolver — the stored row can be stale). If ClickUp has moved back off
  // Clear to Close since the review was raised, do NOT advance PILOT / email the
  // borrower. The status comes straight off task.status (no dropdown options
  // needed). Best-effort: if ClickUp can't be reached, honor the human's explicit
  // confirm rather than block it on a transient outage.
  const tid = taskId || cur.clickup_pipeline_task_id;
  if (tid && !String(tid).startsWith('app:')) {
    try {
      const clickup = require('../clickup/client');
      const mapper = require('../clickup/mapper');
      const statusMap = require('../clickup/status');
      const task = await clickup.getTask(tid, { include: ['custom_fields'] });
      const read = mapper.readTaskFields(task, {});   // internalStatus is derived from task.status
      const liveExternal = statusMap.externalFor(read.internalStatus) || null;
      if (liveExternal !== CTC) return { fromStatus, reverted: true, liveExternal };
      internalStatus = read.internalStatus || internalStatus;   // write the live internal value
    } catch (_) { /* ClickUp unreachable → proceed with the human's explicit confirm */ }
  }

  await client.query(
    `UPDATE applications
        SET status=$2,
            internal_status=COALESCE($3, internal_status),
            status_notified_external=$2,
            updated_at=now()
      WHERE id=$1`,
    [appId, CTC, internalStatus]);

  // Tell the borrower they are Clear to Close (the change originated in ClickUp,
  // so the team already knows). The watermark was set to clear_to_close above in
  // lock-step, so the next inbound echo of this status is a silent no-op.
  try {
    const { borrowerStatusOpts } = require('./status-notify');
    await require('./notify').notifyAppBorrowers(appId, borrowerStatusOpts(appId, fromStatus, CTC));
  } catch (_) { /* best-effort — a notify failure must never block the confirm */ }

  await client.query(
    `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
     VALUES ($1,$2,'clickup_pull_ctc_confirmed','application',$3,$4)`,
    [actorId ? 'staff' : 'system', actorId, appId, JSON.stringify({ fromStatus })]).catch(() => {});

  return { fromStatus, alreadyThere: false };
}

module.exports = { shouldHoldCtc, applyInboundCtcConfirm, confirmCtc, CTC, AT_OR_PAST_CTC };
