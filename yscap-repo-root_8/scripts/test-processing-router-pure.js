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

  // ---- VSLICE-2: reconcileReads (pure) ----
  const { reconcileReads } = PR._internals;
  ok(reconcileReads(null, null).ran === false, 'reconcileReads: no challenger → ran false');
  const agree = reconcileReads({ documentType: 'Bank Statement', confidence: 0.9 }, { documentType: 'bank_statement', confidence: 0.8 });
  ok(agree.ran && agree.agreement === 'agree' && agree.chosen === 'primary' && agree.challengerConfidence === 0.8, 'reconcileReads: same type (norm) → agree, primary kept (higher conf)');
  const disagree = reconcileReads({ documentType: 'insurance', confidence: 0.6 }, { documentType: 'bank_statement', confidence: 0.95 });
  ok(disagree.agreement === 'disagree' && disagree.chosen === 'challenger', 'reconcileReads: different type → disagree; challenger chosen (strictly higher conf)');
  const tie = reconcileReads({ documentType: 'x', confidence: 0.8 }, { documentType: 'x', confidence: 0.8 });
  ok(tie.chosen === 'primary', 'reconcileReads: equal confidence → primary kept (challenger only wins strictly higher)');
  const unknown = reconcileReads({ confidence: 0.8 }, { confidence: 0.9 });
  ok(unknown.agreement === 'unknown' && unknown.chosen === 'challenger', 'reconcileReads: no type on either → unknown agreement, still picks higher-confidence read');

  // ---- VSLICE-2: routeDocument actually RUNS the challenger + records reconciliation ----
  let challengerRan = false;
  const recon = [];
  const reconDb = { query: async (_sql, params) => { recon.push(params); return { rows: [{ id: 'r2' }] }; } };
  const reconAdapters = [
    fakeAdapter('azure', 'document_intelligence', async () => ({ documentType: 'insurance', confidence: 0.7, latencyMs: 10, estimatedCost: 4 })),
    fakeAdapter('google', 'document_ai', async () => { challengerRan = true; return { documentType: 'bank_statement', confidence: 0.95, latencyMs: 8, estimatedCost: 3 }; }),
  ];
  const outR = await PR.routeDocument({
    features: { docType: 'bank_statement', availability: { azure: true, google: true } },
    request: { base64: 'AAAA' }, adapters: reconAdapters, recordDb: reconDb, documentId: 'd', jobId: 'j', loanId: 'l',
  });
  ok(challengerRan === true, 'routeDocument RAN the challenger adapter (was: recorded but never executed)');
  ok(outR.challengerResult && outR.challengerResult.confidence === 0.95, 'routeDocument returns the challenger read result');
  ok(outR.reconciliation && outR.reconciliation.ran && outR.reconciliation.agreement === 'disagree', 'routeDocument reconciles the two reads (disagreement surfaced)');
  const pr2 = recon[0];
  ok(pr2[11] === 0.95, 'route row records challenger_confidence from the challenger read');
  ok(pr2[13] === 18 && pr2[14] === 7, 'route row cost/latency account for BOTH reads (10+8 latency, 4+3 cost)');
  // special_handling (index 16) carries the reconciliation + trust tags
  const special = JSON.parse(pr2[16] || '[]');
  ok(special.includes('reconciliation:disagree') && special.includes('trust:challenger'), 'route row special_handling tags reconciliation + trust');
  // warnings (index 18) surface the disagreement
  const warns = JSON.parse(pr2[18] || '[]');
  ok(warns.some((w) => /engine disagreement/i.test(w)), 'route row warnings surface the engine disagreement');

  // ---- VSLICE-2: a FAILED primary read does NOT run the challenger (nothing to cross-check) ----
  let chRan2 = false;
  const failPrimary = [
    fakeAdapter('azure', 'document_intelligence', async () => ({ confidence: null, warnings: ['429'] })),
    fakeAdapter('google', 'document_ai', async () => { chRan2 = true; return { confidence: 0.9 }; }),
  ];
  const outF = await PR.routeDocument({ features: { docType: 'bank_statement', availability: { azure: true, google: true } }, request: {}, adapters: failPrimary });
  ok(outF.outcome === 'failed' && chRan2 === false, 'a failed primary read skips the challenger (no cross-check on a failed read)');

  console.log(`test-processing-router-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
