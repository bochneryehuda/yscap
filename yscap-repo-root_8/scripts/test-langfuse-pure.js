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
// The project lookup (a GET, no body) is answered separately from the ingestion POSTs.
// `projectsReply` is what /api/public/projects returns; tests swap it to exercise each outcome.
let projectsReply = { ok: false, status: 401, json: async () => ({}) };
let projectsCalls = 0;
global.fetch = async (url, opts) => {
  if (String(url).includes('/api/public/projects')) { projectsCalls++; return projectsReply; }
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

  // ---- 5. THE TRACE LINK MUST NEVER BE A DEAD LINK (owner-reported 2026-07-26) ----
  // "The 'AI reasoning trace →' link 404s. A dead link on every finding erodes trust in all of
  // them." The link was built from LANGFUSE_PROJECT — a human LABEL — while Langfuse addresses a
  // trace by an opaque project IDENTIFIER, so every link ever written pointed at nothing.
  const fresh = () => {
    for (const k of Object.keys(require.cache)) if (/\/(lib\/ai\/langfuse|src\/config)\.js$/.test(k)) delete require.cache[k];
    return require('../src/lib/ai/langfuse');
  };
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';
  process.env.LANGFUSE_SECRET_KEY = 'sk-lf-test';
  process.env.LANGFUSE_PROJECT = 'pilot-underwriting';   // the label that produced the 404s
  delete process.env.LANGFUSE_PROJECT_ID;

  // (a) No identifier known → still a WORKING link, via Langfuse's own /trace/<id> redirect. This is
  // what removes the dead one: the link that renders is the one that resolves, always.
  projectsReply = { ok: false, status: 401, json: async () => ({}) };
  let lfA = fresh();
  const ta = lfA.trace({ name: 'no-project-id' });
  assert.strictEqual(ta.url(), 'https://us.cloud.langfuse.com/trace/' + ta.id,
    'with no project identifier the link goes through Langfuse\'s own trace redirect');
  assert.strictEqual(lfA.projectId(), null, 'and no identifier is invented');
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(String(ta.url()).startsWith('https://us.cloud.langfuse.com/trace/'),
    'a failed lookup leaves the redirect form in place rather than a broken link');

  // (b) The human label is NEVER used as the identifier — that was the entire bug.
  assert.ok(!String(ta.url() || '').includes('pilot-underwriting'), 'the project LABEL never appears in a trace URL');
  // A findings row written in the first moments after a deploy must not be stuck link-less forever.
  assert.ok(lfA.traceUrl('abc-123'), 'a link is available for any trace id, with no lookup at all');
  assert.strictEqual(lfA.traceUrl(null), null, 'and there is no link without a trace');

  // (c) Looked up from Langfuse's own API → a real, resolvable link.
  projectsReply = { ok: true, status: 200, json: async () => ({ data: [{ id: 'cm4realprojectid00000001', name: 'PILOT' }] }) };
  const lfB = fresh();
  const tb = lfB.trace({ name: 'lookup' });
  await new Promise((r) => setTimeout(r, 20));
  assert.strictEqual(lfB.projectId(), 'cm4realprojectid00000001', 'the identifier is read from Langfuse itself');
  assert.strictEqual(tb.url(), 'https://us.cloud.langfuse.com/project/cm4realprojectid00000001/traces/' + tb.id,
    'and the link points at the real project + this trace');
  // A trace created BEFORE the lookup finished still links once it has — url() reads at call time.
  const tb2 = lfB.trace({ name: 'after' });
  assert.ok(String(tb2.url()).includes('cm4realprojectid00000001'), 'later traces link too');
  // The lookup is not repeated on every trace.
  const before = projectsCalls;
  lfB.trace({ name: 'again' }); lfB.trace({ name: 'again2' });
  assert.strictEqual(projectsCalls, before, 'the identifier is looked up once, not per trace');

  // (d) An explicitly configured identifier short-circuits the lookup entirely.
  process.env.LANGFUSE_PROJECT_ID = 'cmadminsetthisone0000001';
  projectsReply = { ok: false, status: 500, json: async () => ({}) };
  const lfC = fresh();
  const callsC = projectsCalls;
  const tc = lfC.trace({ name: 'explicit' });
  assert.strictEqual(lfC.projectId(), 'cmadminsetthisone0000001', 'an admin-set identifier is used as-is');
  assert.ok(String(tc.url()).includes('cmadminsetthisone0000001'), 'and the link uses it');
  assert.strictEqual(projectsCalls, callsC, 'with it set, Langfuse is never asked');
  delete process.env.LANGFUSE_PROJECT_ID;

  // (e) A malformed API answer is treated as "unknown", never as an identifier.
  for (const bad of [{ data: [] }, { data: [{ name: 'no id' }] }, { data: [{ id: '   ' }] }, {}]) {
    projectsReply = { ok: true, status: 200, json: async () => bad };
    const lfD = fresh();
    lfD.trace({ name: 'bad-shape' });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(lfD.projectId(), null, `a malformed projects answer (${JSON.stringify(bad)}) yields no identifier`);
  }

  // (f) Tracing itself keeps working throughout — an unavailable link never costs us the record.
  projectsReply = { ok: false, status: 503, json: async () => ({}) };
  captured.length = 0;
  const lfE = fresh();
  const te = lfE.trace({ name: 'still-records' });
  te.end({ output: { ok: true } });
  await lfE.flushNow();
  assert.ok(captured.flatMap((c) => c.body.batch).some((e) => e.type === 'trace-create'),
    'the AI call is still recorded when the project lookup is unavailable');
  assert.ok(String(te.url()).includes('/trace/'), 'and it still offers a link that resolves');

  // (g) Tracing OFF → no link at all. There is no trace to point at, so there is nothing to link.
  delete process.env.LANGFUSE_PUBLIC_KEY;
  const lfOff = fresh();
  assert.strictEqual(lfOff.enabled(), false);
  assert.strictEqual(lfOff.trace({ name: 'off' }).url(), null, 'tracing off → no link');
  assert.strictEqual(lfOff.traceUrl('abc'), null, 'and no link for a bare id either');
  process.env.LANGFUSE_PUBLIC_KEY = 'pk-lf-test';

  global.fetch = origFetch;
  console.log('test-langfuse-pure: trace + generation + span + PII redaction + wrap + off-mode + never-a-dead-trace-link all pass');
})().catch(e => { console.error(e); process.exit(1); });
