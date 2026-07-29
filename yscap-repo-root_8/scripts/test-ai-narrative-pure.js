'use strict';
/**
 * Pure tests for ai-narrative (src/lib/underwriting/ai-narrative.js). No DB/network/keys. Proves the
 * concern key is stable + text-sensitive, the layer is ON by default, and analyzeFile is best-effort
 * (returns a shaped skip, never throws) when the AI is unavailable.
 */
const assert = require('assert');
const n = require('../src/lib/underwriting/ai-narrative');

delete process.env.AI_NARRATIVE_ENABLED;
assert.strictEqual(n.enabled(), true, 'ON by default');
process.env.AI_NARRATIVE_ENABLED = '0';
assert.strictEqual(n.enabled(), false);
process.env.AI_NARRATIVE_ENABLED = '1';

const { concernKey } = n._internals;
assert.strictEqual(concernKey('The borrower has no experience'), concernKey('the borrower has no experience  '), 'case/space-insensitive key');
assert.notStrictEqual(concernKey('concern A'), concernKey('concern B'), 'different text → different key');
assert.ok(concernKey('x').startsWith('narrative_coherence:'), 'namespaced key');

(async () => {
  // No Azure config in this env → a clean skip, never a throw, writes nothing.
  const res = await n.analyzeFile({ query: async () => ({ rows: [] }) }, 'app-1', null);
  assert.ok(res && typeof res.skipped === 'string', 'shaped result');
  assert.strictEqual(res.skipped, 'ai_unavailable', 'no Azure → skipped');
  // Disabled path.
  process.env.AI_NARRATIVE_ENABLED = '0';
  const res2 = await n.analyzeFile({ query: async () => ({ rows: [] }) }, 'app-1', null);
  assert.strictEqual(res2.skipped, 'disabled');
  process.env.AI_NARRATIVE_ENABLED = '1';
  // Bad args → nothing_to_do / never throws.
  const res3 = await n.analyzeFile(null, null, null);
  assert.ok(['ai_unavailable', 'nothing_to_do'].includes(res3.skipped));
  console.log('✓ test-ai-narrative-pure: concern key + off-by-switch + best-effort skip');
})().catch((e) => { console.error(e); process.exit(1); });
