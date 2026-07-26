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

// Normalize a document-type label for agreement comparison (case/space/punct-insensitive).
function normType(v) {
  if (v == null) return '';
  return String(v).trim().toLowerCase().replace(/[_\-\s]+/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * PURE — reconcile a PRIMARY read against a CHALLENGER read of the SAME document. This is the
 * coarse, document-level cross-check (do two independent engines agree on what this document is,
 * and which read do we trust more); field-level reconciliation belongs to the evidence layer.
 * Never throws. Returns:
 *   { ran, challengerConfidence, agreement:'agree'|'disagree'|'unknown', chosen:'primary'|'challenger', reason }
 *  - agreement: 'agree' when both reads name the SAME documentType; 'disagree' when both name a
 *    DIFFERENT one; 'unknown' when either side didn't produce a type (nothing to cross-check).
 *  - chosen: the higher-confidence read — the challenger only wins when it is STRICTLY higher
 *    (a tie keeps the primary). Advisory only: nobody is overruled downstream by this pick.
 */
function reconcileReads(primary, challenger) {
  if (!challenger) return { ran: false, challengerConfidence: null, agreement: 'unknown', chosen: 'primary', reason: 'no challenger read' };
  const pc = num(primary && primary.confidence);
  const cc = num(challenger && challenger.confidence);
  const pt = normType(primary && primary.documentType);
  const ct = normType(challenger && challenger.documentType);
  let agreement = 'unknown';
  if (pt && ct) agreement = (pt === ct) ? 'agree' : 'disagree';
  const chosen = (cc != null && (pc == null || cc > pc)) ? 'challenger' : 'primary';
  let reason;
  if (agreement === 'disagree') reason = `primary read "${primary.documentType}", challenger read "${challenger.documentType}"`;
  else if (agreement === 'agree') reason = `both engines agree on "${primary.documentType}"`;
  else reason = 'not enough type signal to cross-check';
  return { ran: true, challengerConfidence: cc, agreement, chosen, reason };
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
    warnings = Array.isArray(result.warnings) ? result.warnings.slice() : [];
    // A vendor error normalizes to confidence:null + a warning — that's a failed read.
    outcome = (result.confidence == null && warnings.length > 0) ? 'failed' : 'completed';
  }

  // ── CHALLENGER (VSLICE-2) ── when the plan calls for a second reader AND its adapter is present,
  // actually RUN it and RECONCILE the two reads (was: recorded but never executed). Only fires on
  // a successful primary read (no point cross-checking a failed read). Advisory: the reconciliation
  // is recorded + returned; it overrules nothing downstream. Never throws (adapter contract).
  let challengerResult = null;
  let reconciliation = { ran: false, challengerConfidence: null, agreement: 'unknown', chosen: 'primary', reason: 'no challenger read' };
  const challengerAdapter = (result && outcome === 'completed' && plan.challenger)
    ? adapterByKey(adapters, plan.challenger.adapterKey) : null;
  if (challengerAdapter) {
    challengerResult = await challengerAdapter.analyze(request || {});
    reconciliation = reconcileReads(result, challengerResult);
    const chWarn = Array.isArray(challengerResult.warnings) ? challengerResult.warnings : [];
    // A genuine engine disagreement is a signal worth surfacing on the shadow route row.
    if (reconciliation.agreement === 'disagree') warnings = warnings.concat([`engine disagreement — ${reconciliation.reason}`]);
    // A challenger that itself errored is a soft note, not a primary failure.
    if (challengerResult.confidence == null && chWarn.length) warnings = warnings.concat([`challenger read failed: ${chWarn[0]}`]);
  }

  // Tag the route with the reconciliation outcome (no schema change — rides special_handling).
  const specialHandling = Array.isArray(plan.specialHandling) ? plan.specialHandling.slice() : [];
  if (reconciliation.ran) specialHandling.push(`reconciliation:${reconciliation.agreement}`, `trust:${reconciliation.chosen}`);

  // Cost + latency account for BOTH reads (the challenger really ran).
  const costCents = (result ? (num(result.estimatedCost) || 0) : 0) + (challengerResult ? (num(challengerResult.estimatedCost) || 0) : 0);
  const latencyMs = (result ? (num(result.latencyMs) || 0) : 0) + (challengerResult ? (num(challengerResult.latencyMs) || 0) : 0);

  const routeId = recordDb ? await recordRoute(recordDb, {
    jobId, documentId, loanId,
    documentFamily: (features && features.docType) || null,
    provider: plan.primary ? plan.primary.provider : '',
    service: plan.primary ? plan.primary.service : null,
    modelVersion: result ? (result.modelVersion || result.modelId || null) : null,
    reason: plan.reason,
    challengerProvider: plan.challenger ? plan.challenger.provider : null,
    challengerService: plan.challenger ? plan.challenger.service : null,
    challengerConfidence: reconciliation.challengerConfidence,
    confidence: result ? result.confidence : null,
    latencyMs,
    costCents,
    materiality: plan.materiality,
    specialHandling,
    outcome,
    warnings,
  }) : null;

  return { plan, result, challengerResult, reconciliation, routeId, outcome };
}

module.exports = {
  planFor, routeDocument, recordRoute,
  _internals: { adapterByKey, ENGINE_TO_ADAPTER, reconcileReads, normType },
};
