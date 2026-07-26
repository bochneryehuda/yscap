'use strict';
/**
 * Integration test: the two Azure clients (docint.js reader + azure-openai.js analyzer) are
 * actually WIRED to the resilience layer — a transient 429 is retried (not surfaced as a hard
 * failure), and the happy path still returns clean results. Uses a stubbed global.fetch; no
 * network, no keys beyond the env we set here so config reports "configured".
 */
const assert = require('assert');

// Config reads env at require time — set fake endpoints/keys BEFORE requiring the clients.
process.env.AZURE_DOCINT_ENDPOINT = 'https://fake-docint.example.com';
process.env.AZURE_DOCINT_KEY = 'fake-docint-key';
process.env.AZURE_OPENAI_ENDPOINT = 'https://fake-openai.example.com';
process.env.AZURE_OPENAI_KEY = 'fake-openai-key';
process.env.AZURE_OPENAI_DEPLOYMENT = 'gpt-test';

const docint = require('../src/lib/ai/docint');
const openai = require('../src/lib/ai/azure-openai');
const { _resetBreakers } = require('../src/lib/ai/resilience');

// A minimal Response shim.
function resp({ status = 200, headers = {}, json = {}, opLocation } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (opLocation) h.set('operation-location', opLocation);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) },
    json: async () => json,
  };
}

const realFetch = global.fetch;
function stubFetch(handler) { global.fetch = handler; }
function restore() { global.fetch = realFetch; }

async function main() {
  // -------------------------------------------------------------------------
  // (1) Analyzer: a 429 with retry-after-ms:0 is retried, then succeeds.
  // -------------------------------------------------------------------------
  {
    _resetBreakers();
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      if (calls === 1) return resp({ status: 429, headers: { 'retry-after-ms': '0' }, json: { error: { message: 'slow down' } } });
      return resp({ status: 200, json: { choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: {} } });
    });
    const res = await openai.complete({ userContent: 'hi' });
    assert.ok(res.ok, 'a 429 then 200 should end OK, not a hard failure');
    assert.strictEqual(calls, 2, 'retried exactly once');
  }

  // -------------------------------------------------------------------------
  // (2) Analyzer: a content-filter 400 is terminal — NOT retried, flagged blocked.
  // -------------------------------------------------------------------------
  {
    _resetBreakers();
    let calls = 0;
    stubFetch(async () => { calls += 1; return resp({ status: 400, json: { error: { code: 'content_filter', message: 'blocked' } } }); });
    const res = await openai.complete({ userContent: 'hi' });
    assert.ok(!res.ok && res.blocked, 'content filter is a clean block');
    assert.strictEqual(calls, 1, 'a document-specific 400 is never retried');
  }

  // -------------------------------------------------------------------------
  // (3) Reader: a 500 on submit is retried, then the poll succeeds.
  // -------------------------------------------------------------------------
  {
    _resetBreakers();
    let submitCalls = 0;
    stubFetch(async (url) => {
      if (String(url).includes(':analyze')) {
        submitCalls += 1;
        if (submitCalls === 1) return resp({ status: 500, headers: { 'retry-after': '0' }, json: { error: { message: 'oops' } } });
        return resp({ status: 202, opLocation: 'https://fake-docint.example.com/op/123' });
      }
      // poll
      return resp({ status: 200, json: { status: 'succeeded', analyzeResult: { content: 'HELLO WORLD', pages: [{}] } } });
    });
    const res = await docint.read({ base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
    assert.ok(res.ok && res.text === 'HELLO WORLD', 'reader retried the 500 then read the text');
    assert.strictEqual(submitCalls, 2, 'submit retried once');
  }

  // -------------------------------------------------------------------------
  // (4) Reader: a 400 (bad document) is terminal and surfaced as non-retriable.
  // -------------------------------------------------------------------------
  {
    _resetBreakers();
    let submitCalls = 0;
    stubFetch(async () => { submitCalls += 1; return resp({ status: 400, json: { error: { message: 'InvalidContent' } } }); });
    const res = await docint.read({ base64: Buffer.from('x').toString('base64'), mimeType: 'application/pdf' });
    assert.ok(!res.ok, 'bad document fails');
    assert.strictEqual(res.retriable, false, 'a 400 is not retriable');
    assert.strictEqual(submitCalls, 1, 'not retried');
  }

  restore();
  console.log('ai-client-retry: all tests passed');
}

main().catch((e) => { restore(); console.error(e); process.exit(1); });
