'use strict';

/**
 * SUPER-ADMIN CONDITION OVERRIDE — the one rule, in one place
 * (owner-directed 2026-07-27).
 *
 * "Add an admin override for each and every condition — if we're unable to
 *  clear it, the admin should be able to overwrite and clear the condition
 *  without a document attached to it or without fulfilling the requirement of
 *  that condition. Only super admin."
 *
 * WHAT THIS IS NOT. It is not a relaxation of any fulfillment gate, and it is
 * not a role that skips them. The 2026-07-20 rule stands untouched: the plain
 * Sign off / Waive buttons refuse an unfulfilled condition for EVERYONE,
 * super admins included. Signing off the government-ID condition with nothing
 * uploaded is still impossible by accident.
 *
 * WHAT THIS IS. A separate, deliberate action that a super admin — and only a
 * super admin — can take on ANY condition, on top of the refusal: "clear it
 * anyway, and here is why". Three properties make it safe enough to exist:
 *
 *   1. EXPLICIT. The caller must ask for it (`adminOverride: true`). Nothing is
 *      inferred from the actor's role, so an override can never happen because
 *      of who clicked — only because of what they clicked.
 *   2. REASONED. A reason is required, always. Same house rule as a waive or a
 *      push-back: the decision travels with its justification or not at all.
 *   3. RECORDED. The caller stamps who/when/why on the condition AND keeps the
 *      gate's refusal text (what was actually missing) alongside it, so the file
 *      can answer "what was skipped here?" long after everyone has forgotten.
 *
 * Every surface that can complete a condition routes its override decision
 * through `evaluate()` here, so the gate can never drift between them: the
 * conditions list, the tasks queue, and the first-class condition objects all
 * ask the same question and get the same answer + the same wording.
 *
 * PURE — no database, no request object, no throwing. Takes the actor and the
 * request body, returns a verdict.
 */

// Only this role. Deliberately NOT a capability: capabilities are grantable
// per-person from the Team screen, and this one is not meant to be handed out
// (an admin can already grant themselves anything else). Mirrors
// issuance-policy.SUPER_ADMIN_ROLES, the other place where "super admin only"
// is the actual policy rather than a default.
const OVERRIDE_ROLES = Object.freeze(new Set(['super_admin']));

const REASON_MAX = 500;

// Plain-language, borrower-free wording — these strings reach a staff screen.
const DENIED_MESSAGE =
  'Only a super admin can override a condition. Ask a super admin to clear this one, ' +
  'or finish what the condition is asking for.';
const REASON_REQUIRED_MESSAGE =
  'An override needs a reason — say why this condition is being cleared without what it asks for. ' +
  'The reason is saved on the file for everyone to see.';
const NO_ACTION_MESSAGE =
  'An override has to come with the sign-off (or waive) it is overriding.';

/** Is this actor allowed to override a condition at all? */
function mayOverride(actor) {
  if (!actor || actor.kind !== 'staff') return false;
  return OVERRIDE_ROLES.has(String(actor.role == null ? '' : actor.role).trim().toLowerCase());
}

/** Was an override asked for on this request? (explicit only — never inferred) */
function isRequested(body) {
  return !!(body && body.adminOverride === true);
}

/** Trim + cap an override reason; '' / whitespace / non-strings become null. */
function normalizeReason(input) {
  if (input == null) return null;
  const s = String(input).trim();
  return s ? s.slice(0, REASON_MAX) : null;
}

/**
 * Does this checklist PATCH body actually complete the condition? An override
 * only makes sense attached to a completion — overriding a note edit is
 * meaningless, and silently accepting one would record an override that cleared
 * nothing. Sign-off, waive and the status dropdown's "satisfied" are the three
 * ways a checklist condition completes (mirrors the gate call in staff.js).
 */
function isCompletionAction(body) {
  const b = body || {};
  return b.signedOff === true || b.waived === true || b.status === 'satisfied';
}

/**
 * evaluate(actor, body, opts) → verdict  (PURE, NEVER THROWS)
 *
 *   { requested:false, ok:true }                    nothing asked for — carry on
 *   { requested:true,  ok:true, reason }            allowed; stamp it
 *   { requested:true,  ok:false, status, error }    refused; answer with status
 *
 * opts.requireCompletion (default true for the checklist surface) makes the
 * "must accompany a completion" check part of the same verdict, so no caller
 * has to remember it.
 */
function evaluate(actor, body, opts = {}) {
  try {
    if (!isRequested(body)) return { requested: false, ok: true, reason: null };
    if (!mayOverride(actor)) {
      return { requested: true, ok: false, status: 403, error: DENIED_MESSAGE, reason: null };
    }
    const reason = normalizeReason(body && body.overrideReason);
    if (!reason) {
      return { requested: true, ok: false, status: 400, error: REASON_REQUIRED_MESSAGE, reason: null };
    }
    if (opts.requireCompletion !== false && !isCompletionAction(body)) {
      return { requested: true, ok: false, status: 400, error: NO_ACTION_MESSAGE, reason: null };
    }
    return { requested: true, ok: true, reason };
  } catch (_e) {
    // Fail CLOSED: an unreadable override request is not an override.
    return { requested: true, ok: false, status: 400, error: REASON_REQUIRED_MESSAGE, reason: null };
  }
}

/**
 * One line of prose describing an override, for an audit entry / a notification
 * / the register note. `blocked` is what the fulfillment gate refused with —
 * null when nothing was actually blocking (a super admin may override a
 * condition that would have cleared anyway; the record should say so plainly).
 */
function describe({ label, reason, blocked } = {}) {
  const what = label ? `"${String(label).slice(0, 120)}"` : 'a condition';
  const why = reason ? String(reason).slice(0, REASON_MAX) : 'no reason given';
  const missing = blocked
    ? ` What was missing: ${String(blocked).slice(0, 400)}`
    : ' Nothing was blocking it at the time.';
  return `Super-admin override cleared ${what}. Reason: ${why}.${missing}`;
}

module.exports = {
  OVERRIDE_ROLES, REASON_MAX,
  DENIED_MESSAGE, REASON_REQUIRED_MESSAGE, NO_ACTION_MESSAGE,
  mayOverride, isRequested, normalizeReason, isCompletionAction, evaluate, describe,
};
