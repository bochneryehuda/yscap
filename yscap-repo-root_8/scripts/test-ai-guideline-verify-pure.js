'use strict';

/**
 * Pure test for investor-guidelines/ai-guideline-verify.js (no DB, no GPT).
 * Covers the two pure surfaces: buildInstruction (prompt text from a condition)
 * and verdictToSuggestion (GPT verdict → advisory payload | null), plus the
 * schema shape. The DB/GPT path (verifySatisfiedCondition) is env-gated and
 * best-effort — proven not to throw when Azure is unconfigured.
 */

const assert = require('assert');
const v = require('../src/lib/underwriting/investor-guidelines/ai-guideline-verify');

let n = 0;
function check(name, fn) { fn(); n++; console.log('  ok -', name); }

console.log('ai-guideline-verify pure tests');

// 1 — buildInstruction includes the requirement + checks + task, never throws.
check('buildInstruction renders requirement + checks', () => {
  const s = v.buildInstruction({
    name: 'CONSTRUCTION FEASIBILITY REPORT',
    required_evidence: 'A third-party feasibility report from an approved vendor.',
    checks: [{ text: 'Site inspection with photos' }, { detail: 'Budget within 10% variance' }],
  });
  assert(/CONSTRUCTION FEASIBILITY REPORT/.test(s), 'condition name present');
  assert(/third-party feasibility report/.test(s), 'requirement present');
  assert(/Site inspection with photos/.test(s), 'check 1 present');
  assert(/Budget within 10% variance/.test(s), 'check 2 (detail) present');
  assert(/SATISFIED/.test(s), 'states the condition is satisfied');
  // never throws on junk
  assert.strictEqual(typeof v.buildInstruction(null), 'string');
  assert.strictEqual(typeof v.buildInstruction({}), 'string');
});

// 2 — a "meets" verdict raises nothing.
check('verdictToSuggestion: meets=true → null', () => {
  assert.strictEqual(v.verdictToSuggestion({ name: 'X', cond_no: 1 }, { meets: true, confidence: 0.9, reason: 'ok', missing: [] }), null);
  assert.strictEqual(v.verdictToSuggestion({ name: 'X' }, {}), null, 'absent meets → null');
  assert.strictEqual(v.verdictToSuggestion(null, null), null, 'null-safe');
});

// 3 — a "does not meet" verdict → a warning finding advisory with the shortfall.
check('verdictToSuggestion: meets=false → warning finding', () => {
  const s = v.verdictToSuggestion(
    { name: 'HAZARD INSURANCE', cond_no: 2186, checklistItemId: 'ci-9' },
    { meets: false, confidence: 0.72, reason: 'Coverage is below the required amount.', missing: ['dwelling coverage ≥ loan amount'] });
  assert.strictEqual(s.source, 'investor_guideline_ai');
  assert.strictEqual(s.kind, 'finding');
  assert.strictEqual(s.severity, 'warning');
  assert.strictEqual(s.important, false, 'advisory, not a fatal email storm');
  assert(/may not meet the note buyer's rule for "HAZARD INSURANCE"/.test(s.title));
  assert(/below the required amount/.test(s.body));
  assert(/Missing: dwelling coverage/.test(s.body));
  assert(/advisory/.test(s.body), 'labels itself advisory');
  assert.strictEqual(s.proposedAction.type, 'review_condition');
  assert.strictEqual(s.proposedAction.checklistItemId, 'ci-9');
  assert.strictEqual(s.evidence.code, 'isg_ai_verify');
  assert.strictEqual(s.evidence.cond_no, 2186);
  assert.strictEqual(s.confidence, 0.72);
  assert.strictEqual(s.dedupeKey, 'isg-ai-verify:2186');
});

// 4 — dedupe key falls back to the checklist item / name when cond_no is absent.
check('verdictToSuggestion: dedupe key fallback', () => {
  const byItem = v.verdictToSuggestion({ name: 'X', checklistItemId: 'ci-3' }, { meets: false, missing: [] });
  assert.strictEqual(byItem.dedupeKey, 'isg-ai-verify:ci-3');
  const byName = v.verdictToSuggestion({ name: 'Some Condition' }, { meets: false, missing: [] });
  assert.strictEqual(byName.dedupeKey, 'isg-ai-verify:Some Condition');
});

// 5 — schema shape is a strict object with the four verdict fields.
check('VERDICT_SCHEMA is well-formed', () => {
  const sc = v.VERDICT_SCHEMA;
  assert.strictEqual(sc.type, 'object');
  assert.strictEqual(sc.additionalProperties, false);
  assert.deepStrictEqual(sc.required.sort(), ['confidence', 'meets', 'missing', 'reason']);
  assert.strictEqual(sc.properties.meets.type, 'boolean');
});

console.log(`\nai-guideline-verify: ${n} checks passed`);
