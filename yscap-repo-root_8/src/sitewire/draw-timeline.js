'use strict';
/**
 * THE PER-DRAW STAGE TIMELINE — the draw's journey as a staged, timestamped path a human reads at a
 * glance, the way a loan file's own status timeline reads (owner-directed: "a timestamp on every
 * step … a unified status like a loan file's stages, so we can see where the draw is up to").
 *
 * The draw desk already had the ladder MODEL (`approval.js` STAGE_ORDER) and every step's time
 * recorded across several tables — but the two were never joined: the desk showed ONE current-stage
 * chip, and the timestamps lived only in a flat, newest-first audit log. This turns the two into the
 * one thing the owner asked for — each stage in order, marked done / current / upcoming, carrying the
 * date it was reached.
 *
 * PURE — no DB, no network. The IO half (`rollup.js`) gathers the recorded times into a `stage_times`
 * object and hands it here; the server attaches the resolved shape so the UI never re-derives it
 * (the same pattern `lib/draw-status.js` follows).
 *
 * NEVER GUESS A TIMESTAMP. A stage with no recorded time — `inspector_approved`, because Sitewire
 * does not stamp the inspector's proposal separately — is shown as a stage with NO date rather than a
 * fabricated one. An honest blank is the whole point of a status a human trusts.
 *
 * BORROWER-SAFE: with `borrower:true` the capital-partner step (`with_investor`) is omitted entirely
 * (the frozen rule that a borrower is never shown the capital-partner step), and the borrower wording
 * from STAGE_TEXT is used.
 */

const { STAGE_ORDER, STAGE_TEXT } = require('./approval');

// The milestones a draw passes through, in display order. The dispute detour (`borrower_disputed`)
// is inserted only when it actually happened. `with_investor` is staff-only.
const STAFF_FLOW = ['inspecting', 'inspector_approved', 'borrower_review', 'borrower_accepted', 'with_investor', 'final_approved', 'released'];
const BORROWER_FLOW = ['inspecting', 'inspector_approved', 'borrower_review', 'borrower_accepted', 'final_approved', 'released'];

// Which recorded time belongs to each stage. A stage with no source returns null — an honest blank.
function timeFor(stage, t) {
  const times = t || {};
  switch (stage) {
    case 'inspecting':         return times.submitted_at || null;
    case 'inspector_approved': return null;                                     // no separate stamp
    case 'borrower_review':    return times.delivered_at || null;
    case 'borrower_disputed':  return times.disputed_at || null;
    case 'borrower_accepted':  return times.accepted_at || times.resolved_at || null;
    case 'with_investor':      return times.investor_delivered_at || null;
    case 'final_approved':     return times.approved_at || null;
    case 'released':           return times.released_at || null;
    default:                   return null;
  }
}

/**
 * Build the ordered timeline for one draw.
 *
 * @param times         recorded timestamps: { submitted_at, delivered_at, accepted_at, disputed_at,
 *                      resolved_at, investor_delivered_at, approved_at, released_at }
 * @param currentStage  the draw's approval_stage (from `approval.drawMoney`)
 * @param borrower      borrower voice + no capital-partner step
 * @returns [{ stage, label, at, state: 'done' | 'current' | 'upcoming' }]
 */
function stageTimeline(times, currentStage, { borrower = false } = {}) {
  const t = times || {};
  const flow = (borrower ? BORROWER_FLOW : STAFF_FLOW).slice();
  // Show the dispute detour only when the borrower actually pushed back — for BOTH audiences (a
  // borrower who disputed should see that their pushback is on the record).
  if (t.disputed_at || currentStage === 'borrower_disputed') {
    const at = flow.indexOf('borrower_accepted');
    if (at >= 0) flow.splice(at, 0, 'borrower_disputed');
  }
  const curIdx = STAGE_ORDER.indexOf(String(currentStage || ''));
  const steps = flow.map((stage) => {
    const idx = STAGE_ORDER.indexOf(stage);
    let state;
    if (curIdx < 0 || idx > curIdx) state = 'upcoming';
    else if (idx === curIdx) state = 'current';
    else state = 'done';
    const text = STAGE_TEXT[stage] || {};
    return {
      stage,
      label: (borrower ? text.borrower : text.staff) || stage,
      at: state === 'upcoming' ? null : timeFor(stage, t),
      state,
    };
  });
  // If the draw's current stage is not itself a visible milestone (the borrower cannot see
  // `with_investor`, or the draw sits before the first shown step), nothing got marked "current" —
  // so promote the furthest-reached visible step, which is where the draw actually is for the reader.
  if (curIdx >= 0 && !steps.some((s) => s.state === 'current')) {
    for (let i = steps.length - 1; i >= 0; i--) {
      if (steps[i].state === 'done') { steps[i] = { ...steps[i], state: 'current' }; break; }
    }
  }
  return steps;
}

module.exports = { stageTimeline, STAFF_FLOW, BORROWER_FLOW, timeFor };
