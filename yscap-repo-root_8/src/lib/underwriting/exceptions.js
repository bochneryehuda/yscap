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

// Verbs that CLOSE a fatal finding and thereby CLEAR the clear-to-close gate. The effect is the
// same no matter the label — a hard dealbreaker goes away and the loan can proceed — so the tiered
// authority is on the EFFECT, not the verb: grant_exception (override — finding is right),
// clear/fix_file (assert remediated / the file is actually fine), dismiss (assert it's noise) all
// unblock CTC. A prior version gated ONLY grant_exception, so a processor could dismiss or clear a
// fraud/mismatch dealbreaker and unblock the loan under the base permission (deep-audit 2026-07-20).
// `decline` closes the finding too but DECLINES the loan (no leniency risk), and post_condition/
// request_document keep it OPEN — those stay at the base authority.
const GATE_CLEARING_ACTIONS = new Set(['grant_exception', 'clear', 'fix_file', 'dismiss']);

/**
 * The permission required to apply `action` to `finding`, ABOVE the base sign_off_conditions
 * gate the route already enforces. Returns a permission string when an elevated bar applies,
 * else null (the base gate is enough).
 */
function elevatedPermissionFor(action, finding) {
  const a = canon(action);
  const f = finding || {};
  const isFatalBlocking = f.severity === 'fatal' && (f.blocks_ctc ?? f.blocksCtc ?? false);
  // Clearing a hard, clear-to-close-blocking dealbreaker needs senior authority (waive_conditions).
  // Underwriters + admins hold waive_conditions, so their workflow is unchanged; only coordinators/
  // processors are restricted from unilaterally waving off a dealbreaker.
  if (GATE_CLEARING_ACTIONS.has(a) && isFatalBlocking) return 'waive_conditions';
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
    reason: 'clearing a clear-to-close-blocking dealbreaker needs senior authority (waive conditions) — route it to an underwriter or admin' };
}

module.exports = { elevatedPermissionFor, canApply, GATE_CLEARING_ACTIONS };
