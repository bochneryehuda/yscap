'use strict';
/**
 * Unit tests for the underwriter action model (src/lib/underwriting/actions.js).
 * Pure — no DB/network/keys.
 */
const assert = require('assert');
const { underwriterActions, validateResolution, ACTIONS } = require('../src/lib/underwriting/actions');

// 1. A fatal finding offers the full menu, always including clear + dismiss, deduped.
{
  const acts = underwriterActions({ severity: 'fatal', actions: ['fix_file', 'keep', 'custom', 'dismiss', 'decline'] });
  const keys = acts.map((a) => a.key);
  assert.ok(keys.includes('post_condition') && keys.includes('request_document'));
  assert.ok(keys.includes('fix_file') && keys.includes('clear') && keys.includes('dismiss') && keys.includes('decline'));
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate actions');
  // legacy verbs are canonicalized: 'keep'->clear, 'custom'->fix_file, no raw 'keep'/'custom'
  assert.ok(!keys.includes('keep') && !keys.includes('custom'));
}

// 2. A warning finding does not offer 'decline' by default.
{
  const keys = underwriterActions({ severity: 'warning', actions: ['acknowledge', 'dismiss'] }).map((a) => a.key);
  assert.ok(!keys.includes('decline'));
  assert.ok(keys.includes('clear') && keys.includes('dismiss'));
}

// 3. Every returned action carries a label + outcome + description.
{
  for (const a of underwriterActions({ severity: 'fatal' })) {
    assert.ok(a.label && a.desc && a.outcome, `action ${a.key} fully described`);
  }
}

// 4. validateResolution enforces required inputs.
assert.strictEqual(validateResolution('clear').ok, true);
assert.strictEqual(validateResolution('clear').outcome, 'resolved');
assert.strictEqual(validateResolution('post_condition', {}).ok, false, 'post_condition needs a note');
assert.strictEqual(validateResolution('post_condition', { note: 'need proof of funds' }).outcome, 'open');
assert.strictEqual(validateResolution('fix_file', {}).ok, false, 'fix_file needs a value');
assert.strictEqual(validateResolution('fix_file', { value: '1980-05-15' }).outcome, 'resolved');
assert.strictEqual(validateResolution('bogus').ok, false);
// alias: open_condition -> post_condition
assert.strictEqual(validateResolution('open_condition', { note: 'x' }).action, 'post_condition');

console.log('✓ test-underwriting-actions: underwriter action model cases pass');
