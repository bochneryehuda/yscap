#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT A LOAN BOTH ENGINES REFUSE IS JUDGED ON THE REFUSAL, NOT ON ITS PRICE.
 *
 * ⛔ WHAT WAS BROKEN, and the run said so out loud before anyone noticed. `runOne` gated `agree` on the
 * COARSE rung axes first and consulted the decline reconciliation afterwards — where the only moves
 * available were "stay false" and "become incomparable". `outcome === 'agree'` did nothing. So on a
 * scenario BOTH engines declined:
 *   • our engine returned NO rungs, precisely BECAUSE it declined;
 *   • Lender Price returns its ladder even for a program it refuses;
 *   • every coarse difference therefore read "Lender Price offers coupon X that we do not price" —
 *     trivially true of EVERY declined loan, and evidence about nothing;
 *   • `agree` was already false by the time the reasons were compared, so a both-decline could never
 *     be recorded as an agreement and `agreedDeclined` could never leave zero.
 *
 * MEASURED live 2026-08-18, 8 scoped Deephaven scenarios with the decline feed on: **168 of 168** coarse
 * differences were `coupon_missing_ours` on six scenarios both engines refused — including `dscr 0.6`,
 * whose decline reconciliation was a clean `agree` with an EMPTY mismatch list. The summary printed the
 * contradiction in one object: `bothDeclined: 8` beside `agreedDeclined: 0`.
 *
 * THE FIX is an ordering one: `bothDeclined` is known BEFORE the coarse axes are gated, no coarse axis
 * gates a both-decline, and the reconciliation decides the verdict IN BOTH DIRECTIONS. The differences
 * are still recorded (they are true — LP did return a ladder) and `declines.coarseNotEvidence` counts
 * them so the `byCategory` tally stays reconcilable instead of reading as 168 price disagreements.
 *
 * ⛔ THE SUPPRESSION IS NARROW ON PURPOSE. A ONE-SIDED decline is the opposite case: if we decline and
 * Lender Price prices — or the reverse — the missing coupons ARE the finding, and section C proves the
 * coarse axes still gate there. Widening this to "either side declined" would hide the expensive
 * direction, which is the whole reason the disqualify feed exists.
 *
 * PURE: no DB, no network — `runOne` is driven with stub legs. LT-only. No RTL imports.
 */
const { runOne, summarize } = require('../src/longterm/ppe/ratesheet-agreement');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

