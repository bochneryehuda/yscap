'use strict';
/**
 * R5.40/R5.41 — pure tests for the admin-question builder. Guarantees: a vague
 * or unsafe question is rejected — no evidence, <2 options, or an option that
 * tries to create a permanent rule directly all fail; a well-formed question
 * shapes into the db/264 payload.
 */
const assert = require('assert');
const { validate, build } = require('../src/lib/underwriting/admin-question');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const good = {
  question: 'Are "ABC Property LLC" and "ABC Property Holdings LLC" the same entity after a name change?',
  blockedComponent: 'entity_chain',
  options: [
    { key: 'different', label: 'Different entities — request correction' },
    { key: 'same_attach', label: 'Same entity — filed amendment available; attach it' },
    { key: 'same_exception', label: 'Same for this file only — approve a documented exception' },
  ],
  evidenceSpanIds: ['span-title-1', 'span-oa-1'],
  recommendedOption: 'same_attach',
  answerScope: 'case_only',
  dedupeKey: 'entity_name:abcproperty',
};

let v = validate(good);
assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
ok('a well-formed narrow question validates');

// no evidence → invalid.
v = validate({ ...good, evidenceSpanIds: [] });
assert.strictEqual(v.ok, false);
assert.ok(v.errors.some((e) => /evidenceSpanIds/.test(e)));
ok('a question with no evidence is rejected');

// <2 options → invalid.
v = validate({ ...good, options: [good.options[0]] });
assert.strictEqual(v.ok, false);
assert.ok(v.errors.some((e) => /2 mutually-exclusive/.test(e)));
ok('a question with <2 options is rejected');

// no blocked component → invalid.
assert.strictEqual(validate({ ...good, blockedComponent: '' }).ok, false);
ok('a question not tied to a blocked decision is rejected');

// an option that creates a permanent rule directly → invalid. Cover every
// phrasing the audit flagged (broadened content lint).
for (const effect of [
  'create a permanent global rule',
  'make this a permanent global rule for all cases',
  'establish a permanent rule going forward',
  'always apply this rule to every future file',
  'auto-apply this rule',
]) {
  const vv = validate({ ...good, options: [...good.options, { key: 'rule', label: 'Always', effect }] });
  assert.strictEqual(vv.ok, false, `must reject effect: "${effect}"`);
  assert.ok(vv.errors.some((e) => /permanent rule/.test(e)));
}
// …but a case-scoped effect that merely says "apply for this case only" is fine.
assert.strictEqual(validate({ ...good, options: [...good.options, { key: 'x', label: 'Once', effect: 'apply to this file only' }] }).ok, true);
ok('every permanent/global-rule phrasing is rejected; a case-only effect is allowed');

// recommendedOption must be a real option.
assert.strictEqual(validate({ ...good, recommendedOption: 'nope' }).ok, false);
ok('recommendedOption must be one of the options');

// build shapes the db/264 payload + defaults scope/learning to case_only.
const row = build(good);
assert.strictEqual(row.blocked_component, 'entity_chain');
assert.strictEqual(row.answer_scope, 'case_only');
assert.strictEqual(row.learning_eligibility, 'case_only');
assert.deepStrictEqual(row.evidence_span_ids, ['span-title-1', 'span-oa-1']);
ok('build() shapes the db/264 payload, case_only by default');

// propose_rule scope flows to learning_eligibility.
assert.strictEqual(build({ ...good, answerScope: 'propose_rule' }).learning_eligibility, 'propose_rule');
ok('propose_rule scope sets learning_eligibility');

// build throws on an invalid question.
assert.throws(() => build({ ...good, evidenceSpanIds: [] }), /admin-question:/);
ok('build() throws on an invalid question (never persists an unsafe one)');

console.log(`\nR5.40 admin-question pure — ${passed} checks passed`);
