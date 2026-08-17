'use strict';
/**
 * Pure offline test for the LT PPE shadow runner (src/longterm/ppe/shadow.js).
 * Engines are injected stubs — no DB, no network.
 *   node scripts/test-lt-ppe-shadow.js
 */

const assert = require('assert');
const S = require('../src/longterm/ppe/shadow');
const M = require('../src/longterm/ppe/scenario-matrix');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

// A tiny engine: eligible, one coupon whose price = base + bump(scenario).
const engine = (bump) => (s) => ({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 + bump(s) }] });

async function main() {
  // ---- agree across a batch -------------------------------------------------
  {
    const { scenarios } = M.buildMatrix({ ltv: [70, 75, 80] });
    const { results, summary } = await S.runShadow(scenarios, {
      ours: engine(() => 0),
      theirs: engine(() => 0),
    }, { priceToleranceMilli: 0 });
    eq(results.length, 3, 'runShadow: one result per scenario');
    eq(summary.scenarios, 3, 'summary: scenarios counted');
    eq(summary.agreed, 3, 'summary: all agreed');
    eq(summary.errors, 0, 'summary: no errors');
    ok(results.every((r) => r.scenario && r.scenario.includes('ltv=')), 'each result carries the scenario label');
  }

  // ---- a disagreement becomes a finding, batch survives ---------------------
  {
    const { scenarios } = M.buildMatrix({ ltv: [70, 75] });
    const { results, summary } = await S.runShadow(scenarios, {
      ours: engine((s) => (s.ltv === 75 ? 5 : 0)), // ours prices 5 higher at ltv 75
      theirs: engine(() => 0),
    }, { priceToleranceMilli: 0 });
    eq(summary.agreed, 1, 'one scenario agrees');
    eq(summary.disagreed, 1, 'one scenario disagrees');
    eq(summary.findings, 1, 'one finding total');
    eq(summary.byKind.price_mismatch, 1, 'the disagreement is a price mismatch');
    const bad = results.find((r) => !r.agree);
    ok(bad.scenario.includes('ltv=75'), 'the finding is tagged to the right scenario');
  }

  // ---- D29: our raw declines reach the comparator, so a reasoned overlay is typed OVERLAY ---
  {
    const overlay = require('../src/longterm/ppe/overlay');
    const ovl = overlay.overlayDecline('occupancy', 'Vacant/Unleased ineligible for cash-out refi');
    // ours declines (with the overlay decline attached, as quoteProgram emits it); LP prices it.
    const ourIneligible = () => ({ eligible: false, declines: [ovl] });
    const lpEligible = () => ({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] });
    const r = await S.runOne({ _label: 'ltv=70' }, ourIneligible, lpEligible, { priceToleranceMilli: 0 });
    eq(r.agree, false, 'overlay divergence is never scored as agreement');
    eq(r.overlay, true, 'runOne surfaces overlay:true for a reasoned override');
    eq(r.findings[0].kind, 'eligibility_overlay', 'the finding is typed OVERLAY, not a defect');

    // a decline on an LP-visible fact stays a real mismatch (no overlay pass through the runner)
    const ourBadDecline = () => ({ eligible: false, declines: [{ code: 'dhvn_max_ltv', reason: 'ltv max 80 exceeded' }] });
    const r2 = await S.runOne({ _label: 'ltv=85' }, ourBadDecline, lpEligible, { priceToleranceMilli: 0 });
    eq(r2.overlay, false, 'an LP-visible decline is not an overlay through the runner');
    eq(r2.findings[0].kind, 'eligibility_mismatch', 'it stays a real eligibility mismatch');
  }

  // ---- an engine throw is recorded, never crashes the batch -----------------
  {
    const { scenarios } = M.buildMatrix({ ltv: [70, 75, 80] });
    const { results, summary } = await S.runShadow(scenarios, {
      ours: (s) => { if (s.ltv === 75) throw new Error('boom'); return { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] }; },
      theirs: engine(() => 0),
    }, { priceToleranceMilli: 0 });
    eq(results.length, 3, 'batch completed despite a throw');
    eq(summary.errors, 1, 'one engine error tallied');
    const err = results.find((r) => r.error);
    eq(err.error, 'ours', 'error side recorded');
    eq(err.findings[0].kind, S.ERROR_KIND, 'engine_error finding kind');
    ok(err.findings[0].detail.includes('boom'), 'error detail carries the message');
    eq(summary.disagreed, 1, 'the errored scenario counts as a disagreement');
  }

  // ---- their-side throw recorded --------------------------------------------
  {
    const { results, summary } = await S.runShadow([{ _label: 'x=1' }], {
      ours: engine(() => 0),
      theirs: () => { throw new Error('LP timeout'); },
    });
    eq(summary.errors, 1, 'theirs throw tallied');
    eq(results[0].error, 'theirs', 'error side is theirs');
    ok(results[0].findings[0].detail.includes('LP timeout'), 'LP error message carried');
  }

  // ---- async engines + bounded concurrency ----------------------------------
  {
    const { scenarios } = M.buildMatrix({ i: [0, 1, 2, 3, 4] });
    let active = 0; let peak = 0;
    const slow = async () => {
      active += 1; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 100000 }] };
    };
    const { summary } = await S.runShadow(scenarios, { ours: slow, theirs: slow }, { concurrency: 2 });
    eq(summary.scenarios, 5, 'all async scenarios ran');
    ok(peak <= 2, `concurrency bounded (peak ${peak} <= 2)`);
  }

  // ---- onResult reporter called per scenario, a throwing reporter contained --
  {
    const { scenarios } = M.buildMatrix({ i: [0, 1] });
    let calls = 0;
    const { summary } = await S.runShadow(scenarios, { ours: engine(() => 0), theirs: engine(() => 0) }, {
      onResult: () => { calls += 1; throw new Error('reporter blew up'); },
    });
    eq(calls, 2, 'onResult called for each scenario');
    eq(summary.scenarios, 2, 'a throwing reporter never breaks the run');
  }

  // ---- missing engines rejects ----------------------------------------------
  {
    let threw = false;
    try { await S.runShadow([], {}); } catch (_) { threw = true; }
    ok(threw, 'runShadow requires ours + theirs');
  }

  // ---- a scenario with no _label falls back to describeScenario -------------
  {
    const { results } = await S.runShadow([{ fico: 740, ltv: 70 }], {
      ours: engine((s) => (s.ltv === 70 ? 9 : 0)),
      theirs: engine(() => 0),
    }, { priceToleranceMilli: 0 });
    eq(results[0].scenario, 'fico=740 ltv=70', 'no _label -> describeScenario tag');
    ok(results[0].findings[0].scenario === 'fico=740 ltv=70', 'finding carries the derived tag');
  }

  // ---- empty batch ----------------------------------------------------------
  {
    const { results, summary } = await S.runShadow([], { ours: engine(() => 0), theirs: engine(() => 0) });
    eq(results.length, 0, 'empty batch -> no results');
    eq(summary.agreementRate, null, 'empty batch agreement rate is null');
  }

  console.log(`ok - lt ppe shadow runner (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