ok(typeof runOne === 'function', 'A0 runOne is reachable for a direct drive');
ok(typeof summarize === 'function', 'A0b summarize is reachable');
if (typeof runOne !== 'function' || typeof summarize !== 'function') {
  console.log(`FAIL — both-decline verdict guard: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(1);
}

// ⛔ THE STUB SHAPES ARE TAKEN FROM THE NORMALIZER AND FROM THE SIBLING SUITE, NOT GUESSED. A hand-made
// `{rate, price}` option is folded to ZERO rungs by lp-normalize-full (it reads a `priceBuild` block),
// which makes every scenario `lp_no_signal` and every assertion below pass for the wrong reason — the
// trap the decline-unobserved suite documents having fallen into. Same for our leg: it returns a
// `ladder`, not `rungs`.
const SC = { _label: 'both-decline', fico: 660, ltv: 75000, dscr: 1250, loan_amount: 375000 };
const OPTS = { filter: { investor: 'Deephaven Mortgage' }, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'] };

// Lender Price. THE LADDER IS PRESENT EVEN WHEN LP DECLINES — the vendor behaviour this file is about.
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
// Our engine. A DECLINE carries NO ladder — which is the point.
// `dimension` is tagged on the decline directly — `ourVerdictFromQuote` reads a caller-tagged one
// before it tries the program's rules, and this suite deliberately drives runOne with no program.
const ourDecline = (code, reason, dimension) => async () => ({ eligible: false, ladder: [], declines: [{ code, reason, dimension, source: 'base' }] });
const ourPriced = (rungs) => async () => ({
  eligible: true,
  ladder: rungs.map((rate, i) => ({ rate: Math.round(rate * 1000), finalPriceMilli: Math.round((99.25 + i * 0.5) * 1000), adjustments: [] })),
});

// The reason both sides state, so the reconciler can pair them on one dimension.
// Both sides' texts are REAL ones captured live 2026-08-18, chosen because the crosswalk resolves them
// to a known dimension — a synthetic reason mostly resolves to nothing and the outcome is then
// `indeterminate`, which would make every assertion below pass for the wrong reason.
const OUR_DSCR_REASON = 'Minimum DSCR 0.75';
// ⛔ NOT `"DSCR >=1.25%  only eligible on this program"`, which this suite used until §2.107. That
// sentence resolves to `dscr` and so looked like an ordinary stand-in, but it was MEASURED to be a
// statement about Lender Price's own program partition — a container saying a SIBLING container owns
// the loan, while that sibling priced it on the same request — so it is now set aside rather than
// scored (lp-container-partition.js). Using it here would teach the suite that a partition sentence
// AGREES with a real refusal of ours, which is the exact false agreement §2.107 exists to prevent.
// This is another real reason captured live 2026-08-18 that the crosswalk resolves to `dscr`.
const LP_DSCR_REASON = 'DSCR >= 1.00, Minimum Loan Amount $75,000';
const LP_FICO_REASON = 'DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%';
const run = (ours, lp) => runOne(SC, ours, lp, OPTS);

(async () => {
  // ---- A. BOTH DECLINE, SAME REASON -> AGREEMENT ------------------------------------------------
  const agreeCase = await run(ourDecline('dhvn_min_dscr', OUR_DSCR_REASON, 'dscr'), lpLeg({ declineRule: LP_DSCR_REASON }));
  ok(agreeCase.bothDeclined === true, 'A1 the case really is a both-decline');
  ok((agreeCase.coarse && agreeCase.coarse.differences || []).length > 0,
    'A2 …and Lender Price\'s ladder really does produce coarse differences (so the suppression has something to suppress)');
  ok((agreeCase.gatingCategories || []).length === 0,
    `A3 …none of which GATED — got ${JSON.stringify(agreeCase.gatingCategories)}`);
  ok(agreeCase.declineOutcome === 'agree', `A4 the reasons reconcile as an agreement — got ${agreeCase.declineOutcome}`);
  ok(agreeCase.agree === true, 'A5 …so the scenario AGREES (this was impossible before: the coupons held it false)');
  ok(agreeCase.incomparable === false, 'A6 …and is comparable');

  // ---- B. BOTH DECLINE, DIFFERENT REASONS -> STILL A DISAGREEMENT --------------------------------
  const disagreeCase = await run(ourDecline('dhvn_min_dscr', OUR_DSCR_REASON, 'dscr'), lpLeg({ declineRule: LP_FICO_REASON }));
  ok(disagreeCase.bothDeclined === true, 'B1 the case is a both-decline');
  ok(disagreeCase.declineOutcome === 'disagree', `B2 the reasons do NOT reconcile — got ${disagreeCase.declineOutcome}`);
  ok(disagreeCase.agree === false, 'B3 …so it disagrees — the fix must not turn every both-decline into a pass');

  // ---- C. A ONE-SIDED DECLINE STILL GATES ON THE COARSE AXES ------------------------------------
  // The expensive direction. If this ever stops gating, the feed stops earning its keep.
  const oneSided = await run(ourDecline('dhvn_min_dscr', OUR_DSCR_REASON, 'dscr'), lpLeg({ declineRule: null })); // LP PRICED it
  ok(oneSided.bothDeclined === false, 'C1 our decline against an LP price is NOT a both-decline');
  ok((oneSided.gatingCategories || []).length > 0,
    `C2 …and its coarse axes still GATE — got ${JSON.stringify(oneSided.gatingCategories)}`);
  ok(oneSided.agree === false, 'C3 …so we-decline / they-price is still a disagreement');

  // ---- D. BOTH PRICED IS UNTOUCHED --------------------------------------------------------------
  const bothPriced = await run(ourPriced([6.125, 6.25, 6.375]), lpLeg({ declineRule: null }));
  ok(bothPriced.bothDeclined === false, 'D1 both-priced is not a both-decline');
  ok(bothPriced.agree === true, `D2 …and a matching ladder still agrees — got ${bothPriced.agree}`);
  const mismatched = await run(ourPriced([6.125, 6.25]), lpLeg({ declineRule: null }));
  ok(mismatched.agree === false, 'D3 …while a ladder missing a coupon still disagrees (the axis is alive)');

  // ---- E. THE SUMMARY RECONCILES ----------------------------------------------------------------
  const sum = summarize([agreeCase, disagreeCase, oneSided, bothPriced]);
  ok(sum.declines.bothDeclined === 2, `E1 the summary counts both both-declines — got ${sum.declines.bothDeclined}`);
  ok(sum.agreedDeclined === 1, `E2 …and records the reconciled one as an agreed DECLINE — got ${sum.agreedDeclined}`);
  ok(sum.declines.coarseNotEvidence > 0,
    `E3 …and names how many coarse differences it declined to treat as evidence — got ${sum.declines.coarseNotEvidence}`);
  // The counter must reconcile EXACTLY with the tally it explains, or it re-creates the puzzle: a count
  // taken from a wider population (every both-decline, including the incomparable ones) reads 224 beside
  // a byCategory of 168 and a reader is back to guessing. Both are counted in the same loop.
  const tallied = Object.values(sum.byCategory || {}).reduce((n, v) => n + v, 0);
  const gating = [agreeCase, disagreeCase, oneSided, bothPriced]
    .filter((r) => !r.bothDeclined)
    .reduce((n, r) => n + ((r.coarse && r.coarse.differences) || []).length, 0);
  ok(tallied === sum.declines.coarseNotEvidence + gating,
    `E6 the coarse tally reconciles: ${tallied} tallied = ${sum.declines.coarseNotEvidence} not-evidence + ${gating} from one-sided/priced scenarios`);
  ok(sum.agreed >= 2, `E4 the agreeing decline and the agreeing price both count — got ${sum.agreed}`);
  // The contradiction this closes, asserted as such.
  ok(!(sum.declines.bothDeclined > 0 && sum.agreedDeclined === 0 && sum.declines.reasonsAgree > 0),
    'E5 the summary can no longer say "N both declined, reasons agree" and "0 agreed declines" at once');

  console.log(`${fails.length ? 'FAIL' : 'PASS'} — both-decline verdict guard: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(fails.length ? 1 : 0);
})();
