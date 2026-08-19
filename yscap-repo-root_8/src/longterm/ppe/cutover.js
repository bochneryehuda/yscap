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
const finding = require('./finding');

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

// A SETTLED finding that has come back — the fix did not hold (`finding.mergeOne` sets the flag).
//
// ⛔ IT IS COUNTED SEPARATELY, AND ONLY WHERE IT IS NOT ALREADY OPEN. A regressed row keeps its settled
// status (`fixed`/`verified`), so `isOpen` is false for it and NOTHING in this file used to see it: the
// gate answered `eligible` with no reasons for an investor whose price fix had come apart. A human can
// later triage it back to `open`, and then it must produce ONE reason, not two.
function isRegressed(f) { return !!f && f.regressed === true && !isOpen(f); }

// A row whose ENGINE WIRING has since changed (§2.126) — `finding.measuredByCurrentLeg` owns the test,
// and it is required here rather than re-expressed so the ledger, the gate and the screen can never
// drift into two answers about the same row.
function isUnreadable(f) { return !finding.measuredByCurrentLeg(f); }

// A row somebody SETTLED under an engine wiring that has since changed. It is not a defect and not a
// regression — it is a decision nobody can check, and it is counted on its own because neither of the
// other two terms can see it: settled rows are not open, and `mergeOne` deliberately does not flag them
// regressed (accusing a fix that was never made of coming undone is the §2.124 defect in a new costume).
function isStaleDecision(f) {
  return !!f && !isOpen(f) && f.staleDecision === true;
}

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
    // Fixes that did not hold (§2.74). The ledger already carried this and the scoreboard threw it away.
    regressedFindings: findings.filter(isRegressed).length,
    // §2.126. `openFindings` above counts these too, DELIBERATELY: they are open rows, they still block,
    // and dropping them out of the total would silently loosen the gate on the strength of a doubt. What
    // this number buys is the WORDING — "3 open finding(s) must be resolved" tells a reader to go fix
    // three defects, when 3 of them may be rows an older engine wiring filed and nobody can read.
    unreadableOpenFindings: open.filter(isUnreadable).length,
    staleDecisions: findings.filter(isStaleDecision).length,
    oldestOpenFindingDays,
    consecutiveCleanDays: consecutiveCleanDays(input.dailyNewFindings),
    // How much the latest canary actually COMPARED (§10.5/§10.6) — comparable LESS the scenarios where
    // an engine threw, which is `parity.comparedOf` and is what the caller must supply (§2.77). null
    // when not supplied, which is NOT the same as zero: one is "nobody measured", the other is
    // "measured nothing", and the coverage floor below fails closed on the first.
    canaryScenarioCount: typeof input.canaryScenarioCount === 'number' ? input.canaryScenarioCount : null,
    canaryIncomparable: typeof input.canaryIncomparable === 'number' ? input.canaryIncomparable : null,
    // THE REST OF THE RUN'S SPLIT (§2.79), so the coverage figure above can be RECONCILED rather than
    // taken on faith: compared + errors + overlay + incomparable = scenarios. They gate nothing on their
    // own — `canaryUnaccounted` is the one exception, because buckets that do not add up mean the
    // measurement itself is broken and a broken measurement is not proof of anything.
    canaryScenarios: num(input.canaryScenarios),
    canaryOverlay: num(input.canaryOverlay),
    canaryErrors: num(input.canaryErrors),
    canaryUnaccounted: num(input.canaryUnaccounted),
    // §2.126b — how many stored runs the board could and could NOT read. These gate nothing on their
    // own: dropping the unreadable ones already makes every measure above null-or-smaller, which fails
    // closed by itself. What they buy is the WORDING — "no canary run has proven 100% agreement" is
    // true of sixty unreadable runs and sends a reader to run a sixty-first.
    canaryRunsReadable: num(input.canaryRunsReadable),
    canaryRunsUnreadable: num(input.canaryRunsUnreadable),
  };
}

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }

// Trailing run of days (from the most recent) with zero new findings. Sorted by dayMs descending
// first so the caller need not pre-sort. A day with a positive count breaks the streak.
function consecutiveCleanDays(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return 0;
  const sorted = daily.slice().sort((a, b) => (b.dayMs || 0) - (a.dayMs || 0));
  let streak = 0;
  for (const d of sorted) {
    // §2.126b — A DAY WHOSE EVIDENCE CANNOT BE READ IS NOT A CLEAN DAY. It breaks the run rather than
    // being skipped: this function walks the entries it is GIVEN, so a caller that simply omitted such
    // a day would join the stretches either side of it into one longer streak — the wrong direction,
    // and invisible on every screen. Only an EXPLICIT `false` breaks it, so a caller that knows nothing
    // about readability (every caller before this) behaves exactly as it did.
    if (d && d.readable === false) break;
    if ((d.count || 0) === 0) streak += 1; else break;
  }
  return streak;
}

/**
 * The cutover gate (§10.5): is this investor eligible to promote shadow → live?
 *   settings: { minCleanDays=14, requireCanaryPerfect=true, minCanaryScenarios=0 }
 * Returns { eligible, reasons } — reasons lists every gate that FAILED (empty when eligible).
 */
/**
 * NAME WHAT WAS SUBTRACTED, or the refusal points at the wrong remedy (§2.79).
 *
 * MEASURED: a 300-scenario battery with 100 reasoned overrides and 4 throws refused with *"only 196
 * compared canary scenario(s), needs at least 200"*. Every word of that is true and it reads as "your
 * battery is too small" — so the obvious response is to add scenarios, which changes nothing, while the
 * actual causes (a third of the battery is deliberately not scored, and four scenarios threw) go unsaid.
 *
 * Both helpers stay SILENT on anything they were not told, so a scoreboard assembled without the split
 * produces exactly the message it produced before.
 */
