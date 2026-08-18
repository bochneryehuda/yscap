'use strict';
/**
 * Pure offline test for the LT PPE cutover scoreboard + lifecycle gate (src/longterm/ppe/cutover.js).
 *   node scripts/test-lt-ppe-cutover.js
 */

const assert = require('assert');
const C = require('../src/longterm/ppe/cutover');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const DAY = C.DAY_MS;
const NOW = 1_700_000_000_000; // fixed injected clock

// ---- consecutiveCleanDays ---------------------------------------------------
eq(C.consecutiveCleanDays([]), 0, 'clean days: empty -> 0');
eq(C.consecutiveCleanDays([{ dayMs: NOW, count: 0 }, { dayMs: NOW - DAY, count: 0 }]), 2, 'clean days: two clean');
eq(C.consecutiveCleanDays([{ dayMs: NOW, count: 0 }, { dayMs: NOW - DAY, count: 3 }, { dayMs: NOW - 2 * DAY, count: 0 }]), 1,
  'clean days: a dirty day breaks the trailing streak');
eq(C.consecutiveCleanDays([{ dayMs: NOW - DAY, count: 0 }, { dayMs: NOW, count: 2 }]), 0,
  'clean days: most recent day dirty -> 0 (unsorted input handled)');

// ---- buildScoreboard --------------------------------------------------------
(() => {
  const sb = C.buildScoreboard({
    canaryAgreementRate: 1,
    findings: [
      { status: 'open', firstSeenMs: NOW - 5 * DAY },
      { status: 'triaged', firstSeenMs: NOW - 2 * DAY },
      { status: 'fixed', firstSeenMs: NOW - 10 * DAY },
      { status: 'verified', firstSeenMs: NOW - 20 * DAY },
      { status: 'wontfix', firstSeenMs: NOW - 30 * DAY },
    ],
    dailyNewFindings: Array.from({ length: 3 }, (_, i) => ({ dayMs: NOW - i * DAY, count: 0 })),
    nowMs: NOW,
  });
  eq(sb.openFindings, 2, 'scoreboard: only open+triaged count as open');
  eq(sb.oldestOpenFindingDays, 5, 'scoreboard: oldest open finding age in days');
  eq(sb.consecutiveCleanDays, 3, 'scoreboard: clean-day streak');
  eq(sb.canaryAgreementRate, 1, 'scoreboard: canary rate carried');
})();

(() => {
  const sb = C.buildScoreboard({ findings: [], dailyNewFindings: [], nowMs: NOW });
  eq(sb.openFindings, 0, 'scoreboard: no findings -> 0 open');
  eq(sb.oldestOpenFindingDays, null, 'scoreboard: no open findings -> null age');
  eq(sb.canaryAgreementRate, null, 'scoreboard: no canary -> null rate');
})();

// ---- eligibleForLive --------------------------------------------------------
(() => {
  // §2.73: the gate's own defaults are the STRICT ones now — the configured clean WEEKS (x7) and the
  // publish gate's "measured enough" coverage floor — so a fixture that passes with no settings has to
  // clear both. The old fixture (14 clean days, no coverage recorded) asserted the permissive defaults
  // that were the defect, and is kept below as an assertion of what changed.
  const strict = C.settingsToGate({});
  const good = {
    canaryAgreementRate: 1, openFindings: 0,
    consecutiveCleanDays: strict.minCleanDays,
    canaryScenarioCount: strict.minCanaryScenarios,
    canaryIncomparable: 0,
  };
  const r = C.eligibleForLive(good);
  eq(r.eligible, true, 'eligible: all gates pass');
  eq(r.reasons.length, 0, 'eligible: no reasons');

  // A caller that passes NO settings can no longer be promoted on the old permissive numbers.
  const oldPermissive = C.eligibleForLive({ canaryAgreementRate: 1, openFindings: 0, consecutiveCleanDays: 14 });
  eq(oldPermissive.eligible, false, 'eligible: 14 clean days and no recorded coverage is no longer enough');
  ok(oldPermissive.reasons.some((x) => x.includes('consecutive clean')), 'eligible: ...and says the clean-day shortfall');
  ok(oldPermissive.reasons.some((x) => x.includes('coverage')), 'eligible: ...and the missing coverage');
})();

(() => {
  const r = C.eligibleForLive({ canaryAgreementRate: 1, openFindings: 2, consecutiveCleanDays: 14 });
  eq(r.eligible, false, 'ineligible: open findings block');
  ok(r.reasons.some((x) => x.includes('open finding')), 'reason names open findings');
})();

(() => {
  const r = C.eligibleForLive({ canaryAgreementRate: 0.95, openFindings: 0, consecutiveCleanDays: 14 });
  eq(r.eligible, false, 'ineligible: canary below 100%');
  ok(r.reasons.some((x) => x.includes('95%')), 'reason names the canary percentage');
})();

