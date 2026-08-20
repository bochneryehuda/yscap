'use strict';
/**
 * IS THIS DRAW A DRAFT, OR HAS THE BORROWER ACTUALLY SUBMITTED IT?
 *
 * THE ONE DEFINITION. Owner-reported 2026-08-20:
 *
 *   "The email that our Draw Coordinator is getting when a borrower is STARTING a
 *    draw request … he just clicks Start, and he's starting to take pictures.
 *    Sometimes it could take a few days … Our draw department is getting an email
 *    right away when he clicks the Start button, and it sounds for our team that
 *    this is an actual draw request that he submitted already. The truth is that
 *    he just started a draft, so we need to change this notification and
 *    restructure it. When they actually submit the draw request for review to the
 *    inspector, it should be that it was submitted for review. When they start, it
 *    should only be started as a draft."
 *
 * ROOT CAUSE. Pressing Start in Sitewire CREATES the draw row immediately, in a
 * DRAFT status, and the reconcile's first-seen branch announced every brand-new
 * draw with one sentence — "A new draw request came in" — plus an "Action needed"
 * badge, whatever status it carried. So the moment a borrower opened a draw to
 * start photographing, the desk was told a request had arrived; the real
 * submission, days later, produced a quieter status-transition notice. The two
 * events were the wrong way round.
 *
 * THE CLASS: a record that EXISTS is not a record that was SUBMITTED. Any inbound
 * mirror that announces on first sight has to read the row's own phase first.
 *
 * WHY THIS FILE EXISTS RATHER THAN A THIRD COPY OF THE SET. The submitted-status
 * set was already written out twice — `sitewire/trustpoint-intake.js` (does this
 * draw need hand-entering into TrustPoint?) and `trinity/intake.js` (is this draw
 * ready to send an inspector to?) — each with a comment saying it matched the
 * other. Both now import it from here. A third copy in the notification path is
 * precisely how the desk would end up told a draw was submitted while the two
 * ordering doors, reading a drifted list, quietly stood down.
 *
 * PURE — no DB, no network, no requires. Safe to call from a notification path
 * that must never throw.
 */

/* THE STATUSES SITEWIRE GIVES A DRAW BEFORE THE BORROWER HAS FINISHED WITH IT.
   `drafting`  — created by the Start button; the borrower is filling it in.
   `pending_borrower` — back with the borrower (composing, or re-composing after
                        an amend). `sitewire/approval.js` STAGE_ORDER puts
                        `with_borrower` BEFORE `inspecting`, so this is a
                        pre-submission phase, not a post-inspection one.
   Nothing has been asked of us in either state. */
const DRAFT_STATUSES = new Set(['drafting', 'pending_borrower']);

/* THE STATUSES THAT MEAN THE BORROWER ACTUALLY SUBMITTED IT. This is the exact
   set the two ordering doors have always used — moved here, not re-derived, so
   "did they submit?" has one answer for the notification, the TrustPoint import
   task and the Trinity inspection order alike. */
const SUBMITTED_STATUSES = new Set(['inspecting', 'pending', 'pending_capital_partner', 'approved']);

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Is this draw still the borrower's own draft — nothing asked of us yet? */
function isDraft(status) { return DRAFT_STATUSES.has(norm(status)); }

/** Has the borrower actually submitted it for review? */
function isSubmitted(status) { return SUBMITTED_STATUSES.has(norm(status)); }

/**
 * 'draft' | 'submitted' | 'unknown'.
 *
 * AN UNRECOGNISED STATUS READS AS SUBMITTED, NOT AS A DRAFT — and that direction
 * is deliberate. The statuses we do not name are the LATE ones (declined,
 * completed, whatever Sitewire adds next); calling one of those a draft would
 * leave the desk unaware of a live draw, which is the worse of the two errors.
 * Callers are told it was 'unknown' so the wording can say so rather than
 * asserting a phase nobody confirmed.
 */
function phaseOf(status) {
  const s = norm(status);
  if (!s) return 'unknown';
  if (DRAFT_STATUSES.has(s)) return 'draft';
  if (SUBMITTED_STATUSES.has(s)) return 'submitted';
  return 'unknown';
}

/** Did this transition cross from a draft into a submitted state? */
function crossedIntoSubmitted(prevStatus, nextStatus) {
  return isDraft(prevStatus) && isSubmitted(nextStatus);
}

/* WHERE A SUBMISSION LANDS — the first rung after the borrower lets go of the draw.
   A virtual file lands on `inspecting`, a physical or TrustPoint file skips that and
   lands on `pending`; both mean "they just submitted it, nobody has decided anything
   yet". `pending_capital_partner` and `approved` are deliberately NOT here: a draw
   that reached one of those is PAST the submission, and their own REACT_STATUS
   wording ("a draw was approved in Sitewire") tells the desk strictly more than
   "it was submitted" would. */
const SUBMISSION_ARRIVAL_STATUSES = new Set(['inspecting', 'pending']);

/**
 * Should THIS transition be announced as "the borrower submitted it for review"?
 *
 * Two conditions, and the second is the one that is easy to miss: the draw must
 * have crossed OUT of a draft (so a live draw sent back for a re-inspection is
 * never mislabelled a fresh submission), AND it must have landed at the point
 * where submission is the news. A poll gap wide enough for a draft to reach
 * `approved` did contain a submission — but announcing that one as "submitted for
 * review" would tell the desk less than the truth, so it defers to the approval's
 * own message instead.
 */
function announcesSubmission(prevStatus, nextStatus) {
  return crossedIntoSubmitted(prevStatus, nextStatus)
    && SUBMISSION_ARRIVAL_STATUSES.has(norm(nextStatus));
}

module.exports = {
  DRAFT_STATUSES, SUBMITTED_STATUSES, SUBMISSION_ARRIVAL_STATUSES,
  isDraft, isSubmitted, phaseOf, crossedIntoSubmitted, announcesSubmission,
};
