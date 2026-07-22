#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the learning loop (src/lib/underwriting/learning.js).
 * matchesDecision and DECISION_BY_ACTION are the pure pieces — the DB writers
 * are tested separately (DB-gated).
 */
const assert = require('assert');
const { DECISION_BY_ACTION, matchesDecision } = require('../src/lib/underwriting/learning');

// ---- action → decision label ----
assert.strictEqual(DECISION_BY_ACTION.dismiss, 'false_positive');
assert.strictEqual(DECISION_BY_ACTION.grant_exception, 'granted_exception');
assert.strictEqual(DECISION_BY_ACTION.post_condition, 'needs_condition');
assert.strictEqual(DECISION_BY_ACTION.clear, 'cleared');
assert.strictEqual(DECISION_BY_ACTION.decline, 'declined');

// ---- committee agreement — the committee said the same thing the human did ----
// confirm ↔ real
assert.strictEqual(matchesDecision('confirm', 'confirmed_real'), true);
assert.strictEqual(matchesDecision('confirm', 'needs_condition'), true);
assert.strictEqual(matchesDecision('confirm', 'granted_exception'), true);
assert.strictEqual(matchesDecision('confirm', 'declined'), true);
// dismiss ↔ false positive
assert.strictEqual(matchesDecision('dismiss', 'false_positive'), true);
assert.strictEqual(matchesDecision('dismiss', 'confirmed_real'), false);
// modify ↔ severity drift or condition/exception
assert.strictEqual(matchesDecision('modify', 'severity_too_high'), true);
assert.strictEqual(matchesDecision('modify', 'severity_too_low'), true);
// hold ↔ nothing matches (still-uncertain panel; humans go either way)
assert.strictEqual(matchesDecision('hold', 'false_positive'), false);
assert.strictEqual(matchesDecision('hold', 'confirmed_real'), false);
// unknown committee action
assert.strictEqual(matchesDecision('nonsense', 'confirmed_real'), false);

console.log('test-learning-pure: correction labeling + committee-agreement matching pass');
