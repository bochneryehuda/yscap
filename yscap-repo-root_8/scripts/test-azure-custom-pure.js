#!/usr/bin/env node
'use strict';
/**
 * Pure tests for src/lib/ai/azure-custom.js — no real HTTP. Overrides fetch to simulate
 * the classifier + extractor submit/poll cycle and asserts the returned segments + fields
 * shape. Covers configured/unconfigured branches, canonical DOC_TYPES normalization, and
 * a realistic classify() → per-type extract() flow.
 */
const assert = require('assert');

// Force the classifier + one extractor id ON, keep the others OFF.
process.env.AZURE_DOCINT_ENDPOINT = 'https://pilot-docint.cognitiveservices.azure.com';
process.env.AZURE_DOCINT_KEY = 'test-key';
process.env.AZURE_DOCINT_CLASSIFIER_ID = 'pilot-doc-splitter';
process.env.AZURE_DOCINT_EXTRACT_BANK_STATEMENT = 'pilot-bank-statement';
delete process.env.AZURE_DOCINT_EXTRACT_INSURANCE;

for (const k of Object.keys(require.cache)) if (/\/(src\/config|lib\/ai\/(azure-custom|langfuse))\.js$/.test(k)) delete require.cache[k];

// Stub fetch — records + replies based on URL.
const calls = [];
let submitCount = 0;
global.fetch = async (url, opts) => {
  calls.push({ url, method: opts && opts.method });
  if (opts && opts.method === 'POST' && /:analyze/.test(url)) {
    submitCount += 1;
    return {
      status: 202, ok: true,
      headers: { get: (k) => k.toLowerCase() === 'operation-location' ? `https://poll/${submitCount}` : null },
      json: async () => ({}),
    };
  }
  if (/^https:\/\/poll\/1$/.test(url)) {   // classifier poll
    return {
      status: 200, ok: true, headers: { get: () => null },
      json: async () => ({
        status: 'succeeded',
        analyzeResult: {
          documents: [
            { docType: 'bank_statement', confidence: 0.94, boundingRegions: [{ pageNumber: 1 }, { pageNumber: 2 }] },
            { docType: 'drivers_license', confidence: 0.88, boundingRegions: [{ pageNumber: 3 }] },
            { docType: 'insurance', confidence: 0.71, boundingRegions: [{ pageNumber: 4 }, { pageNumber: 5 }] },
          ],
        },
      }),
    };
  }
  if (/^https:\/\/poll\/2$/.test(url)) {   // bank-statement extractor poll
    return {
      status: 200, ok: true, headers: { get: () => null },
      json: async () => ({
        status: 'succeeded',
        analyzeResult: {
          documents: [{
            docType: 'pilot-bank-statement',
            confidence: 0.92,
            fields: {
              account_holder_name: { valueString: 'JOHN DOE', type: 'string', confidence: 0.98, boundingRegions: [{ pageNumber: 1, polygon: [0, 0] }] },
              ending_balance:      { valueNumber: 24500.13, type: 'number', confidence: 0.87 },
              period_start:        { valueDate: '2026-06-01', type: 'date', confidence: 0.99 },
              period_end:          { valueDate: '2026-06-30', type: 'date', confidence: 0.99 },
            },
          }],
        },
      }),
    };
  }
  return { status: 500, ok: false, headers: { get: () => null }, json: async () => ({}) };
};

// Speed the polls up so the test is fast.
const azc = require('../src/lib/ai/azure-custom');

(async function main() {
  // ---- Config branches ----
  assert.strictEqual(azc.classifierConfigured(), true);
  assert.strictEqual(azc.extractorConfigured('bank_statement'), true);
  assert.strictEqual(azc.extractorConfigured('insurance'), false, 'insurance extractor is unset');

  // Type normalization
  assert.strictEqual(azc.normalizeType('Bank Statement'), 'bank_statement');
  assert.strictEqual(azc.normalizeType('photo_id'), 'drivers_license');   // alias
  assert.strictEqual(azc.normalizeType('HOI'), 'insurance');              // alias
  assert.strictEqual(azc.normalizeType('nothing'), null);

  // ---- classify() ----
  const buf = Buffer.from('%PDF-1.4 stub');
  const c = await azc.classify({ buffer: buf, appId: 'app-1', documentId: 'doc-1' });
  assert.strictEqual(c.ok, true);
  assert.strictEqual(c.segments.length, 3);
  assert.deepStrictEqual(c.segments[0], { docType: 'bank_statement', rawLabel: 'bank_statement', confidence: 0.94, pages: [1, 2] });
  assert.deepStrictEqual(c.segments[1].pages, [3]);
  assert.deepStrictEqual(c.segments[2].pages, [4, 5]);

  // ---- extract() for the trained type ----
  const e = await azc.extract({ docType: 'bank_statement', buffer: buf, pages: '1-2', appId: 'app-1', documentId: 'doc-1' });
  assert.strictEqual(e.ok, true);
  assert.strictEqual(e.docType, 'bank_statement');
  assert.strictEqual(e.fields.account_holder_name.value, 'JOHN DOE');
  assert.strictEqual(e.fields.ending_balance.value, 24500.13);
  assert.strictEqual(e.fields.ending_balance.confidence, 0.87);
  assert.strictEqual(e.fields.period_start.value, '2026-06-01');

  // The submit URL for the extractor MUST include ?pages=1-2 (per the argument).
  const extractorSubmit = calls.find(c => c.method === 'POST' && /pilot-bank-statement/.test(c.url));
  assert.ok(/pages=1-2/.test(extractorSubmit.url), 'pages param propagated');

  // ---- extract() for an unconfigured type is a clean failure ----
  const bad = await azc.extract({ docType: 'insurance', buffer: buf });
  assert.strictEqual(bad.ok, false);
  assert.match(bad.reason, /no custom extractor trained for insurance/);

  console.log('test-azure-custom-pure: classifier + extractor + type-normalize + config branches all pass');
})().catch(e => { console.error(e); process.exit(1); });
