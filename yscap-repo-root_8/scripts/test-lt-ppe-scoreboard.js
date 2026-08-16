'use strict';
/**
 * Pure offline test for the LT PPE agreement scoreboard / continuous measurement
 * (src/longterm/ppe/scoreboard.js).  node scripts/test-lt-ppe-scoreboard.js
 */

const assert = require('assert');
const S = require('../src/longterm/ppe/scoreboard');
const cutover = require('../src/longterm/ppe/cutover');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const near = (a, b, m) => { assert.ok(Math.abs(a - b) < 1e-9, `${m} (got ${a}, want ${b})`); n += 1; };

const DAY = S.DAY_MS;
const NOW = 1_700_000_000_000;
const d = (n) => NOW - n * DAY; // n days ago (already day-aligned enough for bucketing)

// ---- dailySeries: collapse per day, ascending, latest run drives the measure ----
{
  const runs = [
    { dayMs: d(2), agreementRate: 0.9, findingKeys: ['a', 'b'] },
    { dayMs: d(2) + 3600_000, agreementRate: 0.95, findingKeys: ['a'] }, // same day, later
    { dayMs: d(0), agreementRate: 1.0, findingKeys: [] },
  ];
  const { days, dropped } = S.dailySeries(runs);
  eq(dropped, 0, 'series: nothing dropped');
  eq(days.length, 2, 'series: two calendar days');
  ok(days[0].dayMs < days[1].dayMs, 'series: ascending by day');
  eq(days[0].runCount, 2, 'series: same-day runs collapse (runCount 2)');
  near(days[0].agreementRate, 0.95, 'series: latest run of the day drives agreementRate');
  eq(days[0].newFindings, 2, 'series: both keys new on their first day');
  eq(days[1].newFindings, 0, 'series: a clean later day adds no new findings');
}

// ---- a NEW finding is counted only the FIRST day its key appears ----
{
  const runs = [
    { dayMs: d(3), agreementRate: 0.8, findingKeys: ['x'] },       // x new
    { dayMs: d(2), agreementRate: 0.8, findingKeys: ['x'] },       // x recurs -> not new
    { dayMs: d(1), agreementRate: 0.7, findingKeys: ['x', 'y'] },  // y new, x recurs
    { dayMs: d(0), agreementRate: 0.9, findingKeys: ['x'] },       // recurs
  ];
  const dn = S.dailyNewFindings(runs);
  eq(dn.length, 4, 'newFindings: one entry per day');
  eq(dn[0].count, 1, 'newFindings: x new on day 3');
  eq(dn[1].count, 0, 'newFindings: x recurring is not new');
  eq(dn[2].count, 1, 'newFindings: only y is new on day 1');
  eq(dn[3].count, 0, 'newFindings: recurrence never counts as new');
}

// ---- runs with no placeable time are dropped and COUNTED (never silent) ----
{
  const { days, dropped } = S.dailySeries([
    { dayMs: d(0), agreementRate: 1 },
    { agreementRate: 1 },                 // no dayMs
    { dayMs: NaN, agreementRate: 1 },     // not finite
    null,
  ]);
  eq(days.length, 1, 'drop: only the placeable run survives');
  eq(dropped, 3, 'drop: the three unplaceable runs are counted');
}

// ---- latestAgreementRate ----
eq(S.latestAgreementRate([]), null, 'latest: empty -> null');
near(S.latestAgreementRate([{ dayMs: d(2), agreementRate: 0.5 }, { dayMs: d(0), agreementRate: 0.99 }]), 0.99,
  'latest: newest run wins regardless of input order');
eq(S.latestAgreementRate([{ dayMs: d(0), agreementRate: null }, { dayMs: d(2), agreementRate: 0.5 }]), null,
  'latest: newest run unmeasured -> null (never falls back to an older day)');

