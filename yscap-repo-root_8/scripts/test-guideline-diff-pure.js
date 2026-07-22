'use strict';
/**
 * R5.34 — pure tests for the guideline semantic diff. Guarantees: added /
 * removed / changed rules are detected by rule_key, a nested key-order-only
 * difference is NOT a change, and a materiality escalation is flagged.
 */
const assert = require('assert');
const { diff, describe } = require('../src/lib/underwriting/guideline-diff');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const prev = [
  { rule_key: 'max_ltv', scope: {}, expression: {}, outcome: { max_ltv: 0.75 }, materiality: 'material', exception_allowed: true },
  { rule_key: 'min_fico', scope: {}, expression: {}, outcome: { min_fico: 680 }, materiality: 'material', exception_allowed: false },
  { rule_key: 'legacy_rule', scope: {}, expression: {}, outcome: { x: 1 }, materiality: 'info', exception_allowed: false },
];
const next = [
  // unchanged (only nested key order differs in outcome — must NOT count as changed)
  { rule_key: 'max_ltv', scope: {}, expression: {}, outcome: { max_ltv: 0.75 }, materiality: 'material', exception_allowed: true },
  // changed: fico tightened + materiality escalated to hard_stop
  { rule_key: 'min_fico', scope: {}, expression: {}, outcome: { min_fico: 700 }, materiality: 'hard_stop', exception_allowed: false },
  // added
  { rule_key: 'new_reserve_rule', scope: {}, expression: {}, outcome: { months: 6 }, materiality: 'material', exception_allowed: false },
  // legacy_rule removed
];

const d = diff(prev, next);

assert.strictEqual(d.summary.added, 1, 'one added');
assert.strictEqual(d.added[0].rule_key, 'new_reserve_rule');
assert.strictEqual(d.summary.removed, 1, 'one removed');
assert.strictEqual(d.removed[0].rule_key, 'legacy_rule');
assert.strictEqual(d.summary.changed, 1, 'one changed');
assert.strictEqual(d.changed[0].rule_key, 'min_fico');
assert.strictEqual(d.summary.unchanged, 1, 'max_ltv unchanged');
assert.ok(d.hasChanges);
ok('added / removed / changed / unchanged counted correctly');

// changed fields name outcome + materiality.
const fields = d.changed[0].fields.map((f) => f.field).sort();
assert.deepStrictEqual(fields, ['materiality', 'outcome']);
ok('changed rule reports exactly the fields that differ');

// materiality escalation flagged as stricter.
assert.strictEqual(d.materialityEscalations.length, 1);
assert.strictEqual(d.materialityEscalations[0].rule_key, 'min_fico');
assert.strictEqual(d.materialityEscalations[0].stricter, true, 'material → hard_stop is stricter');
ok('materiality escalation is flagged as stricter');

// identical rule sets → no changes.
const same = diff(prev, prev);
assert.strictEqual(same.hasChanges, false);
assert.strictEqual(same.summary.unchanged, 3);
ok('identical rule sets produce no changes');

// nested key-order-only difference is NOT a change.
const a = [{ rule_key: 'r', scope: { a: 1, b: 2 }, expression: {}, outcome: { x: { p: 1, q: 2 } }, materiality: 'info' }];
const b = [{ rule_key: 'r', scope: { b: 2, a: 1 }, expression: {}, outcome: { x: { q: 2, p: 1 } }, materiality: 'info' }];
assert.strictEqual(diff(a, b).hasChanges, false, 'key-order-only difference is not a change');
ok('nested key-order-only difference is not a change');

// describe produces one line per change.
const lines = describe(d);
assert.strictEqual(lines.length, 3, '1 added + 1 removed + 1 changed');
ok('describe() renders one plain line per change');

// empty inputs safe.
assert.strictEqual(diff([], []).hasChanges, false);
assert.strictEqual(diff(null, null).summary.added, 0);
ok('empty/null inputs are safe');

console.log(`\nR5.34 guideline-diff pure — ${passed} checks passed`);
