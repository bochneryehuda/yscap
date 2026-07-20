/* Sitewire sync-review resolution rules (owner-directed 2026-07-20).
 *
 * A parked Sitewire review must offer ONLY the action(s) that actually fix its cause — otherwise a
 * "resolution" is a no-op that loops (the owner's report: clicking Retry on an advisory cleared the
 * card, re-pushed, and re-parked the same advisory, emailing every time). This module is the single,
 * PURE (no DB / no network) source of truth for "which actions may a given review offer", so the route
 * handler and the tests agree exactly.
 *
 *   • ADVISORY reasons  — informational; the push already proceeded past them. Only "acknowledge"
 *     (close, never re-push) or "dismiss". Retrying an advisory is what created the loop, so it is NOT
 *     offered.
 *   • DUPE reason       — a real loan-number collision with a hand-entered Sitewire property. Offer
 *     "link" (adopt that property into management) or "dismiss" (keep them separate). Never "retry" —
 *     a blind re-push just re-hits the same collision wall.
 *   • Everything else   — a genuine blocker the human fixed upstream (bad address, unmatched partner,
 *     budget mismatch): offer "retry" (re-queue the push) or "dismiss".
 *
 * "dismiss" is universally allowed and handled by the caller; it is intentionally NOT in the per-reason
 * lists below only where it would be redundant — the route always permits it.
 */

// Advisory (non-blocking) parked reasons — the push succeeded; these are notes, not walls.
const SITEWIRE_ADVISORY = new Set([
  'sitewire_units_note',
  'sitewire_type_unmapped',
  'sitewire_borrower_assign_failed',
  'sitewire_reconcile_draw_error',
  'sitewire_unknown_op',
]);

// The loan-number collision reason (a Sitewire property already carries this loan number).
const SITEWIRE_DUPE = 'sitewire_loan_already_in_sitewire';

// The reason "class" is the token before the first ':' (reasons are stored as
// "sitewire_units_note: the file lists 2 unit(s)…"). Everything downstream keys off the class.
const sitewireReasonClass = (reason) => String(reason || '').split(':')[0];

// The actions a review of this class may offer (besides the always-allowed "dismiss").
function sitewireAllowedActions(reasonClass) {
  if (reasonClass === SITEWIRE_DUPE) return ['link', 'dismiss'];
  if (SITEWIRE_ADVISORY.has(reasonClass)) return ['acknowledge', 'dismiss'];
  return ['retry', 'dismiss'];
}

module.exports = { SITEWIRE_ADVISORY, SITEWIRE_DUPE, sitewireReasonClass, sitewireAllowedActions };
