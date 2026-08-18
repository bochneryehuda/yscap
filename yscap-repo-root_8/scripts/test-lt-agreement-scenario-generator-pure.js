#!/usr/bin/env node
'use strict';
/**
 * LT PPE #49 part 1 — the SCALED per-program SCENARIO AUTO-GENERATOR (agreement-scenarios.js). PURE,
 * offline, no DB, no network, no RTL imports.
 *
 * Proves the coverage GUARANTEE: given a compiled program, buildAgreementScenarios emits a bounded,
 * deterministic battery in which EVERY encoded rule/LLPA cell is targeted by at least one scenario,
 * and every "targeted" claim is VERIFIED against the real rules.js evaluator — plus the dead-rule
 * guard: a rule nothing can satisfy is surfaced, never silently counted as covered.
 *
 * PROVEN TO FAIL (mutation): replacing one rule's `when` with a self-contradictory predicate flips
 * coverage.complete to false and lists that rule in `uncovered` — the CONTROL (unmutated program) is
 * green on either side. Removing a targeting scenario would break the per-rule scenarioIndex link.
 */
const { buildProgramAgreementScenarios: buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenario-generator');
const { evalPredicate } = require('../src/longterm/ppe/rules');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

// A compiled program in the exact shape quote.quoteProgram prices — one rule per cell.
function makeProgram() {
  return {
    code: 'TEST', name: 'Test DSCR',
    baseGrid: [{ rate: 7000, lockDays: 30, basePriceMilli: 101000 }, { rate: 7250, lockDays: 30, basePriceMilli: 102000 }],
    rules: [
      { code: 'llpa_fico_740_760', kind: 'pricing', when: { fact: 'fico', op: 'between', value: [740, 760] }, adjustment: { dimension: 'fico', adjMilli: 250, unit: 'points', reason: 'FICO 740-759' } },
      { code: 'llpa_ltv_gte75', kind: 'pricing', when: { fact: 'ltv', op: 'gte', value: 75000 }, adjustment: { dimension: 'ltv', adjMilli: 500, unit: 'points', reason: 'LTV>=75' } },
      { code: 'elig_fico_min', kind: 'eligibility', when: { fact: 'fico', op: 'lt', value: 660 }, declineReason: 'FICO below 660', dimension: 'fico' },
      { code: 'bound_ltv_max', kind: 'bound', when: null, target: 'ltv', op: 'max', value: 80000 },
      { code: 'elig_prepay_ny', kind: 'eligibility', when: { all: [{ fact: 'prepay', op: 'eq', value: 'none' }, { fact: 'state', op: 'eq', value: 'NY' }] }, declineReason: 'No-prepay not allowed in NY', dimension: 'prepay' },
    ],
  };
}
const AXES = { purpose: ['purchase', 'refinance', 'cashout'], units: [1, 2, 4], occupancy: ['investment', 'primary'] };
const BASE = { term: 30, lock_days: 30, product: '30yr' };

console.log('#49.1 scenario auto-generator — coverage completeness + dead-rule guard');

// ---- CONTROL: every rule targeted, and every targeting proven by the real evaluator ----
const r = buildAgreementScenarios({ program: makeProgram(), axes: AXES, base: BASE, opts: { maxScenarios: 400 } });
ok(r.coverage.total === 5, 'COV-1 all 5 rules accounted for');
ok(r.coverage.complete === true, 'COV-2 coverage complete — every encoded cell targeted at least once');
ok(r.coverage.uncovered.length === 0, 'COV-3 nothing uncovered');
ok(r.coverage.rules.every((rc) => rc.targeted), 'COV-4 every rule row targeted:true');

// each "targeted" claim must actually fire the rule's predicate on its scenario — proof, not assertion
const byCode = new Map(makeProgram().rules.map((x) => [x.code, x]));
let proven = 0;
for (const rc of r.coverage.rules) {
  const sc = r.scenarios[rc.scenarioIndex];
  const rule = byCode.get(rc.code);
  if (sc && evalPredicate(rule.when, sc).value === true) proven += 1;
}
ok(proven === 5, 'COV-5 every targeting scenario genuinely FIRES its rule under the real rules.js evaluator');

// coverage metadata names the dimension read from the rule (not guessed)
const prepay = r.coverage.rules.find((x) => x.code === 'elig_prepay_ny');
ok(prepay && prepay.dimension === 'prepay', 'COV-6 each rule row carries the dimension read from the rule');

// ---- determinism + bounded + de-dupe + no silent caps ----
const r2 = buildAgreementScenarios({ program: makeProgram(), axes: AXES, base: BASE, opts: { maxScenarios: 400 } });
ok(JSON.stringify(r.scenarios) === JSON.stringify(r2.scenarios), 'DET-1 deterministic — same battery every run');
ok(r.scenarios.length <= 400, 'BND-1 bounded by maxScenarios');
ok(r.meta.total === r.scenarios.length && typeof r.meta.truncated === 'boolean', 'BND-2 meta reports total + truncation (no silent caps)');
const keys = new Set(r.scenarios.map((s) => JSON.stringify(Object.fromEntries(Object.keys(s).filter((k) => k[0] !== '_').sort().map((k) => [k, s[k]])))));
ok(keys.size === r.scenarios.length, 'DED-1 no two scenarios share the same fact bag');
ok(r.scenarios.every((s, i) => s._index === i && typeof s._label === 'string'), 'DED-2 each scenario carries a stable _index + _label');
ok(r.meta.axesCount > 0 && r.meta.edgeCount > 0, 'LYR-1 edge + axes layers contributed scenarios');

// ---- MUTATION: one rule made unsatisfiable ⇒ coverage incomplete + surfaced (dead-rule guard) ----
const mutated = makeProgram();
mutated.rules[0].when = { all: [{ fact: 'fico', op: 'lt', value: 600 }, { fact: 'fico', op: 'gte', value: 700 }] }; // contradictory
const rm = buildAgreementScenarios({ program: mutated, axes: AXES, base: BASE, opts: { maxScenarios: 400 } });
ok(rm.coverage.complete === false, 'MUT-1 a contradictory rule flips coverage.complete to false');
ok(rm.coverage.uncovered.includes('llpa_fico_740_760'), 'MUT-2 the unreachable rule is listed in uncovered (surfaced, not dropped)');
const deadRow = rm.coverage.rules.find((x) => x.code === 'llpa_fico_740_760');
ok(deadRow && deadRow.targeted === false && deadRow.reason === 'unsatisfiable_by_synthesis' && deadRow.scenarioIndex === null,
  'MUT-3 the dead rule row is targeted:false with a reason and no scenario');
ok(r.coverage.complete === true, 'MUT-4 CONTROL — the unmutated program stays complete (green on either side)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
