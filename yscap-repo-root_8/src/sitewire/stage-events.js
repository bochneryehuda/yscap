'use strict';
/**
 * DRAW STAGE HISTORY — when each draw reached each step, recorded forward-only.
 *
 * PILOT could always DERIVE a draw's current stage (`./approval` approvalState) but never kept a
 * record of WHEN it got there. So there was no timeline, no "days in this stage", no speed report,
 * and no way to answer "how long do our draws actually take?" — the desk could only ever show the
 * present tense.
 *
 * FORWARD-ONLY, AND IT NEVER INVENTS A PAST. A stage is stamped when PILOT WATCHES it happen; a
 * stage that was reached before this existed simply has no row, and the timeline says so rather
 * than back-dating a guess (the same discipline `draw-timeline.js` already holds to — it refuses
 * to fabricate a missing timestamp). Nothing here reads as evidence of anything except that we
 * saw it.
 *
 * DELIBERATELY NOT UNIQUE per (draw, stage). A draw legitimately re-enters a stage: an amend or a
 * reopen sends it back for another round of inspection and another decision, and collapsing those
 * would erase the very rework the speed report exists to find. What IS suppressed is a repeat of
 * the stage the draw is ALREADY in, so a poll that sees no change writes nothing.
 *
 * The stage vocabulary is owned by `./approval` STAGE_ORDER — this module stores whatever it is
 * given (the column has no CHECK on purpose) so a new rung added there needs no migration here.
 *
 * Never throws. A history row is worth having; it is never worth failing a draw action over.
 */

const db = require('../db');
const APPROVAL = require('./approval');

/** The id space a caller is holding. The two are never interchangeable. */
function refColumns(ref = {}) {
  if (ref.sitewireDrawId != null && /^\d+$/.test(String(ref.sitewireDrawId))) {
    return { col: 'sitewire_draw_id', value: String(ref.sitewireDrawId) };
  }
  if (ref.portalRequestId != null && /^\d+$/.test(String(ref.portalRequestId))) {
    return { col: 'portal_request_id', value: String(ref.portalRequestId) };
  }
  return null;
}

/**
 * Record that a draw entered `stage`.
 *
 *   ref     { sitewireDrawId } | { portalRequestId }
 *   stage   a `approval.STAGE_ORDER` value (or another step PILOT watches, e.g. 'released')
 *   detail  one short human sentence — what actually happened, for the activity strip
 *   source  'pilot' (a human acted here) | 'sitewire' | 'trustpoint' | 'portal'
 *
 * Returns { recorded } / { skipped }.
 */
async function record(appId, ref, stage, { detail = null, actorStaffId = null, source = 'pilot', force = false } = {}) {
  try {
    if (!appId || !stage) return { skipped: 'bad_args' };
    const r = refColumns(ref);
    if (!r) return { skipped: 'no_draw_ref' };

    // Suppress a repeat of the stage this draw is already in — a poll that sees no change must not
    // grow the history. An amend/reopen genuinely re-enters an EARLIER stage, which is a change and
    // is recorded; `force` covers a step that can legitimately happen twice in a row.
    if (!force) {
      const last = (await db.query(
        `SELECT stage FROM draw_stage_events
          WHERE application_id=$1 AND ${r.col}=$2
          ORDER BY entered_at DESC, id DESC LIMIT 1`, [appId, r.value])).rows[0];
      if (last && String(last.stage) === String(stage)) return { skipped: 'already_in_stage' };
    }

    const row = (await db.query(
      `INSERT INTO draw_stage_events (application_id, ${r.col}, stage, detail, actor_staff_id, source)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, stage, entered_at`,
      [appId, r.value, String(stage).slice(0, 60), detail ? String(detail).slice(0, 500) : null, actorStaffId, String(source || 'pilot').slice(0, 30)])).rows[0];
    return { recorded: true, event: row };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[sitewire] stage event:', e && e.message);
    return { skipped: 'error' };
  }
}

/**
 * One draw's history, oldest first — what the timeline and "days in stage" are built from.
 * Returns [] on any failure: a screen missing its history is a smaller problem than a screen that
 * will not load.
 */
async function historyFor(appId, ref) {
  try {
    const r = refColumns(ref);
    if (!appId || !r) return [];
    return (await db.query(
      `SELECT id, stage, detail, source, actor_staff_id, entered_at
         FROM draw_stage_events WHERE application_id=$1 AND ${r.col}=$2
        ORDER BY entered_at ASC, id ASC`, [appId, r.value])).rows;
  } catch (_) { return []; }
}

/**
 * How long this draw has been sitting in its CURRENT stage, in whole days — the number that makes
 * a stuck draw obvious. `null` when there is no history yet, which is honest: a draw whose stages
 * all predate this history is not "0 days old", it is unknown.
 */
function daysInCurrentStage(history, now = new Date()) {
  const rows = Array.isArray(history) ? history : [];
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const t = last && last.entered_at ? new Date(last.entered_at).getTime() : NaN;
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now.getTime() - t) / 86400000));
}

/** The stage this history says the draw is in, or null. Never guessed from anything else. */
function currentStage(history) {
  const rows = Array.isArray(history) ? history : [];
  return rows.length ? String(rows[rows.length - 1].stage) : null;
}

/**
 * Stamp the stage a draw is in NOW, derived by the ladder. Used by the desk's sync so watching a
 * file keeps its history current without every call site having to name the stage itself. The
 * derived stage comes from `approval.drawMoney` output (`approval_stage`), so this can never
 * disagree with the stage the screen is showing beside it.
 */
async function recordDerived(appId, ref, money, opts = {}) {
  const stage = money && money.approval_stage;
  if (!stage || !APPROVAL.STAGE_ORDER.includes(String(stage))) return { skipped: 'unknown_stage' };
  return record(appId, ref, stage, opts);
}

module.exports = { record, recordDerived, historyFor, daysInCurrentStage, currentStage, _internals: { refColumns } };