// ---- trend ----
{
  eq(S.trend([]).direction, 'unknown', 'trend: empty -> unknown');
  eq(S.trend([{ dayMs: d(0), agreementRate: 0.9 }]).direction, 'unknown', 'trend: one day -> unknown');
  const up = S.trend([
    { dayMs: d(3), agreementRate: 0.80 }, { dayMs: d(2), agreementRate: 0.82 },
    { dayMs: d(1), agreementRate: 0.95 }, { dayMs: d(0), agreementRate: 0.99 },
  ]);
  eq(up.direction, 'improving', 'trend: rising agreement -> improving');
  ok(up.delta > 0, 'trend: positive delta when improving');
  const down = S.trend([
    { dayMs: d(3), agreementRate: 0.99 }, { dayMs: d(2), agreementRate: 0.98 },
    { dayMs: d(1), agreementRate: 0.80 }, { dayMs: d(0), agreementRate: 0.79 },
  ]);
  eq(down.direction, 'worsening', 'trend: falling agreement -> worsening');
  const flat = S.trend([
    { dayMs: d(3), agreementRate: 0.90 }, { dayMs: d(2), agreementRate: 0.9005 },
    { dayMs: d(1), agreementRate: 0.90 }, { dayMs: d(0), agreementRate: 0.9002 },
  ]);
  eq(flat.direction, 'flat', 'trend: sub-epsilon change -> flat');
}

// ---- assemble: MEASURES here, DELEGATES the decision to cutover (one definition) ----
{
  // A perfect, settled investor: 14 clean days at 100% agreement, no open findings.
  const cleanRuns = [];
  for (let i = 0; i < 14; i += 1) cleanRuns.push({ dayMs: d(i), agreementRate: 1, findingKeys: [] });
  const clean = S.assemble(cleanRuns, [], { nowMs: NOW, settings: { minCleanDays: 14, requireCanaryPerfect: true } });
  near(clean.scoreboard.canaryAgreementRate, 1, 'assemble: canary rate carried through');
  eq(clean.scoreboard.openFindings, 0, 'assemble: no open findings');
  eq(clean.scoreboard.consecutiveCleanDays, 14, 'assemble: 14 consecutive clean days');
  eq(clean.eligible.eligible, true, 'assemble: clean 14-day investor is eligible for live');

  // The SAME scoreboard fed straight to cutover must agree — proves we delegate, not re-implement.
  const direct = cutover.eligibleForLive(clean.scoreboard, { minCleanDays: 14, requireCanaryPerfect: true });
  eq(direct.eligible, clean.eligible.eligible, 'assemble: eligibility matches cutover.eligibleForLive exactly');

  // An open finding blocks, whatever the canary says.
  const blocked = S.assemble(cleanRuns, [{ status: 'open', firstSeenMs: d(3) }], { nowMs: NOW, settings: { minCleanDays: 14 } });
  eq(blocked.eligible.eligible, false, 'assemble: an open finding blocks promotion');
  ok(blocked.scoreboard.oldestOpenFindingDays >= 3, 'assemble: oldest-open-finding age measured from the ledger');

  // A recent disagreement breaks the clean streak -> not eligible.
  const dirty = cleanRuns.slice();
  dirty[0] = { dayMs: d(0), agreementRate: 0.9, findingKeys: ['z'] }; // today has a new finding
  const notClean = S.assemble(dirty, [], { nowMs: NOW, settings: { minCleanDays: 14 } });
  eq(notClean.scoreboard.consecutiveCleanDays, 0, 'assemble: a new finding today zeroes the streak');
  eq(notClean.eligible.eligible, false, 'assemble: broken streak -> not eligible');
  eq(notClean.trend.direction, 'worsening', 'assemble: trend surfaces the dip');

  // §10.6 threaded end to end: the latest run's summary counts reach the gate.
  const incRuns = [];
  for (let i = 0; i < 14; i += 1) {
    incRuns.push({ dayMs: d(i), agreementRate: 1, findingKeys: [], summary: { comparable: 300, incomparable: i === 0 ? 2 : 0 } });
  }
  const inc = S.assemble(incRuns, [], { nowMs: NOW, settings: { minCleanDays: 14 } });
  eq(inc.scoreboard.canaryScenarioCount, 300, 'assemble: latest run comparable count reaches the scoreboard');
  eq(inc.scoreboard.canaryIncomparable, 2, 'assemble: latest run incomparable count reaches the scoreboard');
  eq(inc.eligible.eligible, false, 'assemble: an incomparable scenario blocks promotion end to end');

  // §10.5 coverage floor threaded end to end.
  const thinRuns = [];
  for (let i = 0; i < 14; i += 1) thinRuns.push({ dayMs: d(i), agreementRate: 1, findingKeys: [], summary: { comparable: 8, incomparable: 0 } });
  const thin = S.assemble(thinRuns, [], { nowMs: NOW, settings: { minCleanDays: 14, minCanaryScenarios: 200 } });
  eq(thin.eligible.eligible, false, 'assemble: a thin canary (8 scenarios) fails the coverage floor');
}

console.log(`ok - lt ppe scoreboard (${n} assertions)`);
