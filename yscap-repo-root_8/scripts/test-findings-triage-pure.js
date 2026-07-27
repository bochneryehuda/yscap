'use strict';
/**
 * Pure tests for findings-triage (src/lib/underwriting/findings-triage.js). No DB/network/keys.
 * Proves the set-hash is order-independent + set-sensitive, and the display pass re-orders by the
 * AI's rank + annotates each finding, keeping un-ranked ones in place. Display-only, never throws.
 */
const assert = require('assert');
const t = require('../src/lib/underwriting/findings-triage');
const { claimOf } = require('../src/lib/underwriting/finding-claims');

// ON by default.
delete process.env.FINDINGS_TRIAGE_ENABLED;
assert.strictEqual(t.enabled(), true);
process.env.FINDINGS_TRIAGE_ENABLED = '0';
assert.strictEqual(t.enabled(), false);
process.env.FINDINGS_TRIAGE_ENABLED = '1';

// setHashOf: order-independent, changes when the SET changes.
const fA = { code: 'a', field: 'x' };
const fB = { code: 'b', field: 'y' };
const fC = { code: 'c', field: 'z' };
assert.strictEqual(t.setHashOf([fA, fB]), t.setHashOf([fB, fA]), 'order-independent');
assert.notStrictEqual(t.setHashOf([fA, fB]), t.setHashOf([fA, fB, fC]), 'a new finding changes the set hash');

// applyTriage: annotate + re-order by rank; un-ranked stay in original order AFTER ranked ones.
{
  const findings = [fA, fB, fC];
  const mem = new Map();
  mem.set(claimOf(fB), { claim_key: claimOf(fB), bucket: 'primary', rank: 1, why: 'the real story' });
  mem.set(claimOf(fC), { claim_key: claimOf(fC), bucket: 'noise', rank: 3, why: 'formatting nit' });
  // fA has no ranking.
  const out = t.applyTriage(findings, mem);
  assert.strictEqual(out[0].code, 'b', 'rank 1 comes first');
  assert.strictEqual(out[1].code, 'c', 'rank 3 comes next (both ranked before the un-ranked)');
  assert.strictEqual(out[2].code, 'a', 'the un-ranked finding is last, order preserved');
  assert.deepStrictEqual(out[0].aiTriage, { bucket: 'primary', rank: 1, why: 'the real story' }, 'the ranking is annotated');
  assert.ok(!out[2].aiTriage, 'an un-ranked finding carries no aiTriage');
}
// Empty memory → findings returned unchanged (no reorder, no annotation).
{
  const findings = [fA, fB];
  const out = t.applyTriage(findings, new Map());
  assert.strictEqual(out, findings, 'no rankings → the same array, unchanged');
}
// Never throws on garbage.
assert.deepStrictEqual(t.applyTriage(null, null), []);
assert.strictEqual(t.applyTriage([fA], 'not-a-map')[0].code, 'a', 'a bad memory is treated as empty');

console.log('✓ test-findings-triage-pure: set hash + display re-order/annotate pass');
