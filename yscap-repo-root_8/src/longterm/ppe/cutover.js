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

// Both are PURE (neither requires anything of its own; `agreement-store` is a store only by name — the
// module is the gate LOGIC, and its constant is the one definition of "measured enough"). Reading them
// here is what stops this file growing a second copy of a threshold that decides whether our engine, and
// not Lender Price, answers a borrower.
const ppeSettings = require('./settings');
const agreementStore = require('./agreement-store');

const MODES = { DRAFT: 'draft', SHADOW: 'shadow', LIVE: 'live', RETIRED: 'retired' };

// ---------------------------------------------------------------------------
// SETTINGS -> THE GATE'S THRESHOLDS (§2.73)
// ---------------------------------------------------------------------------
//
// ⛔ THE GATE USED TO RUN NUMBERS NOBODY COULD SET, AND THREE ARTIFACTS TOLD THREE STORIES ABOUT ONE OF
// THEM. `eligibleForLive` was called with NO settings from anywhere, so it ran its own signature
// defaults: 14 clean days and NO coverage floor. Meanwhile the settings registry carried
// `cutover.clean_weeks_required` — 8 weeks, on the Cutover screen, editable by a super admin, and read
// by NOTHING; and the owner's answer about taking an investor live was that the number belongs in the
// super admin. So the dial the screen showed was connected to nothing and the gate ran a quarter of it.
//
// WORSE, THE COVERAGE FLOOR WAS OFF ENTIRELY. Publishing a rate sheet demands agreement with Lender
// Price over `MIN_COMPARABLE_SCENARIOS` comparable scenarios (the owner's HARD RULE). Promoting an
// investor to LIVE — which makes OUR engine, not Lender Price, the answer a borrower is quoted — asked
// for no minimum at all: a canary that compared ONE scenario at 100% satisfied it. The bigger decision
// demanded less proof than the smaller one, which is the whole of this defect.
//
// UNITS ARE THE OTHER HALF, and they are exactly the kind of join that goes wrong quietly: the SETTING
// is in WEEKS and the GATE counts DAYS. The conversion lives here, once.
//
// WHAT THIS DOES NOT DO IS INVENT A BUSINESS RULE. The clean-week COUNT stays the owner's — this only
// makes the gate read the dial they were given. The coverage floor is the owner's OWN already-stated
// "measured enough" number applied to a strictly bigger decision; it is the cautious reading, it is
// stated as an assumption in `source`, and it is recorded in the open-questions doc for confirmation.
const SETTING_CLEAN_WEEKS = 'cutover.clean_weeks_required';
const DAYS_PER_WEEK = 7;

function registryDefault(key) {
  const def = ppeSettings.getDefinition(key);
  return def && Number.isFinite(def.default) ? def.default : null;
}

/**
 * Turn a resolved PPE settings map into the `settings` object `eligibleForLive` takes.
 * PURE. Never throws — a settings map that cannot be read falls back to the registry default, which is
 * the STRICTER number, so a bad read can only ever make the gate harder to pass.
 *
 * Returns { minCleanDays, minCanaryScenarios, requireCanaryPerfect, source } where `source` says where
 * each number came from, so a screen can publish the thresholds AND their provenance rather than
 * presenting an assumption as settled policy.
 */
function settingsToGate(values = {}) {
  const raw = values && values[SETTING_CLEAN_WEEKS];
  const fallbackWeeks = registryDefault(SETTING_CLEAN_WEEKS);
  const weeks = (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ? raw : fallbackWeeks;
  const usable = (typeof weeks === 'number' && Number.isFinite(weeks) && weeks > 0) ? weeks : null;
  return {
    // A registry with no readable default leaves the gate on its own signature default rather than on
    // zero — `minCleanDays: 0` would mean "no clean days required", the one answer a broken read must
    // never produce.
    minCleanDays: usable == null ? undefined : Math.round(usable * DAYS_PER_WEEK),
    minCanaryScenarios: agreementStore.MIN_COMPARABLE_SCENARIOS,
    requireCanaryPerfect: true,
    source: {
      cleanWeeks: usable == null ? 'gate-default' : (raw === usable ? 'settings' : 'registry-default'),
      cleanWeeksValue: usable,
      minCanaryScenarios: 'the same "measured enough" bar a rate sheet must clear to be published — an assumption, pending the owner (open question 3a)',
    },
  };
}
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
    // How much the latest canary actually COMPARED (§10.5/§10.6). null when not supplied.
    canaryScenarioCount: typeof input.canaryScenarioCount === 'number' ? input.canaryScenarioCount : null,
    canaryIncomparable: typeof input.canaryIncomparable === 'number' ? input.canaryIncomparable : null,
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
 *   settings: { minCleanDays=14, requireCanaryPerfect=true, minCanaryScenarios=0 }
 * Returns { eligible, reasons } — reasons lists every gate that FAILED (empty when eligible).
 */
function eligibleForLive(scoreboard = {}, settings = {}) {
  // ⛔ THE DEFAULTS ARE THE STRICT ONES, so forgetting to pass settings can only ever make the gate
  // HARDER (§2.73). They used to be `14` clean days and a coverage floor of `0` — and the one production
  // caller passed nothing, so those were the numbers that actually ran while the super admin's dial sat
  // unread and a one-scenario canary satisfied the coverage requirement that did not exist. A source
  // guard would catch the caller that forgets; strict defaults mean it does not matter if one does.
  const fallback = settingsToGate({});
  const minClean = settings.minCleanDays == null
    ? (Number.isFinite(fallback.minCleanDays) ? fallback.minCleanDays : 14)
    : settings.minCleanDays;
  const requirePerfect = settings.requireCanaryPerfect !== false;
  const minScenarios = settings.minCanaryScenarios == null
    ? (Number.isFinite(fallback.minCanaryScenarios) ? fallback.minCanaryScenarios : 0)
    : settings.minCanaryScenarios;
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
  // §10.6 HARD RULE: a scenario the harness could not fully compare is never proof of agreement — it
  // blocks promotion whenever the count is known, no setting can turn it off. (100% "agreement" over
  // scenarios that could not all be compared is not 100% agreement.)
  if (typeof scoreboard.canaryIncomparable === 'number' && scoreboard.canaryIncomparable > 0) {
    reasons.push(`${scoreboard.canaryIncomparable} canary scenario(s) could not be compared`);
  }
  // §10.5 COVERAGE FLOOR (owner-set, opt-in): an investor may not go live on too thin a canary. Off
  // by default (0); when set, an unknown/absent count fails CLOSED.
  if (minScenarios > 0) {
    const nSc = scoreboard.canaryScenarioCount;
    if (typeof nSc !== 'number') {
      reasons.push(`no canary coverage recorded, needs at least ${minScenarios} compared scenario(s)`);
    } else if (nSc < minScenarios) {
      reasons.push(`only ${nSc} compared canary scenario(s), needs at least ${minScenarios}`);
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
  SETTING_CLEAN_WEEKS, settingsToGate,
  MODES, OPEN_FINDING_STATUSES, DAY_MS,
  buildScoreboard, consecutiveCleanDays, eligibleForLive, transition,
  _internals: { isOpen, TRANSITIONS },
};
