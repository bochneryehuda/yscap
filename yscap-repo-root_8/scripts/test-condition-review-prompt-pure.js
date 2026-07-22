'use strict';
/**
 * R5.29 — pure tests for the semantic condition reviewer (Prompt E). Guarantees:
 * the system prompt constrains outcomes + forbids inferring authority, the user
 * payload carries the evidence, and validateResult rejects an out-of-vocab
 * outcome, a hallucinated citation, and a non-satisfied outcome with no
 * explanation.
 */
const assert = require('assert');
const { promptFor, validateResult, SYSTEM_PROMPT } = require('../src/lib/underwriting/condition-review-prompt');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// system prompt encodes the key rules.
assert.ok(/ONLY the named requirement|Evaluate ONLY/i.test(SYSTEM_PROMPT));
assert.ok(/correct document type alone is never enough/i.test(SYSTEM_PROMPT));
assert.ok(/Never cite an evidence ID that was not supplied/i.test(SYSTEM_PROMPT));
assert.ok(/do not infer authority/i.test(SYSTEM_PROMPT));
ok('system prompt constrains outcomes + forbids inferring authority + hallucinated cites');

// user payload carries the evidence + requirement.
const { system, user } = promptFor({
  requirementId: 'insured_name_matches_vesting',
  requirement: 'The named insured must match the current vesting entity.',
  freshnessDays: 365,
  evidenceSpans: [{ id: 's1', quote: 'Named Insured: ABC LLC', pageNumber: 2, normalizedValue: 'abc llc' }],
  guidelineRule: { rule_key: 'insured_matches_vesting' },
});
assert.strictEqual(system, SYSTEM_PROMPT);
const u = JSON.parse(user);
assert.strictEqual(u.requirement_id, 'insured_name_matches_vesting');
assert.strictEqual(u.evidence_spans[0].id, 's1');
assert.strictEqual(u.freshness_days, 365);
ok('user payload carries the requirement + cited evidence');

// validateResult: a valid satisfied outcome with a real span passes.
let v = validateResult({ outcome: 'satisfied', evidenceSpanIds: ['s1'] }, new Set(['s1', 's2']));
assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
ok('a valid satisfied result with a real span passes');

// out-of-vocabulary outcome rejected.
assert.strictEqual(validateResult({ outcome: 'cleared' }, ['s1']).ok, false);
ok('an out-of-vocabulary outcome is rejected');

// hallucinated citation rejected.
v = validateResult({ outcome: 'satisfied', evidenceSpanIds: ['ghost'] }, ['s1']);
assert.strictEqual(v.ok, false);
assert.ok(v.errors.some((e) => /hallucinated/.test(e)));
ok('a hallucinated citation is rejected');

// a non-satisfied outcome with no explanation is rejected.
v = validateResult({ outcome: 'not_satisfied', evidenceSpanIds: ['s1'] }, ['s1']);
assert.strictEqual(v.ok, false);
assert.ok(v.errors.some((e) => /explain/.test(e)));
// …but with an explanation it passes.
assert.strictEqual(validateResult({ outcome: 'not_satisfied', explanation: 'Need the filed amendment.', evidenceSpanIds: ['s1'] }, ['s1']).ok, true);
ok('a non-satisfied outcome must explain the resolving evidence');

console.log(`\nR5.29 condition-review-prompt pure — ${passed} checks passed`);
