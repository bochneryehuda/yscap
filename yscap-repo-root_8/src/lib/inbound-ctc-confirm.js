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

/* THE READINESS GATE (owner-directed 2026-08-06: "it's possible for a file to go
 * to Final CTC … I saw a file that was CTC without having a Final Executed Term
 * Sheet Package, which means a few conditions were still open … even if it's
 * getting CTC in ClickUp, this should go to manual review and not really be CTC
 * till the file is really ready for CTC. This should be a gate.").
 *
 * WHAT WAS WRONG. The confirm-gate above already HELD every pre-CTC → CTC move
 * for a human, but `confirmCtc` then wrote `status='clear_to_close'` STRAIGHT to
 * the row — it never consulted `advancementBlockers`. So the whole readiness
 * apparatus the portal door enforces (every open required condition, and the
 * REAL executed-term-sheet-package gate of 2026-08-01, `esign/ctc-gate.js`) was
 * bypassed the moment the move originated in ClickUp: the reviewer was asked
 * "does ClickUp mean this?", never "is this file actually finished?", and had
 * nothing on the review row telling them the term sheet had never been signed.
 * That is exactly the file the owner found.
 *
 * THE FIX IS THE PORTAL DOOR'S OWN RULE, not a second one. `ctcReadiness` calls
 * the SAME `advancementBlockers(appId,'clear_to_close')` the portal status door
 * calls and filters the SAME advisory AI sources, so "is this file ready?" has
 * ONE answer in this codebase and the two doors can never drift. An ADMIN can
 * still force past it — the same recorded escape hatch every other gate on this
 * file has (`confirm_ctc_override`, audited + stamped on the review) — because
 * "real gate" means nobody reaches CTC by accident, not that a loan with a
 * genuine reason can never move.
 *
 * FUNDED / CLOSED IS DELIBERATELY NOT GATED (owner: "if it's coming up closed or
 * funded in ClickUp, it should get updated in our system as well. It should not
 * gate the further steps. It should only gate the actual clear to close.").
 * `shouldHoldCtc` only ever fires on the move TO Clear to Close, so an inbound
 * 'funded' applies untouched — including on a file PILOT is holding pre-CTC,
 * which then moves straight to funded exactly as ClickUp says.
 */
// AI suggestions are ADVISORY per the HARD RULE — they show on the readiness
// widget but never gate a transition. Mirrors AI_BLOCKER_SOURCES in staff.js;
// the parity test pins the two together.
const AI_BLOCKER_SOURCES = new Set(['ai_suggestion', 'ai_advisory']);

/**
 * Is this file ACTUALLY ready for Clear to Close? Delegates to the portal door's
 * own aggregator so the two can never disagree. THROWS on a read failure — the
 * caller decides what an unreadable file means (confirmCtc refuses, retryably;
 * the sync's review-decoration swallows it).
 * @returns {Promise<{ready:boolean, conditions:Array, gates:Array}>}
 */
async function ctcReadiness(appId) {
  // Lazily required: staff.js is a route module that requires half this library
  // back. By the time anyone confirms a review both are long since loaded, so
  // the cycle is never exercised — a top-level require here would create one.
  const { advancementBlockers } = require('../routes/staff');
  const blockers = await advancementBlockers(appId, CTC) || {};
  const conditions = (blockers.conditions || []).filter((c) => c && !AI_BLOCKER_SOURCES.has(c.source));
  const gates = blockers.gates || [];
  return { ready: !conditions.length && !gates.length, conditions, gates };
}

/* Plain wording for the person reading the review / the refusal. Names what is
 * outstanding rather than a count, because "3 things" sends someone hunting. */
