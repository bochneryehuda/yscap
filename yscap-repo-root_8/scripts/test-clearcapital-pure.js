'use strict';
/**
 * #149 (R5.52) — pure tests for the Clear Capital ClearAVM connector. Proves:
 *   • buildAvmRequest needs a key + a street/zip address, POSTs the address with a
 *     bearer auth header, and honors an env-overridable AVM path;
 *   • parseAvmResponse reads the value TOLERANTLY across plausible field shapes,
 *     normalizes confidence (0..100 → 0..1), carries the low/high range, and returns
 *     a clean {ok:false} (never a guessed number) when there is no value;
 *   • fetch() flows through an injected HTTP impl and never throws;
 *   • the credential (bearer key) never appears in the URL.
 */
const assert = require('assert');
const cc = require('../src/lib/integrations/direct-source-connectors/clearcapital');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const CTX = { property: { street: '12 Main St', city: 'Athens', state: 'GA', zip: '30601' } };

// 1. buildAvmRequest — key + address required; POST + bearer header; path override.
{
  assert.strictEqual(cc.buildAvmRequest({}, CTX).ok, false, 'no key → not ok');
  assert.strictEqual(cc.buildAvmRequest({ key: 'k' }, { property: { city: 'X' } }).ok, false, 'no street/zip → not ok');
  const r = cc.buildAvmRequest({ key: 'SECRET_KEY', endpoint: 'https://api.clearcapital.com', avmPath: '/uve/v1.0.0/avm' }, CTX);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://api.clearcapital.com/uve/v1.0.0/avm');
  assert.strictEqual(r.headers.Authorization, 'Bearer SECRET_KEY');
  assert.deepStrictEqual(r.body, { address: '12 Main St', city: 'Athens', state: 'GA', zip: '30601' });
  assert.ok(!/SECRET_KEY/.test(r.url), 'the key never appears in the URL');
  // a path without a leading slash is still joined correctly
  assert.strictEqual(cc.buildAvmRequest({ key: 'k', avmPath: 'x/y' }, CTX).url, 'https://api.clearcapital.com/x/y');
  ok('buildAvmRequest requires key+address, POSTs with a bearer header, path override honored, key not in URL');
}

// 2. parseAvmResponse — tolerant value read + range + confidence normalization.
{
  const a = cc.parseAvmResponse({ value: 452000, low: 430000, high: 475000, confidence: 92 });
  assert.strictEqual(a.ok, true);
  assert.strictEqual(a.observations[0].fact_key, 'appraisal.arv');
  assert.strictEqual(a.observations[0].raw_value, 452000);
  assert.deepStrictEqual(a.observations[0].value_json, { value: 452000, low: 430000, high: 475000, source: 'clearcapital_avm' });
  assert.strictEqual(a.observations[0].confidence, 0.92, '0..100 confidence normalizes to 0..1');
  // an alternate envelope shape still resolves the value
  const b = cc.parseAvmResponse({ valuation: { value: 300000 }, valueRange: { low: 290000, high: 310000 } });
  assert.strictEqual(b.observations[0].raw_value, 300000);
  assert.strictEqual(b.observations[0].value_json.low, 290000);
  // an already-0..1 confidence passes through; missing confidence → sane default
  assert.strictEqual(cc.parseAvmResponse({ value: 1, confidence: 0.7 }).observations[0].confidence, 0.7);
  assert.strictEqual(cc.parseAvmResponse({ value: 1 }).observations[0].confidence, 0.85);
  ok('parseAvmResponse reads value tolerantly, carries range, normalizes confidence');
}

// 3. no usable value → clean {ok:false}, never a guessed number.
{
  const r = cc.parseAvmResponse({ message: 'address not found' });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.observations, []);
  assert.ok(/address not found/.test(r.reason), 'the vendor message is surfaced');
  assert.strictEqual(cc.parseAvmResponse({ value: 0 }).ok, false, 'a zero value is not a valuation');
  assert.strictEqual(cc.parseAvmResponse(null).ok, false);
  ok('no usable value → clean {ok:false}; never invents a number');
}

// 4. fetch flows through an injected HTTP impl and never throws.
{
  (async () => {
    // stub cfg so configured()/fetch build a request; inject a fake fetch returning a value.
    const cfg = require('../src/config');
    cfg.clearCapital = { key: 'k', endpoint: 'https://api.clearcapital.com', avmPath: '/uve/v1.0.0/avm' };
    // _http.requestJson reads the body via text() then JSON-parses it.
    const jsonResp = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj), json: async () => obj });
    const fakeFetch = async () => jsonResp({ value: 500000, confidence: 88 });
    const res = await cc.fetch('app1', CTX, { fetchImpl: fakeFetch });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.observations[0].raw_value, 500000);
    // an http error → clean not-ok, never a throw
    const errFetch = async () => ({ ok: false, status: 503, json: async () => null, text: async () => '' });
    const res2 = await cc.fetch('app1', CTX, { fetchImpl: errFetch });
    assert.strictEqual(res2.ok, false);
    // hostile inputs never throw
    for (const bad of [null, undefined, 42, 'x', []]) {
      await assert.doesNotReject(() => cc.fetch('app1', bad, {}));
      assert.doesNotThrow(() => cc.buildAvmRequest(bad, bad));
      assert.doesNotThrow(() => cc.parseAvmResponse(bad));
      assert.doesNotThrow(() => cc.addressParts(bad));
    }
    ok('fetch flows through an injected HTTP impl; http error → not-ok; hostile input never throws');
    console.log(`\nclearcapital pure — ${passed} checks passed`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
