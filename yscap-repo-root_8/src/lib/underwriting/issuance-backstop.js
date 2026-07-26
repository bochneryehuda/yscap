'use strict';
/**
 * #202 (R6.18) — the route-facing ISSUANCE BACKSTOP.
 *
 * Every term-sheet / export / clear-to-close / funding write path consults this
 * one helper as a SAFETY NET over the whole-loan underwriting decision. It wraps
 * issuance-policy.js (the #217 two-tier, never-block layer) into a single answer a
 * route can act on AND record:
 *
 *   • tier 'clear'    → proceed, no warning.
 *   • tier 'advisory' → proceed (ANY staff); surface the note. Never a gate.
 *   • tier 'fatal'    → a super-admin-overridable HARD WARNING. A super-admin can
 *                       ALWAYS proceed (recorded as an override with a reason);
 *                       anyone else is asked to escalate (needsSuperAdminOverride).
 *
 * CARDINAL INVARIANT (governing rule #217): this is NEVER an un-overridable block.
 * A super-admin proceeds for ANY input. On no run / any error it FAILS OPEN to a
 * non-blocking advisory. It reads the latest run's decision and applies policy — it
 * decides nothing, clears nothing, and touches NO frozen pricing number.
 *
 * PURE core (decideBackstop) + a thin DB reader (backstopForRun) that lazy-requires
 * the policy, so the decision logic unit-tests with no pg. NEVER THROWS.
 */

const ROLE_SUPER = 'super_admin';

function str(v) { return v == null ? '' : String(v); }
function low(v) { return str(v).trim().toLowerCase(); }
function arr(v) { return Array.isArray(v) ? v : []; }

/**
 * decideBackstop(resolved, opts) → {
 *   action, tier, hardWarning, proceed, needsSuperAdminOverride, reason,
 *   fatals, advisories, override:{ requested, applied, byRole, reason }
 * }  (PURE, NEVER THROWS)
 *   resolved: an issuance-policy.resolve() result
 *             { tier, action, status, reason, fatals, advisories, hardWarning,
 *               proceed, needsSuperAdminOverride }.
 *   opts: { actorRole, action?, override?:boolean, overrideReason?:string }
 *
 * The route's live answer:
 *   • clear/advisory → proceed:true, hardWarning:false (surface any note).
 *   • fatal → hardWarning:true; proceed only for a super-admin. A super-admin
 *     proceeding past a fatal is recorded as an override (override.applied) with
 *     their reason; anyone else gets proceed:false + needsSuperAdminOverride:true
 *     (escalate) — NEVER an un-overridable stop.
 */
function decideBackstop(resolved, opts = {}) {
  try {
    const r = resolved && typeof resolved === 'object' ? resolved : {};
    const o = opts && typeof opts === 'object' ? opts : {};
    const actorRole = low(o.actorRole);
    const isSuper = actorRole === ROLE_SUPER;
    const tier = r.tier === 'clear' || r.tier === 'advisory' || r.tier === 'fatal' ? r.tier : 'advisory';
    const hardWarning = tier === 'fatal';
    const proceed = hardWarning ? isSuper : true; // super-admin ALWAYS proceeds on a fatal
    const overrideReason = str(o.overrideReason).trim();
    const overrideRequested = o.override === true || overrideReason.length > 0;
    const overrideApplied = hardWarning && isSuper && proceed; // a super-admin clearing a fatal IS the override

    return {
      action: r.action || o.action || null,
      status: r.status || null,
      tier,
      hardWarning,
      proceed,
      needsSuperAdminOverride: hardWarning && !isSuper,
      reason: r.reason || null,
      fatals: arr(r.fatals),
      advisories: arr(r.advisories),
      override: {
        requested: overrideRequested,
        applied: overrideApplied,
        byRole: overrideApplied ? actorRole : null,
        reason: overrideApplied ? (overrideReason || null) : null,
      },
    };
  } catch (_e) {
    // Fail OPEN — the AI never hard-blocks, even on hostile input.
    return {
      action: null, status: null, tier: 'advisory', hardWarning: false, proceed: true,
      needsSuperAdminOverride: false, reason: null, fatals: [], advisories: [],
      override: { requested: false, applied: false, byRole: null, reason: null },
    };
  }
}

/**
 * backstopForRun(applicationId, action, db, opts) → decideBackstop result (async).
 * Reads the latest underwriting run's issuance decision (via issuance-policy),
 * then applies the backstop. Best-effort: on any error it degrades to a
 * non-blocking advisory (never a hard block). NEVER THROWS.
 *   action: 'term_sheet' | 'ctc' | 'funding'
 *   opts:   { actorRole, override?, overrideReason? }
 */
async function backstopForRun(applicationId, action, db, opts = {}) {
  let resolved;
  try {
    // Ensure the file's whole-loan run reflects CURRENT data before we read its
    // issuance decision — otherwise this backstop would decide off a stale (or
    // absent) run. Best-effort + deduped (no new run when nothing moved) + never
    // throws; if it can't run, resolveFromLatestRun simply reads whatever exists
    // (or nothing → advisory/proceed). This is what makes the CTC/funding gate
    // actually reflect the loan, while staying fail-open by construction.
    try { await require('./run').maybeRunWholeLoan(applicationId, db, action); } catch (_e2) { /* fail open */ }
    const policy = require('./issuance-policy');
    resolved = await policy.resolveFromLatestRun(applicationId, action, db, { actorRole: (opts && opts.actorRole) || null });
  } catch (_e) {
    resolved = { tier: 'advisory', action, fatals: [], advisories: [] };
  }
  return decideBackstop(resolved, Object.assign({}, opts, { action }));
}

/** actionForStatus(externalStatus) → the issuance action a status transition maps to, or null. */
function actionForStatus(externalStatus) {
  const s = low(externalStatus);
  if (s === 'funded') return 'funding';
  if (s === 'clear_to_close') return 'ctc';
  return null;
}

module.exports = { decideBackstop, backstopForRun, actionForStatus, ROLE_SUPER };
