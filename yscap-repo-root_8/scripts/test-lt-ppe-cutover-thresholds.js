#!/usr/bin/env node
'use strict';
/**
 * LT PPE - THE GO-LIVE GATE MUST RUN THE NUMBERS A SUPER ADMIN CAN SET.
 *
 * OFFLINE: pure. No database, no vendor call.
 *
 * WHAT WAS WRONG, MEASURED 2026-08-18. `cutover.eligibleForLive` was called from the route with NO
 * settings, so it ran its own signature defaults:
 *
 *   - **14 clean days**, while the settings registry carried `cutover.clean_weeks_required` at **8
 *     weeks** - on the Cutover screen, editable by a super admin, and read by NOTHING. The dial the
 *     screen showed was connected to nothing and the gate ran a quarter of it. The owner's answer about
 *     taking an investor live was that the number belongs in the super admin; the setting was built and
 *     never plugged in.
 *   - **no coverage floor at all** (`minCanaryScenarios` defaults to 0 and nobody set it), while
 *     PUBLISHING a rate sheet demands agreement over `MIN_COMPARABLE_SCENARIOS` comparable scenarios.
 *     So an investor could be promoted to LIVE - our engine, not Lender Price, answering a borrower -
 *     on a canary that compared ONE scenario. **The bigger decision demanded less proof than the
 *     smaller one.**
 *
 * And the units are the other half: the SETTING is in WEEKS, the GATE counts DAYS. Two individually
 * correct halves; the defect lived in the join.
 *
 * NOTHING HERE INVENTS A BUSINESS RULE. The clean-week count stays the owner's - this only makes the
 * gate read the dial. The coverage floor is the owner's OWN "measured enough" number applied to a
 * strictly bigger decision, stated as an assumption in `source` and recorded in the open questions.
 */
const path = require('path');
const fs = require('fs');

