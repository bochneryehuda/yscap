'use strict';
/* Sitewire client — 304 no-op + retry-safety unit tests (NO DB, NO real network).
 * Stubs global.fetch. Proves:
 *  · a 304 Not Modified is a SUCCESSFUL no-op (never a park) — the "could not assign borrower … (Sitewire
 *    304)" class: re-assigning the SAME borrower email on a re-push is "already in that state", not a failure.
 *  · a budget PATCH carrying id-LESS creates is NOT retried in-call (a lost response must not duplicate a
 *    job-item line — the "Exterior of House Photos appears twice" class); a pure update batch stays retryable.
 * Run: node scripts/test-sitewire-client-304.js */

// Sitewire client needs the 3-header token present (authHeaders throws otherwise) + the outbound gate on.
process.env.SITEWIRE_ACCESS_TOKEN = process.env.SITEWIRE_ACCESS_TOKEN || 'test-at';
process.env.SITEWIRE_CLIENT = process.env.SITEWIRE_CLIENT || 'test-client';
process.env.SITEWIRE_UID = process.env.SITEWIRE_UID || 'test-uid';
process.env.SITEWIRE_OUTBOUND_ENABLED = '1';
process.env.SITEWIRE_DRYRUN = '0';
process.env.SITEWIRE_MAX_TRIES = '3';

const assert = require('assert');
const client = require('../src/sitewire/client');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const realFetch = global.fetch;

// Minimal Response-ish stub honoring what fetchWithTimeout reads (.status, .ok, .headers.get, .text()).
function stubResponse({ status, body = '' }) {
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

(async () => {
  // ---- 304 on borrower assign resolves as an unchanged no-op (never throws / parks) ----
  let calls = 0;
  global.fetch = async () => { calls++; return stubResponse({ status: 304, body: '' }); };
  const res = await client.assignBorrower(1234, 'moshespitzer123@gmail.com');
  assert.ok(res && res.__unchanged === true, '304 → { __unchanged:true } (a successful no-op, not an error)');
  assert.strictEqual(calls, 1, '304 is terminal — not retried');
  ok('304 Not Modified is a successful no-op (borrower re-assign on a re-push never parks)');

  // ---- a 304 with a JSON body preserves the body and still marks unchanged ----
  global.fetch = async () => stubResponse({ status: 304, body: { id: 5 } });
  const res2 = await client.call('/api/v2/anything', { method: 'PATCH', body: { x: 1 } });
  assert.strictEqual(res2.id, 5); assert.strictEqual(res2.__unchanged, true);
  ok('304 with a body → body preserved + __unchanged');

  // ---- a budget PATCH with id-LESS creates is NOT retried in-call on a transient 500 ----
  let patchCalls = 0;
  global.fetch = async () => { patchCalls++; return stubResponse({ status: 500, body: {} }); };
  await assert.rejects(
    client.updateBudget(77, { job_items: [{ name: 'Exterior of House Photos', budgeted_cents: 0 }], draw_eligible: true }),
    (e) => e && e.status === 500 && e.retryable === true,
    'an id-less-create budget PATCH surfaces the 500 as retryable (queue re-drives), not an in-call retry');
  assert.strictEqual(patchCalls, 1, 'id-less-create PATCH is sent ONCE in-call (no duplicate-making retry)');
  ok('budget PATCH with id-less creates is not retried in-call (no duplicate line)');

  // ---- a pure UPDATE batch (every job_item has an id) STAYS retryable in-call ----
  let updCalls = 0;
  global.fetch = async () => { updCalls++; return stubResponse({ status: 500, body: {} }); };
  await assert.rejects(
    client.updateBudget(77, { job_items: [{ id: 42, budgeted_cents: 1000 }], draw_eligible: true }),
    (e) => e && e.status === 500);
  assert.strictEqual(updCalls, 3, 'a pure id-bearing update batch is idempotent → retried the full in-call budget');
  ok('pure update batch stays idempotent/retryable in-call');

  global.fetch = realFetch;
  console.log(`\nAll ${n} Sitewire client 304 / retry-safety checks passed.`);
})().catch((e) => { global.fetch = realFetch; console.error(e); process.exit(1); });
