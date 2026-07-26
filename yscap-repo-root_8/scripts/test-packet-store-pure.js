'use strict';
/**
 * R5.6 — pure tests for the packet-lifecycle store internals (no DB). Validates
 * the deterministic helpers + the exported constant sets that the packet
 * intelligence workstream (R5.7–R5.12) relies on.
 */
const assert = require('assert');
const store = require('../src/lib/underwriting/packet-store');
const { isUuid, familyKeyFor, normalizePages } = store._internals;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- isUuid ---
assert.ok(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301'));
assert.ok(!isUuid('nope'));
assert.ok(!isUuid(null));
ok('isUuid recognizes v4-shaped uuids only');

// --- familyKeyFor ---
assert.strictEqual(familyKeyFor('Bank Statement', { accountLast4: '4776' }), 'bank_statement:4776',
  'bank statements bucket per account so two accounts never collapse');
assert.strictEqual(familyKeyFor('Bank Statement', { accountLast4: '99994776' }), 'bank_statement:4776',
  'account key uses last-4 only');
assert.strictEqual(familyKeyFor('bank_statement', {}), 'bank_statement',
  'a bank statement with no account still has a family');
assert.strictEqual(familyKeyFor('Title Report'), 'title_report');
assert.strictEqual(familyKeyFor('  Purchase / Contract  '), 'purchase_contract');
assert.strictEqual(familyKeyFor(''), null);
assert.strictEqual(familyKeyFor(null), null);
ok('familyKeyFor normalizes + buckets bank statements per account');

// --- normalizePages ---
assert.deepStrictEqual(normalizePages([3, 1, 2, 2, 1]), [1, 2, 3], 'dedupes + sorts ascending');
assert.deepStrictEqual(normalizePages([0, -1, 2.5, 'x', 4]), [4], 'drops non-positive / non-integer');
assert.deepStrictEqual(normalizePages(null), []);
assert.deepStrictEqual(normalizePages('nope'), []);
ok('normalizePages returns ascending deduped 1-indexed ints');

// --- exported constant sets (the lifecycle contract) ---
for (const e of ['ingest', 'render', 'quality', 'segment', 'reclassify', 'split', 'merge', 'version', 'supersede', 'replace', 'human_confirm']) {
  assert.ok(store.LIFECYCLE_EVENTS.has(e), `lifecycle event ${e}`);
}
for (const v of ['draft', 'current', 'superseded', 'duplicate', 'amendment', 'unknown']) {
  assert.ok(store.VERSION_STATES.has(v), `version state ${v}`);
}
for (const c of ['accepted', 'needs_review', 'rejected']) {
  assert.ok(store.CLASSIFICATION_STATES.has(c), `classification state ${c}`);
}
for (const r of ['supersedes', 'amends', 'duplicates', 'continues', 'attachment_to', 'replaces']) {
  assert.ok(store.RELATIONSHIP_TYPES.has(r), `relationship type ${r}`);
}
ok('lifecycle / version / classification / relationship constant sets are complete');

// --- module surface ---
for (const fn of ['createPackage', 'setPackageStatus', 'upsertPage', 'markDuplicatePage', 'listPages',
  'createLogicalDocument', 'attachPages', 'confirmLogicalDocument', 'listLogicalDocuments',
  'recordRelationship', 'logEvent']) {
  assert.strictEqual(typeof store[fn], 'function', `exports ${fn}`);
}
ok('packet-store exports the full CRUD surface');

console.log(`\nR5.6 packet-store pure — ${passed} checks passed`);
