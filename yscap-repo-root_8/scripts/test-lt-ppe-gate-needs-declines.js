#!/usr/bin/env node
'use strict';
/**
 * LT PPE — A GATE THAT CANNOT SEE A REFUSAL CANNOT PASS (§2.93).
 *
 * §2.91 stopped a run made without the decline feed from manufacturing FINDINGS. This closes the other
 * half: such a run could still report **GATE MET YES**.
 *
 * ⛔ AND THE DIRECTION IT CANNOT SEE IS THE EXPENSIVE ONE. The disqualify tree is the only place Lender
 * Price states a refusal, so with the feed off `lpDeclined` is false on **every** scenario. §2.91's arm
 * covers the harmless direction — we decline, they appear to price — by marking it incomparable. The
 * direction it cannot cover is **Lender Price declines and we price**: that case is not merely unproven,
 * it is *undetectable*, because there is no decline row for anything to compare against. That is the case
 * where we quote a loan the investor will not buy.
 *
 * So the gate now requires that the refusals were observed on **every** scenario in the battery.
 * `--no-disqualify` remains a legitimate and useful way to measure PRICE parity — it simply cannot
 * support a verdict about eligibility, and now says so instead of answering.
 *
 * This is the same reasoning the runner's own mis-invocation guard already applies to an unscoped run:
 * *a gate that answers confidently when it was asked the wrong question is worse than a gate that
 * refuses.* It was applied to the scope and not to the feed.
 *
 *   node scripts/test-lt-ppe-gate-needs-declines.js
 *
 * PURE — no DB, no network. LT-only.
 */
const path = require('path');
const fs = require('fs');
const { summarize, runOne } = require('../src/longterm/ppe/ratesheet-agreement');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// A clean, agreeing result — everything a gate wants, varying only whether the feed was seen.
const okResult = (lpDisqReady) => ({ scenario: 's', agree: true, incomparable: false, lpDisqReady,
  ourEligible: true, lpEligible: true, coarse: { differences: [] }, rungReconciles: [], bounds: [] });

// ---- A: the gate ---------------------------------------------------------------------------------
console.log('-- A: the verdict --');
{
  const on = summarize([okResult(true), okResult(true), okResult(true)]);
  ok(on.gateMet === true, 'a clean run WITH the decline feed can pass');
  ok(on.declineFeedComplete === true && on.declineFeedReady === 3, `…and reports the feed (${on.declineFeedReady}/3)`);

  const off = summarize([okResult(false), okResult(false), okResult(false)]);
  ok(off.disagreed === 0 && off.errors === 0 && off.comparable === 3,
    'THE DEFECT: the same run without the feed still has 0 disagreements, 0 errors and 3 comparable…');
  ok(off.agreementRate === 1, '…and an agreement rate of 100%…');
  ok(off.gateMet === false, '…and now CANNOT pass the gate');
  ok(off.declineFeedComplete === false && off.declineFeedReady === 0, `…because no scenario saw a refusal (${off.declineFeedReady}/3)`);
}
{
  // PARTIAL is not enough. A battery where some scenarios saw the feed and some did not cannot prove
  // the ones that did not — and "most of it was checked" is exactly the shape §2.90 refused.
  const mixed = summarize([okResult(true), okResult(true), okResult(false)]);
  ok(mixed.gateMet === false, 'a PARTIAL feed does not pass — most is not all');
  ok(mixed.declineFeedReady === 2 && mixed.declineFeedComplete === false, `…and the partial count is reported (${mixed.declineFeedReady}/3)`);
}
{
  const empty = summarize([]);
  ok(empty.gateMet === false && empty.declineFeedComplete === false,
    'an EMPTY battery is not "complete" — nothing was observed, so nothing can be claimed');
}

