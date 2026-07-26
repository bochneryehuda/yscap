'use strict';
/**
 * #221 — STAGED live-operation modes, gated on metrics.
 *
 * Turning an AI underwriter loose on real loans is not one switch — it's a
 * ladder the platform climbs only as the evidence earns it. Three postures,
 * least-trusted first:
 *
 *   SHADOW      the AI runs on every live loan but its output is RECORDED ONLY —
 *               never shown in a way that can sway a decision. This is the floor;
 *               it is ALWAYS allowed (you can always watch quietly).
 *   ASSISTED    the AI's advisories are SURFACED to staff to help them — staff
 *               still drive every call. Allowed once the shadow record proves the
 *               AI isn't actively dangerous (no false clears, a real sample).
 *   CONTROLLED  the AI does more of the legwork (pre-fills, suggests clears) but
 *               EVERY action still needs a human, and a super-admin can override
 *               anything. Allowed only when the strict production metrics (#218)
 *               are GREEN over a real sample AND the senior-approved golden replay
 *               (#219) passes.
 *
 * CARDINAL INVARIANT (owner-directed): no mode — not even the top one — ever lets
 * the AI BLOCK a loan or decide without a human who can override it. The mode
 * governs only HOW MUCH of the AI's output is surfaced and leaned on; it is never
 * a stop. This module RECOMMENDS the safe posture from the live metrics; it moves
 * nothing itself and changes no loan decision.
 *
 * Two ceilings meet here:
 *   • the SAFETY ceiling — the highest mode the metrics currently EARN (this module);
 *   • the INTENT ceiling — the mode a super-admin has configured the platform for.
 * The effective mode is the LOWER of the two (metrics can't push you past what ops
 * asked for; ops can't push you past what the metrics have earned) — UNLESS a
 * super-admin explicitly FORCES a higher mode, which is allowed (nothing here is a
 * hard block) but flagged as an override so it's never silent.
 *
 * PURE: no DB, no AI, no clock, no I/O. Composes #218 production-metrics + #219
 * golden-production replay results (it READS them; it does not compute them).
 * NEVER THROWS.
 */

// Ascending trust. rank is the ladder position; a higher mode requires every
// lower mode's gate too (monotonic).
const MODES = Object.freeze([
  Object.freeze({ key: 'shadow', rank: 0, label: 'Shadow-live' }),
  Object.freeze({ key: 'assisted', rank: 1, label: 'Assisted' }),
  Object.freeze({ key: 'controlled', rank: 2, label: 'Controlled' }),
]);
const MODE_KEYS = Object.freeze(MODES.map((m) => m.key));
const BY_KEY = Object.freeze(MODES.reduce((a, m) => { a[m.key] = m; return a; }, {}));

const DEFAULT_THRESHOLDS = Object.freeze({
  assistedMinSample: 20,    // enough scored shadow decisions to trust "not dangerous"
  controlledMinSample: 50,  // a real production sample before leaning on the AI
  requireGoldenForControlled: true, // the senior-approved replay must pass to reach Controlled
});

function low(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : null; }

/** normalize a requested mode key; unknown / blank → 'shadow' (the safe floor). */
function normalizeMode(key) {
  const k = low(key);
  return MODE_KEYS.indexOf(k) >= 0 ? k : 'shadow';
}
function rankOf(key) { const m = BY_KEY[normalizeMode(key)]; return m ? m.rank : 0; }

/**
 * gateFor(mode, signals, t) → { ok, blockers:[...] }  — the requirement to be
 * ALLOWED to operate at `mode`, evaluated against the live signals. PURE.
 *   signals: {
 *     production: <#218 productionMetrics result> { status, falseClears, sampleSize, missedMaterialRate },
 *     golden:     <#219 replay result>            { release:{pass}, ran },
 *     canaryRollback?: boolean  // a canary (#R5.48) actively recommending rollback
 *   }
 */
function gateFor(mode, signals, t) {
  const s = signals || {};
  const prod = s.production || {};
  const golden = s.golden || {};
  const blockers = [];
  const status = low(prod.status);
  const falseClears = num(prod.falseClears);
  const sample = num(prod.sampleSize);

  if (mode === 'shadow') return { ok: true, blockers: [] }; // the floor — always allowed

  // ASSISTED — the AI must not be actively dangerous, on a real sample.
  if (rankOf(mode) >= rankOf('assisted')) {
    if (status === 'insufficient_data' || sample == null || sample < t.assistedMinSample) {
      blockers.push(`need at least ${t.assistedMinSample} scored decisions before surfacing AI advice (have ${sample == null ? 0 : sample})`);
    }
    if (falseClears != null && falseClears > 0) {
      blockers.push(`${falseClears} false clear(s) on record — the AI is not safe to surface yet`);
    }
    if (status === 'red') {
      blockers.push('production metrics are RED — resolve before assisting staff with AI advice');
    }
    if (s.canaryRollback === true) {
      blockers.push('a canary is recommending rollback — hold at shadow');
    }
  }

  // CONTROLLED — green production over a real sample AND the golden replay passes.
  if (rankOf(mode) >= rankOf('controlled')) {
    if (status !== 'green') {
      blockers.push(`production status must be GREEN to lean on the AI (is ${status || 'unknown'})`);
    }
    if (sample == null || sample < t.controlledMinSample) {
      blockers.push(`need at least ${t.controlledMinSample} scored decisions for controlled mode (have ${sample == null ? 0 : sample})`);
    }
    if (t.requireGoldenForControlled && golden.release && golden.release.pass !== true) {
      blockers.push('the senior-approved golden replay does not pass — cannot enter controlled mode');
    }
    if (t.requireGoldenForControlled && !golden.release) {
      blockers.push('no senior-approved golden replay on record — cannot enter controlled mode');
    }
  }
  return { ok: blockers.length === 0, blockers };
}

