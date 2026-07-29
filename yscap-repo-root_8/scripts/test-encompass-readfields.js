'use strict';
/**
 * Unit test for src/encompass/client.js `readFields` — response-shape normalization
 * + the invalid-field split resilience. No network: the low-level
 * `encompass.fieldReader` is mocked so the exact wire shapes and failure modes can be
 * driven deterministically.
 *
 * Asserts:
 *   1. an OBJECT map response (v3) is returned normalized.
 *   2. an ARRAY response (v1, [{fieldId,value}]) normalizes to the SAME map.
 *   3. an invalid-field 400 with ONE bad id splits the list and returns the GOOD
 *      fields (the bad id isolated), WITHOUT throwing.
 *   4. a NETWORK / timeout error does NOT fan out — fieldReader is called EXACTLY
 *      ONCE and the error propagates (no request storm during an Encompass outage).
 *   5. a total 400 (every id invalid) still throws (nothing to isolate).
 */
const assert = require('assert');

process.env.ENCOMPASS_CLIENT_ID = process.env.ENCOMPASS_CLIENT_ID || 'test-client';
process.env.ENCOMPASS_CLIENT_SECRET = process.env.ENCOMPASS_CLIENT_SECRET || 'test-secret';
process.env.ENCOMPASS_INSTANCE_ID = process.env.ENCOMPASS_INSTANCE_ID || 'TESTINSTANCE';

// Mock the low-level integration module BEFORE requiring the client, so no real fetch
// ever runs. `calls` records each fieldReader invocation's id list; `handler` decides
// the response/error per test.
const encPath = require.resolve('../src/lib/integrations/encompass');
let calls = [];
let handler = null;
require.cache[encPath] = {
  id: encPath, filename: encPath, loaded: true,
  exports: {
    name: 'encompass', READ_ONLY: true, configured: () => true, ping: async () => ({ ok: true }),
    apiGet: async () => ({}), pipelineSearch: async () => [],
    fieldReader: async (guid, ids) => { calls.push(ids.slice()); return handler(guid, ids); },
  },
};

const client = require('../src/encompass/client');

async function main() {
  // (1) object map (v3) passes through normalized.
  calls = []; handler = async () => ({ '1859': 'MW TRADING LLC', '388': '1.000' });
  let r = await client.readFields('guid-abc-123', ['1859', '388']);
  assert.deepStrictEqual(r, { '1859': 'MW TRADING LLC', '388': '1.000' }, 'object map normalized');

  // (2) array shape (v1) normalizes to the SAME map.
  calls = []; handler = async () => [{ fieldId: '1859', value: 'MW TRADING LLC' }, { fieldId: '388', value: '1.000' }];
  r = await client.readFields('guid-abc-123', ['1859', '388']);
  assert.deepStrictEqual(r, { '1859': 'MW TRADING LLC', '388': '1.000' }, 'array normalized to the same map');

  // (3) invalid-field 400 on ONE id: split isolates the bad id, returns the good ones.
  const BAD = 'CX.NOPE';
  calls = [];
  handler = async (guid, ids) => {
    if (ids.includes(BAD)) throw new Error('Encompass fieldReader 400: invalid field ' + BAD);
    const out = {}; for (const id of ids) out[id] = 'v-' + id; return out;
  };
  r = await client.readFields('guid-abc-123', ['1859', '388', BAD, '364']);
  assert.ok(!(BAD in r), 'the invalid id is isolated out');
  assert.strictEqual(r['1859'], 'v-1859', 'good field 1859 returned despite the bad id');
  assert.strictEqual(r['388'], 'v-388', 'good field 388 returned');
  assert.strictEqual(r['364'], 'v-364', 'good field 364 returned');

  // (4) a NETWORK error does NOT fan out — fieldReader called exactly once, error thrown.
  calls = []; handler = async () => { throw new Error('fetch failed: ECONNRESET'); };
  await assert.rejects(() => client.readFields('guid-abc-123', ['1859', '388', '364', '4']), /ECONNRESET/, 'network error propagates');
  assert.strictEqual(calls.length, 1, 'a network error must NOT trigger a retry fan-out (exactly one call)');

  // (5) a TOTAL 400 (every id invalid) still throws — nothing to isolate.
  calls = []; handler = async () => { throw new Error('Encompass fieldReader 400: all invalid'); };
  await assert.rejects(() => client.readFields('guid-abc-123', ['a', 'b']), /400/, 'total 400 still throws');

  // (6) empty id list short-circuits (no call).
  calls = []; handler = async () => ({ x: 1 });
  assert.deepStrictEqual(await client.readFields('guid-abc-123', []), {}, 'empty id list → {} with no call');
  assert.strictEqual(calls.length, 0, 'no fieldReader call for an empty id list');

  console.log('OK — Encompass readFields normalizes both shapes; splits only on an invalid-field 400; never fans out on a network outage.');
}

main().catch((e) => { console.error(e); process.exit(1); });
