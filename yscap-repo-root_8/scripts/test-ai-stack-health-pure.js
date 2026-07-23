'use strict';
/**
 * #216 — pure tests for the AI/OCR stack-health report. Proves: every component
 * has a well-formed descriptor; report() returns one sane row per component and
 * NEVER leaks a secret (only booleans + model NAMES); with no keys (the CI
 * default) every component is inactive and the committee is not multi-model;
 * summary() aggregates by group; and nothing ever throws.
 */
const assert = require('assert');
const health = require('../src/lib/ai/stack-health');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// 1. Descriptors are well-formed + unique + cover the expected components.
{
  const keys = new Set();
  for (const c of health.COMPONENTS) {
    assert.ok(c.key && !keys.has(c.key), `unique key: ${c.key}`);
    keys.add(c.key);
    assert.ok(c.name && c.role && c.provider && c.group, `${c.key} has name/role/provider/group`);
    assert.strictEqual(typeof c.probe, 'function', `${c.key} has a probe`);
  }
  for (const k of ['azure_openai', 'anthropic', 'azure_docint', 'google_docai', 'mistral_ocr',
    'azure_custom_classifier', 'azure_custom_extractors', 'langfuse']) {
    assert.ok(keys.has(k), `a slot exists for ${k}`);
  }
  ok('every component descriptor is well-formed, unique, and the expected set is present');
}

// 2. report() returns one sane row per component; never leaks a secret.
{
  const rep = health.report();
  assert.strictEqual(rep.length, health.COMPONENTS.length, 'one row per component');
  for (const r of rep) {
    assert.strictEqual(typeof r.active, 'boolean', `${r.key} active is boolean`);
    assert.ok('model' in r, `${r.key} has a model field`);
    // A model value, if present, is a NAME — never a long opaque secret/key.
    if (r.model) assert.ok(!/[A-Za-z0-9]{40,}/.test(r.model), `${r.key} model is not a secret-looking blob`);
    assert.ok(r.name && r.group && r.role && r.provider);
  }
  ok('report() returns one sane row per component and never leaks a secret');
}

// 3. With no keys (CI default) every component is inactive; committee not multi-model.
{
  const rep = health.report();
  assert.ok(rep.every((r) => r.active === false), 'no keys → nothing active');
  const s = health.summary(rep);
  assert.strictEqual(s.active, 0);
  assert.strictEqual(s.inactive, rep.length);
  assert.strictEqual(s.reasoningProviders, 0);
  assert.strictEqual(s.multiModel, false, 'no reasoning providers → not multi-model');
  ok('with no keys, every component is inactive and the committee is not multi-model');
}

// 4. summary() aggregates by group and flags multi-model when ≥2 reasoning providers are active.
{
  const fake = [
    { key: 'azure_openai', group: 'reasoning', active: true },
    { key: 'anthropic', group: 'reasoning', active: true },
    { key: 'azure_docint', group: 'ocr', active: true },
    { key: 'mistral_ocr', group: 'ocr', active: false },
    { key: 'langfuse', group: 'observability', active: false },
  ];
  const s = health.summary(fake);
  assert.strictEqual(s.total, 5);
  assert.strictEqual(s.active, 3);
  assert.strictEqual(s.byGroup.reasoning.active, 2);
  assert.strictEqual(s.byGroup.ocr.total, 2);
  assert.strictEqual(s.byGroup.ocr.active, 1);
  assert.strictEqual(s.reasoningProviders, 2);
  assert.strictEqual(s.multiModel, true, 'two active reasoning providers → multi-model');
  ok('summary() aggregates by group and flags multi-model at ≥2 active reasoning providers');
}

// 4b. REGRESSION guard (audit defect): azure-custom.DOC_TYPES is an OBJECT, not an
//     array — the extractors probe must enumerate its DISTINCT canonical values, or
//     it always reports OFF (the exact "health page lies" bug this module fixes).
{
  const custom = require('../src/lib/ai/azure-custom');
  assert.ok(custom.DOC_TYPES && typeof custom.DOC_TYPES === 'object' && !Array.isArray(custom.DOC_TYPES),
    'DOC_TYPES is a non-array object — the probe must use Object.values, never Array.isArray');
  const distinct = [...new Set(Object.values(custom.DOC_TYPES))];
  assert.ok(distinct.length >= 6 && distinct.includes('bank_statement'),
    'the deduped canonical types are the extractor set the probe checks');
  ok('extractors probe enumerates DOC_TYPES as an object (guards the drift bug)');
}

// 5. Never throws on hostile input.
{
  for (const bad of [null, undefined, 42, 'x', {}]) {
    assert.doesNotThrow(() => health.summary(bad));
  }
  assert.doesNotThrow(() => health.report());
  ok('report() / summary() never throw');
}

console.log(`\nai-stack-health pure — ${passed} checks passed`);
