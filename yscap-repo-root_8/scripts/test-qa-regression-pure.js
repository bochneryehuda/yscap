'use strict';
/**
 * R5.65 — pure tests for the QA-miss → evaluation-case converter. Guarantees:
 * only genuine DECISION errors become fixtures (a duplicate condition does
 * NOT), each fixture is high-risk with a valid taxonomy cause, and a batch
 * dedupes by key.
 */
const assert = require('assert');
const { toEvaluationCase, fixturesFromMisses, isFixtureWorthy } = require('../src/lib/underwriting/qa-regression');
const taxonomy = require('../src/lib/underwriting/error-taxonomy');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// fatal_advanced → a high-risk fixture with a valid cause.
let c = toEvaluationCase({ kind: 'fatal_advanced', applicationId: 'app-1', snapshot: { s: 1 } });
assert.ok(c);
assert.strictEqual(c.risk_tier, 'high');
assert.strictEqual(c.expected.outcome, 'block_advance_until_fatal_resolved');
assert.ok(taxonomy.isValidCause(c.primary_cause), 'primary cause is a valid taxonomy key');
assert.strictEqual(c.dedupe_key, 'qa:fatal_advanced:app-1');
ok('fatal_advanced becomes a high-risk fixture with a valid cause');

// cleared_without_evidence → a false-clear fixture.
c = toEvaluationCase({ kind: 'cleared_without_evidence', applicationId: 'app-2' });
assert.strictEqual(c.expected.outcome, 'not_cleared_without_current_document');
assert.strictEqual(c.primary_cause, 'condition_requirement');
ok('cleared_without_evidence becomes a false-clear fixture');

// a duplicate condition is NOT a decision error → no fixture.
assert.strictEqual(toEvaluationCase({ kind: 'duplicate_condition', applicationId: 'app-3' }), null);
assert.strictEqual(isFixtureWorthy('duplicate_condition'), false);
assert.strictEqual(isFixtureWorthy('fatal_advanced'), true);
ok('a duplicate condition is not turned into a fixture (not a decision error)');

// an unknown kind → null.
assert.strictEqual(toEvaluationCase({ kind: 'made_up' }), null);
assert.strictEqual(toEvaluationCase(null), null);
ok('an unknown / empty miss → null');

// a batch drops non-fixtures + dedupes by key.
const fixtures = fixturesFromMisses([
  { kind: 'fatal_advanced', applicationId: 'app-1' },
  { kind: 'fatal_advanced', applicationId: 'app-1' },   // duplicate → deduped
  { kind: 'duplicate_condition', applicationId: 'app-1' }, // dropped
  { kind: 'cleared_without_evidence', applicationId: 'app-9' },
]);
assert.strictEqual(fixtures.length, 2, 'deduped + non-decision-errors dropped');
const keys = fixtures.map((f) => f.dedupe_key).sort();
assert.deepStrictEqual(keys, ['qa:cleared_without_evidence:app-9', 'qa:fatal_advanced:app-1']);
ok('a batch drops non-fixtures + dedupes by key');

console.log(`\nR5.65 qa-regression pure — ${passed} checks passed`);
