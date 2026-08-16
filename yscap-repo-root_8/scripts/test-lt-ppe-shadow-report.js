'use strict';
/**
 * Pure offline test for the shadow-run scoreboard report (src/longterm/ppe/shadow-report.js).
 *   node scripts/test-lt-ppe-shadow-report.js
 */

const assert = require('assert');
const R = require('../src/longterm/ppe/shadow-report');
const parity = require('../src/longterm/ppe/parity');
const shadow = require('../src/longterm/ppe/shadow');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

// Build a run object by hand from parity comparisons (no engines needed).
function runOf(results) { return { results, summary: shadow.summarize(results) }; }

// ---- all agree --------------------------------------------------------------
(() => {
  const results = [
    parity.compareScenario({ eligible: false }, { eligible: false }),
    parity.compareScenario({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] },
      { eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] }, { priceToleranceMilli: 0 }),
  ];
  const rep = R.buildReport(runOf(results));
  ok(rep.verdict.includes('agree'), 'verdict: all agree');
  eq(rep.byKind.length, 0, 'no disagreement kinds');
  eq(rep.worstPriceGaps.length, 0, 'no price gaps');
})();

// ---- ranks worst price gaps, honors topN, reports omitted -------------------
(() => {
  const mk = (rate, delta) => parity.compareScenario(
    { eligible: true, ladder: [{ rate, finalPriceMilli: 100000 + delta }] },
    { eligible: true, rungs: [{ rate, priceMilli: 100000 }] },
    { priceToleranceMilli: 0, scenario: { fico: rate } },
  );
  const results = [mk(7000, 1), mk(7100, 50), mk(7200, -80), mk(7300, 10)];
  const rep = R.buildReport(runOf(results), { topPriceGaps: 2 });
  eq(rep.worstPriceGaps.length, 2, 'topN honored');
  eq(Math.abs(rep.worstPriceGaps[0].deltaMilli), 80, 'biggest |delta| first');
  eq(Math.abs(rep.worstPriceGaps[1].deltaMilli), 50, 'second biggest next');
  eq(rep.worstPriceGapsOmitted, 2, 'omitted count reported (no silent truncation)');
  eq(rep.byKind[0].kind, parity.SEVERITY.PRICE, 'byKind led by price disagreements');
  eq(rep.byKind[0].count, 4, 'all four counted');
})();

// ---- eligibility + missing + error kinds surface ----------------------------
(() => {
  const elig = parity.compareScenario({ eligible: true, ladder: [] }, { eligible: false });
  const missTheirs = parity.compareScenario(
    { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] },
    { eligible: true, rungs: [] },
  );
  const errResult = { agree: false, scenario: 'x=1', error: 'theirs',
    findings: [{ kind: shadow.ERROR_KIND, side: 'theirs', detail: 'LP timeout', scenario: 'x=1' }] };
  const rep = R.buildReport(runOf([elig, missTheirs, errResult]));
  const kinds = rep.byKind.map((k) => k.kind);
  ok(kinds.includes(parity.SEVERITY.ELIGIBILITY), 'eligibility kind present');
  ok(kinds.includes(parity.SEVERITY.MISSING_THEIRS), 'missing_theirs kind present');
  ok(kinds.includes('engine_error'), 'engine_error kind present');
  eq(rep.errors.length, 1, 'errors list populated');
  ok(rep.errors[0].detail.includes('LP timeout'), 'error detail carried');
})();

// ---- verdict wording --------------------------------------------------------
(() => {
  eq(R.verdictOf({ scenarios: 0 }), 'No scenarios were run.', 'empty verdict');
  eq(R.verdictOf({ scenarios: 5, agreed: 5, disagreed: 0 }), 'All 5 scenarios agree with Lender Price.', 'all-agree verdict');
  const v = R.verdictOf({ scenarios: 4, agreed: 3, disagreed: 1, agreementRate: 0.75, errors: 0 });
  ok(v.includes('3 of 4') && v.includes('75%'), 'mixed verdict shows counts + rate');
  const ve = R.verdictOf({ scenarios: 4, agreed: 2, disagreed: 2, agreementRate: 0.5, errors: 1 });
  ok(ve.includes('could not be priced'), 'verdict notes engine errors');
})();

// ---- renderText produces readable plain text --------------------------------
(() => {
  const results = [
    parity.compareScenario(
      { eligible: true, ladder: [{ rate: 7125, finalPriceMilli: 102900 }] },
      { eligible: true, rungs: [{ rate: 7125, priceMilli: 102850 }] },
      { priceToleranceMilli: 0, scenario: { fico: 740, ltv: 70 } },
    ),
  ];
  const txt = R.renderText(runOf(results));
  ok(txt.includes('Lender Price shadow comparison'), 'has a heading');
  ok(txt.includes('Biggest price gaps'), 'lists price gaps');
  ok(txt.includes('7.125'), 'coupon rendered in points/percent');
  ok(txt.includes('102.900') && txt.includes('102.850'), 'both prices rendered');
  ok(txt.endsWith('\n'), 'ends with a single newline');
  ok(txt.includes('fico=740 ltv=70'), 'an object scenario tag renders via describeScenario, not [object Object]');
  ok(!txt.includes('[object Object]'), 'never emits [object Object]');
})();

// ---- empty run --------------------------------------------------------------
(() => {
  const txt = R.renderText({ results: [] });
  ok(txt.includes('No scenarios were run.'), 'empty run renders the empty verdict');
})();

console.log(`ok - lt ppe shadow report (${n} assertions)`);
