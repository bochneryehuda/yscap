'use strict';

/**
 * esign/gate-disposition.js — PURE tiering + send-disposition for the e-sign
 * send-gate (owner-directed 2026-07-23). No `require`s / no DB, so it unit-tests
 * anywhere and gate.js stays a thin DB reader on top of it.
 *
 * The send-gate's blockers split into two tiers. The FLOOR makes the signed term
 * sheet itself CORRECT and can NEVER be waived — exactly the four the owner named:
 * appraisal back (rtl_cond_appraisaldocs), product & pricing re-registered on the
 * appraised value (rtl_p1_product), the estimated closing date (expected_closing),
 * and a current registration (registration_stale / manual_approval / an unreadable
 * registration). Everything ELSE is CLEAR-TO-CLOSE readiness a super-admin MAY waive
 * with an approved `esign_before_ctc` exception so the package can go out early —
 * today that is only the internal appraisal-review sign-off (rtl_p3_apprreview).
 *
 * WAIVABLE is an explicit allow-list (FAIL-CLOSED): any code NOT listed here is
 * FLOOR, so a future blocker is never silently made waivable. Add a code here ONLY
 * when it is a genuine clear-to-close readiness step that does not change the term
 * sheet's numbers or dates.
 */

const APPRAISAL_REVIEW = 'rtl_p3_apprreview';

const WAIVABLE_CODES = new Set([APPRAISAL_REVIEW]);
function tierOf(code) { return WAIVABLE_CODES.has(code) ? 'ctc' : 'floor'; }

/**
 * Split the raw outstanding blockers into floor vs. clear-to-close readiness and
 * decide whether the package may send. `exception` is the latest esign_before_ctc
 * loan_exceptions row (any status) or null.
 *   ready        — nothing outstanding (fully green; unchanged meaning).
 *   floorMet     — no FLOOR blocker outstanding (the exception's precondition).
 *   sendAllowed  — ready OR (an APPROVED exception AND the floor is met).
 * The floor is ALWAYS enforced, exception or not, so a stale/changed deal can never
 * send even with an approval on file.
 */
function gateDisposition(outstanding, exception) {
  const withTier = (outstanding || []).map((o) => ({ ...o, tier: tierOf(o.code) }));
  const floorOutstanding = withTier.filter((o) => o.tier === 'floor');
  const ctcOutstanding = withTier.filter((o) => o.tier === 'ctc');
  const ready = withTier.length === 0;
  const floorMet = floorOutstanding.length === 0;
  const approved = !!(exception && exception.status === 'approved');
  const sendAllowed = ready || (approved && floorMet);
  return {
    ready,
    sendAllowed,
    outstanding: withTier,
    floorOutstanding,
    ctcOutstanding,
    floorMet,
    exception: exception || null,
    // Sending is allowed ONLY because of the approved exception (not fully ready).
    waivedByException: sendAllowed && !ready,
    // The UI may offer to request an exception once the floor is met, the file is
    // not already ready, and there isn't already an open/approved one.
    canRequestException: !ready && floorMet && !(exception && ['requested', 'approved'].includes(exception.status)),
  };
}

module.exports = { WAIVABLE_CODES, tierOf, gateDisposition, APPRAISAL_REVIEW };
