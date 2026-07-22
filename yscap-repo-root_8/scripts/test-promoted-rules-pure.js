#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the promoted training-proposal applier
 * (src/lib/underwriting/promoted-rules.js). Exercises the pure
 * applyRules() + stepDown/stepUp — DB paths are tested separately.
 */
const assert = require('assert');
const { applyRules, _internals } = require('../src/lib/underwriting/promoted-rules');
const { stepDown, stepUp } = _internals;

// ---- stepDown / stepUp ----
assert.strictEqual(stepDown('fatal'), 'warning');
assert.strictEqual(stepDown('warning'), 'info');
assert.strictEqual(stepDown('info'), 'dismiss');
assert.strictEqual(stepDown('dismiss'), 'dismiss');           // floors
assert.strictEqual(stepDown('unknown'), 'unknown');           // no-op on unknown
assert.strictEqual(stepUp('info'), 'warning');
assert.strictEqual(stepUp('warning'), 'fatal');
assert.strictEqual(stepUp('fatal'), 'fatal');                  // ceils

// ---- empty rules + empty findings ----
{
  const r = applyRules([], null);
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.suppressed, []);
}
{
  const r = applyRules([{ code: 'x', severity: 'fatal' }], null);
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].severity, 'fatal');
}

// ---- suppress ----
{
  const r = applyRules(
    [{ code: 'noisy', severity: 'warning', title: 'noise' }, { code: 'keeper', severity: 'fatal' }],
    { suppress: new Set(['noisy']), downgrade: new Set(), upgrade: new Set() });
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].code, 'keeper');
  assert.strictEqual(r.suppressed.length, 1);
  assert.strictEqual(r.suppressed[0].code, 'noisy');
  assert.strictEqual(r.suppressed[0].title, 'noise');
}

// ---- downgrade + upgrade ----
{
  const r = applyRules(
    [{ code: 'a', severity: 'fatal' }, { code: 'b', severity: 'info' }],
    { suppress: new Set(), downgrade: new Set(['a']), upgrade: new Set(['b']) });
  assert.strictEqual(r.findings.find((f) => f.code === 'a').severity, 'warning');
  assert.strictEqual(r.findings.find((f) => f.code === 'b').severity, 'warning');
}

// ---- downgrade to dismiss = suppress ----
{
  const r = applyRules(
    [{ code: 'x', severity: 'info', title: 'noise' }],
    { suppress: new Set(), downgrade: new Set(['x']), upgrade: new Set() });
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.suppressed.length, 1);
  assert.strictEqual(r.suppressed[0].code, 'x');
}

// ---- unknown finding code passes through unchanged ----
{
  const r = applyRules(
    [{ code: 'unknown', severity: 'fatal' }],
    { suppress: new Set(['other']), downgrade: new Set(['nope']), upgrade: new Set() });
  assert.strictEqual(r.findings[0].severity, 'fatal');
}

// ---- suppress wins over downgrade if BOTH are set for the same code ----
{
  const r = applyRules(
    [{ code: 'x', severity: 'fatal' }],
    { suppress: new Set(['x']), downgrade: new Set(['x']), upgrade: new Set() });
  assert.strictEqual(r.findings.length, 0);
  assert.strictEqual(r.suppressed.length, 1);
}

// ---- finding without a code passes through ----
{
  const r = applyRules(
    [{ severity: 'warning' }],
    { suppress: new Set(['x']), downgrade: new Set(), upgrade: new Set() });
  assert.strictEqual(r.findings.length, 1);
}

console.log('test-promoted-rules-pure: applier + severity-step logic pass');
