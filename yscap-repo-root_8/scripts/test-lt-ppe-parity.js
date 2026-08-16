'use strict';
/**
 * Pure offline test for the LT PPE parity comparator (src/longterm/ppe/parity.js).
 * No DB, no network. Runs the shadow-model comparisons (§10) and the scoreboard.
 *
 *   node scripts/test-lt-ppe-parity.js
 */

const assert = require('assert');
const P = require('../src/longterm/ppe/parity');

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n += 1; };

// ---- normalizeOurQuote ------------------------------------------------------
(() => {
  const q = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }, { rate: 7250, finalPriceMilli: 101250 }] };
  const norm = P.normalizeOurQuote(q);
  eq(norm.eligible, true, 'normalizeOurQuote: eligible carried');
  eq(norm.rungs.length, 2, 'normalizeOurQuote: two rungs');
  eq(norm.rungs[0].priceMilli, 100000, 'normalizeOurQuote: maps finalPriceMilli -> priceMilli');

  const bad = P.normalizeOurQuote({ eligible: false });
  eq(bad.eligible, false, 'normalizeOurQuote: ineligible -> eligible false');
  eq(bad.rungs.length, 0, 'normalizeOurQuote: ineligible -> no rungs');

  eq(P.normalizeOurQuote(null).eligible, false, 'normalizeOurQuote: null safe');
})();

// ---- normalizeLadder --------------------------------------------------------
(() => {
  const arr = P.normalizeLadder([{ rate: 7250, priceMilli: 1 }, { rate: 7000, priceMilli: 2 }]);
  eq(arr.eligible, true, 'normalizeLadder: bare array is eligible');
  eq(arr.rungs[0].rate, 7000, 'normalizeLadder: sorts by rate ascending');

  const obj = P.normalizeLadder({ eligible: true, rungs: [{ rate: 8000, priceMilli: 5 }] });
  eq(obj.rungs[0].rate, 8000, 'normalizeLadder: object shape passes through');

  eq(P.normalizeLadder(null).eligible, false, 'normalizeLadder: null safe');
  eq(P.normalizeLadder(undefined).rungs.length, 0, 'normalizeLadder: undefined -> empty rungs');
})();

// ---- eligibility mismatch short-circuits ------------------------------------
(() => {
  const ours = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] };
  const theirs = { eligible: false, rungs: [] };
  const r = P.compareScenario(ours, theirs);
  eq(r.agree, false, 'eligibility mismatch -> disagree');
  eq(r.findings.length, 1, 'eligibility mismatch -> single finding (short-circuit)');
  eq(r.findings[0].kind, P.SEVERITY.ELIGIBILITY, 'eligibility mismatch -> eligibility_mismatch kind');
  eq(r.findings[0].ourEligible, true, 'eligibility finding carries ourEligible');
  eq(r.findings[0].theirEligible, false, 'eligibility finding carries theirEligible');
})();

// ---- both ineligible -> agreement, no rung comparison -----------------------
(() => {
  const r = P.compareScenario({ eligible: false }, { eligible: false });
  eq(r.agree, true, 'both ineligible -> agree');
  eq(r.findings.length, 0, 'both ineligible -> no findings');
})();

// ---- exact match -> agreement -----------------------------------------------
(() => {
  const ladder = [{ rate: 7000, finalPriceMilli: 100000 }, { rate: 7250, finalPriceMilli: 101250 }];
  const ours = { eligible: true, ladder };
  const theirs = { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }, { rate: 7250, priceMilli: 101250 }] };
  const r = P.compareScenario(ours, theirs, { priceToleranceMilli: 0 });
  eq(r.agree, true, 'exact match -> agree');
  eq(r.findings.length, 0, 'exact match -> no findings');
})();

// ---- price within / beyond tolerance ----------------------------------------
(() => {
  const ours = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100001 }] };
  const theirs = { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] };

  const within = P.compareScenario(ours, theirs, { priceToleranceMilli: 1 });
  eq(within.agree, true, 'price delta within tolerance -> agree');

  const beyond = P.compareScenario(ours, theirs, { priceToleranceMilli: 0 });
  eq(beyond.agree, false, 'price delta beyond tolerance -> disagree');
  eq(beyond.findings[0].kind, P.SEVERITY.PRICE, 'price disagreement -> price_mismatch kind');
  eq(beyond.findings[0].deltaMilli, 1, 'price finding reports the delta');
  eq(beyond.findings[0].ourPriceMilli, 100001, 'price finding carries our price');
  eq(beyond.findings[0].theirPriceMilli, 100000, 'price finding carries their price');
})();

// ---- rung missing on each side ----------------------------------------------
(() => {
  const ours = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }, { rate: 7250, finalPriceMilli: 101250 }] };
  const theirs = { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] };
  const r = P.compareScenario(ours, theirs);
  eq(r.agree, false, 'we priced a coupon they did not -> disagree');
  const miss = r.findings.find((f) => f.kind === P.SEVERITY.MISSING_THEIRS);
  ok(miss, 'reports rung_missing_theirs');
  eq(miss.rate, 7250, 'missing_theirs carries the coupon rate');

  const r2 = P.compareScenario(theirs, ours); // flip: theirs (their ladder as ours) missing 7250
  const miss2 = r2.findings.find((f) => f.kind === P.SEVERITY.MISSING_OURS);
  ok(miss2, 'reports rung_missing_ours when Lender Price has a coupon we did not');
})();

