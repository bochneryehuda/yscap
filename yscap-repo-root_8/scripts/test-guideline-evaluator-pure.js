'use strict';
/**
 * R5.35 (evaluator) — pure tests. Guarantees: comparators behave, a missing
 * field is "unmet" (never a silent pass), boolean nesting works, and an unknown
 * operator/comparator THROWS (a malformed rule never quietly passes).
 */
const assert = require('assert');
const { evaluate } = require('../src/lib/underwriting/guideline-evaluator');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// leaf comparators.
assert.strictEqual(evaluate({ field: 'ltv', cmp: '<=', value: 0.75 }, { ltv: 0.70 }).matched, true);
assert.strictEqual(evaluate({ field: 'ltv', cmp: '<=', value: 0.75 }, { ltv: 0.80 }).matched, false);
assert.strictEqual(evaluate({ field: 'fico', cmp: '>=', value: 680 }, { fico: 700 }).matched, true);
assert.strictEqual(evaluate({ field: 'state', cmp: 'in', value: ['NY', 'NJ'] }, { state: 'ny' }).matched, true, 'in is case-insensitive');
assert.strictEqual(evaluate({ field: 'm', cmp: 'between', value: [3, 12] }, { m: 12 }).matched, true);
assert.strictEqual(evaluate({ field: 'm', cmp: 'between', value: [3, 12] }, { m: 13 }).matched, false);
ok('leaf comparators (<=, >=, in, between) evaluate correctly');

// missing field is unmet, never a silent pass.
const r = evaluate({ field: 'dscr', cmp: '>=', value: 1.1 }, {});
assert.strictEqual(r.matched, false);
assert.strictEqual(r.unmet.length, 1);
assert.strictEqual(r.unmet[0].actual, null);
ok('a missing field is unmet (never a silent pass)');

// and / or / not.
assert.strictEqual(evaluate({ op: 'and', clauses: [
  { field: 'ltv', cmp: '<=', value: 0.75 },
  { field: 'fico', cmp: '>=', value: 680 },
]}, { ltv: 0.7, fico: 700 }).matched, true);
assert.strictEqual(evaluate({ op: 'and', clauses: [
  { field: 'ltv', cmp: '<=', value: 0.75 },
  { field: 'fico', cmp: '>=', value: 680 },
]}, { ltv: 0.7, fico: 600 }).matched, false, 'AND fails if any clause fails');
assert.strictEqual(evaluate({ op: 'or', clauses: [
  { field: 'a', cmp: '==', value: 1 }, { field: 'b', cmp: '==', value: 2 },
]}, { a: 9, b: 2 }).matched, true, 'OR passes if any clause passes');
assert.strictEqual(evaluate({ op: 'not', clause: { field: 'flag', cmp: '==', value: true } }, { flag: false }).matched, true);
ok('and / or / not compose correctly');

// AND collects every unmet clause (for a plain-English "why not").
const a = evaluate({ op: 'and', clauses: [
  { field: 'ltv', cmp: '<=', value: 0.75 },
  { field: 'fico', cmp: '>=', value: 680 },
]}, { ltv: 0.9, fico: 600 });
assert.strictEqual(a.matched, false);
assert.strictEqual(a.unmet.length, 2, 'both failing clauses reported');
ok('AND reports every unmet clause');

// empty / null expression = always applies.
assert.strictEqual(evaluate({}, { x: 1 }).matched, true);
assert.strictEqual(evaluate(null, {}).matched, true);
assert.strictEqual(evaluate(true, {}).matched, true);
assert.strictEqual(evaluate(false, {}).matched, false);
ok('empty/null/true/false constants behave');

// unknown comparator / operator THROWS (malformed rule never silently passes).
assert.throws(() => evaluate({ field: 'x', cmp: 'approx', value: 1 }, { x: 1 }), /unknown comparator/);
assert.throws(() => evaluate({ op: 'xor', clauses: [] }, {}), /unknown expression op/);
ok('unknown comparator/operator throws (no silent pass)');

console.log(`\nR5.35 evaluator pure — ${passed} checks passed`);
