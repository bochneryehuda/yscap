'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 2 REAL DocumentProvider adapters (Phase 1e).
 *
 * Wraps each existing ai/* vendor client behind the ONE normalized adapter contract
 * (src/pipeline/provider-adapter.js `makeAdapter`), so the DocumentProcessingRouter (Phase 1f)
 * and the admin health page reach every vendor through the same shape — never a client SDK/route
 * directly. Each adapter:
 *   - healthCheck(): delegates to the client's own ping() (a cheap, timeboxed, never-throwing
 *     reachability probe) and maps its {ok, reason?} to the adapter {ok, detail} contract, so the
 *     owner can PROVE each vendor key works the moment it's entered in Render.
 *   - analyze(request): forwards a normalized {buffer, base64, mimeType} request to the client's
 *     real read/classify call and maps the vendor output into a partial ProviderResult (a not-ok
 *     vendor result becomes a normalized result carrying the reason as a warning + confidence null,
 *     never a throw — the router decides, nothing crashes).
 *
 * ADDITIVE + INERT: nothing calls these until the health route (this PR) / the router (Phase 1f)
 * is wired; every loan still runs on Pipeline V1. This module touches no frozen number and no
 * existing flow. Clients are lazy-required so it loads even if one is mid-refactor.
 *
 * Note: this complements src/lib/ai/stack-health.js (which reports CONFIG presence, sync, no
 * network) by adding a LIVE reachability check — the difference between "a key is entered" and
 * "the key actually works".
 */
const cfg = require('../config');
const { makeAdapter, checkAll } = require('./provider-adapter');

function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return (v == null) ? '' : String(v); }

/**
 * The document/OCR/classifier vendors reached through the Layer-2 contract. Each entry is
 * self-describing (friendly name + role for the health page) and says how to reach its client's
 * real analyze call, its ping, its config predicate, and its model name — all as lazy accessors so
 * a client that is mid-refactor never breaks module load.
 */
const REGISTRY = Object.freeze([
  {
    provider: 'azure', service: 'document_intelligence',
    name: 'Azure Document Intelligence', role: 'Primary OCR (page → text)',
    clientName: 'docint',
    analyze: (c, req) => c.read(req),
    configured: (c) => c.configured(),
    model: () => (cfg.docint && cfg.docint.model) || 'prebuilt-read',
    modelVersion: () => (cfg.docint && cfg.docint.apiVersion) || '2024-11-30',
  },
  {
    provider: 'google', service: 'document_ai',
    name: 'Google Document AI', role: 'Second OCR engine (auto-fallback)',
    clientName: 'docai-google',
    analyze: (c, req) => c.read(req),
    configured: (c) => c.configured(),
    model: () => 'Enterprise Document OCR',
    modelVersion: () => null,
  },
  {
    provider: 'mistral', service: 'ocr',
    name: 'Mistral OCR', role: 'Third OCR engine (auto-fallback)',
    clientName: 'docai-mistral',
    analyze: (c, req) => c.read(req),
    configured: (c) => c.configured(),
    model: () => (cfg.mistralOcr && cfg.mistralOcr.model) || 'mistral-ocr-latest',
    modelVersion: () => null,
  },
  {
    provider: 'azure', service: 'custom_classifier',
    name: 'Custom document classifier', role: 'Trained package splitter (doc-type classifier)',
    clientName: 'azure-custom',
    analyze: (c, req) => c.classify(req),
    configured: (c) => c.classifierConfigured(),
    model: () => (cfg.azureCustom && cfg.azureCustom.classifierId) || null,
    modelVersion: () => (cfg.docint && cfg.docint.apiVersion) || '2024-11-30',
  },
  {
    provider: 'azure', service: 'openai',
    name: 'Azure OpenAI (reasoning)', role: 'Field extraction + reasoning (Layer 5)',
    clientName: 'azure-openai',
    // Not a document OCR call — reasoning has no page-analyze surface here. analyze is a
    // no-op that returns an empty normalized result; its VALUE in this module is the live
    // healthCheck (prove the endpoint/key/deployment work together).
    analyze: () => ({ ok: true }),
    configured: (c) => c.available(),
    model: () => (cfg.azureOpenai && cfg.azureOpenai.deployment) || null,
    modelVersion: () => (cfg.azureOpenai && cfg.azureOpenai.apiVersion) || null,
  },
]);

function loadClient(name) {
  // Lazy + guarded: a broken/missing client yields null, and its adapter reports unavailable
  // instead of throwing at module load.
  try { return require('../lib/ai/' + name); } catch (_e) { return null; }
}

