'use strict';
/**
 * LT PPE — END-TO-END integration test of the shadow-reliability pipeline. PURE/offline, but uses the
 * REAL pricing engine (quote.quoteProgram) as "our engine" — not a stub — so it proves the module
 * INTERFACES and UNITS actually line up across:
 *   coverage -> shadow -> lp-normalize -> parity -> shadow-report -> finding -> cutover.
 *
 * "Lender Price" is modelled as our own engine's ladder converted to LP units (percent rate / point
 * price), with a deliberate perturbation on cash-out scenarios. That makes the round-trip itself the
 * thing under test: quote's milli units must survive the trip through LP points/percent and back via
 * lp-normalize, or every scenario would falsely "disagree". A real, localized disagreement (cash-out)
 * must then flow all the way to findings, the report, and the cutover gate.
 *
 *   node scripts/test-lt-ppe-shadow-e2e.js
 */

const assert = require('assert');
const { quoteProgram } = require('../src/longterm/ppe/quote');
const coverage = require('../src/longterm/ppe/coverage');
const shadow = require('../src/longterm/ppe/shadow');
const lpNorm = require('../src/longterm/ppe/lp-normalize');
const report = require('../src/longterm/ppe/shadow-report');
const finding = require('../src/longterm/ppe/finding');
const cutover = require('../src/longterm/ppe/cutover');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const NOW = 1_700_000_000_000;
const DAY = cutover.DAY_MS;

// A real program: milli-percent rates, milli-point base prices.
const program = {
  code: 'DHVN_DSCR30', name: 'DSCR 30yr', investorCode: 'DHVN',
  baseGrid: [
    { rate: 70000, lockDays: 30, basePriceMilli: 101500 },
    { rate: 71250, lockDays: 30, basePriceMilli: 102850 },
    { rate: 72500, lockDays: 30, basePriceMilli: 104000 },
  ],
  rules: [
    { code: 'no_ny', kind: 'eligibility', when: { fact: 'state', op: 'eq', value: 'NY' }, declineReason: 'NY not eligible' },
    { code: 'max_ltv', kind: 'bound', target: 'ltv', op: 'max', value: 80000 },
    { code: 'cashout', kind: 'pricing', when: { fact: 'purpose', op: 'eq', value: 'cashout' }, adjustment: { code: 'cashout', category: 'purpose', adjMilli: 500 } },
  ],
};
// rounding 'none' so the milli round-trip through LP points is exact.
const settings = { 'pricing.rounding_mode': 'none', 'pricing.correspondent_margin_milli': 250 };

const ours = (scenario) => quoteProgram({ scenario, program, settings });

// Model LP as ours converted to LP units, with a perturbation on cash-out.
function theirsParsed(scenario, { perturb = true } = {}) {
  const q = ours(scenario);
  if (!q.eligible) return { programs: [] };
  const rungs = q.ladder.map((r) => {
    let price = r.finalPriceMilli / 1000;
    if (perturb && scenario.purpose === 'cashout') price += 0.010; // 10 milli-points -> a real disagreement
    return { rate: r.rate / 1000, price };
  });
  return { programs: [{ program: 'DSCR 30yr', product: 'Fixed', rungs }] };
}
const theirs = (perturb) => (scenario) => lpNorm.normalizeLpParsed(theirsParsed(scenario, { perturb }), { program: 'DSCR 30yr' });