// ---- B: the count is over the whole battery, not the survivors -----------------------------------
console.log('\n-- B: the denominator --');
{
  // An errored scenario still had, or lacked, the feed. Counting only comparable ones would let a run
  // with one clean scenario and ninety-nine errors report a "complete" feed.
  const withError = summarize([okResult(true), { scenario: 'e', error: { kind: 'lp' }, lpDisqReady: false }]);
  ok(withError.declineFeedReady === 1, 'an errored scenario without the feed is counted as not-ready');
  ok(withError.declineFeedComplete === false, '…so the feed is not complete');
  const bothReady = summarize([okResult(true), { scenario: 'e', error: { kind: 'lp' }, lpDisqReady: true }]);
  ok(bothReady.declineFeedReady === 2, 'and an errored scenario that DID have the feed is counted as ready');
  ok(bothReady.gateMet === false, '…though the error itself still fails the gate, as before');
}
{
  // An incomparable scenario likewise. §2.90 already blocks on those downstream; the feed count must
  // not disagree with it about what the battery was.
  const inc = summarize([okResult(true), { scenario: 'i', agree: false, incomparable: true,
    incomparableReason: 'lp_no_signal', lpDisqReady: true, coarse: { differences: [] }, rungReconciles: [], bounds: [] }]);
  ok(inc.declineFeedReady === 2, 'an incomparable scenario that saw the feed still counts toward it');
  ok(inc.incomparable === 1, '…and is still counted as incomparable');
}

// ---- C: end to end through the real runOne -------------------------------------------------------
console.log('\n-- C: through the real comparison --');
{
  const ours = async () => ({ eligible: true, ladder: [{ rate: 6125, finalPriceMilli: 99000, adjustments: [] }] });
  const lp = (ready) => async () => ({
    full: { programs: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR',
      options: [{ priceBuild: { noteRate: 6.125, price: 99.25, basePoints: 0.75, adjustmentPoints: 0 }, adjustments: [] }] }] },
    disqualified: { ready, lenders: [] },
  });
  const OPTS = { filter: { investor: 'Deephaven Mortgage' }, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'] };
  const SC = { _label: 'x', fico: 760, ltv: 70000, dscr: 1250, loan_amount: 350000 };
  (async () => {
    const withFeed = await runOne(SC, ours, lp(true), OPTS);
    const without = await runOne(SC, ours, lp(false), OPTS);
    ok(withFeed.lpDisqReady === true, 'runOne records that the feed WAS observed');
    ok(without.lpDisqReady === false, '…and that it was not');
    ok(summarize([withFeed]).declineFeedComplete === true, 'a real result with the feed makes the run complete');
    ok(summarize([without]).declineFeedComplete === false, '…and one without does not');

    // ---- D: the CLI says it, before the verdict --------------------------------------------------
    console.log('\n-- D: the report tells the reader --');
    const cli = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
    ok(/declineFeedComplete/.test(cli), 'the runner reads the flag');
    ok(/NOT OBSERVED/.test(cli), '…and prints a warning naming what was not observed');
    ok(/expensive case|will not buy/.test(cli), '…saying WHICH direction it cannot see, not merely that something is missing');
    ok(/price comparison above\n\s*\/\/\s*stands|price comparison above/.test(cli),
      '…and that the PRICE comparison still stands — the tool is not being called useless');
    ok(/--no-disqualify to gate|without --no-disqualify/.test(cli), '…and what to do about it');
    // Ordering: the warning must precede the verdict, or a reader sees "GATE MET NO" and scrolls away.
    ok(cli.indexOf('NOT OBSERVED') < cli.indexOf('GATE MET      $'), 'the warning is printed BEFORE the verdict');
    // And the reasons behind a shrunken battery are named, not just counted.
    ok(/incomparableByReason/.test(cli), 'the report names WHY scenarios went incomparable, not only how many');

    // ---- E: the reasoning lives where the decision is made ---------------------------------------
    console.log('\n-- E: the claim in the source --');
    const src = fs.readFileSync(path.join(__dirname, '../src/longterm/ppe/ratesheet-agreement.js'), 'utf8');
    ok(/gateMet: errors === 0 && disagreed === 0 && comparable > 0 && declineFeedComplete/.test(src),
      'the gate expression itself requires the feed');
    ok(/declineFeedReady === list\.length/.test(src), 'complete means EVERY scenario, not a majority');
    ok(/list\.length > 0/.test(src), '…and an empty battery is not complete');
    ok(/undetectable|UNDETECTABLE/.test(src), 'the source says why: the expensive direction is not merely unproven but undetectable');

    console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
    process.exit(failures ? 1 : 0);
  })().catch((e) => { console.error('SUITE CRASHED:', e); process.exit(1); });
}