(() => {
  const r = C.eligibleForLive({ canaryAgreementRate: null, openFindings: 0, consecutiveCleanDays: 14 });
  ok(r.reasons.some((x) => x.includes('no canary')), 'ineligible: no canary run proven');
})();

(() => {
  const r = C.eligibleForLive({ canaryAgreementRate: 1, openFindings: 0, consecutiveCleanDays: 6 });
  eq(r.eligible, false, 'ineligible: not enough clean days');
  ok(r.reasons.some((x) => x.includes('consecutive clean')), 'reason names clean-day shortfall');
})();

(() => {
  // custom settings
  // "Relaxed" now has to say so about the coverage floor too, since that is ON by default (§2.73).
  const r = C.eligibleForLive({ canaryAgreementRate: 0.9, openFindings: 3, consecutiveCleanDays: 2 },
    { minCleanDays: 2, requireCanaryPerfect: false, minCanaryScenarios: 0 });
  eq(r.eligible, false, 'ineligible: still blocked by open findings under relaxed settings');
  // Matched on the AGREEMENT wording specifically — a bare `canary` also matches the coverage reason,
  // so the loose version would report the agreement gate as dropped when it was a different gate.
  ok(!r.reasons.some((x) => x.includes('canary agreement') || x.includes('no canary run')),
    'relaxed: canary agreement gate dropped when requireCanaryPerfect false');
  ok(!r.reasons.some((x) => x.includes('consecutive')), 'relaxed: clean-day gate met at 2');
})();

// ---- canary coverage carried onto the scoreboard ---------------------------
(() => {
  const sb = C.buildScoreboard({
    canaryAgreementRate: 1, findings: [], dailyNewFindings: [], nowMs: NOW,
    canaryScenarioCount: 240, canaryIncomparable: 3,
  });
  eq(sb.canaryScenarioCount, 240, 'scoreboard: compared-scenario count carried');
  eq(sb.canaryIncomparable, 3, 'scoreboard: incomparable count carried');

  const none = C.buildScoreboard({ findings: [], dailyNewFindings: [], nowMs: NOW });
  eq(none.canaryScenarioCount, null, 'scoreboard: unknown count -> null');
  eq(none.canaryIncomparable, null, 'scoreboard: unknown incomparable -> null');
})();

// ---- §10.6: an incomparable scenario blocks promotion, no setting turns it off
(() => {
  const base = { canaryAgreementRate: 1, openFindings: 0, consecutiveCleanDays: 14 };
  const r = C.eligibleForLive({ ...base, canaryIncomparable: 2 });
  eq(r.eligible, false, 'incomparable > 0 blocks promotion');
  ok(r.reasons.some((x) => x.includes('could not be compared')), 'reason names the incomparable scenarios');

  // even under fully relaxed settings the incomparable gate stands
  const relaxed = C.eligibleForLive({ ...base, canaryIncomparable: 1, consecutiveCleanDays: 0 },
    { minCleanDays: 0, requireCanaryPerfect: false });
  ok(!relaxed.eligible, 'incomparable gate cannot be relaxed away');

  // zero incomparable is fine — stated against a base that clears the strict defaults, so this asserts
  // the incomparable gate rather than accidentally re-asserting the clean-day or coverage one.
  const strict = C.settingsToGate({});
  const clean = C.eligibleForLive({
    ...base, canaryIncomparable: 0,
    consecutiveCleanDays: strict.minCleanDays, canaryScenarioCount: strict.minCanaryScenarios,
  });
  eq(clean.eligible, true, 'zero incomparable does not block');
})();

// ---- §10.5 coverage floor: ON by default (§2.73), fails closed on an unknown count --------
(() => {
  // The clean-day side is satisfied from the gate's own configured number so this block asserts the
  // COVERAGE gate and nothing else — a fixture stuck on 14 days would fail here for another reason.
  const base = {
    canaryAgreementRate: 1, openFindings: 0,
    consecutiveCleanDays: C.settingsToGate({}).minCleanDays,
  };

  // §2.73: ON by default now, at the SAME "measured enough" number a rate sheet must clear to be
  // published — it used to be off, which let an investor go live on a canary that compared one
  // scenario while publishing a sheet demanded 200. An unknown count fails CLOSED, as it always did.
  const noCount = C.eligibleForLive(base);
  eq(noCount.eligible, false, 'coverage floor is ON by default');
  ok(noCount.reasons.some((x) => x.includes('coverage')), 'coverage floor: names the missing coverage');
  eq(C.settingsToGate({}).minCanaryScenarios, require('../src/longterm/ppe/agreement-store').MIN_COMPARABLE_SCENARIOS,
    'coverage floor: the default IS the publish gate\'s number, not a second copy');

  // met
  eq(C.eligibleForLive({ ...base, canaryScenarioCount: 300 }, { minCanaryScenarios: 200 }).eligible, true,
    'coverage floor met -> eligible');

  // below
  const below = C.eligibleForLive({ ...base, canaryScenarioCount: 12 }, { minCanaryScenarios: 200 });
  eq(below.eligible, false, 'below the coverage floor -> blocked');
  ok(below.reasons.some((x) => x.includes('needs at least 200')), 'reason names the coverage shortfall');

  // required but unknown -> fail CLOSED
  const unknown = C.eligibleForLive(base, { minCanaryScenarios: 200 });
  eq(unknown.eligible, false, 'coverage floor required but no count -> blocked (fail closed)');
  ok(unknown.reasons.some((x) => x.includes('no canary coverage recorded')), 'reason names the missing coverage');
})();

