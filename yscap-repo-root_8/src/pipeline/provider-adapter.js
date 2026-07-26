'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 2 DocumentProvider adapter contract.
 *
 * Every document/AI vendor (Azure Document Intelligence, Azure Content Understanding,
 * Google Document AI, Mistral OCR, Azure OpenAI, Anthropic, a data feed, …) is reached
 * ONLY through an adapter that implements one normalized contract, so the
 * DocumentProcessingRouter — and the underwriting code above it — never touches a vendor
 * SDK/endpoint directly:
 *
 *   DocumentProvider {
 *     analyze(request) -> Promise<ProviderResult>
 *     healthCheck()    -> Promise<ProviderHealth>
 *   }
 *
 * A ProviderResult normalizes EVERY vendor's raw output into one shape (owner's spec):
 *   { provider, service, modelId, modelVersion, documentType, pages, fields, tables,
 *     evidenceRegions, confidence, warnings, latencyMs, estimatedCost, rawArtifactId }
 *
 * This module is pure + additive: it defines the contract, a normalizer, and a factory
 * that wraps a raw vendor call into a timed, never-throwing adapter. It calls no vendor
 * itself. Real adapters (wrapping the existing ai/* clients) + the DocumentProcessingRouter
 * + the /api/admin/pipeline/health endpoint are wired in later Phase-1 PRs.
 */

function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function arr(v) { return Array.isArray(v) ? v : []; }
function str(v) { return (v == null) ? '' : String(v); }

/**
 * Coerce a partial/raw result into the canonical ProviderResult shape. Missing fields get
 * safe defaults (arrays → [], unknown numbers → null, strings → ''). Always returns a fresh
 * object with exactly the canonical keys, so downstream code can rely on the shape.
 */
function normalizeResult(input = {}) {
  const r = input || {};
  return {
    provider: str(r.provider),
    service: str(r.service),
    modelId: str(r.modelId),
    modelVersion: str(r.modelVersion),
    documentType: str(r.documentType),
    // The read's textual content + page count. `text` is the concatenated document text; `pages`
    // carries the per-page structure (lines/words + polygons = bounding regions) so evidence can
    // point at the exact spot. Preserving BOTH is what lets a fact carry page-level provenance —
    // the earlier normalizer dropped everything but `pages`, losing text/pageCount/segments/
    // fields/tables (the "dropped classifier results" gap). Kept back-compat: new keys default safe.
    text: str(r.text),
    pageCount: num(r.pageCount),
    pages: arr(r.pages),
    // `segments` = a package splitter/classifier's per-page-range document-type boundaries
    // ([{ docType, rawLabel, confidence, pages:[…] }]). `fields`/`tables` = a structured
    // extractor's output. `evidenceRegions` = bounding regions. All must survive normalization.
    segments: arr(r.segments),
    fields: arr(r.fields),
    tables: arr(r.tables),
    evidenceRegions: arr(r.evidenceRegions),
    confidence: num(r.confidence),
    warnings: arr(r.warnings),
    latencyMs: num(r.latencyMs) == null ? 0 : num(r.latencyMs),
    estimatedCost: num(r.estimatedCost) == null ? 0 : num(r.estimatedCost),
    rawArtifactId: str(r.rawArtifactId),
  };
}

const HEALTH_TIMEOUT_MS = 12000;

/** A monotonic-ish millisecond clock the caller can override in tests (avoids Date in workflows). */
function nowMs() { return Date.now(); }

/**
 * Wrap a raw vendor call into a DocumentProvider adapter.
 *
 *  makeAdapter({
 *    provider: 'azure',            // vendor family
 *    service: 'document_intelligence', // which service of that vendor
 *    analyze: async (request) => rawResult,      // your vendor call; returns a partial ProviderResult
 *    healthCheck: async () => ({ ok, detail }),  // cheap reachability/config probe
 *  })
 *
 * The returned adapter:
 *  - analyze(request): times the call, normalizes the result (stamping provider/service +
 *    latencyMs), and NEVER throws — a thrown vendor error becomes a normalized result whose
 *    `warnings` carries the message and `confidence` is null (so the router can decide, not crash).
 *  - healthCheck(): times + timeboxes the probe; returns { ok, provider, service, latencyMs, detail }
 *    and never throws.
 */
function makeAdapter({ provider, service, analyze, healthCheck, clock = nowMs } = {}) {
  if (typeof analyze !== 'function') throw new Error('makeAdapter requires an analyze(request) function');
  const P = str(provider), S = str(service);

  return {
    provider: P,
    service: S,

    async analyze(request) {
      const t0 = clock();
      try {
        const raw = await analyze(request);
        const out = normalizeResult(Object.assign({ provider: P, service: S }, raw || {}));
        out.latencyMs = Math.max(0, clock() - t0);
        return out;
      } catch (e) {
        const out = normalizeResult({ provider: P, service: S, confidence: null, warnings: [`analyze failed: ${(e && e.message) || 'error'}`] });
        out.latencyMs = Math.max(0, clock() - t0);
        return out;
      }
    },

    async healthCheck() {
      const t0 = clock();
      if (typeof healthCheck !== 'function') {
        return { ok: false, provider: P, service: S, latencyMs: 0, detail: 'no health check defined' };
      }
      let timer = null;
      try {
        const res = await Promise.race([
          Promise.resolve().then(healthCheck),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('health check timed out')), HEALTH_TIMEOUT_MS); if (timer && timer.unref) timer.unref(); }),
        ]);
        const r = res || {};
        return { ok: r.ok === true, provider: P, service: S, latencyMs: Math.max(0, clock() - t0), detail: str(r.detail) || (r.ok ? 'ok' : 'unavailable') };
      } catch (e) {
        return { ok: false, provider: P, service: S, latencyMs: Math.max(0, clock() - t0), detail: (e && e.message) || 'health check failed' };
      } finally {
        // Clear the race's timeout so a fast, healthy probe doesn't leave a dangling
        // timer holding the event loop open (would delay process exit by up to the timeout).
        if (timer) clearTimeout(timer);
      }
    },
  };
}

/** Run every adapter's healthCheck() concurrently; never throws. Returns a structured report. */
async function checkAll(adapters = []) {
  const checks = await Promise.all((adapters || []).map((a) => Promise.resolve()
    .then(() => a.healthCheck())
    // Belt-and-suspenders: makeAdapter's healthCheck never throws/rejects, but a
    // hand-rolled adapter might — catch both sync throws and async rejections so one
    // bad adapter can never fail the whole health report.
    .catch((e) => ({ ok: false, provider: a && a.provider, service: a && a.service, latencyMs: 0, detail: (e && e.message) || 'threw' }))));
  return { checkedAt: null, providers: checks, healthy: checks.filter((c) => c.ok).length, total: checks.length };
}

module.exports = {
  normalizeResult, makeAdapter, checkAll,
  CANONICAL_KEYS: ['provider', 'service', 'modelId', 'modelVersion', 'documentType', 'text', 'pageCount', 'pages', 'segments', 'fields', 'tables', 'evidenceRegions', 'confidence', 'warnings', 'latencyMs', 'estimatedCost', 'rawArtifactId'],
  HEALTH_TIMEOUT_MS,
};
