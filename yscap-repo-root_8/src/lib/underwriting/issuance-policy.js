'use strict';
/**
 * #217 — Issuance POLICY (the never-block / two-tier hard-warning layer).
 *
 * OWNER-DIRECTED (2026-07-23): PILOT's AI must NEVER hard-block a loan, and the
 * super-admin-overridable HARD WARNING is reserved for REAL / CONFIRMED FATALS
 * ONLY. The raw issuance-gate (issuance-gate.js) answers a strict allowed/blocked
 * that FAILS CLOSED — correct as a computation, wrong as a live policy, because it
 * would make the AI an un-overridable blocker. This module wraps that gate output
 * into the owner's two tiers:
 *
 *   TIER 'fatal'    — a genuine dealbreaker proven on VERIFIED data (a confirmed
 *                     fatal finding / a hard leverage-cap breach on confirmed
 *                     numbers). → a HARD WARNING that ONLY a super-admin can
 *                     override (with a reason, recorded on the run). A super-admin
 *                     can ALWAYS proceed — it is never an un-overridable stop.
 *   TIER 'advisory' — everything else the gate flags (MANUAL_PENDING, STALE, a
 *                     missing decision, a non-fatal data conflict, an ungrounded/
 *                     unconfirmed value, plain warnings). → an ordinary advisory
 *                     ANY staff member sees and can proceed past; no super-admin,
 *                     no gating.
 *   TIER 'clear'    — the gate allowed it. Proceed, no warning.
 *
 * CARDINAL INVARIANT: for ANY input, a super-admin can proceed (resolve().proceed
 * is true for a super-admin). The AI never produces a stop a human super-admin
 * cannot override. PURE core; NEVER THROWS. The DB convenience reader lazy-requires
 * the gate so this module stays unit-testable with no pg.
 */

const SUPER_ADMIN_ROLES = Object.freeze(new Set(['super_admin']));
function isSuperAdmin(role) { return SUPER_ADMIN_ROLES.has(String(role == null ? '' : role).trim().toLowerCase()); }

function str(v) { return v == null ? '' : String(v); }
function low(v) { return str(v).trim().toLowerCase(); }

// A blocker is a CONFIRMED FATAL only when it is severity 'fatal' AND it is NOT
// derived from an unconfirmed / ungrounded value. Once the grounding quarantine
// (#212) lands, an ungrounded value can't produce a mismatch finding at all — but
// this stays belt-and-suspenders: a fatal explicitly marked unverified/ungrounded
// (or sourced from grounding) is downgraded to an ADVISORY, never the super-admin
// tier, so an AI extraction error can never force a super-admin gate.
function isUngrounded(f) {
  const o = f || {};
  if (o.grounded === false || o.verified === false) return true;
  if (o.unverified === true || o.ungrounded === true) return true;
  // A finding SOURCED FROM the grounding check is itself an "unconfirmed value"
  // signal — never a confirmed fatal.
  if (low(o.source) === 'grounding') return true;
  const s = low(o.source) + '|' + low(o.code) + '|' + low(o.grounding_status);
  return /ungrounded|unconfirmed|unverified|not_?grounded/.test(s);
}
function isConfirmedFatal(f) {
  const o = f || {};
  return low(o.severity) === 'fatal' && !isUngrounded(o);
}

/**
 * classify(gateResult) → { tier: 'clear'|'advisory'|'fatal', fatals:[], advisories:[],
 *   requiresSuperAdminOverride: boolean }  (PURE, NEVER THROWS)
 *   gateResult: an issuance-gate gateFor()/gateFromLatestRun() result
 *   { allowed, action, status, reason, blockers }.
 */
function classify(gateResult) {
  try {
    const g = gateResult || {};
    if (g.allowed === true) {
      return { tier: 'clear', fatals: [], advisories: [], requiresSuperAdminOverride: false };
    }
    const blockers = Array.isArray(g.blockers) ? g.blockers : [];
    const fatals = blockers.filter(isConfirmedFatal);
    if (fatals.length > 0) {
      return { tier: 'fatal', fatals, advisories: blockers.filter((f) => !isConfirmedFatal(f)), requiresSuperAdminOverride: true };
    }
    // Not allowed, but no confirmed fatal → an ordinary advisory (any staff proceeds).
    return { tier: 'advisory', fatals: [], advisories: blockers, requiresSuperAdminOverride: false };
  } catch (_e) {
    // On any hostile input, degrade to a non-blocking advisory — NEVER a hard block.
    return { tier: 'advisory', fatals: [], advisories: [], requiresSuperAdminOverride: false };
  }
}

/**
 * resolve(gateResult, { actorRole }) → {
 *   tier, hardWarning, proceed, needsSuperAdminOverride, reason, fatals, advisories, action, status
 * }  (PURE, NEVER THROWS)
 * The live answer for an actor clicking a term-sheet / CTC / funding action:
 *   • clear    → proceed:true, no warning.
 *   • advisory → proceed:true for ANY staff, hardWarning:false (surface the note).
 *   • fatal    → hardWarning:true; proceed only if the actor is a super-admin
 *                (they can ALWAYS override with a reason). A non-super-admin gets
 *                proceed:false + needsSuperAdminOverride:true (escalate) — but this
 *                is NEVER an un-overridable block: a super-admin can always proceed.
 */
function resolve(gateResult, opts = {}) {
  try {
    const g = gateResult || {};
    const c = classify(g);
    const superAdmin = isSuperAdmin(opts && opts.actorRole);
    const base = {
      tier: c.tier,
      action: g.action || null,
      status: g.status || null,
      reason: g.reason || null,
      fatals: c.fatals,
      advisories: c.advisories,
    };
    if (c.tier === 'clear') {
      return Object.assign(base, { hardWarning: false, proceed: true, needsSuperAdminOverride: false });
    }
    if (c.tier === 'advisory') {
      // Ordinary advisory — any staff can proceed; it is shown, never a gate.
      return Object.assign(base, { hardWarning: false, proceed: true, needsSuperAdminOverride: false });
    }
    // tier 'fatal' — the super-admin-overridable HARD WARNING.
    return Object.assign(base, {
      hardWarning: true,
      proceed: superAdmin,                    // a super-admin can ALWAYS override
      needsSuperAdminOverride: !superAdmin,    // anyone else escalates
    });
  } catch (_e) {
    // Fail OPEN to an advisory — the AI never hard-blocks, even on bad input.
    return { tier: 'advisory', action: null, status: null, reason: null, fatals: [], advisories: [], hardWarning: false, proceed: true, needsSuperAdminOverride: false };
  }
}

/**
 * resolveFromLatestRun(applicationId, action, db, { actorRole }) → resolve() result (async).
 * Convenience: read the latest run's gate result, then apply the two-tier policy.
 * Best-effort — on any read error it degrades to a non-blocking advisory (never a
 * hard block).
 */
async function resolveFromLatestRun(applicationId, action, db, opts = {}) {
  try {
    const gate = require('./issuance-gate');
    const gateResult = await gate.gateFromLatestRun(applicationId, action, db);
    return resolve(gateResult, opts);
  } catch (_e) {
    return { tier: 'advisory', action: action || null, status: null, reason: null, fatals: [], advisories: [], hardWarning: false, proceed: true, needsSuperAdminOverride: false };
  }
}

module.exports = {
  classify, resolve, resolveFromLatestRun,
  isSuperAdmin, isConfirmedFatal, isUngrounded, SUPER_ADMIN_ROLES,
};
