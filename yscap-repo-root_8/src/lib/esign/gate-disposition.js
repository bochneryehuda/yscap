'use strict';

/**
 * esign/gate-disposition.js — PURE tiering + send-disposition for the e-sign
 * send-gate. No `require`s / no DB, so it unit-tests anywhere and gate.js stays
 * a thin DB reader on top of it.
 *
 * TIERS (unchanged, 2026-07-23): the send-gate's blockers split into two tiers.
 * The FLOOR makes the signed term sheet itself CORRECT — appraisal back
 * (rtl_cond_appraisaldocs), product & pricing re-registered on the appraised
 * value (rtl_p1_product), the estimated closing date (expected_closing), and a
 * current registration (registration_stale / manual_approval / an unreadable
 * registration). Everything else is CLEAR-TO-CLOSE readiness — today only the
 * internal appraisal-review sign-off (rtl_p3_apprreview). WAIVABLE_CODES is the
 * explicit ctc allow-list (FAIL-CLOSED): any code NOT listed is FLOOR.
 *
 * PER-REQUIREMENT WAIVERS (owner-directed 2026-07-24): a system flag stuck in
 * error (e.g. the false "Term: 12 → 12 Months" re-register loop) must never
 * leave the team with no path to send. So an exception can now be REQUESTED
 * whenever the package can't send (floor met or not), and on approval the
 * super-admin picks EXACTLY which outstanding requirements to waive
 * (exception.waived_codes). Everything NOT waived still blocks — "I'm waiving
 * this requirement, but you still need to complete these." The tier still
 * matters: the UI pre-selects only ctc blockers and demands explicit opt-in +
 * a loud consequence warning (WAIVE_WARNINGS) for each floor blocker.
 *
 * SAFETY (all fail CLOSED):
 *   · A waiver names a code EXPLICITLY — nothing is ever waived by default.
 *   · A waived code counts ONLY while the blocker still means what the
 *     super-admin saw: each outstanding item's `reason` must equal the reason
 *     recorded in exception.decided_gate at decision time. If the picture
 *     changed after the approval (a NEW blocker appeared, or a waived one now
 *     fires for a DIFFERENT reason — e.g. the registration went stale again for
 *     a REAL economics change), that blocker is NOT waived and sending stops
 *     until a fresh exception is decided.
 *   · A LEGACY approval (waived_codes absent/null, from before per-item
 *     waivers) keeps its original meaning exactly: it waives the ctc tier only;
 *     the floor stays enforced.
 */

const APPRAISAL_REVIEW = 'rtl_p3_apprreview';

const WAIVABLE_CODES = new Set([APPRAISAL_REVIEW]);
function tierOf(code) { return WAIVABLE_CODES.has(code) ? 'ctc' : 'floor'; }

// Plain-language consequence of waiving each known blocker — shown to the
// super-admin next to its checkbox (floor items), and recorded nowhere else.
// An unknown/future code gets the generic floor warning (fail closed on copy too).
const WAIVE_WARNINGS = Object.freeze({
  rtl_p3_apprreview: 'The internal appraisal review hasn’t been signed off — the package goes out before the review is finished.',
  rtl_cond_appraisaldocs: 'The appraisal is NOT back. The term sheet will carry numbers that were never confirmed by an appraisal.',
  rtl_p1_product: 'Product & pricing was NOT (re-)registered and signed off on the current numbers — the signed term sheet may not match what underwriting would price.',
  expected_closing: 'No estimated closing date is on file — the signed term sheet will be missing the first-payment and maturity dates.',
  registration_stale: 'The system marked the registration stale (its inputs changed since pricing). Waive this ONLY if you have confirmed the flagged change is not real (e.g. a formatting echo) — otherwise the signed term sheet may not match the deal.',
  manual_approval: 'This is a manual-review structure that normally needs its own super-admin pricing approval first.',
  registration: 'The registration status could not be read — the system cannot prove the term sheet matches a current registration.',
});
const GENERIC_FLOOR_WARNING = 'This requirement makes the signed term sheet correct — waiving it means the documents go out without that guarantee.';
function waiveWarningOf(code) {
  return WAIVE_WARNINGS[code] || (tierOf(code) === 'floor' ? GENERIC_FLOOR_WARNING : '');
}