// ---- rate tolerance matching ------------------------------------------------
(() => {
  const ours = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] };
  const theirs = { eligible: true, rungs: [{ rate: 7010, priceMilli: 100000 }] };

  const noTol = P.compareScenario(ours, theirs, { rateToleranceMilli: 0 });
  eq(noTol.agree, false, 'rate off with zero rate tolerance -> no coupon match');

  const withTol = P.compareScenario(ours, theirs, { rateToleranceMilli: 25, priceToleranceMilli: 0 });
  const rateFinding = withTol.findings.find((f) => f.kind === P.SEVERITY.RATE);
  ok(rateFinding, 'matched within rate tolerance but coupon differs -> rate_mismatch finding');
  eq(rateFinding.theirRate, 7010, 'rate finding carries their coupon');
})();

// ---- scenario tag echoed onto findings --------------------------------------
(() => {
  const ours = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100001 }] };
  const theirs = { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] };
  const r = P.compareScenario(ours, theirs, { priceToleranceMilli: 0, scenario: { program: 'X', ltv: 70 } });
  eq(r.findings[0].scenario.program, 'X', 'scenario echoed onto findings');
})();

// ---- §10.6 incomparable: a side with no result is never scored as agreement -
(() => {
  const ladder = { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] };

  // our engine gave nothing (null) — must NOT read as ineligible-agrees-with-ineligible
  const oursMissing = P.compareScenario(null, { eligible: false });
  eq(oursMissing.agree, false, 'ours absent -> not agree');
  eq(oursMissing.incomparable, true, 'ours absent -> incomparable');
  eq(oursMissing.findings[0].kind, P.SEVERITY.INCOMPARABLE, 'ours absent -> incomparable finding');
  eq(oursMissing.findings[0].side, 'ours', 'incomparable names the missing side');
  ok(/no result/i.test(oursMissing.reason), 'incomparable carries a reason');

  // their engine gave nothing
  const theirsMissing = P.compareScenario(ladder, undefined);
  eq(theirsMissing.incomparable, true, 'theirs absent -> incomparable');
  eq(theirsMissing.findings[0].side, 'theirs', 'incomparable names Lender Price when it is absent');

  // an EMPTY object is not a real result either
  const emptyObj = P.compareScenario({}, ladder);
  eq(emptyObj.incomparable, true, 'an empty object is not a comparable result');

  // both absent
  const both = P.compareScenario(null, null);
  eq(both.incomparable, true, 'both absent -> incomparable');
  eq(both.findings[0].side, 'both', 'incomparable names both when neither answered');

  // a REAL ineligible result (has eligible boolean) is still comparable — not incomparable
  const realIneligible = P.compareScenario({ eligible: false }, { eligible: false });
  ok(!realIneligible.incomparable, 'a stated ineligible is a real result, still comparable');
  eq(realIneligible.agree, true, 'two stated ineligibles still agree');

  // the scenario tag is echoed onto the incomparable finding
  const tagged = P.compareScenario(null, ladder, { scenario: { program: 'Z' } });
  eq(tagged.findings[0].scenario.program, 'Z', 'incomparable finding carries the scenario tag');
})();

// ---- summarize splits incomparable out of the agreement rate ---------------
(() => {
  const results = [
    P.compareScenario({ eligible: false }, { eligible: false }),          // agree
    P.compareScenario({ eligible: true, ladder: [] }, { eligible: false }), // eligibility mismatch (disagree)
    P.compareScenario(null, { eligible: false }),                          // incomparable
  ];
  const s = P.summarize(results);
  eq(s.scenarios, 3, 'summarize: all scenarios counted');
  eq(s.agreed, 1, 'summarize: one agreed');
  eq(s.disagreed, 1, 'summarize: one disagreed (incomparable not counted here)');
  eq(s.incomparable, 1, 'summarize: one incomparable');
  eq(s.comparable, 2, 'summarize: comparable = agreed + disagreed');
  ok(Math.abs(s.agreementRate - 1 / 2) < 1e-9, 'summarize: rate is over comparable scenarios (1/2), not 1/3');
})();

// ---- summarize scoreboard ---------------------------------------------------
(() => {
  const results = [
    P.compareScenario({ eligible: false }, { eligible: false }),                                   // agree
    P.compareScenario({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100001 }] },
      { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] }, { priceToleranceMilli: 0 }), // price mismatch
    P.compareScenario({ eligible: true, ladder: [] }, { eligible: false }),                        // eligibility mismatch
  ];
  const s = P.summarize(results);
  eq(s.scenarios, 3, 'summarize: counts scenarios');
  eq(s.agreed, 1, 'summarize: counts agreed');
  eq(s.disagreed, 2, 'summarize: counts disagreed');
  eq(s.findings, 2, 'summarize: total findings');
  eq(s.byKind[P.SEVERITY.PRICE], 1, 'summarize: byKind price count');
  eq(s.byKind[P.SEVERITY.ELIGIBILITY], 1, 'summarize: byKind eligibility count');
  ok(Math.abs(s.agreementRate - 1 / 3) < 1e-9, 'summarize: agreement rate');

  const empty = P.summarize([]);
  eq(empty.scenarios, 0, 'summarize: empty safe');
  eq(empty.agreementRate, null, 'summarize: empty agreement rate is null');
})();

console.log(`ok - lt ppe parity comparator (${n} assertions)`);
