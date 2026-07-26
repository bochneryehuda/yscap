'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 2 DocumentProvider adapter contract
 * (src/pipeline/provider-adapter.js). Pure, no DB, no network.
 *
 * Proves: normalizeResult always yields the canonical shape with safe defaults;
 * makeAdapter.analyze stamps provider/service + a measured latencyMs and NEVER throws
 * (a vendor error becomes a normalized result carrying the warning); healthCheck reports
 * ok/throw/missing correctly; checkAll aggregates without throwing.
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const PA = require(R + '/src/pipeline/provider-adapter');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  // ---- normalizeResult ----
  const empty = PA.normalizeResult();
  assert.deepStrictEqual(Object.keys(empty).sort(), PA.CANONICAL_KEYS.slice().sort());
  ok(Array.isArray(empty.pages) && Array.isArray(empty.fields) && Array.isArray(empty.tables) && Array.isArray(empty.evidenceRegions) && Array.isArray(empty.warnings), 'empty result: array fields default to []');
  ok(empty.confidence === null && empty.latencyMs === 0 && empty.estimatedCost === 0, 'empty result: confidence null, latency/cost 0');
  ok(empty.provider === '' && empty.modelId === '' && empty.documentType === '', 'empty result: string fields default to ""');

  const partial = PA.normalizeResult({ provider: 'azure', service: 'document_intelligence', confidence: 0.9, pages: [{ n: 1 }], extra: 'dropped', latencyMs: 42 });
  ok(partial.provider === 'azure' && partial.service === 'document_intelligence' && partial.confidence === 0.9, 'partial: passthrough of known fields');
  ok(partial.pages.length === 1 && partial.latencyMs === 42, 'partial: pages + latency preserved');
  ok(!('extra' in partial), 'partial: unknown keys are dropped (canonical shape only)');
  ok(PA.normalizeResult({ confidence: 'x', latencyMs: NaN }).confidence === null && PA.normalizeResult({ latencyMs: NaN }).latencyMs === 0, 'non-finite numbers coerce to null/0');

  // ---- makeAdapter.analyze: happy path stamps provider/service + measured latency ----
  let clk = 0; const clock = () => clk;
  const good = PA.makeAdapter({
    provider: 'google', service: 'doc_ai_ocr', clock,
    analyze: async (req) => { clk += 7; return { documentType: req.type, confidence: 0.8, pages: [{}], modelVersion: 'v1' }; },
  });
  const gr = await good.analyze({ type: 'bank_statement' });
  ok(gr.provider === 'google' && gr.service === 'doc_ai_ocr', 'adapter stamps provider/service');
  ok(gr.documentType === 'bank_statement' && gr.confidence === 0.8 && gr.modelVersion === 'v1', 'adapter passes vendor fields through normalizeResult');
  ok(gr.latencyMs === 7, 'adapter measures latencyMs from the injected clock');

  // ---- makeAdapter.analyze: a throwing vendor call NEVER throws — becomes a warning ----
  clk = 0;
  const bad = PA.makeAdapter({ provider: 'mistral', service: 'ocr', clock, analyze: async () => { clk += 3; throw new Error('429 rate limited'); } });
  const br = await bad.analyze({});
  ok(br.provider === 'mistral' && br.confidence === null, 'failed analyze: normalized, confidence null');
  ok(Array.isArray(br.warnings) && /429 rate limited/.test(br.warnings[0] || ''), 'failed analyze: error captured in warnings');
  ok(br.latencyMs === 3, 'failed analyze: latency still measured');

  // ---- healthCheck: ok / not-ok / throw / missing ----
  const upA = PA.makeAdapter({ provider: 'azure', service: 'cu', analyze: async () => ({}), healthCheck: async () => ({ ok: true, detail: 'reachable' }) });
  const upH = await upA.healthCheck();
  ok(upH.ok === true && upH.provider === 'azure' && upH.detail === 'reachable', 'healthCheck ok:true reported');
  const downA = PA.makeAdapter({ provider: 'azure', service: 'openai', analyze: async () => ({}), healthCheck: async () => ({ ok: false, detail: 'no key' }) });
  ok((await downA.healthCheck()).ok === false, 'healthCheck ok:false reported');
  const throwA = PA.makeAdapter({ provider: 'x', service: 'y', analyze: async () => ({}), healthCheck: async () => { throw new Error('dns'); } });
  const th = await throwA.healthCheck();
  ok(th.ok === false && /dns/.test(th.detail), 'healthCheck that throws → ok:false with detail');
  const noneA = PA.makeAdapter({ provider: 'x', service: 'y', analyze: async () => ({}) });
  ok((await noneA.healthCheck()).ok === false, 'missing healthCheck → ok:false');

  // ---- checkAll aggregates, never throws ----
  const rep = await PA.checkAll([upA, downA, throwA]);
  ok(rep.total === 3 && rep.healthy === 1 && Array.isArray(rep.providers), 'checkAll: total/healthy counts + providers array');

  // makeAdapter requires an analyze function
  let threw = false; try { PA.makeAdapter({ provider: 'a' }); } catch (_) { threw = true; }
  ok(threw, 'makeAdapter without analyze throws (programmer error, surfaced early)');

  console.log(`test-provider-adapter-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
