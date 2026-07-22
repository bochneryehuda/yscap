#!/usr/bin/env node
'use strict';
/**
 * Pure tests for src/lib/ai/langfuse.js — no HTTP, no DB. Overrides fetch to CAPTURE
 * what the tracer WOULD send, then asserts the shape/PII-redaction/wrapper semantics.
 */
const assert = require('assert');

// Force enable BEFORE requiring so `enabled()` returns true.
process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
process.env.LANGFUSE_HOST = 'https://us.cloud.langfuse.com';

// Clear the module cache in case a previous test loaded it in another parent.
for (const k of Object.keys(require.cache)) if (/\/(lib\/ai\/langfuse|src\/config)\.js$/.test(k)) delete require.cache[k];

const captured = [];
const origFetch = global.fetch;
global.fetch = async (url, opts) => {
  captured.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, status: 200, json: async () => ({}) };
};

const lf = require('../src/lib/ai/langfuse');

(async function main() {
  assert.strictEqual(lf.enabled(), true, 'enabled with keys set');

  // ---- 1. Trace + generation + span shape ----
  const t = lf.trace({ name: 'unit-test', appId: 'app-1', staffId: 'staff-1', tags: ['t'], input: { q: 'hello' } });
  assert.ok(t.id && typeof t.url === 'function', 'trace has id + url()');
  const g = t.generation({ name: 'gen1', model: 'gpt-5', input: { prompt: 'x' } });
  g.end({ output: { text: 'y' }, usage: { prompt_tokens: 100, completion_tokens: 20 }, confidence: 0.9 });
  const s = t.span({ name: 'span1' });
  s.end({ output: { rows: 3 } });
  t.end({ output: { done: true } });

  await lf.flushNow();
  assert.ok(captured.length >= 1, 'at least one flush went out');
  const events = captured.flatMap(c => c.body.batch);
  const types = new Set(events.map(e => e.type));
  ['trace-create', 'generation-create', 'generation-update', 'span-create', 'span-update'].forEach(k =>
    assert.ok(types.has(k), `event type ${k} present`));

  // Usage normalization: prompt/completion → input/output/total.
  const genUpd = events.find(e => e.type === 'generation-update');
  assert.strictEqual(genUpd.body.usage.input, 100);
  assert.strictEqual(genUpd.body.usage.output, 20);
  assert.strictEqual(genUpd.body.usage.total, 120);
  assert.strictEqual(genUpd.body.usage.unit, 'TOKENS');
  assert.strictEqual(genUpd.body.metadata.confidence, 0.9);

  // ---- 2. PII redaction ----
  captured.length = 0;
  const t2 = lf.trace({ name: 'pii', input: { ssn: '123-45-6789', card: '4111111111111111', text: 'SSN 999888777 for John' } });
  t2.end();
  await lf.flushNow();
  const evs = captured.flatMap(c => c.body.batch);
  const inp = evs.find(e => e.type === 'trace-create').body.input;
  assert.strictEqual(inp.ssn, '[redacted]', 'ssn key redacted');
  assert.strictEqual(inp.card, '****************', 'card digits masked (16-char)');
  assert.ok(/SSN \*+/.test(inp.text), 'inline SSN masked in strings');

  // Also test the pure redactor for a nested structure.
  const r = lf._redact({ password: 'p', nested: { api_key: 'x', ok: 'y', big: '9'.repeat(200000) } });
  assert.strictEqual(r.password, '[redacted]');
  assert.strictEqual(r.nested.api_key, '[redacted]');
  assert.strictEqual(r.nested.ok, 'y');
  assert.ok(r.nested.big.length <= 200010, 'huge string truncated');

  // ---- 3. wrap() records generation from an async producer ----
  captured.length = 0;
  const t3 = lf.trace({ name: 'wrap-test' });
  const out = await lf.wrap(t3, { name: 'call', model: 'x', input: { a: 1 } }, async () => ({ data: { z: 42 }, usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  assert.deepStrictEqual(out.data, { z: 42 });
  await lf.flushNow();
  const gu = captured.flatMap(c => c.body.batch).find(e => e.type === 'generation-update');
  assert.deepStrictEqual(gu.body.output, { z: 42 });

  // wrap() records ERROR level on throw and rethrows.
  captured.length = 0;
  const t4 = lf.trace({ name: 'wrap-err' });
  await assert.rejects(lf.wrap(t4, { name: 'fail', model: 'x', input: {} }, async () => { throw new Error('boom'); }), /boom/);
  await lf.flushNow();
  const errEv = captured.flatMap(c => c.body.batch).find(e => e.type === 'generation-update');
  assert.strictEqual(errEv.body.level, 'ERROR');
  assert.match(errEv.body.statusMessage, /boom/);

  // ---- 4. Disabled config → no-op trace, no fetch calls ----
  captured.length = 0;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  for (const k of Object.keys(require.cache)) if (/\/(lib\/ai\/langfuse|src\/config)\.js$/.test(k)) delete require.cache[k];
  const lf2 = require('../src/lib/ai/langfuse');
  assert.strictEqual(lf2.enabled(), false);
  const tn = lf2.trace({ name: 'off' });
  tn.generation({ name: 'g' }).end({ output: 'x' });
  tn.end();
  await lf2.flushNow();
  assert.strictEqual(captured.length, 0, 'no HTTP made when disabled');

  global.fetch = origFetch;
  console.log('test-langfuse-pure: trace + generation + span + PII redaction + wrap + off-mode all pass');
})().catch(e => { console.error(e); process.exit(1); });