function readinessSummary(readiness) {
  if (!readiness) return null;
  if (readiness.ready) return 'Everything on this file is cleared — it is ready for Clear to Close.';
  const title = (r) => (r && (r.title || r.label)) || 'an item';
  const bits = [];
  // The gates first: the executed term sheet package is the one the owner named,
  // and it is the one nobody can clear by ticking a box.
  for (const g of readiness.gates.slice(0, 4)) bits.push(title(g));
  for (const c of readiness.conditions.slice(0, 6 - bits.length)) bits.push(title(c));
  const total = readiness.gates.length + readiness.conditions.length;
  const more = total - bits.length;
  return `This file is NOT ready for Clear to Close — still outstanding: ${bits.join('; ')}`
    + (more > 0 ? `; plus ${more} more` : '') + '.';
}

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

  // WHAT IS STILL OUTSTANDING, captured onto the review row itself — the reviewer
  // is being asked to advance a file to a locking milestone, so they must see
  // whether it is actually finished without opening the file and hunting. Purely
  // decorative here (the real refusal lives in confirmCtc, which re-reads it
  // LIVE at decision time — this snapshot is from whenever the pull happened and
  // can be stale by then). Best-effort: the sync must never break on it.
  let readiness = null;
  try { readiness = await ctcReadiness(appId); } catch (_) { readiness = null; }

  try {
    await review.queueReview({
      applicationId: appId, borrowerId: borrowerId || null, taskId,
      direction: 'inbound', fieldKey: 'status_ctc', reason: 'ctc_confirm_needed',
      clickupValue: STATUS_LABEL[CTC], portalValue: STATUS_LABEL[curStatus] || curStatus,
      rawValue: JSON.stringify({
        fromStatus: curStatus,
        internalStatus: incomingInternal,
        readiness: readiness ? {
          ready: readiness.ready,
          summary: readinessSummary(readiness),
          // Titles only — the blocker rows carry section/reason decoration the
          // review UI has no use for, and a forensic column should stay small.
          outstanding: [...readiness.gates, ...readiness.conditions]
            .map((r) => (r && (r.title || r.label)) || 'an item').slice(0, 12),
        } : null,
      }),
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
async function confirmCtc({ appId, actorId = null, internalStatus = null, taskId = null,
                            force = false, allowForce = false, client = db }) {
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

  // THE READINESS GATE. Re-read LIVE at decision time — the snapshot on the
  // review row is from whenever the pull happened, and the whole point is that a
  // file gets FINISHED between the hold and the confirm.
  const forced = !!(force && allowForce);
  let readiness = null;
  if (forced) {
    // An override does not CONSULT the gate, but it still RECORDS it — what was
    // outstanding is captured here, before the write, or the audit row would
    // describe the file as it looks afterwards.
    try { readiness = await ctcReadiness(appId); } catch (_) { readiness = null; }
  } else {
    try {
      readiness = await ctcReadiness(appId);
    } catch (_) {
      // FAILS CLOSED, but retryably. An unreadable file is not evidence that it
      // is finished, and this is a deliberate human action a person can simply
      // repeat — unlike the sync, where refusing would break the pull. Nothing
      // is permanently blocked: the next click re-asks.
      const e = new Error("PILOT could not check whether this file is ready for Clear to Close. Nothing was changed — please try again in a moment.");
      e.status = 503; e.expose = true; throw e;
    }
    if (!readiness.ready) {
      const e = new Error(`${readinessSummary(readiness)} Finish these (or have an admin override) before moving the file to Clear to Close.`);
      e.status = 409; e.expose = true; e.code = 'ctc_not_ready';
      e.readiness = readiness;
      throw e;
    }
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
    [actorId ? 'staff' : 'system', actorId, appId, JSON.stringify({
      fromStatus,
      forced,
      // AN OVERRIDE IS NEVER SILENT — record WHAT was outstanding at the moment
      // somebody advanced past it, so the file can answer years later. (Only an
      // override has an outstanding list; a normal confirm passed the gate.)
      overrodeBlockers: forced ? (readinessSummary(readiness) || 'could not be read') : undefined,
    })]).catch(() => {});

  // The move is REAL history — until now this door wrote none, so a file that
  // reached Clear to Close from ClickUp had no row saying when, and every
  // "days in stage" answer was computed over the portal-driven minority of
  // moves. Best-effort by contract; `forced` carries the override.
  try {
    await require('./stage-history').record(appId, fromStatus, CTC,
      { changedBy: actorId || null, source: 'clickup', forced, client });
  } catch (_) { /* history must never break the confirm */ }

  // The closing attorney is told, on the file's closing chain, that we are clear to
  // close (owner-directed 2026-07-28). This door is hooked SEPARATELY from the portal
  // one because it deliberately bypasses `notifyStatusTransition` — a ClickUp-driven
  // change is announced from here. Both call the same `announce()`, whose dedupe key
  // is what guarantees exactly one email however the file got here.
  // Silent when the file has no closing chain; never blocks the confirm.
  try {
    // Carry the closing date like the portal door does. Both share the dedupe key
    // `clear_to_close`, so whichever fires first is the ONE email the attorney gets —
    // and without this the ClickUp-originated route won a race by sending the poorer
    // version, silently dropping the expected-closing line from it.
    const cd = (await client.query(
      `SELECT to_char(COALESCE(expected_closing, est_closing_date),'YYYY-MM-DD') AS day
         FROM applications WHERE id=$1`, [appId])).rows[0] || {};
    await require('./closing-prep').announce({
      applicationId: appId, eventKind: 'clear_to_close', dedupeKey: 'clear_to_close',
      extra: { closingDate: cd.day || null },
    });
  } catch (_) { /* best-effort */ }

  return { fromStatus, alreadyThere: false, forced };
}

module.exports = {
  shouldHoldCtc, applyInboundCtcConfirm, confirmCtc, ctcReadiness, readinessSummary,
  CTC, AT_OR_PAST_CTC, AI_BLOCKER_SOURCES,
};