/** Map an ai/* client `ping()`-style result ({ok, reason?}) → the adapter health {ok, detail}. */
function pingToHealth(r) {
  const ok = !!(r && r.ok === true);
  return { ok, detail: ok ? 'reachable' : ((r && r.reason) || 'unavailable') };
}

/**
 * Map a vendor read/classify/extract result into a partial ProviderResult (never throws here).
 * FAITHFUL PASSTHROUGH: every structural field the vendor produced survives — the OCR text +
 * per-page structure (lines/words + polygons = bounding regions), the splitter's segments
 * (per-range docType boundaries), and an extractor's fields/tables. The earlier version carried
 * only `pages`, silently dropping text/pageCount/segments/fields/tables — so a classifier's
 * document-type result and an extractor's fields never reached the router (the "dropped
 * classifier results" gap). Downstream normalizeResult defaults any missing key safely.
 */
function mapVendorResult(entry, raw) {
  const r = raw || {};
  const base = { modelId: entry.model() || '', modelVersion: entry.modelVersion() || '' };
  if (r.ok === false) {
    return { ...base, confidence: null, warnings: [str(r.reason) || 'vendor returned not-ok'] };
  }
  const segments = arr(r.segments);
  // The package splitter reports per-range docType + confidence but no document-level type/score.
  // When the vendor gave none, derive a document-level type + confidence from the HIGHEST-confidence
  // segment, so a classifier read carries a usable documentType/confidence downstream.
  let documentType = str(r.documentType);
  let confidence = num(r.confidence);
  if (!documentType && segments.length) {
    const top = segments.reduce((a, b) => ((num(b && b.confidence) || 0) > (num(a && a.confidence) || 0) ? b : a), segments[0]);
    documentType = str(top && top.docType);
    if (confidence == null) confidence = num(top && top.confidence);
  }
  return {
    ...base,
    documentType,
    text: str(r.text),
    pageCount: num(r.pageCount),
    pages: arr(r.pages),
    segments,
    fields: arr(r.fields),
    tables: arr(r.tables),
    evidenceRegions: arr(r.evidenceRegions),
    // OCR gives no single document-level confidence — leave null unless the vendor/segment did.
    confidence,
    warnings: [],
  };
}

/** Build ONE real adapter for a registry entry. */
function adapterFor(entry) {
  const a = makeAdapter({
    provider: entry.provider,
    service: entry.service,
    analyze: async (request) => {
      const c = loadClient(entry.clientName);
      if (!c) return { confidence: null, warnings: [`${entry.name} client unavailable`] };
      const raw = await entry.analyze(c, request || {});
      return mapVendorResult(entry, raw);
    },
    healthCheck: async () => {
      const c = loadClient(entry.clientName);
      if (!c || typeof c.ping !== 'function') return { ok: false, detail: 'not configured' };
      return pingToHealth(await c.ping());
    },
  });
  // Carry the friendly metadata alongside the adapter (used by the health report).
  a.name = entry.name;
  a.role = entry.role;
  a.configured = () => { const c = loadClient(entry.clientName); try { return !!(c && entry.configured(c)); } catch (_e) { return false; } };
  a.model = () => { try { const m = entry.model(); return m == null ? null : String(m); } catch (_e) { return null; } };
  return a;
}

/** All real Layer-2 document-provider adapters. */
function buildDocumentAdapters() { return REGISTRY.map(adapterFor); }

/**
 * Run a LIVE health check across every real adapter and merge in the friendly metadata.
 * Never throws. Each provider row: { provider, service, name, role, configured, model, ok, latencyMs, detail }.
 */
async function healthReport(clock) {
  const adapters = buildDocumentAdapters();
  const rep = await checkAll(adapters);
  const byKey = {};
  adapters.forEach((a) => { byKey[a.provider + '/' + a.service] = a; });
  const providers = arr(rep.providers).map((p) => {
    const a = byKey[(p.provider || '') + '/' + (p.service || '')] || {};
    return {
      provider: p.provider, service: p.service,
      name: a.name || null, role: a.role || null,
      configured: typeof a.configured === 'function' ? a.configured() : null,
      model: typeof a.model === 'function' ? a.model() : null,
      ok: p.ok === true, latencyMs: p.latencyMs, detail: p.detail,
    };
  });
  return {
    checkedAt: (typeof clock === 'function' ? clock() : null),
    providers,
    healthy: providers.filter((p) => p.ok).length,
    total: providers.length,
    configured: providers.filter((p) => p.configured).length,
  };
}

module.exports = { REGISTRY, buildDocumentAdapters, healthReport, _internals: { pingToHealth, mapVendorResult, adapterFor } };
