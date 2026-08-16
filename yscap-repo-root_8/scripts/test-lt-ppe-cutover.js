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
  const good = { canaryAgreementRate: 1, openFindings: 0, consecutiveCleanDays: 14 };
  const r = C.eligibleForLive(good);
  eq(r.eligible, true, 'eligible: all gates pass');
  eq(r.reasons.length, 0, 'eligible: no reasons');
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
  const r = C.eligibleForLive({ canaryAgreementRate: 0.9, openFindings: 3, consecutiveCleanDays: 2 },
    { minCleanDays: 2, requireCanaryPerfect: false });
  eq(r.eligible, false, 'ineligible: still blocked by open findings under relaxed settings');
  ok(!r.reasons.some((x) => x.includes('canary')), 'relaxed: canary gate dropped when requireCanaryPerfect false');
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

  // zero incomparable is fine
  const clean = C.eligibleForLive({ ...base, canaryIncomparable: 0 });
  eq(clean.eligible, true, 'zero incomparable does not block');
})();

// ---- §10.5 coverage floor: opt-in, fails closed on an unknown count --------
(() => {
  const base = { canaryAgreementRate: 1, openFindings: 0, consecutiveCleanDays: 14 };

  // off by default: no count present, still eligible
  eq(C.eligibleForLive(base).eligible, true, 'coverage floor off by default');

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
  const sb = C.buildScoreboard({
    canaryAgreementRate: 1,
    findings: [{ status: 'verified', firstSeenMs: NOW - 30 * DAY }],
    dailyNewFindings: Array.from({ length: 14 }, (_, i) => ({ dayMs: NOW - i * DAY, count: 0 })),
    nowMs: NOW,
  });
  const gate = C.eligibleForLive(sb);
  eq(gate.eligible, true, 'e2e: 14 clean days + no open findings + perfect canary -> eligible');
  const t = C.transition(C.MODES.SHADOW, 'promote', { eligible: gate.eligible });
  eq(t.mode, C.MODES.LIVE, 'e2e: promotes to live');
})();

console.log(`ok - lt ppe cutover (${n} assertions)`);
