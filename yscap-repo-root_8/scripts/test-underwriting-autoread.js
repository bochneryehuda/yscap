'use strict';
/**
 * Unit tests for the auto-reader queue selection (auto-read.js). Pure — no DB, no Azure.
 */
const assert = require('assert');
const { selectAutoReadQueue } = require('../src/lib/underwriting/auto-read');

// Every registered type is "readable"; use a permissive predicate unless a case narrows it.
const readableAll = () => true;

// ---- Maps a document to the type its CONDITION expects; skips already-read + unreadable ----
{
  const documents = [
    { id: 'd1', condition_code: 'rtl_cond_title', filename: 'commitment.pdf' },      // -> title
    { id: 'd2', condition_code: 'rtl_cond_insurance', filename: 'binder.pdf' },       // -> insurance
    { id: 'd3', condition_code: 'rtl_p1_id', filename: 'dl.jpg' },                     // -> government_id
    { id: 'd4', condition_code: 'rtl_llc_formation', filename: 'articles.pdf' },       // -> llc_formation (entity doc)
    { id: 'd5', condition_code: 'some_unmapped_condition', filename: 'misc.pdf' },     // no type -> skipped
    { id: 'd6', condition_code: 'rtl_cond_title', filename: 'already.pdf' },           // already read -> skipped
  ];
  const q = selectAutoReadQueue({ documents, analyzedIds: new Set(['d6']), isReadable: readableAll });
  assert.deepStrictEqual(q.map((x) => x.id), ['d1', 'd2', 'd3', 'd4'], 'reads the on-file-unread mapped docs, skips unmapped + already-read');
  assert.strictEqual(q.find((x) => x.id === 'd1').expectedType, 'title', 'title condition -> title');
  assert.strictEqual(q.find((x) => x.id === 'd2').expectedType, 'insurance', 'insurance condition -> insurance');
  assert.strictEqual(q.find((x) => x.id === 'd3').expectedType, 'government_id', 'id condition -> government_id');
  assert.strictEqual(q.find((x) => x.id === 'd4').expectedType, 'llc_formation', 'entity condition -> llc_formation');
  assert.strictEqual(q.find((x) => x.id === 'd1').conditionCode, 'rtl_cond_title', 'carries the condition it came from');
}

// ---- Flood reads via its OWN condition; settlement (no checklist condition) reads via doc_kind ----
// doc_kind holds a document TYPE and is used directly — NOT looked up as a condition code (that always
// missed, so a settlement statement never got read). The isReadable gate drops any kind with no checker.
{
  const readable = new Set(['settlement', 'flood', 'title']);
  const documents = [
    { id: 'd1', condition_code: null, doc_kind: 'settlement', filename: 'hud.pdf' },        // via doc_kind -> settlement
    { id: 'd2', condition_code: 'rtl_cond_flood', doc_kind: null, filename: 'flood.pdf' },   // via its own flood condition -> flood
    { id: 'd3', condition_code: null, doc_kind: 'photo_id', filename: 'id.jpg' },            // not a readable type -> skipped
    { id: 'd4', condition_code: null, doc_kind: null, filename: 'y.pdf' },                   // nothing -> skipped
  ];
  const q = selectAutoReadQueue({ documents, isReadable: (t) => readable.has(t) });
  assert.deepStrictEqual(q.map((x) => x.id), ['d1', 'd2'], 'settlement reads via its doc_kind; flood via its own condition; unreadable kind + no-signal skipped');
  assert.strictEqual(q.find((x) => x.id === 'd1').expectedType, 'settlement', 'a settlement statement reads via its doc_kind (it has no checklist condition)');
  assert.strictEqual(q.find((x) => x.id === 'd2').expectedType, 'flood', 'a flood determination reads via its own rtl_cond_flood condition, not the insurance condition');
}

// ---- A mapped type the reader has no checker for is skipped (never queued for a read that can't run) ----
{
  const documents = [
    { id: 'd1', condition_code: 'rtl_cond_title', filename: 't.pdf' },
    { id: 'd2', condition_code: 'rtl_cond_insurance', filename: 'i.pdf' },
  ];
  const onlyTitle = (t) => t === 'title';
  const q = selectAutoReadQueue({ documents, isReadable: onlyTitle });
  assert.deepStrictEqual(q.map((x) => x.id), ['d1'], 'only the type the reader can read is queued');
}

// ---- analyzedIds accepts an array; empty/edge inputs never throw ----
{
  assert.deepStrictEqual(selectAutoReadQueue({}), [], 'no documents -> empty queue');
  assert.deepStrictEqual(selectAutoReadQueue({ documents: [null, {}, { id: '' }] }), [], 'junk rows are ignored');
  const q = selectAutoReadQueue({ documents: [{ id: 'd1', condition_code: 'rtl_cond_title' }], analyzedIds: ['d1'] });
  assert.deepStrictEqual(q, [], 'analyzedIds as an array works (already read -> skipped)');
}

// ---- R5.1 — a failed-slice split child (page_bounded=false) is never auto-read ----
// It still references the whole source package, so reading it as one logical
// document is the exact contamination the packet-splitter fix prevents. A normal
// upload (page_bounded null/undefined) and a real page-bounded child (true) queue.
{
  const documents = [
    { id: 'd1', condition_code: 'rtl_cond_title', filename: 'normal.pdf' },                    // null -> queued
    { id: 'd2', condition_code: 'rtl_cond_title', filename: 'bounded.pdf', page_bounded: true },// true -> queued
    { id: 'd3', condition_code: 'rtl_cond_title', filename: 'fallback.pdf', page_bounded: false },// false -> skipped
  ];
  const q = selectAutoReadQueue({ documents, isReadable: readableAll });
  assert.deepStrictEqual(q.map((x) => x.id), ['d1', 'd2'], 'page_bounded=false split child is skipped; null/true queue');
}

console.log('test-underwriting-autoread: queue selection (condition->type, skip read/unreadable/unmapped/unbounded) pass');
