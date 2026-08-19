#!/usr/bin/env node
'use strict';
/**
 * LT PPE — A SCENARIO WE COULD NOT SCORE WAS STILL MEASURED, AND THE REPORT THREW THE MEASUREMENT AWAY.
 *
 * ⛔ WHAT WAS BROKEN. `summarize()` walked the battery once. Partway down that walk sat:
 *
 *     if (r.incomparable) { incomparable += 1; …; continue; }
 *
 * and BELOW the `continue` lived every descriptive tally in the report — `byCategory` (what kind of
 * difference), `byDimension` / `byStatus` (which LLPA families disagreed), `bounds` (cap/floor probes)
 * and `worstDeltaMilli`. So a scenario declared incomparable — meaning its DECLINE REASONS could not be
 * paired or read — contributed nothing to any of them, and the report presented those numbers as what
 * the battery measured.
 *
 * MEASURED on the live run of 2026-08-19 (8 scoped Deephaven scenarios, decline feed on): 6 of the 8
 * were incomparable, each carrying 28 coarse differences. The run printed
 *
 *     by category   {"coupon_missing_ours":56}
 *
 * 56 of 224. The other 168 — three quarters of everything the vendor was paid to tell us — were dropped
 * without a trace, on a report whose whole purpose is answering "which scenarios are not pricing
 * correctly". The comment above the tally made the promise explicit ("tallies EVERY coarse difference …
 * so a reader sees what was measured") and the code did not keep it.
 *
 * ⛔ THE DEFECT CLASS, for the fourth time in this workstream (§2.107, §2.108, §2.109): a comparison
 * that answers confidently on evidence it silently threw away. Here the discarded evidence was not even
 * contested — it was measured, paid for, and skipped by a `continue` placed for a different reason.
 *
 * THE FIX separates SCORING from MEASUREMENT. Scoring stays exactly as narrow as it was: an incomparable
 * scenario is still not `agreed`, still not `disagreed`, and `gateMet` reads none of the widened tallies
 * (it is `errors === 0 && disagreed === 0 && comparable > 0 && declineFeedComplete`). Measurement now
 * runs for every scenario, and `summary.measurement` names the population out loud — how many scenarios
 * were tallied, how many of those could not be scored, and how much of the coarse / LLPA / bounds
 * evidence came from the unscorable ones. A number over 8 scenarios and the same number over 2 are
 * different readings of the same run, and the report now says which one it is.
 *
 * PURE: no DB, no network — `runOne` is driven with stub legs. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { runOne, summarize } = require('../src/longterm/ppe/ratesheet-agreement');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }
const done = (label) => {
  console.log(`${fails.length ? 'FAIL' : 'PASS'} — ${label}: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(fails.length ? 1 : 0);
};

ok(typeof runOne === 'function' && typeof summarize === 'function', 'A0 runOne and summarize are reachable');
if (typeof runOne !== 'function' || typeof summarize !== 'function') done('incomparable-measurement guard');

// ⛔ STUB SHAPES ARE TAKEN FROM THE NORMALIZER, NOT GUESSED — a hand-made `{rate, price}` option folds
// to ZERO rungs (lp-normalize-full reads a `priceBuild` block), which would make every scenario
// `lp_no_signal` and every assertion below pass for the wrong reason.
const SC = { _label: 'measure-me', fico: 660, ltv: 75000, dscr: 1250, loan_amount: 375000 };
const OPTS = { filter: { investor: 'Deephaven Mortgage' }, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'] };

function lpLeg({ rungs = [6.125, 6.25, 6.375], declineRule = null }) {
  return async () => ({
    full: { programs: [{
      lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR 1.00-1.24',
      options: rungs.map((noteRate, i) => ({
        priceBuild: { noteRate, price: 99.25 + i * 0.5, basePoints: 0.75, adjustmentPoints: 0 }, adjustments: [],
      })),
    }] },
    disqualified: declineRule
      ? { ready: true, lenders: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', items: [{ program: 'DSCR 1.00-1.24', reasons: [{ rule: declineRule, adjType: 'SimpleRateAdjustment' }] }] }] }
      : { ready: true, lenders: [] },
  });
}
const ourDecline = (code, reason, dimension) => async () => ({ eligible: false, ladder: [], declines: [{ code, reason, dimension, source: 'base' }] });
const ourPriced = (rungs) => async () => ({
  eligible: true,
  ladder: rungs.map((rate, i) => ({ rate: Math.round(rate * 1000), finalPriceMilli: Math.round((99.25 + i * 0.5) * 1000), adjustments: [] })),
});

// A REAL captured sentence the crosswalk resolves to `dscr`, so the pair reconciles and the row is
// SCORABLE. Using a synthetic one here would make the "comparable" control incomparable too, and the
// contrast this suite is built on would vanish.
const LP_READABLE = 'DSCR >= 1.00, Minimum Loan Amount $75,000';
// ...and a sentence that resolves to NOTHING, which is how a row becomes `decline_reasons_unreadable`.
// This is the state the live run hit on 2 of 8 scenarios.
const LP_UNREADABLE = 'Zqx unreadable vendor sentence 12345';
const OUR_DSCR = 'Minimum DSCR 0.75';

const run = (ours, lp) => runOne(SC, ours, lp, OPTS);
const diffsOf = (r) => ((r && r.coarse && r.coarse.differences) || []).length;
const tallyOf = (sum) => Object.values((sum && sum.byCategory) || {}).reduce((n, v) => n + v, 0);
// Defensive throughout: a mutation that DELETES `measurement` must make these assertions FAIL, not
// crash the process — a crash is not proof (the §2.106 rule, re-learned three times in §2.109).
const meas = (sum) => (sum && sum.measurement) || {};
const fromInc = (sum) => (meas(sum).fromIncomparable) || {};

(async () => {
  // ---- A. AN UNSCORABLE SCENARIO'S MEASUREMENTS REACH THE SUMMARY -------------------------------
  const inc = await run(ourDecline('dhvn_min_dscr', OUR_DSCR, 'dscr'), lpLeg({ declineRule: LP_UNREADABLE }));
  ok(inc.incomparable === true, `A1 the row is incomparable — got ${inc.incomparable}`);
  ok(inc.incomparableReason === 'decline_reasons_unreadable',
    `A2 …because its decline reasons could not be read — got ${inc.incomparableReason}`);
  ok(diffsOf(inc) === 3, `A3 …and it nonetheless MEASURED 3 coarse differences — got ${diffsOf(inc)}`);

  const sumInc = summarize([inc]);
  ok(tallyOf(sumInc) === 3,
    `A4 all 3 reach byCategory — this was 0 before §2.110, the whole defect — got ${tallyOf(sumInc)}`);
  ok((sumInc.byCategory || {}).coupon_missing_ours === 3,
    `A5 …under the category they actually carry — got ${JSON.stringify(sumInc.byCategory)}`);

  // ---- B. AND THE REPORT SAYS WHICH POPULATION THEY CAME FROM -----------------------------------
  ok(meas(sumInc).scenarios === 1, `B1 one scenario was tallied — got ${meas(sumInc).scenarios}`);
  ok(meas(sumInc).incomparable === 1, `B2 …and it is named as unscorable — got ${meas(sumInc).incomparable}`);
  ok(meas(sumInc).comparable === 0, `B3 …with nothing scorable in the battery — got ${meas(sumInc).comparable}`);
  ok(fromInc(sumInc).coarseDifferences === 3,
    `B4 …and all 3 differences are attributed to the unscorable side — got ${fromInc(sumInc).coarseDifferences}`);

  // ---- C. SCORING IS UNCHANGED — THE GATE MUST NOT MOVE ----------------------------------------
  // ⛔ THE EXPENSIVE MISTAKE THIS SECTION FORBIDS. Widening the tallies is only safe because they are
  // descriptive. If an incomparable scenario ever started counting as agreed, a battery nobody could
  // score would report agreement — far worse than the number it fixes.
  ok(sumInc.agreed === 0 && sumInc.disagreed === 0,
    `C1 an unscorable scenario is neither agreed nor disagreed — got ${sumInc.agreed}/${sumInc.disagreed}`);
  ok(sumInc.incomparable === 1, `C2 …it is counted as incomparable — got ${sumInc.incomparable}`);
  ok((sumInc.incomparableByReason || {}).decline_reasons_unreadable === 1,
    `C3 …under its stated reason — got ${JSON.stringify(sumInc.incomparableByReason)}`);
  ok(sumInc.gateMet === false, `C4 …and a battery of nothing but unscorable rows does NOT meet the gate — got ${sumInc.gateMet}`);
  ok(sumInc.agreementRate == null || sumInc.agreementRate === 0,
    `C5 …and states no agreement rate over an empty comparable set — got ${sumInc.agreementRate}`);

  // ---- D. A MIXED BATTERY: THE HEADLINE COVERS EVERY SCENARIO ----------------------------------
  const cmp = await run(ourDecline('dhvn_min_dscr', OUR_DSCR, 'dscr'), lpLeg({ declineRule: LP_READABLE }));
  ok(cmp.incomparable === false && cmp.declineOutcome === 'agree',
    `D1 the control row IS scorable and agrees — got ${cmp.incomparable}/${cmp.declineOutcome}`);
  const oneSided = await run(ourDecline('dhvn_min_dscr', OUR_DSCR, 'dscr'), lpLeg({ declineRule: null }));
  ok(oneSided.bothDeclined === false, `D2 the one-sided row is not a both-decline — got ${oneSided.bothDeclined}`);

  const mixed = summarize([inc, cmp, oneSided]);
  const expected = diffsOf(inc) + diffsOf(cmp) + diffsOf(oneSided);
  ok(expected > 0 && tallyOf(mixed) === expected,
    `D3 the tally covers ALL THREE rows — expected ${expected}, got ${tallyOf(mixed)}`);
  ok(meas(mixed).scenarios === 3 && meas(mixed).comparable === 2 && meas(mixed).incomparable === 1,
    `D4 …and the population is stated: ${meas(mixed).scenarios} tallied, ${meas(mixed).comparable} scorable, ${meas(mixed).incomparable} not`);
  ok(fromInc(mixed).coarseDifferences === diffsOf(inc),
    `D5 …with exactly the unscorable row's share attributed to it — expected ${diffsOf(inc)}, got ${fromInc(mixed).coarseDifferences}`);
  ok(meas(mixed).comparable === mixed.agreed + mixed.disagreed,
    `D6 …and "scorable" reconciles with agreed+disagreed — ${meas(mixed).comparable} vs ${mixed.agreed + mixed.disagreed}`);

  // ---- E. THE coarseNotEvidence IDENTITY STILL HOLDS, NOW OVER THE WIDER POPULATION -------------
  // The counter exists so a reader can subtract the artefacts of a refusal from the tally. It was
  // reconcilable before only because BOTH numbers were computed over the same narrow population; the
  // fix must keep them reconcilable while both cover everything.
  const gating = [inc, cmp, oneSided].filter((r) => !r.bothDeclined).reduce((n, r) => n + diffsOf(r), 0);
  ok(tallyOf(mixed) === mixed.declines.coarseNotEvidence + gating,
    `E1 ${tallyOf(mixed)} tallied = ${mixed.declines.coarseNotEvidence} not-evidence + ${gating} from one-sided/priced rows`);
  ok(mixed.declines.coarseNotEvidence >= diffsOf(inc),
    `E2 …and the unscorable both-decline's differences are INSIDE the not-evidence count — got ${mixed.declines.coarseNotEvidence}`);

  // ---- F. THE ATTRIBUTION IS MEASURED, NOT A CONSTANT -------------------------------------------
  // A counter hard-wired to the number section B happens to expect would pass every assertion above.
  const incWide = await run(ourDecline('dhvn_min_dscr', OUR_DSCR, 'dscr'),
    lpLeg({ rungs: [6.125, 6.25, 6.375, 6.5, 6.625, 6.75, 6.875], declineRule: LP_UNREADABLE }));
  ok(incWide.incomparable === true && diffsOf(incWide) === 7,
    `F1 a wider unscorable row measures 7 differences — got ${incWide.incomparable}/${diffsOf(incWide)}`);
  const sumWide = summarize([incWide]);
  ok(fromInc(sumWide).coarseDifferences === 7,
    `F2 …and the attribution tracks it rather than repeating 3 — got ${fromInc(sumWide).coarseDifferences}`);
  ok(tallyOf(sumWide) === 7, `F3 …as does the tally — got ${tallyOf(sumWide)}`);

  // ---- G. AN ERRORED SCENARIO MEASURED NOTHING AND IS COUNTED AS NOTHING ------------------------
  // The one population that must NOT grow: a scenario that threw produced no observation at all, so
  // folding it into `measurement.scenarios` would overstate the battery in the opposite direction.
  const errored = { scenario: 'boom', error: { kind: 'lp_error', message: 'upstream 500' } };
  const sumErr = summarize([errored, inc]);
  ok(sumErr.errors === 1, `G1 the errored row is counted as an error — got ${sumErr.errors}`);
  ok(meas(sumErr).scenarios === 1,
    `G2 …and is NOT counted as measured: 1 scenario measured, not 2 — got ${meas(sumErr).scenarios}`);
  ok(meas(sumErr).incomparable === 1 && meas(sumErr).comparable === 0,
    `G3 …the surviving row keeps its own attribution — got ${meas(sumErr).incomparable}/${meas(sumErr).comparable}`);

  // ---- H. THE NUMBER REACHES A HUMAN ------------------------------------------------------------
  // A coverage counter nothing prints is a coverage counter nobody reads. Pinned at the source, because
  // the paid runner cannot be executed from a pure suite.
  const runnerPath = path.join(__dirname, 'test-lt-lp-agreement-run.js');
  const runner = fs.existsSync(runnerPath) ? fs.readFileSync(runnerPath, 'utf8') : '';
  ok(/summary\.measurement/.test(runner),
    'H1 the paid runner reads summary.measurement');
  ok(/measured over/.test(runner),
    'H2 …and prints the population the descriptive lines were measured over');
  ok(/fromIncomparable/.test(runner),
    'H3 …including how much of it came from scenarios it could not score');

  done('incomparable-measurement guard');
})().catch((e) => {
  console.log('FAIL — incomparable-measurement guard: threw', e && e.stack ? e.stack : e);
  process.exit(1);
});
