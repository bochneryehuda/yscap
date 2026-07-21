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

// ---- doc_kind is the fallback when the condition isn't mapped ----
{
  const documents = [
    { id: 'd1', condition_code: null, doc_kind: 'rtl_cond_title', filename: 'x.pdf' }, // via doc_kind -> title
    { id: 'd2', condition_code: null, doc_kind: null, filename: 'y.pdf' },              // nothing -> skipped
  ];
  const q = selectAutoReadQueue({ documents, isReadable: readableAll });
  assert.deepStrictEqual(q.map((x) => x.id), ['d1'], 'doc_kind fallback maps; a document with no signal is left alone');
  assert.strictEqual(q[0].expectedType, 'title');
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

console.log('test-underwriting-autoread: queue selection (condition->type, skip read/unreadable/unmapped) pass');
