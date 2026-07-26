'use strict';
/**
 * R5.62 — pure tests for the packet prompt builders. Guarantees: the system
 * prompts encode the never-invent / preserve-order / newest-is-not-controlling
 * safety rules, and the user payloads shape the page/family inputs faithfully.
 */
const assert = require('assert');
const { segmentPrompt, versionPrompt, SEGMENT_SYSTEM, VERSION_SYSTEM } = require('../src/lib/underwriting/packet-prompts');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// Prompt A system prompt encodes the safety rules.
assert.ok(/never invent/i.test(SEGMENT_SYSTEM));
assert.ok(/preserve the original page order/i.test(SEGMENT_SYSTEM));
assert.ok(/needs_human_review/i.test(SEGMENT_SYSTEM));
assert.ok(/not underwriting|not extract loan facts/i.test(SEGMENT_SYSTEM));
ok('Prompt A encodes never-invent / preserve-order / defer-on-disagreement');

// Prompt A user payload shapes the pages.
let { system, user } = segmentPrompt([
  { pageId: 'p1', pageNumber: 1, headerText: 'PURCHASE AGREEMENT', classifierVotes: [{ label: 'contract', conf: 0.9 }] },
  { pageId: 'p2', pageNumber: 2, pageNumberText: 'Page 2 of 6' },
]);
assert.strictEqual(system, SEGMENT_SYSTEM);
let u = JSON.parse(user);
assert.strictEqual(u.pages.length, 2);
assert.strictEqual(u.pages[0].page_id, 'p1');
assert.strictEqual(u.pages[0].header_text, 'PURCHASE AGREEMENT');
assert.deepStrictEqual(u.pages[1].issuer_candidates, [], 'missing fields default to empty');
ok('Prompt A user payload shapes the page inputs');

// Prompt B system prompt encodes newest-is-not-controlling + never-discard.
assert.ok(/newest upload is the controlling|not assume the newest/i.test(VERSION_SYSTEM));
assert.ok(/never discard the older document/i.test(VERSION_SYSTEM));
assert.ok(/different period|does NOT supersede/i.test(VERSION_SYSTEM));
ok('Prompt B encodes newest-is-not-controlling + never-discard');

// Prompt B user payload shapes the family.
({ system, user } = versionPrompt('title', [
  { id: 'd1', documentType: 'title', effectiveDate: '2026-05-01', executed: true, evidenceSpanIds: ['s1'] },
  { id: 'd2', documentType: 'title', effectiveDate: '2026-06-01', executed: true },
]));
assert.strictEqual(system, VERSION_SYSTEM);
u = JSON.parse(user);
assert.strictEqual(u.family_key, 'title');
assert.strictEqual(u.documents.length, 2);
assert.strictEqual(u.documents[0].logical_document_id, 'd1');
assert.deepStrictEqual(u.documents[0].evidence_span_ids, ['s1']);
assert.deepStrictEqual(u.documents[1].evidence_span_ids, [], 'missing spans default empty');
ok('Prompt B user payload shapes the family inputs');

// empty inputs are safe.
assert.strictEqual(JSON.parse(segmentPrompt([]).user).pages.length, 0);
assert.strictEqual(JSON.parse(versionPrompt(null, null).user).documents.length, 0);
ok('empty inputs produce valid empty payloads');

console.log(`\nR5.62 packet-prompts pure — ${passed} checks passed`);