const LT = path.join(__dirname, '..', 'src', 'longterm');
const PPE = path.join(LT, 'ppe');
const cutover = require(path.join(PPE, 'cutover'));
const ppeSettings = require(path.join(PPE, 'settings'));
const agreementStore = require(path.join(PPE, 'agreement-store'));
const scoreboard = require(path.join(PPE, 'scoreboard'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const KEY = cutover.SETTING_CLEAN_WEEKS;
const DEF = ppeSettings.getDefinition(KEY);

// ---------------------------------------------------------------------------
// A - THE MAPPING, and the UNITS.
// ---------------------------------------------------------------------------
{
  ok(DEF && Number.isFinite(DEF.default), `A1 the clean-weeks setting exists in the registry (${KEY})`);

  const fromDefault = cutover.settingsToGate({});
  // Derived from the registry, never a literal: the owner may change the number and this test must
  // still be about the CONVERSION, not about the value of the day.
  eq(fromDefault.minCleanDays, DEF.default * 7,
    'A2 the gate counts DAYS and the setting is in WEEKS - the conversion is x7, not the raw number');
  ok(fromDefault.minCleanDays !== DEF.default,
    'A3 ...so a weeks value is never handed to the gate as if it were days (the join this defect lived in)');

  const set = cutover.settingsToGate({ [KEY]: 3 });
  eq(set.minCleanDays, 21, 'A4 a super admin setting 3 weeks gets 21 clean days');
  eq(set.source.cleanWeeks, 'settings', 'A5 ...and the answer says it came from the settings');
  eq(fromDefault.source.cleanWeeks, 'registry-default', 'A6 an unset value says so too, rather than reading as configured');
}

// ---------------------------------------------------------------------------
// B - IT FAILS CLOSED. A number that cannot be read can only ever make the gate HARDER.
// ---------------------------------------------------------------------------
{
  const strict = cutover.settingsToGate({}).minCleanDays;
  for (const junk of [null, undefined, 0, -4, '6', NaN, {}, [], Infinity]) {
    const g = cutover.settingsToGate({ [KEY]: junk });
    ok(g.minCleanDays >= strict,
      `B1 an unusable clean-weeks value (${JSON.stringify(junk)}) falls back to the stricter registry number - never to zero, which would mean "no clean days required"`);
  }
  let threw = false;
  for (const bad of [null, undefined, 'nope', 7, []]) {
    try { cutover.settingsToGate(bad); } catch (_) { threw = true; }
  }
  ok(!threw, 'B2 a malformed settings map never throws - this sits on the path a screen and a promote both take');
}

// ---------------------------------------------------------------------------
// C - THE COVERAGE FLOOR IS THE PUBLISH GATE'S OWN NUMBER, not a second one.
// ---------------------------------------------------------------------------
{
  const g = cutover.settingsToGate({});
  eq(g.minCanaryScenarios, agreementStore.MIN_COMPARABLE_SCENARIOS,
    'C1 the promote floor IS the "measured enough" bar a rate sheet must clear - one definition, not a second copy');
  ok(g.minCanaryScenarios > 1,
    'C2 ...and it is a real floor: a canary that compared one scenario can never satisfy it');
  eq(g.requireCanaryPerfect, true, 'C3 100% agreement is still required');
  ok(/assumption/i.test(g.source.minCanaryScenarios),
    'C4 the floor SAYS it is an assumption pending the owner, rather than presenting itself as settled policy');
}

// ---------------------------------------------------------------------------
// D - THE GATE END TO END. This is what the defect actually cost.
// ---------------------------------------------------------------------------
{
  const DAY = 86400000;
  const days = (n) => { const out = []; for (let i = 0; i < n; i += 1) out.push({ dayMs: i * DAY, count: 0 }); return out; };
  const board = (scenarios, cleanDays) => cutover.buildScoreboard({
    canaryAgreementRate: 1,
    findings: [],
    dailyNewFindings: days(cleanDays),
    nowMs: cleanDays * DAY,
    canaryScenarioCount: scenarios,
    canaryIncomparable: 0,
  });
  const gs = cutover.settingsToGate({});
  const enough = gs.minCanaryScenarios;
  const cleanEnough = gs.minCleanDays;

  const thin = cutover.eligibleForLive(board(1, cleanEnough), gs);
  ok(!thin.eligible,
    'D1 AN INVESTOR IS NOT PROMOTED ON A ONE-SCENARIO CANARY, however perfect and however many clean days');
  ok(thin.reasons.some((r) => /canary scenario/.test(r)), 'D2 ...and the refusal names the coverage');

  const tooSoon = cutover.eligibleForLive(board(enough, 20), gs);
  ok(!tooSoon.eligible,
    'D3 twenty clean days is no longer enough - the gate runs the configured weeks, not its old 14-day default');
  ok(tooSoon.reasons.some((r) => /consecutive clean day/.test(r)), 'D4 ...and says how many it wants');

  const ready = cutover.eligibleForLive(board(enough, cleanEnough), gs);
  ok(ready.eligible,
    `D5 a fully proven investor still goes live (refused for: ${ready.reasons.join('; ') || 'nothing'})`);

  // A super admin who lowers the setting genuinely lowers the bar - the dial is connected.
  const relaxed = cutover.settingsToGate({ [KEY]: 3 });
  ok(cutover.eligibleForLive(board(enough, 21), relaxed).eligible,
    'D6 lowering the setting to 3 weeks really does let a 21-day-clean investor through - the dial is wired, not decorative');
  ok(!cutover.eligibleForLive(board(enough, 21), gs).eligible,
    'D7 ...and the same investor is refused under the unchanged setting');
}

// ---------------------------------------------------------------------------
// E - WHAT COUNTS AS COVERAGE IS WHAT WAS COMPARED, not what was attempted.
// ---------------------------------------------------------------------------
{
  const runs = [{
    dayMs: 0,
    agreementRate: 1,
    findingKeys: [],
    // 210 scenarios ran; 8 could not be compared and 2 were reasoned overrides (§2.72), so 200 were
    // actually measured against Lender Price.
    // §2.126b — a stamped summary, because the board sets aside runs it cannot read and this fixture
    // stands for a run today's engine took.
    summary: { scenarios: 210, agreed: 200, disagreed: 0, overlay: 2, incomparable: 8, comparable: 200, errors: 0, agreementRate: 1,
      provenance: { legVersion: require('../src/longterm/ppe/agreement-provenance').LEG_VERSION } },
  }];
  const out = scoreboard.assemble(runs, [], { nowMs: 0, settings: cutover.settingsToGate({}) });
  eq(out.scoreboard.canaryScenarioCount, 200,
    'E1 the coverage the gate reads is the COMPARABLE count - a battery of 210 where 10 were never compared is 200 of proof');
  eq(out.scoreboard.canaryIncomparable, 8, 'E2 ...and what could not be compared is carried beside it');
}

// ---------------------------------------------------------------------------
// F - NOBODY CALLS THE GATE WITHOUT THRESHOLDS AGAIN. A source guard, because no unit test of the pure
//     module can see that its one production caller passed nothing.
// ---------------------------------------------------------------------------
{
  const callers = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      if (p === path.join(PPE, 'cutover.js')) continue;          // the definition itself
      const src = fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/\beligibleForLive\s*\(/.test(src)) callers.push([p, src]);
    }
  };
  walk(LT);
  ok(callers.length > 0, 'F1 the gate has production callers to check');

  // ⛔ THE ARGUMENT TEXT IS SCANNED WITH BALANCED PARENTHESES, NOT A REGEX. A lazy
  // `eligibleForLive\(([\s\S]*?)\);` stops at the first `);` in the file, which on the real call site
  // -- `gate: cutover.eligibleForLive(board, gateSettings),` -- is hundreds of characters further on
  // inside some other statement, so it "reads" an argument list that was never one. That is the same
  // over-loose matching this repo keeps being bitten by, and it was caught here by making the parser
  // prove its own balance.
  const argsAt = (src, from) => {
    let d = 0;
    for (let i = from; i < src.length; i += 1) {
      const c = src[i];
      if ('([{'.includes(c)) d += 1;
      else if (')]}'.includes(c)) { d -= 1; if (d === 0) return src.slice(from + 1, i); }
    }
    return null;                                     // unbalanced: report rather than guess
  };
  const topLevelSplit = (args) => {
    const out = []; let d = 0; let start = 0;
    for (let i = 0; i < args.length; i += 1) {
      const c = args[i];
      if ('([{'.includes(c)) d += 1;
      else if (')]}'.includes(c)) d -= 1;
      else if (c === ',' && d === 0) { out.push(args.slice(start, i)); start = i + 1; }
    }
    out.push(args.slice(start));
    return out.map((x) => x.trim()).filter((x) => x.length);
  };

  let calls = 0;
  for (const [p, src] of callers) {
    const rel = path.relative(LT, p);
    let idx = src.indexOf('eligibleForLive(');
    while (idx !== -1) {
      calls += 1;
      const args = argsAt(src, idx + 'eligibleForLive'.length);
      ok(args !== null, `F2b ${rel} the call's argument list was parsed cleanly (balanced)`);
      // The thresholds are the SECOND argument. A call with one argument runs the signature defaults -
      // 14 days and no coverage floor - which is exactly the defect.
      const parts = args === null ? [] : topLevelSplit(args);
      ok(parts.length >= 2,
        `F2 ${rel} passes the thresholds to eligibleForLive - a one-argument call silently runs 14 days and NO coverage floor`);
      idx = src.indexOf('eligibleForLive(', idx + 1);
    }
  }
  ok(calls > 0, 'F3 the call sites were actually found and inspected - a regex that matched nothing would pass every check above');
}

