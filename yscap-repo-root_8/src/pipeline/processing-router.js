'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 2 DocumentProcessingRouter (Phase 1f).
 *
 * ONE router decides which vendor reads each document, runs it through the normalized
 * DocumentProvider adapter (src/pipeline/provider-adapters.js), optionally runs a second
 * "challenger" reader to reconcile the numbers, and RECORDS exactly what it did in
 * document_processing_routes (db/308) — the audit trail behind "why did PILOT send this
 * bank statement to Azure, and what did it cost?".
 *
 * It does NOT re-implement routing: it reuses the existing V1 routing brain
 * (src/lib/ai/routing-matrix.js `planRoute`, which already knows the per-family profiles,
 * table/numeric handling, and challenger policy) to CHOOSE the route, then maps the plan's
 * engine strings ('azure'/'google'/'mistral'/…) onto the real adapters.
 *
 * ADDITIVE + INERT: nothing calls this on a loan path yet. Phase 1g wires it into the
 * worker's packet-control stage behind UW_PIPELINE_V2_SHADOW (shadow only). Everyone stays
 * on Pipeline V1. Touches no frozen number. Never throws on the read path (the adapter
 * contract + a guarded recorder guarantee it); a recording failure never fails the read.
 */
const { planRoute } = require('../lib/ai/routing-matrix');

// Map a routing-matrix engine string → the adapter identity in provider-adapters REGISTRY.
// 'native_pdf' / 'appraisal_xml' are deterministic in-process readers, not vendor adapters —
// they carry no adapter (the caller reads them directly); we still record the route.
const ENGINE_TO_ADAPTER = Object.freeze({
  azure: { provider: 'azure', service: 'document_intelligence' },
  google: { provider: 'google', service: 'document_ai' },
  mistral: { provider: 'mistral', service: 'ocr' },
});

function num(v) { return (typeof v === 'number' && Number.isFinite(v)) ? v : null; }
function str(v) { return (v == null) ? '' : String(v); }

/**
 * Turn a set of document features into a concrete route plan mapped onto adapters.
 * Pure — no DB, no network. Returns:
 *   { primary:{engine, adapterKey|null}, challenger:{engine, adapterKey|null}|null,
 *     reason, materiality, numericCritical, specialHandling:[], reasons:[] }
 */
function planFor(features = {}) {
  const plan = planRoute(features || {});
  const mapEngine = (engine) => {
    if (!engine) return null;
    const a = ENGINE_TO_ADAPTER[engine] || null;
    return { engine, adapterKey: a ? `${a.provider}/${a.service}` : null, provider: a ? a.provider : engine, service: a ? a.service : null };
  };
  return {
    primary: mapEngine(plan.primary),
    challenger: plan.challenger ? mapEngine(plan.challenger) : null,
    reason: Array.isArray(plan.reasons) ? plan.reasons.join('; ') : '',
    materiality: plan.materiality || null,
    numericCritical: !!plan.numericCritical,
    specialHandling: Array.isArray(plan.specialHandling) ? plan.specialHandling : [],
    reasons: Array.isArray(plan.reasons) ? plan.reasons : [],
  };
}

/** Find the adapter in a list whose provider/service matches an adapterKey ('provider/service'). */
function adapterByKey(adapters, key) {
  if (!key) return null;
  return (adapters || []).find((a) => `${a.provider}/${a.service}` === key) || null;
}

/**
 * Record ONE routing decision + outcome into document_processing_routes. Best-effort +
 * NEVER throws (a failed insert must never fail the document read). Returns the inserted
 * row id, or null on any error.
 */
async function recordRoute(db, row = {}) {
  if (!db || typeof db.query !== 'function') return null;
  const r = row || {};
  try {
    const res = await db.query(
      `INSERT INTO document_processing_routes
         (job_id, document_id, loan_id, pipeline_version, document_family,
          provider, service, model_version, reason,
          challenger_provider, challenger_service, challenger_confidence,
          confidence, latency_ms, cost_cents, materiality, special_handling, outcome, warnings)
       VALUES ($1,$2,$3,COALESCE($4,'v2'),$5,
               $6,$7,$8,$9,
               $10,$11,$12,
               $13,COALESCE($14,0),COALESCE($15,0),$16,COALESCE($17,'[]'::jsonb),COALESCE($18,'planned'),COALESCE($19,'[]'::jsonb))
       RETURNING id`,
      [
        r.jobId || null, r.documentId || null, r.loanId || null, r.pipelineVersion || null, r.documentFamily || null,
        str(r.provider), r.service || null, r.modelVersion || null, r.reason || null,
        r.challengerProvider || null, r.challengerService || null, num(r.challengerConfidence),
        num(r.confidence), num(r.latencyMs), num(r.costCents), r.materiality || null,
        JSON.stringify(Array.isArray(r.specialHandling) ? r.specialHandling : []),
        r.outcome || null,
        JSON.stringify(Array.isArray(r.warnings) ? r.warnings : []),
      ],
    );
    return (res.rows[0] && res.rows[0].id) || null;
  } catch (e) {
    // Never let the audit record break the read.
    try { console.warn('[processing-router] recordRoute failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return null;
  }
}

/**
 * Route ONE document: plan → run the primary adapter's analyze (never throws) → record the
 * route + outcome. `opts.recordDb` (if given) persists a document_processing_routes row.
 * Returns { plan, result, routeId } where result is the normalized ProviderResult (or null
 * if the primary engine is a deterministic in-process reader with no adapter, e.g. native_pdf).
 * NEVER throws.
 */
async function routeDocument({ features, request, adapters, recordDb, documentId, jobId, loanId } = {}) {
  const plan = planFor(features || {});
  const primaryAdapter = plan.primary ? adapterByKey(adapters, plan.primary.adapterKey) : null;

  let result = null;
  let outcome = 'planned';
  let warnings = [];
  if (primaryAdapter) {
    result = await primaryAdapter.analyze(request || {});   // never throws (adapter contract)
    warnings = Array.isArray(result.warnings) ? result.warnings : [];
    // A vendor error normalizes to confidence:null + a warning — that's a failed read.
    outcome = (result.confidence == null && warnings.length > 0) ? 'failed' : 'completed';
  }

  const routeId = recordDb ? await recordRoute(recordDb, {
    jobId, documentId, loanId,
    documentFamily: (features && features.docType) || null,
    provider: plan.primary ? plan.primary.provider : '',
    service: plan.primary ? plan.primary.service : null,
    modelVersion: result ? (result.modelVersion || result.modelId || null) : null,
    reason: plan.reason,
    challengerProvider: plan.challenger ? plan.challenger.provider : null,
    challengerService: plan.challenger ? plan.challenger.service : null,
    confidence: result ? result.confidence : null,
    latencyMs: result ? result.latencyMs : 0,
    costCents: result ? (num(result.estimatedCost) || 0) : 0,
    materiality: plan.materiality,
    specialHandling: plan.specialHandling,
    outcome,
    warnings,
  }) : null;

  return { plan, result, routeId, outcome };
}

module.exports = {
  planFor, routeDocument, recordRoute,
  _internals: { adapterByKey, ENGINE_TO_ADAPTER },
};
