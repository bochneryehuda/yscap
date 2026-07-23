'use strict';
/**
 * #192 — pure tests for the guideline-intelligence ORCHESTRATOR. Proves the
 * composition of evaluator + precedence + citation + investor-fit against the
 * ACTUAL seed-rule shapes from db/260 (Standard/Gold program rules): scope gates
 * applicability, an empty expression is a "noted" recorded fact, a failed test on
 * a KNOWN value is a violation, a failed test on an UNKNOWN value is only
 * "indeterminate" (never a false breach), a hard_stop violation blocks the fit,
 * precedence resolves per rule_key, and the report never throws on hostile input.
 */
const assert = require('assert');
const gi = require('../src/lib/underwriting/guideline-intelligence');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// The real db/260 Standard rule shapes.
const STANDARD_RULES = [
  { rule_key: 'fico_floor', scope: {}, expression: { field: 'fico', cmp: '>=', value: 600 },
    outcome: { min_fico: 600, below: 'ineligible' }, materiality: 'hard_stop' },
  { rule_key: 'statement_months', scope: {}, expression: {}, outcome: { statement_months: 1 }, materiality: 'material' },
  { rule_key: 'assignment_fee_cap', scope: { is_assignment: true }, expression: {},
    outcome: { financeable_fee_pct_of_seller_price: 0.15 }, materiality: 'material' },
];
const GOLD_SOW = { rule_key: 'sow_contingency', scope: {}, expression: { field: 'sow_contingency_pct', cmp: '>=', value: 0.05 },
  outcome: { min_contingency_pct: 0.05 }, materiality: 'material' };

// 1. scopeMatches: {} matches everything; {is_assignment:true} gates; array "one of"; unknown field never matches.
{
  assert.strictEqual(gi.scopeMatches({}, { anything: 1 }), true);
  assert.strictEqual(gi.scopeMatches({ is_assignment: true }, { is_assignment: true }), true);
  assert.strictEqual(gi.scopeMatches({ is_assignment: true }, { is_assignment: false }), false);
  assert.strictEqual(gi.scopeMatches({ property_state: ['ny', 'nj'] }, { property_state: 'NY' }), true, 'array scope + case-insensitive');
  assert.strictEqual(gi.scopeMatches({ property_state: 'ny' }, {}), false, 'unknown scope field never assumed to apply');
  ok('scopeMatches: empty=all, flag gate, array one-of (case-insensitive), unknown field never matches');
}

// 2. A clean Standard file (fico 720, not an assignment): fico met, statements noted, assignment N/A, eligible.
{
  const set = gi.evaluateGuidelineSet({ rules: STANDARD_RULES, context: { fico: 720, is_assignment: false }, source: 'program_base' });
  const byKey = Object.fromEntries(set.rules.map((r) => [r.ruleKey, r]));
  assert.strictEqual(byKey.fico_floor.verdict, 'met');
  assert.strictEqual(byKey.statement_months.verdict, 'noted', 'empty expression = a recorded fact, not a pass/fail');
  assert.strictEqual(byKey.assignment_fee_cap.verdict, 'not_applicable', 'scope is_assignment gates it out on a purchase');
  assert.strictEqual(set.eligible, true);
  assert.strictEqual(set.summary.applicable, 2, 'only the two {}-scoped rules apply');
  assert.strictEqual(set.summary.blockers, 0);
  ok('clean Standard file: fico met, statements noted, assignment N/A, eligible');
}

// 3. fico below the floor is a VIOLATION and a blocker (hard_stop → fatal); the citation explains why.
{
  const set = gi.evaluateGuidelineSet({ rules: STANDARD_RULES, context: { fico: 580, is_assignment: false }, source: 'program_base' });
  const fico = set.rules.find((r) => r.ruleKey === 'fico_floor');
  assert.strictEqual(fico.verdict, 'violated');
  assert.strictEqual(fico.severity, 'fatal');
  assert.strictEqual(set.eligible, false);
  assert.strictEqual(set.summary.blockers, 1);
  assert.ok(fico.citation && Array.isArray(fico.citation.reasons) && fico.citation.reasons.length >= 1, 'a plain-language reason is produced');
  assert.ok(/600/.test(fico.citation.reasons[0]), 'the reason cites the 600 floor');
  ok('fico below 600 → violated + fatal blocker → set ineligible, with a cited reason');
}

// 4. fico UNKNOWN is indeterminate, NOT a violation — and it does not block eligibility.
{
  const set = gi.evaluateGuidelineSet({ rules: STANDARD_RULES, context: { is_assignment: false }, source: 'program_base' });
  const fico = set.rules.find((r) => r.ruleKey === 'fico_floor');
  assert.strictEqual(fico.verdict, 'indeterminate', 'a missing value is never reported as a breach');
  assert.strictEqual(set.summary.violated, 0);
  assert.strictEqual(set.summary.indeterminate, 1);
  assert.strictEqual(set.eligible, true, 'unknown data does not make a file ineligible');
  ok('fico unknown → indeterminate (never a false violation), stays eligible');
}

// 5. Gold SOW contingency: 0.03 violates, 0.06 meets, absent is indeterminate.
{
  const lo = gi.evaluateGuidelineSet({ rules: [GOLD_SOW], context: { sow_contingency_pct: 0.03 } });
  const hi = gi.evaluateGuidelineSet({ rules: [GOLD_SOW], context: { sow_contingency_pct: 0.06 } });
  const none = gi.evaluateGuidelineSet({ rules: [GOLD_SOW], context: {} });
  assert.strictEqual(lo.rules[0].verdict, 'violated');
  assert.strictEqual(hi.rules[0].verdict, 'met');
  assert.strictEqual(none.rules[0].verdict, 'indeterminate');
  ok('Gold sow_contingency: 3% violates, 6% meets, missing is indeterminate');
}

