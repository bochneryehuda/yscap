#!/usr/bin/env node
'use strict';
/**
 * LT PPE - "HOW MUCH DID WE COMPARE" MUST BE ONE NUMBER.
 *
 * OFFLINE: pure. No database, no vendor call.
 *
 * WHAT WAS WRONG, MEASURED 2026-08-18. Two readers of the same run summary computed the same idea
 * differently:
 *
 *   - `canary.verdictOf` subtracts the engine ERRORS - its whole job is to refuse to call a run proof,
 *     and a scenario where an engine THREW proves neither agreement nor disagreement;
 *   - `scoreboard.assemble` handed the go-live gate the RAW `comparable` as `canaryScenarioCount` -
 *     which §2.73 turned into a real coverage FLOOR on promotion.
 *
 * On a ten-scenario run with four engine errors that is `compared: 6` on the verdict and `coverage: 10`
 * to the gate, about the same ten scenarios - and `cutover.js` documented the field as "how much the
 * latest canary actually COMPARED".
 *
 * IT IS BELT-AND-BRACES TODAY, AND THAT IS STATED RATHER THAN IMPLIED: an error also drags the
 * agreement rate below 1, and `requireCanaryPerfect` refuses on that first, so no promotion could
 * actually turn on the difference. Section D proves that redundancy rather than assuming it. What is
 * fixed is that the word has ONE definition, so the day somebody relaxes the rate the coverage floor
 * still means what its own name says.
 */
const path = require('path');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const parity = require(path.join(PPE, 'parity'));
const shadow = require(path.join(PPE, 'shadow'));
const canary = require(path.join(PPE, 'canary'));
const scoreboard = require(path.join(PPE, 'scoreboard'));
const cutover = require(path.join(PPE, 'cutover'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---------------------------------------------------------------------------
// A - THE DEFINITION.
// ---------------------------------------------------------------------------
{
  eq(parity.comparedOf({ comparable: 10, errors: 4 }), 6, 'A1 compared is what was comparable LESS the scenarios an engine threw on');
  eq(parity.comparedOf({ comparable: 10 }), 10, 'A2 a run with no errors compared everything comparable');
  eq(parity.comparedOf({ comparable: 3, errors: 9 }), 0, 'A3 more errors than comparable never goes negative');
  eq(parity.comparedOf({}), 0, 'A4 a summary with neither field compared nothing');
  for (const junk of [null, undefined, 'nope', 7, [], { comparable: 'x', errors: {} }]) {
    eq(parity.comparedOf(junk), 0, `A5 junk (${JSON.stringify(junk)}) reads as nothing compared, and never throws`);
  }
}

// ---------------------------------------------------------------------------
// B - BOTH READERS AGREE, through a REAL run rather than a hand-built summary.
// ---------------------------------------------------------------------------
{
  const scen = Array.from({ length: 10 }, (_, i) => ({ _label: `s${i}` }));
  const ours = async (s) => {
    if (Number(s._label.slice(1)) < 4) throw new Error('boom: our engine threw');
    return { eligible: true, ladder: [{ rate: 7.5, finalPriceMilli: 101000 }] };
  };
  const theirs = async () => ({ eligible: true, rungs: [{ rate: 7.5, priceMilli: 101000 }] });

  shadow.runShadow(scen, { ours, theirs }, {}).then((r) => {
    eq(r.summary.errors, 4, 'B1 the run really did fail on four scenarios');
    eq(r.summary.comparable, 10, 'B2 ...and `comparable` counts them, because an engine error lands in `disagreed`');

    const verdict = canary.verdictOf(r.summary);
    eq(verdict.compared, 6, 'B3 the canary\'s verdict says six were compared');

    const board = scoreboard.assemble(
      [{ dayMs: 0, agreementRate: r.summary.agreementRate, findingKeys: [], summary: r.summary }], [], { nowMs: 0 },
    );
    eq(board.scoreboard.canaryScenarioCount, verdict.compared,
      'B4 AND THE GO-LIVE GATE READS THE SAME NUMBER - it used to be handed the raw 10 as proof');

    // "not measured" and "measured nothing" must stay different answers.
    const none = scoreboard.assemble([{ dayMs: 0, agreementRate: null, findingKeys: [] }], [], { nowMs: 0 });
    eq(none.scoreboard.canaryScenarioCount, null,
      'B5 a run with no summary at all reports null coverage, never 0 - one is "nobody measured", the other is "measured nothing"');

    sectionC();
    sectionD(r);
    report();
  }).catch((e) => { failures.push(`B threw: ${e && e.stack ? e.stack : e}`); report(); });
}

// ---------------------------------------------------------------------------
// C - THE FLOOR IS MEASURED ON PROOF, NOT ON ATTEMPTS.
// ---------------------------------------------------------------------------
function sectionC() {
  const GATE = cutover.settingsToGate({});
  const DAY = 86400000;
  const days = (n) => { const out = []; for (let i = 0; i < n; i += 1) out.push({ dayMs: i * DAY, count: 0 }); return out; };
  const boardFor = (summary) => cutover.buildScoreboard({
    canaryAgreementRate: 1,
    findings: [],
    dailyNewFindings: days(GATE.minCleanDays),
    nowMs: GATE.minCleanDays * DAY,
    canaryScenarioCount: parity.comparedOf(summary),
    canaryIncomparable: 0,
  });

  // Exactly at the floor once the errors are taken off: eligible.
  const clean = boardFor({ comparable: GATE.minCanaryScenarios, errors: 0 });
  ok(cutover.eligibleForLive(clean, GATE).eligible, 'C1 a battery that really compared the floor may go live');

  // The SAME `comparable`, with errors: it is short of the floor and must be refused.
  const errored = boardFor({ comparable: GATE.minCanaryScenarios, errors: 5 });
  const v = cutover.eligibleForLive(errored, GATE);
  ok(!v.eligible && v.reasons.some((r) => /canary scenario/.test(r)),
    'C2 the same battery with five engine errors is five short of the floor and is refused - errored scenarios are not proof');
}

// ---------------------------------------------------------------------------
// D - THE REDUNDANCY, PROVEN RATHER THAN ASSUMED. Today an error also drags the agreement rate, and
//     the perfect-rate gate refuses first. Stating that a guard is belt-and-braces is only honest if
//     the belt is checked.
// ---------------------------------------------------------------------------
function sectionD(run) {
  ok(run.summary.agreementRate < 1,
    'D1 an engine error drags the agreement rate below 100% - which is what makes the coverage fix belt-and-braces today');
  const GATE = cutover.settingsToGate({});
  eq(GATE.requireCanaryPerfect, true, 'D2 ...and the gate the route runs always demands 100%, so the rate refuses first');
  // ...but the coverage floor must stand on its own the moment somebody relaxes the rate.
  const relaxed = cutover.eligibleForLive({
    canaryAgreementRate: run.summary.agreementRate,
    openFindings: 0,
    consecutiveCleanDays: GATE.minCleanDays,
    canaryScenarioCount: parity.comparedOf(run.summary),
    canaryIncomparable: 0,
  }, { ...GATE, requireCanaryPerfect: false });
  ok(!relaxed.eligible && relaxed.reasons.some((r) => /canary scenario/.test(r)),
    'D3 with the rate gate relaxed the COVERAGE floor still refuses on its own - the belt no longer depends on the braces');
}

function report() {
  console.log(failures.length
    ? `FAIL - lt ppe compared definition (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe compared definition (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}
