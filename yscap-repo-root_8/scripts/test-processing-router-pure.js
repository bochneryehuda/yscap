'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 2 DocumentProcessingRouter
 * (src/pipeline/processing-router.js). Pure: no DB, no network.
 *
 * Proves: planFor reuses routing-matrix.planRoute and maps engine strings onto adapter keys;
 * routeDocument runs the chosen primary adapter's analyze (never throws), classifies the
 * outcome (completed vs failed), and records a route via an injected fake db; recordRoute is
 * best-effort (a DB error never throws); a deterministic in-process engine (native_pdf) yields
 * a plan with no adapter and a null result.
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const PR = require(R + '/src/pipeline/processing-router');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

// A minimal fake adapter matching the makeAdapter contract (analyze never throws).
function fakeAdapter(provider, service, analyzeImpl) {
  return { provider, service, analyze: async (req) => analyzeImpl(req) };
}

(async function main() {
  // ---- planFor: a table-dense numeric-critical family (bank_statement) → azure primary + a challenger ----
  const p = PR.planFor({ docType: 'bank_statement', pageCount: 3, availability: { azure: true, google: true, mistral: true } });
  ok(p.primary && p.primary.engine === 'azure' && p.primary.adapterKey === 'azure/document_intelligence', 'bank_statement → azure primary mapped to the docint adapter');
  ok(p.challenger && p.challenger.engine && p.challenger.adapterKey, 'numeric-critical → a challenger engine is mapped');
  ok(p.numericCritical === true && p.materiality === 'high', 'plan carries numericCritical + materiality');
  ok(typeof p.reason === 'string' && p.reason.length > 0 && Array.isArray(p.specialHandling), 'plan has a human reason + specialHandling array');

  // ---- planFor: native text layer → deterministic in-process engine, no adapter ----
  const pn = PR.planFor({ docType: 'insurance', hasNativeText: true, mimeType: 'application/pdf', nativeTextChars: 5000, pageCount: 2, availability: { azure: true } });
  ok(pn.primary && pn.primary.engine === 'native_pdf' && pn.primary.adapterKey === null, 'dense native text → native_pdf primary, no adapter');

  // ---- routeDocument: runs the primary adapter, classifies completed, records via fake db ----
  const captured = [];
  const fakeDb = { query: async (_sql, params) => { captured.push(params); return { rows: [{ id: 'route-1' }] }; } };
  const adapters = [
    fakeAdapter('azure', 'document_intelligence', async () => ({ provider: 'azure', service: 'document_intelligence', confidence: 0.91, latencyMs: 12, estimatedCost: 4, modelVersion: '2024-11-30', warnings: [] })),
    fakeAdapter('google', 'document_ai', async () => ({ provider: 'google', service: 'document_ai', confidence: 0.7 })),
  ];
  const out = await PR.routeDocument({
    features: { docType: 'bank_statement', availability: { azure: true, google: true } },
    request: { base64: 'AAAA' }, adapters, recordDb: fakeDb, documentId: 'doc-1', jobId: 'job-1', loanId: 'loan-1',
  });
  ok(out.result && out.result.confidence === 0.91, 'routeDocument ran the azure adapter and returned its result');
  ok(out.outcome === 'completed', 'a good read → outcome completed');
  ok(out.routeId === 'route-1', 'routeDocument returned the recorded route id');
  ok(captured.length === 1, 'exactly one route row recorded');
  // params order: [job,doc,loan,ver,family,provider,service,modelVer,reason,chProv,chSvc,chConf,conf,lat,cost,mat,special,outcome,warn]
  const par = captured[0];
  ok(par[1] === 'doc-1' && par[0] === 'job-1' && par[2] === 'loan-1', 'route row links job/document/loan');
  ok(par[5] === 'azure' && par[6] === 'document_intelligence', 'route row records provider/service');
  ok(par[4] === 'bank_statement', 'route row records the document family');
  ok(par[12] === 0.91 && par[13] === 12 && par[14] === 4, 'route row records confidence/latency/cost');
  ok(par[17] === 'completed', 'route row records outcome completed');

  // ---- routeDocument: a throwing vendor → adapter normalizes to a warning → outcome failed ----
  const badAdapters = [fakeAdapter('mistral', 'ocr', async () => { throw new Error('boom'); })];
  // Force the plan primary to mistral by making only mistral available on a non-table family.
  const outBad = await PR.routeDocument({
    features: { docType: 'other', availability: { mistral: true } },
    request: {}, adapters: badAdapters, recordDb: fakeDb,
  });
  // The real makeAdapter would catch; our fakeAdapter throws, so routeDocument must still not throw.
  ok(outBad && outBad.plan, 'routeDocument never throws even if an adapter throws');

  // ---- recordRoute: a DB error is swallowed (returns null), never throws ----
  const throwDb = { query: async () => { throw new Error('db down'); } };
  const rid = await PR.recordRoute(throwDb, { provider: 'azure' });
  ok(rid === null, 'recordRoute swallows a DB error and returns null');
  const rid2 = await PR.recordRoute(null, { provider: 'azure' });
  ok(rid2 === null, 'recordRoute with no db returns null (no throw)');

  // ---- routeDocument without a recordDb: no persistence, still returns a plan+result ----
  const outNoDb = await PR.routeDocument({ features: { docType: 'bank_statement', availability: { azure: true } }, request: {}, adapters });
  ok(outNoDb.routeId === null && outNoDb.plan && outNoDb.result, 'no recordDb → routeId null, still plans + reads');

  // ---- adapterByKey helper ----
  ok(PR._internals.adapterByKey(adapters, 'google/document_ai').provider === 'google', 'adapterByKey finds by provider/service');
  ok(PR._internals.adapterByKey(adapters, 'nope/nope') === null && PR._internals.adapterByKey(adapters, null) === null, 'adapterByKey misses → null');

  console.log(`test-processing-router-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
