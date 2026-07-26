'use strict';
/**
 * R5.35 core — pure tests for the precedence resolver. The load-bearing
 * guarantee: a higher-authority tier always wins, an approved investor
 * exception beats the investor hard rule, advisory (historical) rules never
 * bind, and a same-tier disagreement ABSTAINS (never silently picks one).
 */
const assert = require('assert');
const P = require('../src/lib/underwriting/guideline-precedence');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// higher authority (lower tier number) wins.
let r = P.resolveRuleKey([
  { source: 'program_base', outcome: { max_ltv: 0.75 } },
  { source: 'state', outcome: { max_ltv: 0.70 } },
]);
assert.strictEqual(r.decision, 'apply');
assert.deepStrictEqual(r.winner.outcome, { max_ltv: 0.70 }, 'state overlay beats program base');
assert.strictEqual(r.tier, P.TIERS.state);
ok('lower tier number wins (state > program base)');

// An approved investor exception overrides the PROGRAM BASE rule (tier 60)…
r = P.resolveRuleKey([
  { source: 'program_base', outcome: { max_ltv: 0.75 } },
  { source: 'investor_exception', outcome: { max_ltv: 0.80 } },
]);
assert.strictEqual(r.decision, 'apply');
assert.deepStrictEqual(r.winner.outcome, { max_ltv: 0.80 }, 'approved exception overrides the base rule');
ok('approved investor exception overrides the program base rule');

// …but it does NOT override a genuine investor HARD rule or a law/state cap
// (you cannot except away a hard stop — the spec puts investor_hard above the
// exception layer). Here the investor hard 0.75 wins over the exception's 0.80.
r = P.resolveRuleKey([
  { source: 'investor_hard', outcome: { max_ltv: 0.75 } },
  { source: 'investor_exception', outcome: { max_ltv: 0.80 } },
]);
assert.strictEqual(r.decision, 'apply');
assert.deepStrictEqual(r.winner.outcome, { max_ltv: 0.75 }, 'an exception cannot override an investor hard rule');
ok('an exception cannot override an investor hard rule / law / state cap');

// advisory (historical) rules never bind.
r = P.resolveRuleKey([{ source: 'historical', outcome: { max_ltv: 0.90 } }]);
assert.strictEqual(r.decision, 'none', 'only advisory → no binding decision');
r = P.resolveRuleKey([
  { source: 'program_base', outcome: { max_ltv: 0.75 } },
  { source: 'historical', outcome: { max_ltv: 0.90 } },
]);
assert.strictEqual(r.decision, 'apply');
assert.deepStrictEqual(r.winner.outcome, { max_ltv: 0.75 }, 'historical is ignored next to a base rule');
ok('advisory/historical rules never bind');

// explicit advisory flag also excluded even at a binding tier.
r = P.resolveRuleKey([{ source: 'program_base', outcome: { x: 1 }, advisory: true }]);
assert.strictEqual(r.decision, 'none');
ok('explicit advisory flag excludes a rule from binding');

// same-tier disagreement ABSTAINS.
r = P.resolveRuleKey([
  { source: 'investor_hard', outcome: { max_ltv: 0.75 }, rule_id: 'a' },
  { source: 'investor_hard', outcome: { max_ltv: 0.70 }, rule_id: 'b' },
]);
assert.strictEqual(r.decision, 'abstain', 'a same-tier conflict must abstain, never pick one');
assert.strictEqual(r.conflicting.length, 2);
ok('same-tier disagreement abstains (asks an admin)');

// same-tier AGREEMENT applies (no false abstain).
r = P.resolveRuleKey([
  { source: 'investor_hard', outcome: { max_ltv: 0.75 } },
  { source: 'investor_hard', outcome: { max_ltv: 0.75 } },
]);
assert.strictEqual(r.decision, 'apply', 'identical same-tier outcomes are not a conflict');
ok('same-tier agreement applies');

// numeric precedence_tier overrides the source label.
r = P.resolveRuleKey([
  { precedence_tier: 10, outcome: { stop: true } },
  { source: 'program_base', outcome: { stop: false } },
]);
assert.deepStrictEqual(r.winner.outcome, { stop: true }, 'law/compliance tier 10 wins');
ok('explicit precedence_tier is honored');

// empty / no-outcome.
assert.strictEqual(P.resolveRuleKey([]).decision, 'none');
assert.strictEqual(P.resolveRuleKey([{ source: 'state' }]).decision, 'none', 'a rule with no outcome does not apply');
ok('empty / outcome-less inputs yield none');

// resolveAll maps keys.
const all = P.resolveAll({ max_ltv: [{ source: 'state', outcome: { v: 0.7 } }], min_fico: [] });
assert.strictEqual(all.max_ltv.decision, 'apply');
assert.strictEqual(all.min_fico.decision, 'none');
ok('resolveAll resolves a whole rule map');

console.log(`\nR5.35 precedence pure — ${passed} checks passed`);
