#!/usr/bin/env node
'use strict';
/**
 * §2.126b — THE GO-LIVE GATE READ RUNS THE CODEBASE ALREADY KNEW IT COULD NOT READ.
 *
 * §2.122a built the reader. The canary's own leg used to hand our engine the RAW Lender Price scenario,
 * so it saw none of the deal's derived facts and declined all 305 — every agreement rate it recorded is
 * a number, not a measurement. `runIsReadable` and `partitionReadable` were written to say so, and
 * `run-store.rowToRunRecord` stamps `readable` on every record it builds.
 *
 * NOTHING IN PRODUCTION EVER CALLED IT. Measured, 2026-08-19:
 *
 *     const runs = 60 perfect days, none of them stamped
 *     runStore.partitionReadable(runs)  ->  readable 0 | unreadable 60 | allReadable false
 *     scoreboard.assemble(runs, ...)    ->  agreementRate 1, compared 305, cleanDays 60
 *     cutover.eligibleForLive(...)      ->  { eligible: true, reasons: [] }
 *
 * Take this investor live, nothing standing in the way — off sixty runs this system itself classifies
 * as unreadable. The recognition existed and never reached the one decision it was built for, which is
 * a different failure from the ones either side of it (§2.126, §2.126a): not a missing measurement, a
 * guard nobody wired.
 *
 * PURE: no DB, no clock. The DB half — the stamp surviving a round trip through jsonb — is proven in
 * scripts/test-lt-ppe-run-store-db.js against a real Postgres.
 */

const assert = require('assert');
const scoreboard = require('../src/longterm/ppe/scoreboard');
const cutover = require('../src/longterm/ppe/cutover');
const runStore = require('../src/longterm/ppe/run-store');
const prov = require('../src/longterm/ppe/agreement-provenance');

let n = 0;
function ok(c, m) { assert.ok(c, m); n += 1; }
function eq(a, b, m) { assert.strictEqual(a, b, m); n += 1; }

const DAY = 86400000;
const NOW = 1755000000000;
const PERFECT = { total: 305, scenarios: 305, comparable: 305, agreed: 305, disagreed: 0, errors: 0, overlay: 0, incomparable: 0 };

// A stored run as `run-store.rowToRunRecord` would hand it over — through the real mapper, so the
// `readable` flag is computed the way production computes it and not asserted into existence here.
function storedRun(daysAgo, stamped) {
  return runStore.rowToRunRecord({
    day_ms: String(NOW - daysAgo * DAY),
    agreement_rate: '1',
    finding_keys: [],
    summary: stamped ? { ...PERFECT, provenance: { legVersion: prov.LEG_VERSION } } : { ...PERFECT },
  });
}
const series = (count, stamped) => {
  const out = [];
  for (let i = count; i >= 1; i -= 1) out.push(storedRun(i, typeof stamped === 'function' ? stamped(i) : stamped));
  return out;
};

// ---- A. the defect, reproduced exactly as it was measured ------------------
{
  const runs = series(60, false);
  const part = runStore.partitionReadable(runs);
  eq(part.readable.length, 0, 'A1 this codebase classifies all sixty of these runs as unreadable');
  eq(part.unreadable.length, 60, 'A2 …every one of them');

  const out = scoreboard.assemble(runs, [], { settings: {}, nowMs: NOW });
  eq(out.scoreboard.canaryAgreementRate, null,
    'A3 the board states NO agreement rate — before this it read a confident 1.00');
  eq(out.scoreboard.canaryScenarioCount, null, 'A4 …and no coverage, where it read 305');
  eq(out.scoreboard.consecutiveCleanDays, 0, 'A5 …and no clean-day streak, where it read 60');
  eq(out.eligible.eligible, false,
    'A6 THE VERDICT: not eligible. Before this it was `{ eligible: true, reasons: [] }`');

  const reasons = out.eligible.reasons.join(' | ');
  ok(/no canary run that can be READ/.test(reasons),
    'A7 the refusal says the runs cannot be READ — not that none were run');
  ok(/60 stored run\(s\)/.test(reasons), 'A8 …and how many there are');
  ok(/run the check again/.test(reasons),
    'A9 …and names the remedy, which is the point: "no canary run has proven 100% agreement" sent a '
    + 'reader with sixty runs behind them off to run a sixty-first');

  eq(out.runsReadable, 0, 'A10 the assembly reports the census…');
  eq(out.runsUnreadable, 60, 'A11 …both halves of it');
  eq(out.scoreboard.canaryRunsUnreadable, 60, 'A12 …and it reaches the board the gate reads');
}

// ---- B. a readable series is untouched — this must not tighten by accident --
{
  const out = scoreboard.assemble(series(60, true), [], { settings: {}, nowMs: NOW });
  eq(out.scoreboard.canaryAgreementRate, 1, 'B1 a stamped series still reports its rate');
  eq(out.scoreboard.canaryScenarioCount, 305, 'B2 …its coverage');
  eq(out.scoreboard.consecutiveCleanDays, 60, 'B3 …and its full clean-day streak');
  eq(out.eligible.eligible, true, 'B4 …and still promotes, with no reasons');
  eq(out.eligible.reasons.length, 0, 'B5 …none at all');
  eq(out.scoreboard.canaryRunsUnreadable, 0, 'B6 nothing was set aside');
}