/**
 * evaluateModes(signals, opts?) → {
 *   allowed,            // the HIGHEST mode the metrics currently earn (the safety ceiling)
 *   byMode: { shadow:{allowed,blockers}, assisted:{...}, controlled:{...} },
 *   nextBlockers,       // what stands between `allowed` and the next rung up
 *   thresholds
 * }  (PURE, NEVER THROWS)
 */
function evaluateModes(signals, opts = {}) {
  try {
    const t = Object.assign({}, DEFAULT_THRESHOLDS, opts.thresholds || {});
    const byMode = {};
    let allowedRank = 0; // shadow is always allowed
    // gates are monotonic: a rung is allowed only if it AND every rung below pass.
    let stillAllowed = true;
    for (const m of MODES) {
      const g = gateFor(m.key, signals, t);
      const allowed = stillAllowed && g.ok;
      if (!allowed && m.rank > 0) stillAllowed = false;
      byMode[m.key] = { allowed, blockers: g.blockers };
      if (allowed) allowedRank = Math.max(allowedRank, m.rank);
    }
    const allowed = MODES.find((m) => m.rank === allowedRank).key;
    const next = MODES.find((m) => m.rank === allowedRank + 1);
    const nextBlockers = next ? byMode[next.key].blockers : [];
    return { allowed, byMode, nextBlockers, thresholds: t };
  } catch (_e) {
    return {
      allowed: 'shadow',
      byMode: { shadow: { allowed: true, blockers: [] }, assisted: { allowed: false, blockers: ['evaluation error'] }, controlled: { allowed: false, blockers: ['evaluation error'] } },
      nextBlockers: ['evaluation error'], thresholds: DEFAULT_THRESHOLDS,
    };
  }
}

/**
 * decideMode(configuredMode, signals, opts?) → {
 *   effective,       // the mode the platform should actually run at
 *   allowed,         // the safety ceiling (highest the metrics earn)
 *   configured,      // the intent ceiling (what ops asked for), normalized
 *   forced,          // true iff a super-admin override pushed ABOVE the safety ceiling
 *   overridable:true,// ALWAYS — nothing here is a hard block; a super-admin can move it
 *   blockers,        // why `effective` isn't higher (empty when at the earned ceiling)
 *   detail           // full evaluateModes() output
 * }  (PURE, NEVER THROWS)
 *
 * effective = min(configured, allowed) — the lower of intent and safety — UNLESS
 * opts.override === true, in which case a super-admin's configured mode wins and is
 * flagged `forced`. Even a forced controlled mode keeps humans in the loop; the
 * override is about how much AI help is surfaced, never a power to auto-decide.
 */
function decideMode(configuredMode, signals, opts = {}) {
  try {
    const detail = evaluateModes(signals, opts);
    const configured = normalizeMode(configuredMode);
    const allowed = detail.allowed;
    const confRank = rankOf(configured);
    const allowRank = rankOf(allowed);

    let effective;
    let forced = false;
    if (opts.override === true && confRank > allowRank) {
      effective = configured; // a super-admin deliberately runs hotter than the metrics earn
      forced = true;
    } else {
      effective = confRank <= allowRank ? configured : allowed;
    }

    // blockers only make sense when the SAFETY ceiling (not the intent ceiling) is
    // what's holding us back and we're not already forced above it.
    const blockers = (!forced && confRank > allowRank) ? detail.nextBlockers : [];
    return { effective, allowed, configured, forced, overridable: true, blockers, detail };
  } catch (_e) {
    return { effective: 'shadow', allowed: 'shadow', configured: 'shadow', forced: false, overridable: true, blockers: ['evaluation error'], detail: evaluateModes(null) };
  }
}

/** modeForSignals(signals, opts?) — convenience: the earned mode with no configured ceiling. */
function modeForSignals(signals, opts = {}) { return evaluateModes(signals, opts).allowed; }

module.exports = {
  MODES, MODE_KEYS, DEFAULT_THRESHOLDS,
  normalizeMode, rankOf, gateFor, evaluateModes, decideMode, modeForSignals,
};