async function main() {
  // Build a battery from coverage (pairwise), merging the fixed facts the grid needs via base.
  const { scenarios } = coverage.pairwise(
    { purpose: ['purchase', 'cashout'], ltv: [70000, 75000], state: ['TX', 'FL'] },
    { base: { lock_days: 30, loan_amount: 500000 } },
  );
  ok(scenarios.length >= 4, 'coverage produced a battery');
  const cashoutCount = scenarios.filter((s) => s.purpose === 'cashout').length;
  const cleanCount = scenarios.length - cashoutCount;
  ok(cashoutCount > 0 && cleanCount > 0, 'battery has both agreeing and disagreeing scenarios');

  // ---- shadow run with a real disagreement on cash-out ----------------------
  {
    const { results, summary } = await shadow.runShadow(scenarios, { ours, theirs: theirs(true) }, { priceToleranceMilli: 0 });
    eq(summary.scenarios, scenarios.length, 'every scenario ran');
    eq(summary.errors, 0, 'no engine errors — the real engine priced every scenario');
    eq(summary.agreed, cleanCount, 'non-cashout scenarios AGREE (milli survives the LP round-trip)');
    eq(summary.disagreed, cashoutCount, 'cash-out scenarios disagree (the perturbation)');
    ok(summary.byKind.price_mismatch >= cashoutCount, 'disagreements are price mismatches');
    // every disagreeing result is a cash-out scenario
    for (const r of results) {
      if (!r.agree) ok(r.scenario.includes('purpose=cashout'), `disagreement is a cash-out scenario: ${r.scenario}`);
    }

    // ---- report ------------------------------------------------------------
    const rep = report.buildReport({ results, summary });
    ok(rep.verdict.includes('disagree'), 'report verdict names disagreements');
    ok(rep.worstPriceGaps.length > 0, 'report ranks the price gaps');
    ok(rep.worstPriceGaps.every((g) => Math.abs(g.deltaMilli) === 10), 'every gap is the 10-milli perturbation');
    const txt = report.renderText({ results, summary });
    ok(txt.includes('Biggest price gaps'), 'text report renders');
    ok(!txt.includes('[object Object]'), 'scenario tags render as labels');

    // ---- findings ledger ---------------------------------------------------
    const incoming = [];
    for (const r of results) {
      incoming.push(...finding.recordsFromComparison({ agree: r.agree, findings: r.findings },
        { scenario: r.scenario, investor: 'DHVN', program: 'DSCR 30yr', nowMs: NOW }));
    }
    const recon = finding.reconcile([], incoming, { nowMs: NOW });
    eq(recon.summary.new, incoming.length, 'first run: all findings new');
    ok(recon.summary.new >= cashoutCount, 'at least one finding per cash-out scenario');

    // ---- cutover gate: open findings + <100% canary -> NOT eligible --------
    const sb = cutover.buildScoreboard({
      canaryAgreementRate: summary.agreementRate,
      findings: recon.records,
      dailyNewFindings: [{ dayMs: NOW, count: recon.summary.new }],
      nowMs: NOW,
    });
    ok(sb.openFindings > 0, 'scoreboard shows open findings');
    const gate = cutover.eligibleForLive(sb);
    eq(gate.eligible, false, 'not eligible for live while findings are open and canary < 100%');
  }

  // ---- a clean run (no perturbation) -> full agreement -> eligible ----------
  {
    const { summary } = await shadow.runShadow(scenarios, { ours, theirs: theirs(false) }, { priceToleranceMilli: 0 });
    eq(summary.disagreed, 0, 'with no perturbation every scenario agrees');
    eq(summary.agreementRate, 1, 'perfect agreement rate');

    // Built from the gate's OWN configured thresholds (§2.73 — the clean-week setting x7, and the
    // coverage floor), so this stays an end-to-end proof and does not silently become an assertion
    // about a particular number of days.
    const strict = cutover.settingsToGate({});
    const sb = cutover.buildScoreboard({
      canaryAgreementRate: summary.agreementRate,
      findings: [], // all resolved
      dailyNewFindings: Array.from({ length: strict.minCleanDays }, (_, i) => ({ dayMs: NOW - i * DAY, count: 0 })),
      nowMs: NOW,
      canaryScenarioCount: strict.minCanaryScenarios,
      canaryIncomparable: 0,
    });
    const gate = cutover.eligibleForLive(sb);
    eq(gate.eligible, true, 'eligible for live: 100% canary + 0 open findings + a full clean streak');
    const t = cutover.transition(cutover.MODES.SHADOW, 'promote', { eligible: gate.eligible });
    eq(t.mode, cutover.MODES.LIVE, 'the investor promotes shadow -> live');
  }

  // ---- an ineligible scenario (NY) agrees as "both ineligible" --------------
  {
    const nyScenario = { state: 'NY', purpose: 'purchase', ltv: 70000, lock_days: 30, loan_amount: 500000 };
    const { results, summary } = await shadow.runShadow([nyScenario], { ours, theirs: theirs(true) }, { priceToleranceMilli: 0 });
    eq(summary.agreed, 1, 'both engines find NY ineligible -> agreement');
    eq(results[0].findings.length, 0, 'no findings on an agreed-ineligible scenario');
  }

  console.log(`ok - lt ppe shadow pipeline e2e (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
