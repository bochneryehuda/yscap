'use strict';
/**
 * Pure tests for document-review-guide.js — the per-document "what to look for"
 * checklist projected from the note-buyer condition specs. No DB, no network.
 */
const assert = require('assert');
const g = require('../src/lib/underwriting/document-review-guide');

let n = 0;
const ok = (name) => { n++; console.log('  ok -', name); };

console.log('document-review-guide pure tests');

// 1 — an insurance document yields the note-buyer's insurance checklist.
{
  const guide = g.reviewGuideForDocType('insurance', { noteBuyerKey: 'bluelake' });
  assert.strictEqual(guide.docType, 'insurance');
  assert.ok(Array.isArray(guide.items) && guide.items.length > 0, 'insurance has items');
  const hazard = guide.items.find((it) => /insurance/i.test(it.condition || ''));
  assert.ok(hazard, 'a hazard-insurance condition is present');
  assert.ok(Array.isArray(hazard.checks) && hazard.checks.length > 0, 'it carries concrete checks');
  assert.ok(hazard.checks.join(' ').toLowerCase().includes('coverage')
    || (hazard.required_evidence || '').toLowerCase().includes('coverage'), 'a coverage check/requirement is surfaced');
  ok('insurance doc → note-buyer insurance checklist with concrete checks');
}

// 2 — a title document yields title checklist items; an unknown type yields none.
{
  const title = g.reviewGuideForDocType('title', { noteBuyerKey: 'bluelake' });
  assert.ok(title.items.length > 0 && title.items.every((it) => Array.isArray(it.checks)), 'title items');
  const none = g.reviewGuideForDocType('not_a_real_doctype', {});
  assert.deepStrictEqual(none.items, [], 'unknown doc type → no items');
  ok('title doc → items; unknown doc type → empty');
}

// 3 — null-safe / never throws on hostile input.
{
  for (const bad of [null, undefined, '', 42, {}, []]) {
    const r = g.reviewGuideForDocType(bad, null);
    assert.ok(r && Array.isArray(r.items), 'always returns { items:[] }');
  }
  assert.strictEqual(g.reviewGuideText(null), '', 'reviewGuideText(null) → empty string');
  assert.strictEqual(g.reviewGuideText({ items: [] }), '', 'no items → empty string');
  ok('null-safe: hostile input never throws, empty guide → empty text');
}

// 4 — the note-buyer filter: a value scoped to Blue Lake only does not surface for CorrFirst,
//     but the shared (all-buyer) requirements still do.
{
  const forCorr = g.reviewGuideForDocType('insurance', { noteBuyerKey: 'corrfirst' });
  const forBlue = g.reviewGuideForDocType('insurance', { noteBuyerKey: 'bluelake' });
  // both buyers require insurance, so both have items…
  assert.ok(forCorr.items.length > 0 && forBlue.items.length > 0, 'both buyers have insurance items');
  // …but no CorrFirst item is tagged as a different buyer's own value, and vice-versa.
  assert.ok(forCorr.items.every((it) => it.noteBuyer === 'corrfirst' || it.noteBuyerSpecific === false),
    'CorrFirst view only shows corrfirst-own or shared items');
  // a raw free-text lender name normalizes the same as the key.
  const rawName = g.reviewGuideForDocType('insurance', { noteBuyerKey: 'Blue Lake' });
  assert.strictEqual(rawName.items.length, forBlue.items.length, '"Blue Lake" normalizes to bluelake');
  ok('note-buyer filter: buyer-own + shared only; raw lender name normalizes');
}

// 5 — reviewGuideText renders a usable grounding block.
{
  const text = g.reviewGuideText(g.reviewGuideForDocType('insurance', { noteBuyerKey: 'bluelake' }));
  assert.ok(typeof text === 'string' && text.length > 0, 'produces text');
  assert.ok(/CHECKLIST/i.test(text), 'labels itself a checklist');
  assert.ok(text.includes('-'), 'lists the check bullets');
  ok('reviewGuideText → a grounding checklist block');
}

// 6 — no note buyer set → union across every buyer, deduped (a shared requirement listed once).
{
  const all = g.reviewGuideForDocType('insurance', {});
  const keys = all.items.map((it) => `${it.condition}|${(it.checks || []).join('|')}`);
  assert.strictEqual(new Set(keys).size, keys.length, 'no duplicate condition+checks rows');
  ok('no buyer set → deduped union across all buyers');
}

console.log(`\ndocument-review-guide: ${n} checks passed`);