// ---------------------------------------------------------------------------
// G - NO CUTOVER SETTING IS A DIAL CONNECTED TO NOTHING. That was the whole defect, and the next one
//     added would repeat it silently.
// ---------------------------------------------------------------------------
{
  const cutoverKeys = ppeSettings.allDefinitions().filter((d) => d.group === 'Cutover').map((d) => d.key);
  ok(cutoverKeys.length > 0, 'G1 there are Cutover settings to check');

  const sources = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      if (p === path.join(PPE, 'settings.js')) continue;          // the registry declares them
      sources.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(LT);
  const all = sources.join('\n');
  for (const key of cutoverKeys) {
    ok(all.includes(`'${key}'`) || all.includes(`"${key}"`),
      `G2 the Cutover setting ${key} is READ by something - a dial on a screen that reaches no gate is worse than no dial, because it reads as policy`);
  }
}

// ---------------------------------------------------------------------------
// H - FORGETTING THE THRESHOLDS CANNOT LOOSEN THE GATE. The source guard in F catches a caller that
//     forgets; this is why it does not matter if one slips through anyway.
// ---------------------------------------------------------------------------
{
  const DAY = 86400000;
  const gs = cutover.settingsToGate({});
  const days = (n) => { const out = []; for (let i = 0; i < n; i += 1) out.push({ dayMs: i * DAY, count: 0 }); return out; };
  const proven = cutover.buildScoreboard({
    canaryAgreementRate: 1, findings: [], dailyNewFindings: days(gs.minCleanDays),
    nowMs: gs.minCleanDays * DAY, canaryScenarioCount: gs.minCanaryScenarios, canaryIncomparable: 0,
  });
  // EACH HALF IS ISOLATED. A fixture that is short on BOTH is refused either way, so it would pass
  // this section with the coverage floor mutated back to zero — which is what the first cut did.
  const thinCoverage = cutover.buildScoreboard({
    canaryAgreementRate: 1, findings: [], dailyNewFindings: days(gs.minCleanDays),
    nowMs: gs.minCleanDays * DAY, canaryScenarioCount: 1, canaryIncomparable: 0,
  });
  const shortStreak = cutover.buildScoreboard({
    canaryAgreementRate: 1, findings: [], dailyNewFindings: days(14),
    nowMs: 14 * DAY, canaryScenarioCount: gs.minCanaryScenarios, canaryIncomparable: 0,
  });
  ok(cutover.eligibleForLive(proven).eligible === cutover.eligibleForLive(proven, gs).eligible,
    'H1 the gate called with NO settings answers exactly as it does with the configured ones');
  const c = cutover.eligibleForLive(thinCoverage);
  ok(!c.eligible && c.reasons.some((r) => /canary scenario/.test(r)),
    'H2 ...a caller that forgets them still cannot promote on a one-scenario canary - the missing coverage floor is gone');
  const d = cutover.eligibleForLive(shortStreak);
  ok(!d.eligible && d.reasons.some((r) => /consecutive clean day/.test(r)),
    'H3 ...nor on the old 14-day streak - the permissive clean-day default is gone too');
}

console.log(failures.length
  ? `FAIL - lt ppe cutover thresholds (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
  : `ok - lt ppe cutover thresholds (${pass} assertions)`);
process.exit(failures.length ? 1 : 0);