// ---- transition (lifecycle) -------------------------------------------------
(() => {
  eq(C.transition(C.MODES.DRAFT, 'activate').mode, C.MODES.SHADOW, 'activate: draft -> shadow');
  ok(!C.transition(C.MODES.SHADOW, 'activate').ok, 'activate: not from shadow');

  const promoteBlocked = C.transition(C.MODES.SHADOW, 'promote', { eligible: false });
  ok(!promoteBlocked.ok, 'promote: blocked when not eligible');
  ok(promoteBlocked.error.includes('not eligible'), 'promote: reason names ineligibility');

  const promoteOk = C.transition(C.MODES.SHADOW, 'promote', { eligible: true });
  ok(promoteOk.ok && promoteOk.mode === C.MODES.LIVE, 'promote: shadow -> live when eligible');

  ok(!C.transition(C.MODES.DRAFT, 'promote', { eligible: true }).ok, 'promote: only from shadow');

  const rb = C.transition(C.MODES.LIVE, 'rollback');
  ok(rb.ok && rb.mode === C.MODES.SHADOW, 'rollback: live -> shadow, always allowed');

  eq(C.transition(C.MODES.LIVE, 'retire').mode, C.MODES.RETIRED, 'retire: live -> retired');
  eq(C.transition(C.MODES.DRAFT, 'retire').mode, C.MODES.RETIRED, 'retire: draft -> retired');
  ok(!C.transition(C.MODES.RETIRED, 'retire').ok, 'retire: already retired rejected');

  eq(C.transition(C.MODES.RETIRED, 'reopen').mode, C.MODES.DRAFT, 'reopen: retired -> draft');
  ok(!C.transition(C.MODES.LIVE, 'reopen').ok, 'reopen: only from retired');

  ok(!C.transition(C.MODES.SHADOW, 'bogus').ok, 'unknown action rejected');
  ok(!C.transition('weird', 'retire').ok, 'unknown current mode rejected on retire');
})();

// ---- end-to-end: scoreboard -> gate -> promote ------------------------------
(() => {
  // Built from the gate's OWN configured thresholds (§2.73) rather than a literal 14 days, so this
  // stays an end-to-end proof of the chain and does not quietly become an assertion about the number.
  const strict = C.settingsToGate({});
  const sb = C.buildScoreboard({
    canaryAgreementRate: 1,
    findings: [{ status: 'verified', firstSeenMs: NOW - 30 * DAY }],
    dailyNewFindings: Array.from({ length: strict.minCleanDays }, (_, i) => ({ dayMs: NOW - i * DAY, count: 0 })),
    nowMs: NOW,
    canaryScenarioCount: strict.minCanaryScenarios,
    canaryIncomparable: 0,
  });
  const gate = C.eligibleForLive(sb);
  eq(gate.eligible, true, 'e2e: enough clean days + coverage + no open findings + perfect canary -> eligible');
  const t = C.transition(C.MODES.SHADOW, 'promote', { eligible: gate.eligible });
  eq(t.mode, C.MODES.LIVE, 'e2e: promotes to live');

  // ...and one day short of the configured streak is refused, so the e2e proves the gate is live rather
  // than that a fixture happened to satisfy it.
  const short = C.buildScoreboard({
    canaryAgreementRate: 1,
    findings: [],
    dailyNewFindings: Array.from({ length: strict.minCleanDays - 1 }, (_, i) => ({ dayMs: NOW - i * DAY, count: 0 })),
    nowMs: NOW,
    canaryScenarioCount: strict.minCanaryScenarios,
    canaryIncomparable: 0,
  });
  eq(C.eligibleForLive(short).eligible, false, 'e2e: one day short of the streak still refuses');
})();

console.log(`ok - lt ppe cutover (${n} assertions)`);