// The reason the super-admin saw for `code` when they decided, or undefined if
// the code wasn't outstanding at decision time. decided_gate is written by the
// decide route: { at, outstanding: [{code,label,reason,tier}] }.
function decidedReasonOf(exception, code) {
  const dg = exception && exception.decided_gate;
  const list = dg && Array.isArray(dg.outstanding) ? dg.outstanding : null;
  if (!list) return undefined;
  const hit = list.find((o) => o && o.code === code);
  return hit ? String(hit.reason || '') : undefined;
}

/**
 * Split the raw outstanding blockers into floor vs. clear-to-close readiness and
 * decide whether the package may send. `exception` is the latest esign_before_ctc
 * loan_exceptions row (any status) or null.
 *   ready         — nothing outstanding (fully green; unchanged meaning).
 *   floorMet      — no FLOOR blocker outstanding (severity info for the UI).
 *   sendAllowed   — ready OR (an APPROVED exception whose waivers cover EVERY
 *                   outstanding blocker, each still meaning what was approved).
 *   outstanding[] — every blocker, with tier + waived flags for the UI.
 * Anything not explicitly waived is always enforced, approval or not.
 */
function gateDisposition(outstanding, exception) {
  const approved = !!(exception && exception.status === 'approved');
  // Explicit per-item waivers (2026-07-24) vs. a legacy tier waiver (2026-07-23).
  const explicit = approved && Array.isArray(exception.waived_codes)
    ? new Set(exception.waived_codes.map(String)) : null;
  const isWaived = (o) => {
    if (!approved) return false;
    if (!explicit) return tierOf(o.code) === 'ctc';   // legacy approval: ctc tier only
    if (!explicit.has(o.code)) return false;
    // The waiver holds only while the blocker still means what was approved.
    const decidedReason = decidedReasonOf(exception, o.code);
    if (decidedReason === undefined) {
      // No decided_gate recorded (defensive) → honor the explicit code as-is;
      // a decided_gate WITHOUT this code → the blocker is NEW since approval.
      const dg = exception.decided_gate;
      return !(dg && Array.isArray(dg.outstanding));
    }
    return decidedReason === String(o.reason || '');
  };

  const withTier = (outstanding || []).map((o) => ({
    ...o, tier: tierOf(o.code), waiveWarning: waiveWarningOf(o.code),
  }));
  for (const o of withTier) o.waived = isWaived(o);

  const floorOutstanding = withTier.filter((o) => o.tier === 'floor');
  const ctcOutstanding = withTier.filter((o) => o.tier === 'ctc');
  const waivedOutstanding = withTier.filter((o) => o.waived);
  const unwaivedOutstanding = withTier.filter((o) => !o.waived);
  const ready = withTier.length === 0;
  const floorMet = floorOutstanding.length === 0;
  const sendAllowed = ready || (approved && unwaivedOutstanding.length === 0);
  return {
    ready,
    sendAllowed,
    outstanding: withTier,
    floorOutstanding,
    ctcOutstanding,
    waivedOutstanding,
    unwaivedOutstanding,
    floorMet,
    exception: exception || null,
    // Sending is allowed ONLY because of the approved exception (not fully ready).
    waivedByException: sendAllowed && !ready,
    // The UI may offer to request an exception whenever the package can't send
    // (owner-directed 2026-07-24: floor met or NOT — a stuck system flag must
    // never leave the team with no path), unless a request is already pending.
    // An approved-but-no-longer-sufficient exception may be superseded by a new
    // request; an approval that still covers everything means sendAllowed and
    // needs nothing further.
    canRequestException: !ready && !sendAllowed && !(exception && exception.status === 'requested'),
  };
}

module.exports = { WAIVABLE_CODES, tierOf, gateDisposition, APPRAISAL_REVIEW, WAIVE_WARNINGS, waiveWarningOf };