// 6. An APPROVED exception downgrades a violation out of the blocker set (still shown as a note).
{
  const set = gi.evaluateGuidelineSet({
    rules: STANDARD_RULES, context: { fico: 580, is_assignment: false },
    source: 'program_base', exceptedKeys: ['fico_floor'],
  });
  assert.strictEqual(set.eligible, true, 'an approved exception clears the block');
  assert.strictEqual(set.summary.blockers, 0);
  assert.ok(set.fitResult.notes.some((n) => /exception/.test(n)), 'the honored exception is surfaced as a note');
  ok('an approved exception downgrades a hard_stop violation out of the blockers');
}

// 7. Precedence RUNS: two same-key rules that agree → apply; that disagree → abstain (never a silent pick).
{
  const agree = gi.evaluateGuidelineSet({ rules: [
    { rule_key: 'max_ltv', scope: {}, expression: {}, outcome: { max: 0.75 }, materiality: 'material' },
    { rule_key: 'max_ltv', scope: {}, expression: {}, outcome: { max: 0.75 }, materiality: 'material' },
  ], context: {} });
  assert.strictEqual(agree.resolved.max_ltv.decision, 'apply');
  const disagree = gi.evaluateGuidelineSet({ rules: [
    { rule_key: 'max_ltv', scope: {}, expression: {}, outcome: { max: 0.75 }, materiality: 'material' },
    { rule_key: 'max_ltv', scope: {}, expression: {}, outcome: { max: 0.80 }, materiality: 'material' },
  ], context: {} });
  assert.strictEqual(disagree.resolved.max_ltv.decision, 'abstain', 'same-tier disagreement abstains for a human');
  ok('precedence resolves per rule_key: agreement applies, disagreement abstains');
}

// 8. rankSets across a fitting program set and a failing investor set → best = the fit, with differentiators.
{
  const good = gi.evaluateGuidelineSet({ rules: STANDARD_RULES, context: { fico: 720, is_assignment: false }, source: 'program_base', label: 'Standard program' });
  const bad = gi.evaluateGuidelineSet({ rules: [{ rule_key: 'fico_floor', scope: {}, expression: { field: 'fico', cmp: '>=', value: 740 }, outcome: {}, materiality: 'hard_stop' }],
    context: { fico: 720 }, source: 'investor_hard', label: 'Acme Capital' });
  const fit = gi.rankSets([good, bad]);
  assert.strictEqual(fit.anyFit, true);
  assert.strictEqual(fit.best, 'Standard program');
  assert.strictEqual(fit.ranked[0].fit, 'fits');
  assert.strictEqual(fit.ranked[1].fit, 'fails');
  assert.ok(fit.comparison.length >= 1 && fit.comparison[0].differentiators.length >= 1, 'the A-vs-B differentiator is explained');
  ok('rankSets ranks the fitting program over the failing investor and explains the difference');
}

// 8b. Compound expressions: an UNKNOWN branch of an OR must not read as a
// violation while it could still pass; a fully-known OR failure IS a violation;
// an AND with any known-false leaf is a violation regardless of unknowns.
{
  const OR_RULE = [{ rule_key: 'alt_qual', scope: {}, materiality: 'hard_stop',
    expression: { op: 'or', clauses: [{ field: 'fico', cmp: '>=', value: 740 }, { field: 'dscr', cmp: '>=', value: 1.2 }] }, outcome: {} }];
  const unknownBranch = gi.evaluateGuidelineSet({ rules: OR_RULE, context: { fico: 720 } }); // dscr unknown
  assert.strictEqual(unknownBranch.rules[0].verdict, 'indeterminate', 'a known-false OR branch with an unknown sibling is NOT a violation');
  assert.strictEqual(unknownBranch.eligible, true, 'unknown data never blocks');
  const bothKnownFail = gi.evaluateGuidelineSet({ rules: OR_RULE, context: { fico: 720, dscr: 1.0 } });
  assert.strictEqual(bothKnownFail.rules[0].verdict, 'violated', 'a fully-known OR failure is a real violation');

  const AND_RULE = [{ rule_key: 'both', scope: {}, materiality: 'hard_stop',
    expression: { op: 'and', clauses: [{ field: 'fico', cmp: '>=', value: 600 }, { field: 'dscr', cmp: '>=', value: 1.2 }] }, outcome: {} }];
  const andKnownFalse = gi.evaluateGuidelineSet({ rules: AND_RULE, context: { fico: 580 } }); // dscr unknown, fico fails
  assert.strictEqual(andKnownFalse.rules[0].verdict, 'violated', 'an AND with a known-false leaf is a violation regardless of unknowns');
  ok('compound and/or: unknown OR-branch → indeterminate, known OR-failure → violated, known-false AND leaf → violated');
}

// 9. Hostile input never throws — degrades to a safe empty report.
{
  const bad1 = gi.evaluateGuidelineSet(null);
  const bad2 = gi.evaluateGuidelineSet({ rules: [null, 42, { rule_key: 'x', scope: 7, expression: 'nope' }], context: null });
  assert.strictEqual(bad1.eligible, true);
  assert.ok(Array.isArray(bad2.rules));
  assert.deepStrictEqual(gi.rankSets('not-an-array').ranked, []);
  ok('hostile input degrades to a safe empty report, never throws');
}

console.log(`\nguideline-intelligence pure — ${passed} checks passed`);
