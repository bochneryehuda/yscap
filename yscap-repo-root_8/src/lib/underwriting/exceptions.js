'use strict';
/**
 * Exception / override authority.
 *
 * When a check fails, a file often still proceeds via a DOCUMENTED exception — but not everyone
 * should be able to override every failure. Credit-risk best practice (FDIC / Abrigo) is tiered
 * approval authority: routine (warning) exceptions clear at the desk, but a policy/critical
 * (FATAL, clear-to-close-blocking) exception needs senior sign-off. This module encodes that
 * tier for the underwriting desk.
 *
 * The desk already gates the resolve endpoint on `sign_off_conditions` (a processor/underwriter
 * can post conditions, request docs, fix the file, clear, dismiss). This adds ONE higher bar:
 * GRANTING AN EXCEPTION on a fatal, CTC-blocking finding — approving the loan despite an
 * unmet hard requirement — additionally requires `waive_conditions` (held by admins and
 * underwriters, not coordinators/processors). The exception is still recorded who/why/when on
 * the finding (resolution + note + resolved_by/at) for the immutable audit trail.
 *
 * Pure + dependency-free: takes a `can(actor, permission)` predicate so it never imports auth.
 */
const { canon } = require('./actions');

// The resolution verbs that mean "approve DESPITE the finding" (an override), as opposed to
// asserting it was wrong (clear/dismiss) or scheduling follow-up (condition/request).
const OVERRIDE_ACTIONS = new Set(['grant_exception']);

/**
 * The permission required to apply `action` to `finding`, ABOVE the base sign_off_conditions
 * gate the route already enforces. Returns a permission string when an elevated bar applies,
 * else null (the base gate is enough).
 */
function elevatedPermissionFor(action, finding) {
  const a = canon(action);
  const f = finding || {};
  const isFatalBlocking = f.severity === 'fatal' && (f.blocks_ctc ?? f.blocksCtc ?? false);
  if (OVERRIDE_ACTIONS.has(a) && isFatalBlocking) return 'waive_conditions';
  return null;
}

/**
 * May this actor apply `action` to `finding`? `can(actor, perm)` is the permission predicate.
 * @returns {{ok:true} | {ok:false, requiredPermission, reason}}
 */
function canApply(actor, action, finding, can) {
  const need = elevatedPermissionFor(action, finding);
  if (!need) return { ok: true };
  if (can(actor, need)) return { ok: true, elevated: need };
  return { ok: false, requiredPermission: need,
    reason: 'granting an exception on a clear-to-close-blocking finding needs senior authority (waive conditions) — route it to an underwriter or admin' };
}

module.exports = { elevatedPermissionFor, canApply, OVERRIDE_ACTIONS };
