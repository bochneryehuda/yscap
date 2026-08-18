#!/usr/bin/env node
'use strict';
/**
 * LT PPE - A REASONED OVERRIDE MUST NOT HOLD THE GO-LIVE GATE SHUT.
 *
 * OFFLINE: pure. No database, no vendor call - the canary runs against stub engines.
 *
 * THE OWNER'S RULE (D29) IS THAT OUR ENGINE MAY DECLINE A SCENARIO LENDER PRICE PRICES, on a fact LP
 * cannot see, WITH a stated reason. `parity.js` has said since it was written that such a divergence is
 * "scored separately (never counted as agreement, never counted as a mismatch)".
 *
 * NOTHING ENFORCED THAT SENTENCE, and the cost was not cosmetic. Measured 2026-08-18, an override:
 *
 *   1. landed in `summarize().disagreed` and dragged the agreement rate (nine agreeing scenarios plus
 *      ONE override reported 0.9) - and `cutover.eligibleForLive` demands 100% under
 *      `requireCanaryPerfect`;
 *   2. was born `open` in the findings ledger - and the gate refuses while ONE finding is open;
 *   3. counted as a NEW finding the day it first appeared - and the gate wants 14 consecutive days
 *      with none.
 *
 * THREE INDEPENDENT GATES, ALL TRIPPED BY THE BEHAVIOUR WORKING AS SPECIFIED, and none of them with a
 * remedy: you cannot "fix" a decline you deliberately hold. **A gate whose only remedy is to break the
 * correct behaviour is a dead end, not a gate** - the same class this repo has closed before (a refusal
 * that told staff to re-register a product which could not produce the state the refusal demanded).
 *
 * This suite pins all three, plus the one definition they now share.
 */
const path = require('path');
const fs = require('fs');

const PPE = path.join(__dirname, '..', 'src', 'longterm', 'ppe');
const parity = require(path.join(PPE, 'parity'));
const overlay = require(path.join(PPE, 'overlay'));
const finding = require(path.join(PPE, 'finding'));
const cutover = require(path.join(PPE, 'cutover'));
const scoreboard = require(path.join(PPE, 'scoreboard'));
const canary = require(path.join(PPE, 'canary'));

