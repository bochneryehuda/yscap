/**
 * WHICH CONDITIONS AM I LOOKING AT — one definition, both products.
 *
 * Owner-directed 2026-09-01, on the Long-Term conditions screen: *"We also need
 * to add the full sorting features so that you can sort by stuff that is done,
 * by signed off, and by outstanding, to sort the conditions accordingly that we
 * have on the short-term side. You can share that code as well."*
 *
 * ── WHY THIS IS A MODULE AND NOT A THIRD COPY ───────────────────────────────
 *
 * The rule already existed TWICE before this file did. `roleDone` — the whole
 * question of whether a condition is off YOUR plate — was written out in
 * `screens/StaffApplication.jsx` and again in `screens/StaffTasks.jsx`, each
 * with its own comment saying it mirrors the other. Two copies of one rule
 * drift, and the one that drifts is the one that hides a condition somebody
 * still has to work. Writing a THIRD copy for Long-Term is exactly the shape
 * the owner's own share-the-code directive exists to stop, so the rule moved
 * here and all three screens read it.
 *
 * ── IT RUNS ON THE SHARED CONDITION SHAPE, WHICH IS WHAT MAKES IT SHAREABLE ──
 *
 * Every predicate here reads only `status` / `signed_off_at` / `waived_at` /
 * `reviewed_at` — the fields the SHARED condition components already render.
 * Long-Term's own rows are mapped into that shape by `asSharedCondition`
 * (`longterm/LtFileConditions.jsx`) before they ever reach a shared component,
 * so this module never learns that two products exist and neither product's
 * storage leaks into the other's screen.
 *
 * PURE on purpose — no React, no api, no DOM — so the whole truth table is
 * testable without a browser, and so a filter can never quietly become a place
 * where a screen fetches something.
 */

import { conditionStatusLabel } from './conditions-vocab.js';

/**
 * ONE "off my plate" rule for every conditions/checklist surface
 * (owner-directed 2026-07-16).
 *
 * The loan officer's terminal action is DONE (`reviewed_at`); the back office's
 * is SIGN-OFF. Once YOUR role's action is complete the item leaves your default
 * view — which is the entire reason the officer's Done step is a stamp of its
 * own rather than a status: it clears the row for THEM without clearing the
 * condition for anybody else.
 *
 * An unknown role reads as the back office, deliberately: showing a condition
 * that is already handled costs a glance, and hiding one that is not costs the
 * work. Fail toward SHOWING.
 */
export function roleDone(it, role) {
  if (!it) return false;
  return it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at
    || (role === 'loan_officer' && !!it.reviewed_at);
}

/**
 * The picker's options, in the order they are offered.
 *
 * `mine` is FIRST and is the default because it answers the question a person
 * opening a file is actually asking. `all` is LAST because it is the escape
 * hatch, not the starting point: a list of forty rows where thirty are finished
 * is a list nobody reads.
 */
export const CONDITION_FILTER_KEYS = Object.freeze([
  'mine', 'awaiting', 'review', 'attention', 'unsigned', 'signed', 'all',
]);

/**
 * What each option is CALLED. The status words come from the shared vocabulary
 * rather than being retyped, so a filter can never name a state differently
 * from the row stamp directly under it.
 *
 * `mine` is the one label that depends on WHO is reading — a loan officer's
 * terminal action is a different action from the back office's, and naming both
 * "mine" would tell one of them the wrong thing about what clears the row.
 */
export function conditionFilterLabel(key, role) {
  switch (key) {
    case 'mine':      return role === 'loan_officer' ? 'Needs my review' : 'Needs my sign-off';
    case 'awaiting':  return conditionStatusLabel('outstanding');
    case 'review':    return conditionStatusLabel('received');
    case 'attention': return conditionStatusLabel('issue');
    case 'unsigned':  return 'Not signed off yet';
    case 'signed':    return 'Signed off';
    case 'all':       return 'Everything';
    // Same fallback as the predicate, for the same reason.
    default:          return role === 'loan_officer' ? 'Needs my review' : 'Needs my sign-off';
  }
}

/** The one-line explanation the picker carries as its tooltip. */
export function conditionFilterHint(role) {
  return role === 'loan_officer'
    ? 'Your default shows conditions still needing your review; marking one Done clears it here.'
    : 'Your default shows conditions still needing your sign-off; accepting a document keeps it here until you sign off.';
}

/**
 * Does this condition belong in the chosen view?
 *
 * AN UNRECOGNISED KEY FALLS THROUGH TO `mine`, which is the short-term
 * screen's own behaviour and is deliberately preserved rather than "improved"
 * while extracting it. The only way to reach this branch is a stale value left
 * in somebody's browser by an option that no longer exists, and `mine` is the
 * default every reader starts on anyway — so the fallback lands them where a
 * fresh browser would, not on a seven-hundred-row list. It hides nothing a
 * person still has to do: `mine` is precisely "not yet off YOUR plate".
 */
export function matchConditionFilter(it, key, role) {
  if (!it) return false;
  switch (key) {
    // Nothing has been submitted yet.
    case 'awaiting':  return ['outstanding', 'requested'].includes(it.status) && !it.signed_off_at;
    // Uploaded or accepted, and still waiting on a sign-off.
    case 'review':    return it.status === 'received' && !it.signed_off_at;
    // Sent back — somebody has to fix something.
    case 'attention': return it.status === 'issue';
    // Done, by the only definition that clears it for everyone.
    case 'signed':    return !!it.signed_off_at || it.status === 'satisfied';
    /* Everything the back office has NOT signed off yet (owner-directed
       2026-08-12: a loan officer wants to see only what is still pending the
       processor's sign-off). The complement of "Signed off" across every
       sub-status — outstanding, requested, received, issue — excluding waived
       and satisfied, which are already cleared. */
    case 'unsigned':  return !(it.status === 'satisfied' || !!it.signed_off_at || !!it.waived_at);
    case 'all':       return true;
    case 'mine':
    default:          return !roleDone(it, role);
  }
}

/** The same rule over a list. Never mutates the array it is given. */
export function filterConditions(list, key, role) {
  return (Array.isArray(list) ? list : []).filter((it) => matchConditionFilter(it, key, role));
}