// ---- C. an unreadable day BREAKS the streak; it is not simply skipped ------
{
  // ⛔ THE TRAP THIS EXISTS FOR. `consecutiveCleanDays` walks the entries it is GIVEN, so a caller that
  // merely dropped an unreadable day would JOIN the clean stretches either side of it into one longer
  // streak — the wrong direction, and invisible on every screen. Day 30 is the only unreadable one, so
  // the trailing streak must stop at 29.
  const out = scoreboard.assemble(series(60, (i) => i !== 30), [], { settings: {}, nowMs: NOW });
  eq(out.scoreboard.consecutiveCleanDays, 29,
    'C1 the streak stops at the unreadable day — it does not bridge to 59');
  eq(out.runsUnreadable, 1, 'C2 …and the one set-aside run is counted');
  eq(out.scoreboard.canaryAgreementRate, 1,
    'C3 the rate still comes from the newest READABLE run, which exists here');

  // C3a — A DAY THAT HOLDS BOTH KINDS OF RUN. The daily check runs SIX times a day (7/9/10/11/12/4pm
  // ET), so the day an engine change lands genuinely carries readable and unreadable runs together.
  // That day still appears in the series — a readable run put it there — so marking it is the ONLY
  // thing that can stop it counting as clean. Nothing else in this file could see that: on a day with
  // no readable run at all the day is absent from the series and gets its break from the other path.
  const mixedDay = series(10, true);
  mixedDay.push(runStore.rowToRunRecord({
    day_ms: String(NOW - 5 * DAY + 3600000), // same day, three hours later, unstamped
    agreement_rate: '1', finding_keys: [], summary: { ...PERFECT },
  }));
  const mixedOut = scoreboard.assemble(mixedDay, [], { settings: {}, nowMs: NOW });
  eq(mixedOut.runsUnreadable, 1, 'C3a the one unreadable run of that day is set aside');
  eq(mixedOut.scoreboard.consecutiveCleanDays, 4,
    'C3b …and the day it landed on stops the streak, even though a readable run kept the day in the series');

  // C4 — the same shape asked of the gate helper directly, so the rule is pinned where it lives.
  const daily = [{ dayMs: 3, count: 0 }, { dayMs: 2, count: 0, readable: false }, { dayMs: 1, count: 0 }];
  eq(cutover.buildScoreboard({ dailyNewFindings: daily, nowMs: NOW }).consecutiveCleanDays, 1,
    'C4 an explicit readable:false breaks the run, wherever it comes from');
  // …and a caller that knows nothing about readability behaves exactly as it always did.
  const plain = [{ dayMs: 3, count: 0 }, { dayMs: 2, count: 0 }, { dayMs: 1, count: 0 }];
  eq(cutover.buildScoreboard({ dailyNewFindings: plain, nowMs: NOW }).consecutiveCleanDays, 3,
    'C5 …while an entry with no readability field counts exactly as before');
}

// ---- D. nobody has measured this investor vs everything is unreadable ------
{
  // Two situations behind the same null rate, needing opposite actions. The old sentence covered both
  // and pointed at the first.
  const empty = scoreboard.assemble([], [], { settings: {}, nowMs: NOW });
  const reasons = empty.eligible.reasons.join(' | ');
  ok(/no canary run has proven 100% agreement/.test(reasons),
    'D1 with NO runs at all the message is unchanged — go and run one');
  ok(!/cannot be READ|can be READ/.test(reasons), 'D2 …and says nothing about readability, because there is nothing to read');
  eq(empty.runsUnreadable, 0, 'D3 …and sets nothing aside');
}

// ---- E. ONE definition of readable, asked two ways -------------------------
{
  // `scoreboard.assemble` cannot require `run-store` (that module requires the scoreboard), so the
  // adapter lives in `agreement-provenance` beside the predicate. If these two ever disagreed, the
  // board and the store would report different series and nobody could reconcile them.
  const stamped = storedRun(1, true);
  const bare = storedRun(1, false);
  eq(prov.recordIsReadable(stamped), true, 'E1 a stamped record reads as readable');
  eq(prov.recordIsReadable(bare), false, 'E2 …and an unstamped one does not');
  eq(prov.recordIsReadable(null), false, 'E3 …nor does nothing at all');
  // A record the store never built — a canary in flight, a fixture — has no `readable` flag, so the
  // adapter must fall through to the predicate rather than treating "absent" as true.
  eq(prov.recordIsReadable({ summary: { provenance: { legVersion: prov.LEG_VERSION } } }), true,
    'E4 a hand-built record with no flag is answered from its summary');
  eq(prov.recordIsReadable({ summary: { total: 1 } }), false, 'E5 …and an unstamped one is refused');
  eq(prov.recordIsReadable({ readable: false, summary: { provenance: { legVersion: prov.LEG_VERSION } } }), false,
    'E6 an explicit flag wins — the store already decided, and it decides once');
  eq(runStore.partitionReadable([stamped, bare]).readable.length, 1,
    'E7 the store\'s own split runs through the SAME adapter, so the two can never disagree');
}

console.log(`ok - lt ppe the go-live gate reads only runs it can read (${n} assertions)`);