let pass = 0;
const failures = [];
function ok(cond, what) { if (cond) { pass += 1; return; } failures.push(what); }
const eq = (a, b, what) => ok(a === b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// Built with the REAL builder, so this suite cannot pass on a record the classifier would reject.
const OVERLAY_DECLINE = [overlay.overlayDecline('short_term_rental', 'Short-Term Rental - Max LTV 75%', { code: 'dhvn_str_max_ltv' })];
const REAL_DECLINE = [{ code: 'dhvn_min_fico', reason: 'FICO below the program minimum' }];

const OURS_INELIGIBLE = { eligible: false, ladder: [] };
const THEIRS_ELIGIBLE = { eligible: true, rungs: [{ rate: 7.5, priceMilli: 101000 }] };
const AGREED = { agree: true, findings: [] };

const overrideResult = () => parity.compareScenario(OURS_INELIGIBLE, THEIRS_ELIGIBLE, { ourDeclines: OVERLAY_DECLINE });
const defectResult = () => parity.compareScenario(OURS_INELIGIBLE, THEIRS_ELIGIBLE, { ourDeclines: REAL_DECLINE });

// ---------------------------------------------------------------------------
// A - THE SCOREBOARD. An override is a third bucket, out of the rate's denominator.
// ---------------------------------------------------------------------------
{
  const nine = [AGREED, AGREED, AGREED, AGREED, AGREED, AGREED, AGREED, AGREED, AGREED];
  const s = parity.summarize([...nine, overrideResult()]);
  eq(s.agreementRate, 1,
    'A1 nine agreeing scenarios and ONE reasoned override measure 100% - the override is not a mismatch');
  eq(s.disagreed, 0, 'A2 ...it is not counted as a disagreement');
  eq(s.agreed, 9, 'A3 ...and it is not counted as agreement either');
  eq(s.overlay, 1, 'A4 ...it is REPORTED in its own bucket, never silently dropped');
  eq(s.comparable, 9, 'A5 the rate is measured over the scenarios where both engines answered the same question');
  eq(s.scenarios, 10, 'A6 every scenario is still accounted for');
  eq(s.byKind[overlay.FINDING_KIND], 1, 'A7 the override still appears in the per-kind tally a reviewer reads');

  // THE CONTROL, and it is the assertion that stops this becoming a way to hide real defects.
  const real = parity.summarize([...nine, defectResult()]);
  eq(real.agreementRate, 0.9, 'A8 an ORDINARY eligibility disagreement still drags the rate - only a reasoned override is excused');
  eq(real.overlay, 0, 'A9 ...and is not filed as an override');

  // A battery that is ALL override has measured nothing about the sheet. `null` is the honest answer;
  // a perfect score over zero comparisons is the failure this whole file exists to prevent.
  const allOverride = parity.summarize([overrideResult(), overrideResult()]);
  eq(allOverride.agreementRate, null, 'A10 an all-override battery measures NO agreement rate - never a perfect score over nothing');
  eq(allOverride.overlay, 2, 'A11 ...and says how many overrides it was');
}

// ---------------------------------------------------------------------------
// B - THE CLASSIFICATION READS THE FINDING, not only a carried boolean.
// ---------------------------------------------------------------------------
{
  const r = overrideResult();
  ok(parity.isOverlayResult(r), 'B1 a live comparison result is recognised as an override');

  // A result that has been through a JSON store, or rebuilt field by field by a caller, can arrive with
  // the flag gone and the finding intact. The finding is the durable statement.
  const roundTripped = JSON.parse(JSON.stringify({ agree: r.agree, findings: r.findings }));
  ok(parity.isOverlayResult(roundTripped),
    'B2 ...and still is when the `overlay` flag was lost on the way through a store - the finding is what survives');
  eq(parity.summarize([AGREED, roundTripped]).agreementRate, 1,
    'B3 ...so a stored run does not start reporting its overrides as defects');

  ok(!parity.isOverlayResult(defectResult()), 'B4 a real eligibility mismatch is NOT an override');
  ok(!parity.isOverlayResult({ agree: true, findings: [] }), 'B5 an agreeing scenario is not an override');
  ok(!parity.isOverlayResult(null) && !parity.isOverlayResult(undefined), 'B6 junk is never an override');

  // An overlay verdict RETURNS IMMEDIATELY with exactly one finding, so a lone overlay finding is the
  // whole result. A hand-built result carrying an override AND a real disagreement is NOT excused -
  // otherwise one stated reason would bury every price defect on that scenario.
  ok(!parity.isOverlayResult({ agree: false, findings: [{ kind: overlay.FINDING_KIND }, { kind: 'price_mismatch', rate: 7.5 }] }),
    'B7 an override sitting beside a real finding does not excuse the scenario - a reason cannot bury a defect');
}

// ---------------------------------------------------------------------------
// C - THE LEDGER. An override is recorded, and it is not outstanding work.
// ---------------------------------------------------------------------------
{
  const recs = finding.recordsFromComparison(
    { findings: [...overrideResult().findings, { kind: 'price_mismatch', rate: 7.5, detail: 'off by 250' }] },
    { investor: 'deephaven', program: 'dscr', scenario: 'STR at 75 LTV', nowMs: 1000 },
  );
  const override = recs.find((r) => r.kind === overlay.FINDING_KIND);
  const defect = recs.find((r) => r.kind === 'price_mismatch');

  ok(override, 'C1 the override IS recorded - the review queue still shows every scenario we override');
  eq(override.status, 'wontfix', 'C2 ...born settled, because there is no fix for behaviour that is correct');
  eq(defect.status, 'open', 'C3 a real disagreement is still born open - nothing else moved');
  ok(finding.SETTLED_STATUSES.has(override.status) && !finding.OPEN_STATUSES.has(override.status),
    'C4 the status the override is born with is one the ledger genuinely treats as settled');

  // It recurs on every single run for as long as the scenario exists. It must never re-open, and it
  // must never be flagged `regressed` - a recurring override is expected, not a fix coming undone.
  const again = finding.recordsFromComparison({ findings: overrideResult().findings },
    { investor: 'deephaven', program: 'dscr', scenario: 'STR at 75 LTV', nowMs: 2000 });
  const merged = finding.mergeOne(override, again[0]);
  eq(merged.action, 'carried_wontfix', 'C5 a recurring override is carried forward, never reopened');
  eq(merged.record.status, 'wontfix', 'C6 ...keeping its settled status');
  ok(!merged.record.regressed, 'C7 ...and never flagged as a regression');
}

// ---------------------------------------------------------------------------
// D - THE GATE ITSELF, which is the whole point. An investor whose overrides work must be promotable.
// ---------------------------------------------------------------------------
{
  const overrideRec = finding.recordsFromComparison({ findings: overrideResult().findings },
    { investor: 'deephaven', program: 'dscr', scenario: 'STR at 75 LTV', nowMs: 1000 })[0];

  const clean = [];
  for (let i = 0; i < 14; i += 1) clean.push({ dayMs: i * 86400000, count: 0 });

  const sb = cutover.buildScoreboard({
    canaryAgreementRate: parity.summarize([AGREED, AGREED, overrideResult()]).agreementRate,
    findings: [overrideRec],
    dailyNewFindings: clean,
    nowMs: 14 * 86400000,
    canaryScenarioCount: 3,
    canaryIncomparable: 0,
  });
  eq(sb.openFindings, 0, 'D1 an override is not an open finding on the scoreboard');
  eq(sb.canaryAgreementRate, 1, 'D2 ...and the rate it reads is 100%');

  const verdict = cutover.eligibleForLive(sb, { minCleanDays: 14 });
  ok(verdict.eligible,
    `D3 AN INVESTOR WHOSE OVERRIDES ARE WORKING CAN GO LIVE - the dead end is gone (refused for: ${verdict.reasons.join('; ') || 'nothing'})`);

  // THE CONTROL. A real defect must still hold the gate shut, on every one of the three counts.
  const defectRec = finding.recordsFromComparison({ findings: defectResult().findings },
    { investor: 'deephaven', program: 'dscr', scenario: 'FICO 660', nowMs: 1000 })[0];
  const bad = cutover.buildScoreboard({
    canaryAgreementRate: parity.summarize([AGREED, AGREED, defectResult()]).agreementRate,
    findings: [defectRec],
    dailyNewFindings: clean,
    nowMs: 14 * 86400000,
    canaryScenarioCount: 3,
    canaryIncomparable: 0,
  });
  const badVerdict = cutover.eligibleForLive(bad, { minCleanDays: 14 });
  ok(!badVerdict.eligible, 'D4 a REAL disagreement still refuses promotion');
  ok(badVerdict.reasons.some((r) => /open finding/.test(r)), 'D5 ...because it is open work');
  ok(badVerdict.reasons.some((r) => /agreement is/.test(r)), 'D6 ...and because it dragged the rate');
}

// ---------------------------------------------------------------------------
// E - THE CLEAN-DAY STREAK, through the REAL canary against stub engines.
// ---------------------------------------------------------------------------
{
  const scenarios = [
    { _label: 'plain purchase', short_term_rental: false },
    { _label: 'short-term rental', short_term_rental: true },
  ];
  const ours = async (s) => (s.short_term_rental
    ? { eligible: false, ladder: [], declines: OVERLAY_DECLINE }
    : { eligible: true, ladder: [{ rate: 7.5, finalPriceMilli: 101000 }] });
  const theirs = async () => ({ eligible: true, rungs: [{ rate: 7.5, priceMilli: 101000 }] });

  const run = canary.runCanary(scenarios, { ours, theirs }, { investor: 'deephaven', program: 'dscr', nowMs: 1000, dayMs: 0 });

  Promise.resolve(run).then((r) => {
    eq(r.summary.overlay, 1, 'E1 the canary reports the override in its own bucket');
    eq(r.summary.agreementRate, 1, 'E2 ...and measures 100% on the scenario that was actually compared');
    eq(r.findingKeys.length, 0, 'E3 the override is NOT among the run\'s finding keys - it is not work that appeared');
    eq(r.overrideKeys.length, 1, 'E4 ...it is named separately, so a run with forty overrides cannot read like one with none');
    eq(r.records.length, 1, 'E5 ...and it is still RECORDED for the review queue');
    eq(r.records[0].status, 'wontfix', 'E6 ...settled');
    ok(r.verdict.proven, 'E7 the run proved something - one scenario really was compared');

    // The streak is what the gate counts, and it is computed from the run's finding keys.
    const days = scoreboard.dailyNewFindings([r.runRecord]);
    eq(days[0].count, 0, 'E8 the day the override first appeared is a CLEAN day - the 14-day streak survives it');

    // THE CONTROL: a real disagreement on the same day is NOT clean.
    const badRun = canary.runCanary(
      [{ _label: 'fico 660' }],
      { ours: async () => ({ eligible: false, ladder: [], declines: REAL_DECLINE }), theirs },
      { investor: 'deephaven', program: 'dscr', nowMs: 1000, dayMs: 0 },
    );
    return badRun.then((b) => {
      eq(b.findingKeys.length, 1, 'E9 a real disagreement IS a finding key');
      eq(scoreboard.dailyNewFindings([b.runRecord])[0].count, 1, 'E10 ...and it breaks the clean streak, exactly as before');

      // F - the verdict's wording on an all-override battery.
      const allOver = canary.verdictOf({ scenarios: 3, comparable: 0, overlay: 3, incomparable: 0, errors: 0 });
      ok(!allOver.proven, 'F1 a battery of nothing but overrides has proven no agreement');
      ok(/overlay override/i.test(allOver.reason),
        `F2 ...and SAYS SO, instead of reporting "no scenario was priced" about a run in which every scenario priced (got: ${allOver.reason})`);
      eq(allOver.overlay, 3, 'F3 ...with the count carried on the verdict');

      report();
      return null;
    });
  }).catch((e) => {
    failures.push(`E/F threw: ${e && e.stack ? e.stack : e}`);
    report();
  });
}

// ---------------------------------------------------------------------------
// G - ONE DEFINITION. Three consumers had to make the same decision about this kind; three copies of
//     the string is how one of them stops agreeing that an override is an override.
// ---------------------------------------------------------------------------
function sourceGuard() {
  const LT = path.join(__dirname, '..', 'src', 'longterm');
  const spellers = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) { walk(p); continue; }
      if (!f.endsWith('.js')) continue;
      const src = fs.readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
      if (/'eligibility_overlay'|"eligibility_overlay"/.test(src)) spellers.push(path.relative(LT, p));
    }
  };
  walk(LT);
  eq(spellers.join(','), path.join('ppe', 'overlay.js'),
    'G1 exactly ONE file spells the override finding kind - everything else reads it from overlay.js');
  ok(overlay.isOverlayFinding({ kind: overlay.FINDING_KIND }) && !overlay.isOverlayFinding({ kind: 'price_mismatch' }),
    'G2 the shared predicate answers on the kind');
  eq(parity.SEVERITY.OVERLAY, overlay.FINDING_KIND, 'G3 the comparator names the same kind the classifier owns');
}
sourceGuard();

function report() {
  console.log(failures.length
    ? `FAIL - lt ppe overlay not a defect (${pass} passed, ${failures.length} failed)\n  ${failures.join('\n  ')}`
    : `ok - lt ppe overlay not a defect (${pass} assertions)`);
  process.exit(failures.length ? 1 : 0);
}
