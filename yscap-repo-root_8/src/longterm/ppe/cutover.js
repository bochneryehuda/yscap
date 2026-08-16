'use strict';
/**
 * LT PPE — per-investor agreement SCOREBOARD (§10.5) + cutover LIFECYCLE gate (§11). PURE: no DB, no
 * network, no clock (the caller injects `nowMs`). This is what decides when our engine may be trusted
 * for an investor instead of Lender Price — one investor at a time, never all at once, never
 * automatically (§10.6, §11.2).
 *
 * Investor lifecycle (§11.1): draft → shadow → live → (retired), with an always-allowed live → shadow
 * ROLLBACK for safety. shadow → live (PROMOTE) is the only gated transition and requires the
 * scoreboard to pass (§10.5). Every transition here is a pure validator; the caller records who/when/
 * why and persists the mode.
 *
 * A finding is "open" while it still needs work (`open` | `triaged`); `fixed` / `verified` / `wontfix`
 * are settled and do not count against the gate (mirrors the RTL finding ledger). Nothing is ever
 * scored as agreement that could not be fully compared — the harness records `incomparable`
 * separately (§10.6); this module only reads the canary agreement rate the caller passes in.
 *
 * LT-only. No RTL imports.
 */

const MODES = { DRAFT: 'draft', SHADOW: 'shadow', LIVE: 'live', RETIRED: 'retired' };
const OPEN_FINDING_STATUSES = new Set(['open', 'triaged']);
const DAY_MS = 24 * 60 * 60 * 1000;

function isOpen(f) { return !!f && OPEN_FINDING_STATUSES.has(f.status); }

/**
 * Build one investor's scoreboard.
 *   input:
 *     canaryAgreementRate — 0..1 from the latest canary-matrix shadow run (summarize().agreementRate).
 *                           null when no canary has run (treated as "not proven").
 *     findings            — [{ status, firstSeenMs }] the investor's finding ledger.
 *     dailyNewFindings    — [{ dayMs, count }] one entry per day, count = NEW findings that day.
 *     nowMs               — the clock, injected.
 * Returns { canaryAgreementRate, openFindings, oldestOpenFindingDays, consecutiveCleanDays }.
 */
function buildScoreboard(input = {}) {
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : null;

  const open = findings.filter(isOpen);
  let oldestOpenFindingDays = null;
  if (open.length && nowMs != null) {
    let oldest = Infinity;
    for (const f of open) if (typeof f.firstSeenMs === 'number' && f.firstSeenMs < oldest) oldest = f.firstSeenMs;
    if (Number.isFinite(oldest)) oldestOpenFindingDays = Math.max(0, Math.floor((nowMs - oldest) / DAY_MS));
  }

  return {
    canaryAgreementRate: typeof input.canaryAgreementRate === 'number' ? input.canaryAgreementRate : null,
    openFindings: open.length,
    oldestOpenFindingDays,
    consecutiveCleanDays: consecutiveCleanDays(input.dailyNewFindings),
  };
}

// Trailing run of days (from the most recent) with zero new findings. Sorted by dayMs descending
// first so the caller need not pre-sort. A day with a positive count breaks the streak.
function consecutiveCleanDays(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return 0;
  const sorted = daily.slice().sort((a, b) => (b.dayMs || 0) - (a.dayMs || 0));
  let streak = 0;
  for (const d of sorted) {
    if ((d.count || 0) === 0) streak += 1; else break;
  }
  return streak;
}

/**
 * The cutover gate (§10.5): is this investor eligible to promote shadow → live?
 *   settings: { minCleanDays=14, requireCanaryPerfect=true }
 * Returns { eligible, reasons } — reasons lists every gate that FAILED (empty when eligible).
 */
function eligibleForLive(scoreboard = {}, settings = {}) {
  const minClean = settings.minCleanDays == null ? 14 : settings.minCleanDays;
  const requirePerfect = settings.requireCanaryPerfect !== false;
  const reasons = [];

  if (scoreboard.openFindings > 0) {
    reasons.push(`${scoreboard.openFindings} open finding(s) must be resolved`);
  }
  if (requirePerfect) {
    if (scoreboard.canaryAgreementRate == null) {
      reasons.push('no canary run has proven 100% agreement');
    } else if (scoreboard.canaryAgreementRate < 1) {
      const pct = Math.round(scoreboard.canaryAgreementRate * 1000) / 10;
      reasons.push(`canary agreement is ${pct}%, must be 100%`);
    }
  }
  if ((scoreboard.consecutiveCleanDays || 0) < minClean) {
    reasons.push(`only ${scoreboard.consecutiveCleanDays || 0} consecutive clean day(s), needs ${minClean}`);
  }

  return { eligible: reasons.length === 0, reasons };
}

// Allowed lifecycle actions and where they lead. Promotion is gated separately.
const TRANSITIONS = {
  activate: { from: MODES.DRAFT, to: MODES.SHADOW },   // start shadowing
  promote: { from: MODES.SHADOW, to: MODES.LIVE },     // GATED on eligibility
  rollback: { from: MODES.LIVE, to: MODES.SHADOW },    // always allowed (safety)
  reopen: { from: MODES.RETIRED, to: MODES.DRAFT },    // re-configure a retired investor
};

/**
 * Validate a lifecycle transition. Returns { ok, mode, error }.
 *   action: 'activate' | 'promote' | 'rollback' | 'retire' | 'reopen'
 *   opts:   { eligible } — required true for 'promote'.
 * 'retire' is allowed from any non-retired mode. 'promote' requires opts.eligible === true.
 */
function transition(current, action, opts = {}) {
  if (action === 'retire') {
    if (current === MODES.RETIRED) return { ok: false, mode: current, error: 'already retired' };
    if (!Object.values(MODES).includes(current)) return { ok: false, mode: current, error: `unknown mode ${current}` };
    return { ok: true, mode: MODES.RETIRED };
  }
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, mode: current, error: `unknown action ${action}` };
  if (current !== t.from) return { ok: false, mode: current, error: `cannot ${action} from ${current} (only from ${t.from})` };
  if (action === 'promote' && opts.eligible !== true) {
    return { ok: false, mode: current, error: 'not eligible for live — resolve the scoreboard gate first' };
  }
  return { ok: true, mode: t.to };
}

module.exports = {
  MODES, OPEN_FINDING_STATUSES, DAY_MS,
  buildScoreboard, consecutiveCleanDays, eligibleForLive, transition,
  _internals: { isOpen, TRANSITIONS },
};
