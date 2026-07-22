#!/usr/bin/env node
'use strict';
/** Pure test for src/lib/underwriting/splitter-suggest.js — mocks azure-custom + ai-suggestions. */
const assert = require('assert');

// Env — classifier ON so classifierConfigured() returns true.
process.env.AZURE_DOCINT_ENDPOINT = 'https://x';
process.env.AZURE_DOCINT_KEY = 'k';
process.env.AZURE_DOCINT_CLASSIFIER_ID = 'pilot-doc-splitter';
for (const k of Object.keys(require.cache)) if (/\/(src\/config|lib\/(ai\/(azure-custom|langfuse)|underwriting\/(ai-suggestions|splitter-suggest|wrong-condition)))\.js$/.test(k)) delete require.cache[k];

// Stub azure-custom to a controlled classify() result.
require.cache[require.resolve('../src/lib/ai/azure-custom')] = { exports: {
  classifierConfigured: () => true,
  classify: async () => ({
    ok: true,
    segments: [
      { docType: 'bank_statement', rawLabel: 'bank_statement', confidence: 0.92, pages: [1, 2, 3] },
      { docType: 'insurance', rawLabel: 'insurance', confidence: 0.88, pages: [4] },
      { docType: 'drivers_license', rawLabel: 'drivers_license', confidence: 0.85, pages: [5] },
    ],
  }),
} };
// Stub langfuse (dormant).
require.cache[require.resolve('../src/lib/ai/langfuse')] = { exports: {
  enabled: () => false, trace: () => ({ id: null, end: () => {}, url: () => null }),
} };
// Capture ai-suggestions.record calls.
let posted = null;
require.cache[require.resolve('../src/lib/underwriting/ai-suggestions')] = { exports: {
  record: async (_c, s) => { posted = s; return { id: 'sug-split-1', deduped: false }; },
} };

const ss = require('../src/lib/underwriting/splitter-suggest');

(async () => {
  // ---- Too small → skipped ----
  const small = await ss.suggestSplit({}, { applicationId: 'app', documentId: 'doc-small', pageCount: 3 });
  assert.strictEqual(small.ok, false);
  assert.match(small.reason, /too small/);

  // ---- Combined PDF with 3 distinct types → suggestion posted ----
  const r = await ss.suggestSplit({}, { applicationId: 'app-1', documentId: 'doc-big', pageCount: 5, buffer: Buffer.from('x') });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.segments, 3);
  assert.strictEqual(r.suggestionId, 'sug-split-1');
  assert.ok(posted, 'suggestion was posted');
  assert.strictEqual(posted.source, 'splitter');
  assert.strictEqual(posted.kind, 'info');
  assert.match(posted.title, /3 different documents/);
  assert.match(posted.body, /bank statement — page\(s\) 1, 2, 3/);
  assert.match(posted.body, /insurance dec page — page\(s\) 4/);
  assert.strictEqual(posted.proposedAction.type, 'split_and_file');
  assert.strictEqual(posted.proposedAction.segments.length, 3);
  assert.strictEqual(posted.dedupeKey, 'splitter:doc-big');
  assert.ok(Array.isArray(posted.evidence.segments[0].candidateConditionCodes));
  assert.ok(posted.evidence.segments[0].candidateConditionCodes.includes('rtl_p3_assets'));

  // ---- Single-type upload → no suggestion ----
  require.cache[require.resolve('../src/lib/ai/azure-custom')].exports.classify = async () => ({
    ok: true, segments: [{ docType: 'insurance', rawLabel: 'insurance', confidence: 0.9, pages: [1, 2, 3, 4, 5] }],
  });
  posted = null;
  delete require.cache[require.resolve('../src/lib/underwriting/splitter-suggest')];
  const ss2 = require('../src/lib/underwriting/splitter-suggest');
  const single = await ss2.suggestSplit({}, { applicationId: 'app', documentId: 'doc-single', pageCount: 5, buffer: Buffer.from('x') });
  assert.strictEqual(single.ok, true);
  assert.match(single.reason, /single-type/);
  assert.strictEqual(posted, null, 'no suggestion for a single-type upload');

  console.log('test-splitter-suggest-pure: min-pages skip + 3-type combined suggestion + single-type silence all pass');
})().catch(e => { console.error(e); process.exit(1); });
