'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 2 REAL DocumentProvider adapters
 * (src/pipeline/provider-adapters.js). Pure: no env keys, no network.
 *
 * Because every ai/* client's ping()/read() short-circuits on !configured() WITHOUT touching the
 * network, the whole health report runs offline: every vendor reports ok:false / configured:false.
 * Proves: the registry builds one adapter per vendor with friendly metadata; healthReport merges
 * that metadata + never throws; the ping→health and vendor-result→ProviderResult mappers are
 * correct; and a real adapter's analyze NEVER throws (a not-ok vendor becomes a warning).
 */
const assert = require('assert');
const R = require('path').resolve(__dirname, '..');
const PA = require(R + '/src/pipeline/provider-adapters');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async function main() {
  // ---- registry + adapter shape ----
  const adapters = PA.buildDocumentAdapters();
  ok(adapters.length === PA.REGISTRY.length && adapters.length >= 5, 'one adapter per registry entry (>=5)');
  const keys = adapters.map((a) => a.provider + '/' + a.service);
  ['azure/document_intelligence', 'google/document_ai', 'mistral/ocr', 'azure/custom_classifier', 'azure/openai']
    .forEach((k) => ok(keys.includes(k), `registry includes ${k}`));
  const a0 = adapters[0];
  ok(typeof a0.analyze === 'function' && typeof a0.healthCheck === 'function', 'adapter has analyze + healthCheck');
  ok(typeof a0.name === 'string' && typeof a0.role === 'string' && typeof a0.configured === 'function' && typeof a0.model === 'function', 'adapter carries friendly metadata (name/role/configured/model)');

  // ---- pingToHealth mapping ----
  const { pingToHealth, mapVendorResult } = PA._internals;
  ok(pingToHealth({ ok: true }).ok === true && pingToHealth({ ok: true }).detail === 'reachable', 'pingToHealth ok:true → reachable');
  ok(pingToHealth({ ok: false, reason: 'bad key' }).ok === false && pingToHealth({ ok: false, reason: 'bad key' }).detail === 'bad key', 'pingToHealth carries the reason');
  ok(pingToHealth(undefined).ok === false && pingToHealth(undefined).detail === 'unavailable', 'pingToHealth undefined → unavailable');
  ok(pingToHealth({ ok: 'truthy-but-not-true' }).ok === false, 'pingToHealth requires strict true');

  // ---- mapVendorResult mapping ----
  const entry = { model: () => 'm', modelVersion: () => 'v' };
  const okMap = mapVendorResult(entry, { ok: true, pages: [{ n: 1 }], confidence: 0.7 });
  ok(okMap.pages.length === 1 && okMap.confidence === 0.7 && okMap.modelId === 'm' && okMap.modelVersion === 'v', 'mapVendorResult ok: pages/confidence/model passthrough');
  ok(Array.isArray(okMap.warnings) && okMap.warnings.length === 0, 'mapVendorResult ok: no warnings');
  const badMap = mapVendorResult(entry, { ok: false, reason: '429 rate limited' });
  ok(badMap.confidence === null && /429 rate limited/.test(badMap.warnings[0] || ''), 'mapVendorResult not-ok: confidence null + reason in warnings');
  ok(mapVendorResult(entry, { ok: true, confidence: 'x' }).confidence === null, 'mapVendorResult: non-finite confidence → null');

  // ---- VSLICE-1: a real OCR read carries text/pageCount/pages through mapVendorResult ----
  const ocrMap = mapVendorResult(entry, { ok: true, text: 'hello world', pageCount: 2, pages: [{ pageNumber: 1 }, { pageNumber: 2 }] });
  ok(ocrMap.text === 'hello world' && ocrMap.pageCount === 2 && ocrMap.pages.length === 2, 'mapVendorResult OCR: text + pageCount + pages preserved (not dropped)');

  // ---- VSLICE-1: a classifier read carries segments + derives documentType/confidence ----
  const clsMap = mapVendorResult(entry, { ok: true, segments: [
    { docType: 'insurance', confidence: 0.62, pages: [1] },
    { docType: 'bank_statement', confidence: 0.94, pages: [2, 3] },
  ] });
  ok(clsMap.segments.length === 2, 'mapVendorResult classifier: segments preserved (not dropped)');
  ok(clsMap.documentType === 'bank_statement' && clsMap.confidence === 0.94, 'mapVendorResult classifier: documentType/confidence derived from the highest-confidence segment');

  // ---- VSLICE-1: an extractor read carries fields/tables through ----
  const extMap = mapVendorResult(entry, { ok: true, documentType: 'insurance', fields: [{ key: 'coverage', value: 500000 }], tables: [{ rows: 2 }], evidenceRegions: [{ page: 1 }] });
  ok(extMap.documentType === 'insurance' && extMap.fields.length === 1 && extMap.tables.length === 1 && extMap.evidenceRegions.length === 1, 'mapVendorResult extractor: documentType + fields + tables + evidenceRegions preserved');
  // a vendor-provided documentType wins over segment derivation
  ok(mapVendorResult(entry, { ok: true, documentType: 'appraisal', segments: [{ docType: 'x', confidence: 0.9 }] }).documentType === 'appraisal', 'mapVendorResult: explicit documentType is not overridden by segments');

  // ---- healthReport runs offline, merges metadata, never throws ----
  const rep = await PA.healthReport(() => 'STAMP');
  ok(rep.checkedAt === 'STAMP', 'healthReport stamps checkedAt from the injected clock');
  ok(rep.total === adapters.length && rep.healthy === 0 && rep.configured === 0, 'healthReport offline: total set, nothing healthy/configured');
  ok(Array.isArray(rep.providers) && rep.providers.length === adapters.length, 'healthReport: one row per adapter');
  const row = rep.providers[0];
  ['provider', 'service', 'name', 'role', 'configured', 'model', 'ok', 'latencyMs', 'detail'].forEach((k) => ok(k in row, `health row has ${k}`));
  ok(row.ok === false && row.configured === false && typeof row.detail === 'string', 'offline row: ok:false, configured:false, string detail');
  ok(typeof row.latencyMs === 'number' && row.latencyMs >= 0, 'health row measures a non-negative latency');

  // ---- default clock (no arg) → checkedAt null, still shaped ----
  const rep2 = await PA.healthReport();
  ok(rep2.checkedAt === null && rep2.total === adapters.length, 'healthReport with no clock: checkedAt null, still complete');

  // ---- a real adapter's analyze NEVER throws offline (not-ok vendor → warning, provider stamped) ----
  const di = adapters.find((a) => a.service === 'document_intelligence');
  const ar = await di.analyze({ base64: 'AAAA' });
  ok(ar.provider === 'azure' && ar.service === 'document_intelligence', 'analyze stamps provider/service');
  ok(ar.confidence === null && Array.isArray(ar.warnings) && ar.warnings.length >= 1, 'offline analyze: confidence null + a warning (not a throw)');
  ok(typeof ar.latencyMs === 'number', 'analyze measures latency');

  console.log(`test-provider-adapters-real-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
