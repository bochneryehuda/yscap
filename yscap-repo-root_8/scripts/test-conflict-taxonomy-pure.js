'use strict';
/**
 * R5.21 — pure tests for the conflict taxonomy pre-classifier. The load-bearing
 * guarantee: the deterministic cases (identical, formatting-equivalent,
 * superseded, timing, role, incomplete) are settled WITHOUT calling it a
 * true_conflict, and only a real same-role/same-timing difference is deferred
 * for adjudication — so a finding is never raised from a benign difference.
 */
const assert = require('assert');
const { classify, CONDITION_ELIGIBLE } = require('../src/lib/underwriting/conflict-taxonomy');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// identical → no_conflict, not condition-eligible.
let v = classify({ value: '850000' }, { value: '850,000' });
assert.strictEqual(v.category, 'formatting_equivalent', 'same amount diff formatting');
assert.strictEqual(v.conditionEligible, false);
ok('money with different formatting is formatting_equivalent (not a conflict)');

v = classify({ value: 'ABC Property Holdings LLC' }, { value: 'A.B.C. Property Holdings, L.L.C.' }, { entityLike: true });
assert.strictEqual(v.category, 'formatting_equivalent', 'same entity diff punctuation');
ok('an entity with different punctuation/suffix is formatting_equivalent');

v = classify({ value: 'Main Street' }, { value: 'Main Street' });
assert.strictEqual(v.category, 'no_conflict');
ok('identical values are no_conflict');

// incomplete evidence.
v = classify({ value: '' }, { value: 'x' });
assert.strictEqual(v.category, 'incomplete_evidence');
assert.strictEqual(v.conditionEligible, false);
ok('a missing side is incomplete_evidence');

// superseded source.
v = classify({ value: 'Old Entity LLC', sourceStatus: 'superseded' }, { value: 'New Entity LLC', sourceStatus: 'active' });
assert.strictEqual(v.category, 'superseded_source');
ok('a value from a superseded document is superseded_source');

// role difference.
v = classify({ value: 'John Smith', role: 'seller' }, { value: 'Jane Doe', role: 'buyer' });
assert.strictEqual(v.category, 'role_difference');
ok('different roles → role_difference');

// timing difference.
v = classify({ value: '5000', asOf: '2026-05-31' }, { value: '7000', asOf: '2026-06-30' });
assert.strictEqual(v.category, 'timing_difference');
ok('same field, different as-of dates → timing_difference');

// a real same-role/same-timing difference defers to adjudication (NOT a guessed conflict).
v = classify({ value: '850000', role: 'price', asOf: '2026-06-01' }, { value: '900000', role: 'price', asOf: '2026-06-01' });
assert.strictEqual(v.category, 'needs_adjudication', 'a real difference is never auto-called a true_conflict');
assert.strictEqual(v.conditionEligible, false, 'needs_adjudication is not yet condition-eligible');
ok('a genuine same-role/same-timing difference defers to the adjudicator');

// only true_conflict + material_rule_breach are condition-eligible.
assert.ok(CONDITION_ELIGIBLE.has('true_conflict') && CONDITION_ELIGIBLE.has('material_rule_breach'));
assert.strictEqual(CONDITION_ELIGIBLE.size, 2, 'exactly two categories support a condition');
ok('only true_conflict + material_rule_breach can support a condition');

console.log(`\nR5.21 conflict-taxonomy pure — ${passed} checks passed`);
