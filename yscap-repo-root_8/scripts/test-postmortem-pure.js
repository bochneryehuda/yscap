'use strict';
/**
 * R5.49 — pure tests for the postmortem builder. Guarantees: the earliest
 * failed component drives the artifact-to-change, a file-specific exception
 * proposes NO artifact change, and the proposal is never auto-applied.
 */
const assert = require('assert');
const PM = require('../src/lib/underwriting/postmortem');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// earliest failed component drives the artifact.
let p = PM.build({
  symptom: 'cleared a condition the underwriter reopened',
  expected: 'not_cleared', actual: 'cleared',
  taggedCauses: ['condition_requirement', 'packet_boundary', 'ai_reasoning'],
});
assert.strictEqual(p.earliestFailedComponent, 'packet_boundary', 'earliest stage wins');
assert.strictEqual(p.artifactToChange, 'splitter', 'packet_boundary → splitter artifact');
assert.strictEqual(p.applied, false, 'a proposal is never auto-applied');
ok('earliest failed component drives the artifact to change');

// a file-specific exception proposes NO artifact change.
p = PM.build({ symptom: 'x', taggedCauses: ['deterministic_rule'], isException: true });
assert.strictEqual(p.isException, true);
assert.ok(/exception/i.test(p.recommendation));
assert.ok(!/Propose a change/.test(p.recommendation), 'no artifact change for an exception');
ok('a file-specific exception proposes no artifact change');

// insufficient tagging → request instrumentation, do not guess.
p = PM.build({ symptom: 'x', taggedCauses: [] });
assert.strictEqual(p.earliestFailedComponent, null);
assert.ok(/instrumentation|do not guess/i.test(p.recommendation));
ok('insufficient tagging requests instrumentation (no guess)');

// regression fixture stub is high-risk + carries the expected outcome.
p = PM.build({ symptom: 'x', expected: 'not_cleared', taggedCauses: ['ai_reasoning'], inputSnapshot: { a: 1 } });
assert.strictEqual(p.regressionFixture.risk_tier, 'high');
assert.strictEqual(p.regressionFixture.expected, 'not_cleared');
assert.deepStrictEqual(p.regressionFixture.input_snapshot, { a: 1 });
assert.strictEqual(p.artifactToChange, 'prompt', 'ai_reasoning → prompt artifact');
ok('regression fixture stub is high-risk + carries expected outcome');

// promptFor builds a constrained Prompt G payload.
const { system, user } = PM.promptFor({ symptom: 's', taggedCauses: ['ocr'], executionTrace: ['a', 'b'] });
assert.ok(/PROPOSAL only|never edit/i.test(system), 'system prompt forbids applying changes');
const u = JSON.parse(user);
assert.deepStrictEqual(u.tagged_causes, ['ocr']);
assert.ok(Array.isArray(u.taxonomy) && u.taxonomy.length === 20, 'taxonomy keys passed to the model');
ok('promptFor builds a constrained Prompt G payload');

console.log(`\nR5.49 postmortem pure — ${passed} checks passed`);
