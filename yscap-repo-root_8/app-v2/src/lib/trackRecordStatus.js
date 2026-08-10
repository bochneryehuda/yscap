/* THE PER-LINE VERIFICATION STATUS MODEL (owner-directed 2026-08-10, #40; db/518).
   ONE definition of what each track-record verification status means, so the
   React Track Record Center (RecordLedger + LineDetail) and the static tool
   bridges (web/(v2/)tools/track-record-portal.js) never label the same status
   two different ways. `scripts/test-track-record-status-pure.js` reads this file
   AND both bridge copies and fails if the labels drift.

   ONLY 'verified' (Fully verified) COUNTS toward experience — the server sets
   is_verified=true for that status alone (src/routes/staff.js verify route).
   'docs' and 'limited' are LEGACY: 'docs' is the explicit document-request
   status, 'limited' the old "public records only" value the back book carries;
   neither is offered as a plain review outcome, and 'limited' no longer counts
   for a new review. */

export const TR_STATUS_LABEL = {
  pending: 'Pending review',
  verified: 'Fully verified',
  not_verified: 'Not verified',
  unable_docs: 'Unable to verify — waiting on documents',
  unable_mismatch: 'Unable to verify — records don’t match',
  rejected: 'Rejected',
  // legacy — shown with a friendly label if a back-book row still carries one
  docs: 'Documentation required',
  limited: 'Public records only',
};

/* A short pill label — the long "Unable to verify — …" reads as a sentence, so
   the collapsed row and badges use these compact forms. */
export const TR_STATUS_SHORT = {
  pending: 'Pending',
  verified: 'Fully verified',
  not_verified: 'Not verified',
  unable_docs: 'Waiting on docs',
  unable_mismatch: 'Records don’t match',
  rejected: 'Rejected',
  docs: 'Docs required',
  limited: 'Public records',
};

/* Does this stored status count toward experience? Only "Fully verified" does.
   (is_verified is the real gate on the server; this mirrors it for display.) */
export function trStatusCounts(status) {
  return String(status || '') === 'verified';
}

/* The non-counting review OUTCOMES a reviewer may set from the "Mark as…"
   control, in display order. 'verified' is the separate primary sign-off (its
   own button, with the readiness warning), so it is NOT in this list. */
export const TR_REVIEW_OUTCOMES = [
  'pending',
  'not_verified',
  'unable_docs',
  'unable_mismatch',
  'rejected',
];

export function trStatusLabel(status) {
  const s = String(status || 'pending');
  return TR_STATUS_LABEL[s] || s;
}

export function trStatusShort(status) {
  const s = String(status || 'pending');
  return TR_STATUS_SHORT[s] || TR_STATUS_LABEL[s] || s;
}

/* A line the reviewer has NOT yet decided (still awaiting a first look). The
   reviewed-but-not-counting outcomes (not_verified / rejected / the two unable
   reasons) are NOT "waiting" — someone looked and recorded why. 'limited' with
   is_verified is a legacy counting row, handled by the caller via is_verified. */
export function trIsPendingReview(status) {
  const s = String(status || 'pending');
  return s === 'pending' || s === 'docs' || s === '';
}
