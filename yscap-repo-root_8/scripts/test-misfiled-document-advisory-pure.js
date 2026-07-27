'use strict';
/**
 * Pure tests for the mis-filed-document advisory (src/lib/underwriting/misfiled-document-advisory.js).
 * No DB/network/keys. Proves it raises ONLY when the AI reasoning is confident a document doesn't
 * match its filed slot, and never guesses / never nags on an uncertain or same-type reasoning.
 */
const assert = require('assert');
const { _internals } = require('../src/lib/underwriting/misfiled-document-advisory');
const { assess, dedupeKeyFor } = _internals;

// A tax cert filed under "title", the model confident it does NOT match → RAISE.
{
  const a = assess('title', { docNature: 'tax certificate', matchesFiledType: false, confidence: 0.95, purpose: 'shows the current owner' });
  assert.strictEqual(a.raise, true, 'confident mis-file → raise');
  assert.strictEqual(a.docNature, 'tax certificate');
}
// Reasoning stored as a STRING (pg jsonb round-trip) is parsed.
{
  const a = assess('title', JSON.stringify({ docNature: 'warranty deed', matchesFiledType: false, confidence: 0.9 }));
  assert.strictEqual(a.raise, true, 'a stringified reasoning is parsed');
}
// Matches the slot → never raise.
assert.strictEqual(assess('title', { docNature: 'title commitment', matchesFiledType: true, confidence: 0.95 }).raise, false, 'matches → no raise');
// Unknown match (null) → never raise (never guesses).
assert.strictEqual(assess('title', { docNature: 'title report', matchesFiledType: null, confidence: 0.95 }).raise, false, 'unknown match → no raise');
// Low confidence → never nag.
assert.strictEqual(assess('title', { docNature: 'tax certificate', matchesFiledType: false, confidence: 0.5 }).raise, false, 'low confidence → no raise');
// No docNature → nothing to say.
assert.strictEqual(assess('title', { docNature: '', matchesFiledType: false, confidence: 0.95 }).raise, false, 'no docNature → no raise');
// The nature is really the slot worded differently ("title report" vs "title") → don't raise.
assert.strictEqual(assess('title', { docNature: 'title report', matchesFiledType: false, confidence: 0.95 }).raise, false, 'same-type worded differently → no raise');
assert.strictEqual(assess('bank_statement', { docNature: 'bank statement', matchesFiledType: false, confidence: 0.95 }).raise, false, 'bank statement vs bank_statement → no raise');
// No reasoning at all → nothing.
assert.strictEqual(assess('title', null).raise, false);
assert.strictEqual(assess('title', undefined).raise, false);
// Never throws on garbage.
assert.strictEqual(assess('title', 'not json').raise, false);

// dedupe key is per-document.
assert.strictEqual(dedupeKeyFor('doc-123'), 'misfiled_document:doc-123');
assert.notStrictEqual(dedupeKeyFor('a'), dedupeKeyFor('b'));

console.log('✓ test-misfiled-document-advisory-pure: raises only on a confident mis-file, never guesses');
