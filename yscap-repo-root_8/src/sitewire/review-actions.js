/* Sitewire sync-review resolution rules (owner-directed 2026-07-20).
 *
 * A parked Sitewire review must offer ONLY the action(s) that actually fix its cause — otherwise a
 * "resolution" is a no-op that loops (the owner's report: clicking Retry on an advisory cleared the
 * card, re-pushed, and re-parked the same advisory, emailing every time). This module is the single,
 * PURE (no DB / no network) source of truth for "which actions may a given review offer", so the route
 * handler and the tests agree exactly.
 *
 * GO-FORWARD ONLY (owner-directed 2026-07-20): PILOT follows the draw process ONLY for properties IT
 * pushed to Sitewire. It does NOT adopt or follow a pre-existing hand-entered Sitewire property, even on
 * a loan-number match — the owner is not confident in adoption and wants a clean, one-directional
 * pipeline. So the "loan already in Sitewire" collision offers NO one-click link: the only way to bring
 * such a property under PILOT management is to DELETE it in Sitewire and push a fresh copy from the file
 * (a warned re-push = the "retry" action), or keep the two separate (dismiss).
 *
 *   • ADVISORY reasons  — informational; the push already proceeded past them. Only "acknowledge"
 *     (close, never re-push) or "dismiss". Retrying an advisory is what created the loop, so it is NOT
 *     offered. (A failed BORROWER assignment is NOT advisory — it is a real failure a corrected-email
 *     re-push fixes, so it lives in the default retry class below.)
 *   • Everything else (incl. the DUPE collision) — offer "retry" (re-queue the push; for a collision,
 *     only after the human deleted the pre-existing property in Sitewire) or "dismiss".
 *
 * "dismiss" is universally allowed and handled by the caller; the route always permits it.
 */

// Advisory (non-blocking) parked reasons — the push succeeded; these are notes, not walls, and no
// re-push would change anything, so they may only be acknowledged.
//   units_note / type_unmapped   → regenerated every push; retrying just re-parks them (the loop).
//   reconcile_draw_error         → raised by the reconcile poll, not the push; a push-retry can't re-drive it.
//   unknown_op                   → a dead-lettered queue op; there is nothing to retry.
const SITEWIRE_ADVISORY = new Set([
  'sitewire_units_note',
  'sitewire_type_unmapped',
  'sitewire_reconcile_draw_error',
  'sitewire_unknown_op',
]);

// The loan-number collision reason (a pre-existing Sitewire property already carries this loan number).
// Kept as a named constant because the retry handler blocks OTHER reviews' retries while a collision is
// open (a budget push can't land while the property can't be created), and the UI shows special copy.
const SITEWIRE_DUPE = 'sitewire_loan_already_in_sitewire';

// Two-sided DRIFT reviews (bidirectional Phase 2): a PILOT-owned value diverged from Sitewire.
//   budget_drift  → a human likely edited the managed budget directly in Sitewire. Offer RESTORE
//                   (re-push PILOT's budget to overwrite the drift) or ACCEPT (Sitewire's value stands).
//   release_drift → an already-RELEASED draw's approved amount changed in Sitewire. The money already
//                   wired, so this is an ALERT to reconcile the wire by hand — never auto-restored.
const SITEWIRE_DRIFT_RESTORABLE = new Set(['sitewire_budget_drift']);
const SITEWIRE_DRIFT_ALERT = new Set(['sitewire_release_drift']);
const SITEWIRE_TWO_SIDED = new Set([...SITEWIRE_DRIFT_RESTORABLE, ...SITEWIRE_DRIFT_ALERT]);

// The reason "class" is the token before the first ':' (reasons are stored as
// "sitewire_units_note: the file lists 2 unit(s)…"). Everything downstream keys off the class.
const sitewireReasonClass = (reason) => String(reason || '').split(':')[0];

// The actions a review of this class may offer (besides the always-allowed "dismiss").
function sitewireAllowedActions(reasonClass) {
  if (SITEWIRE_DRIFT_RESTORABLE.has(reasonClass)) return ['restore', 'accept', 'dismiss'];
  if (SITEWIRE_DRIFT_ALERT.has(reasonClass)) return ['acknowledge', 'dismiss'];
  if (SITEWIRE_ADVISORY.has(reasonClass)) return ['acknowledge', 'dismiss'];
  return ['retry', 'dismiss'];
}

module.exports = { SITEWIRE_ADVISORY, SITEWIRE_DUPE, SITEWIRE_DRIFT_RESTORABLE, SITEWIRE_DRIFT_ALERT, SITEWIRE_TWO_SIDED, sitewireReasonClass, sitewireAllowedActions };