function ofTotal(sb) {
  return typeof sb.canaryScenarios === 'number' ? ` of ${sb.canaryScenarios}` : '';
}

function subtractedText(sb) {
  const parts = [];
  if (typeof sb.canaryOverlay === 'number' && sb.canaryOverlay > 0) {
    parts.push(`${sb.canaryOverlay} were reasoned overlay overrides (deliberately not scored against Lender Price)`);
  }
  if (typeof sb.canaryErrors === 'number' && sb.canaryErrors > 0) {
    parts.push(`${sb.canaryErrors} hit an engine error`);
  }
  if (typeof sb.canaryIncomparable === 'number' && sb.canaryIncomparable > 0) {
    parts.push(`${sb.canaryIncomparable} could not be compared`);
  }
  if (!parts.length) return '';
  return ` — ${parts.join(', ')}, so a bigger battery is not the remedy`;
}

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
    // §2.126: say how many of them nobody can read, in the same sentence. A reader told to "resolve 3
    // findings" goes looking for three defects; if two were filed by an engine wiring that has since
    // been corrected, the work is to re-run and clear them, not to hunt a bug that may not exist.
    const unreadable = num(scoreboard.unreadableOpenFindings) || 0;
    reasons.push(unreadable > 0
      ? `${scoreboard.openFindings} open finding(s) must be resolved — ${unreadable} of them ${unreadable === 1 ? 'was' : 'were'} recorded by an engine wiring that has since changed and cannot be read; re-run the check or decide them`
      : `${scoreboard.openFindings} open finding(s) must be resolved`);
  }
  // §2.126 HARD RULE, same shape and same reason as the regression term below. A finding somebody marked
  // fixed/verified/dismissed under an engine wiring that has since changed is a decision about a
  // measurement we no longer trust, and NOTHING else here can see it: the row is settled so it is not
  // open, and it is deliberately not flagged `regressed`. Left unsaid, an investor could go live on a
  // ledger whose every row was settled against an engine that has since been corrected.
  //
  // THE REMEDY IS REAL, which is what makes it safe to block on: deciding the row again writes today's
  // stamp (`finding-store.decideFinding`), and it clears. No run can clear it, because no run can re-make
  // a human's decision — that asymmetry is the point, not an oversight.
  if (num(scoreboard.staleDecisions) > 0) {
    reasons.push(`${scoreboard.staleDecisions} finding(s) ${num(scoreboard.staleDecisions) === 1 ? 'was' : 'were'} settled under an engine wiring that has since changed — look at them again and record the decision`);
  }
  // §2.74 HARD RULE, and no setting turns it off — for the same reason the incomparable gate has none.
  // A disagreement somebody marked FIXED and which is reproducing again is not a matter of degree: it
  // says the fix did not hold, which is precisely what "may this engine be trusted on its own?" asks.
  // Neither of the other two terms can see it — the row is settled, so `openFindings` is 0, and its key
  // was seen on an earlier day, so the clean-day streak counts the day it came back as CLEAN.
  //
  // THE REMEDY IS REAL, which is what makes this safe to block on: deciding the finding again (re-fix,
  // verify, or dismiss it) CLEARS the flag — `finding-store.decideFinding` writes `regressed = false`
  // beside the status. Blocking on a flag nothing could clear would be the §2.72 dead end all over
  // again, so the two halves ship together and the test proves the clearing works.
  if (scoreboard.regressedFindings > 0) {
    reasons.push(`${scoreboard.regressedFindings} finding(s) marked fixed have come back — the fix did not hold; look at them again`);
  }
  if (requirePerfect) {
    if (scoreboard.canaryAgreementRate == null) {
      // §2.126b — SAY WHY THERE IS NO RATE. There are two completely different situations behind a null
      // here, and they need opposite actions: nobody has ever run the check, or the checks all ran and
      // none of them can be read. The old sentence covered both and pointed at the first, so an
      // investor sitting on sixty unreadable runs was told to go and run one.
      const unread = num(scoreboard.canaryRunsUnreadable) || 0;
      reasons.push(unread > 0
        ? `no canary run that can be READ has proven 100% agreement — ${unread} stored run(s) were recorded by an engine wiring that has since changed; run the check again to start a series that counts`
        : 'no canary run has proven 100% agreement');
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
      reasons.push(`only ${nSc}${ofTotal(scoreboard)} compared canary scenario(s), needs at least ${minScenarios}${subtractedText(scoreboard)}`);
    }
  }
  // BUCKETS THAT DO NOT ADD UP ARE NOT A ROUNDING QUIRK — they mean the run's own summary cannot be
  // reconciled, so nothing it reports is proof. Reported and blocking, never absorbed silently.
  if (typeof scoreboard.canaryUnaccounted === 'number' && scoreboard.canaryUnaccounted !== 0) {
    reasons.push(`the latest canary does not add up — ${Math.abs(scoreboard.canaryUnaccounted)} scenario(s) are in no bucket, so the run cannot be trusted as proof`);
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
  _isRegressed: isRegressed,
  MODES, OPEN_FINDING_STATUSES, DAY_MS,
  buildScoreboard, consecutiveCleanDays, eligibleForLive, transition,
  _internals: { isOpen, TRANSITIONS },
};
