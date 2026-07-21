#!/usr/bin/env node
'use strict';
/**
 * Unit tests for the OCR router (src/lib/ai/ocr-router.js). No network — the two
 * engines are stubbed in via jest-style intercepts so we can assert the routing
 * decisions (primary succeeds vs empty; Google rescue; both fail) without any
 * live keys. Also confirms the primary-looks-empty heuristic.
 */
const assert = require('assert');
const Module = require('module');

// Intercept the two engine modules BEFORE ocr-router requires them.
let azureImpl = () => ({ ok: false, reason: 'stub' });
let googleImpl = () => ({ ok: false, reason: 'stub' });
let googleConfigured = true;
const origResolve = Module._resolveFilename;
const origLoad = Module._load;
Module._load = function stubbedLoad(request, parent, ...rest) {
  if (request === './docint' && parent && parent.filename && parent.filename.includes('ocr-router')) {
    return { read: (a) => Promise.resolve(azureImpl(a)), configured: () => true, ping: async () => ({ ok: true }) };
  }
  if (request === './docai-google' && parent && parent.filename && parent.filename.includes('ocr-router')) {
    return { read: (a) => Promise.resolve(googleImpl(a)), configured: () => googleConfigured, ping: async () => ({ ok: true }) };
  }
  return origLoad.call(this, request, parent, ...rest);
};

const router = require('../src/lib/ai/ocr-router');

(async () => {
  // 1. Primary succeeds with real text → return primary, engineSequence has only 'azure'.
  azureImpl = () => ({ ok: true, text: 'Contract for the sale of real estate — 20 pages of readable content', pageCount: 20, pages: [] });
  googleImpl = () => ({ ok: true, text: 'GOOGLE READ', pageCount: 1, pages: [] });
  {
    const r = await router.read({ buffer: Buffer.alloc(200 * 1024) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.engine, 'azure-docint', 'primary wins when it returned real text');
    assert.deepStrictEqual(r.engineSequence, ['azure']);
    assert.strictEqual(r.text, 'Contract for the sale of real estate — 20 pages of readable content');
  }

  // 2. Primary returns EMPTY on a big file → Google rescue kicks in, returns Google's text.
  azureImpl = () => ({ ok: true, text: '', pageCount: 5, pages: [] });
  googleImpl = () => ({ ok: true, text: 'Google rescued the scan — real content here across many lines to look real', pageCount: 5, pages: [] });
  {
    const r = await router.read({ buffer: Buffer.alloc(500 * 1024) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.engine, 'google-docai', 'Google wins when Azure came back empty');
    assert.deepStrictEqual(r.engineSequence, ['azure', 'google']);
    assert.strictEqual(r.rescuedFrom, 'azure-docint');
    assert.ok(r.text.includes('Google rescued'), 'the rescued text is returned');
  }

  // 3. Primary FAILS outright (ok:false) → Google rescue.
  azureImpl = () => ({ ok: false, reason: 'Azure endpoint 500' });
  googleImpl = () => ({ ok: true, text: 'Google saved the day here with plenty of content bytes', pageCount: 2, pages: [] });
  {
    const r = await router.read({ buffer: Buffer.alloc(300 * 1024) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.engine, 'google-docai');
    assert.strictEqual(r.primaryReason, 'Azure endpoint 500');
  }

  // 4. Both engines empty/fail → returns the primary's error unchanged.
  azureImpl = () => ({ ok: false, reason: 'Azure timeout' });
  googleImpl = () => ({ ok: false, reason: 'Google not reachable' });
  {
    const r = await router.read({ buffer: Buffer.alloc(300 * 1024) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.engine, 'azure-docint');
    assert.strictEqual(r.primaryReason, 'Azure timeout');
    assert.strictEqual(r.challengerReason, 'Google not reachable');
    assert.deepStrictEqual(r.engineSequence, ['azure', 'google']);
  }

  // 5. Google NOT configured → no rescue attempted; primary result returned.
  googleConfigured = false;
  azureImpl = () => ({ ok: false, reason: 'Azure empty' });
  {
    const r = await router.read({ buffer: Buffer.alloc(300 * 1024) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.engine, 'azure-docint');
    assert.deepStrictEqual(r.engineSequence, ['azure'], 'no google in the sequence when it is not configured');
  }
  googleConfigured = true;

  // 6. `forceEngine:'google'` bypasses the router entirely.
  azureImpl = () => { throw new Error('should not be called'); };
  googleImpl = () => ({ ok: true, text: 'Direct to Google', pageCount: 1, pages: [] });
  {
    const r = await router.read({ buffer: Buffer.alloc(1000), forceEngine: 'google' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.engine, 'google-docai');
    assert.deepStrictEqual(r.engineSequence, ['google']);
  }

  // 7. primaryLooksEmpty heuristic — small docs are OK to be short; big docs are NOT.
  const { primaryLooksEmpty } = router._internals;
  assert.strictEqual(primaryLooksEmpty({ ok: true, text: 'Cash receipt: $42' }, 1024), false, 'a small receipt reading briefly is fine');
  assert.strictEqual(primaryLooksEmpty({ ok: true, text: 'x' }, 1024), true, 'trivially-short text is still suspicious');
  assert.strictEqual(primaryLooksEmpty({ ok: true, text: 'x'.repeat(50) }, 500 * 1024), true, '50 chars from a 500 KB doc is empty-suspicious');
  assert.strictEqual(primaryLooksEmpty({ ok: true, text: 'x'.repeat(500) }, 500 * 1024), false, '500 chars from a 500 KB doc reads');
  assert.strictEqual(primaryLooksEmpty({ ok: false, reason: 'fail' }, 1024), true, 'a failed primary is always empty');
  assert.strictEqual(primaryLooksEmpty({ ok: true, text: 'A short 30-char sample of real text' }, 100 * 1024), false, 'a small (~100 KB) doc reading 30 chars is fine');

  console.log('test-ocr-router: routing decisions + empty heuristic pass');
})().catch((e) => { console.error(e); process.exit(1); });
