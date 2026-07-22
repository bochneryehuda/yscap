'use strict';
/**
 * R5.43 — pure tests for the error taxonomy. Guarantees: exactly 20 ordered
 * causes, earliest() picks the earliest pipeline stage, and a correction cannot
 * be tagged with a cause outside the taxonomy.
 */
const assert = require('assert');
const T = require('../src/lib/underwriting/error-taxonomy');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// exactly 20 causes, stages 1..20 unique + ordered.
assert.strictEqual(T.CAUSES.length, 20, '20 primary causes');
const stages = T.CAUSES.map((c) => c.stage);
assert.deepStrictEqual(stages, [...stages].sort((a, b) => a - b), 'stages are in ascending order');
assert.strictEqual(new Set(stages).size, 20, 'stages are unique');
ok('exactly 20 ordered, unique-stage causes');

// validity.
assert.ok(T.isValidCause('packet_boundary'));
assert.ok(!T.isValidCause('made_up'));
assert.strictEqual(T.labelOf('ocr'), 'OCR / text read');
assert.strictEqual(T.stageOf('packet_boundary'), 2);
ok('isValidCause / labelOf / stageOf behave');

// earliest picks the earliest-stage cause.
assert.strictEqual(T.earliest(['condition_requirement', 'packet_boundary', 'ai_reasoning']), 'packet_boundary',
  'the earliest pipeline stage is the primary suspect');
assert.strictEqual(T.earliest(['made_up', 'ocr']), 'ocr', 'invalid keys are ignored');
assert.strictEqual(T.earliest([]), null);
ok('earliest() returns the earliest-stage valid cause');

// structureCorrection validates the primary cause.
const c = T.structureCorrection({ primary: 'field_extraction', secondaries: ['ocr', 'nonsense'], note: 'x', isException: true });
assert.strictEqual(c.primary, 'field_extraction');
assert.strictEqual(c.primaryStage, 5);
assert.deepStrictEqual(c.secondaries, ['ocr'], 'invalid secondaries are dropped');
assert.strictEqual(c.isException, true);
ok('structureCorrection validates + shapes a correction');

assert.throws(() => T.structureCorrection({ primary: 'not_a_cause' }), /invalid primary cause/);
ok('structureCorrection throws on a cause outside the taxonomy');

console.log(`\nR5.43 error-taxonomy pure — ${passed} checks passed`);
