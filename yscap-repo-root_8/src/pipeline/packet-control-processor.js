'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 1/2 packet-control job processor (Phase 1g).
 *
 * This is the durable worker's `processor(job, ctx)` for a document-processing job. It runs the
 * FIRST controlled stages of the evidence-first pipeline and records each one into
 * document_pipeline_stages (the run manifest), so every document that flows through V2 leaves a
 * complete, auditable stage trail:
 *
 *   intake          — the file was validated + hashed + stored in the HTTP request (Layer 1);
 *                     this stage just confirms the job carries what it needs.
 *   packet_control  — plan the processing ROUTE via the DocumentProcessingRouter (Phase 1f):
 *                     which vendor would read this document, why, and the challenger; record a
 *                     document_processing_routes row. (The route is PLANNED here; the heavy OCR /
 *                     split / extraction read is deferred — see the shadow note below.)
 *   ocr_layout      — the real vendor read. In SHADOW (no adapters injected) this is recorded
 *   classification    not_applicable ("shadow: read not run"); the real read is wired once the
 *                     storage model (a separate Render worker can't reach the web service's
 *                     local-disk documents → S3 vs in-process worker) is decided with the owner.
 *
 * GOVERNING GUARANTEES (never regress):
 *  - SHADOW-ONLY / INERT: nothing enqueues these jobs yet (Phase 1h wires enqueue-on-upload behind
 *    UW_PIPELINE_V2_SHADOW), and the worker itself is off unless UW_WORKER_ENABLED. Everyone stays
 *    on Pipeline V1. This processor writes ONLY to the V2 job/route tables — it never touches a
 *    V1 condition, decision, notification, or a frozen number, and never exposes a V2 decision.
 *  - NEVER THROWS: any error records the failing stage failed_retryable and returns a retryable
 *    outcome to the worker (which leases + backs off) — a bad job never crashes the worker.
 *  - Dependency-injected: the router + job-queue are injected (defaulting to the real modules) so
 *    tests exercise it with fakes, no vendors, no network.
 */

const STAGE = Object.freeze({
  INTAKE: 'intake',
  PACKET_CONTROL: 'packet_control',
  OCR_LAYOUT: 'ocr_layout',
  CLASSIFICATION: 'classification',
});

/**
 * PURE — build a COMPACT summary of what a real read produced, for the shadow surface + audit
 * trail (Phase 3c). Captures only counts + metadata (NO document text, NO PII): provider, model,
 * confidence, latency, page count, and a rough character count if the pages carry text. Defensive
 * against any adapter result shape. Returns a small plain object suitable for the artifact `meta`.
 */
function summarizeRead(routed) {
  const r = (routed && routed.result) || {};
  const pages = Array.isArray(r.pages) ? r.pages : [];
  let charCount = 0;
  for (const p of pages) {
    const t = p && (p.text || p.content);
    if (typeof t === 'string') charCount += t.length;
  }
  return {
    outcome: (routed && routed.outcome) || 'unknown',
    provider: (routed && routed.plan && routed.plan.primary && routed.plan.primary.provider) || null,
    service: (routed && routed.plan && routed.plan.primary && routed.plan.primary.service) || null,
    modelId: r.modelId || null,
    modelVersion: r.modelVersion || null,
    confidence: (typeof r.confidence === 'number' && Number.isFinite(r.confidence)) ? r.confidence : null,
    latencyMs: (typeof r.latencyMs === 'number' && Number.isFinite(r.latencyMs)) ? r.latencyMs : null,
    pageCount: pages.length,
    charCount,
    warnings: Array.isArray(r.warnings) ? r.warnings.slice(0, 10) : [],
  };
}

/**
 * Build the packet-control processor. Returns an async processor(job, ctx) matching the worker's
 * contract: ctx = { db, jq, holder }; returns { status:'completed'|'failed', retryable?, result?, error? }.
 *
 * opts:
 *   router    — the DocumentProcessingRouter (default require('./processing-router'))
 *   adapters  — real DocumentProvider adapters to actually READ with. When absent (shadow), the
 *               route is planned + recorded but the read stages are recorded not_applicable.
 *   loadBytes — async (db, documentId) → { buffer, base64, mimeType, filename } | null. Loads the
 *               real document bytes so the primary adapter can read for real (Phase 3b). Defaults
 *               to require('./document-bytes').loadDocumentBytes; injectable for tests. Only used
 *               when `adapters` are present AND the job payload carries no request bytes already.
 */
function makePacketControlProcessor(opts = {}) {
  const router = opts.router || require('./processing-router');
  const adapters = Array.isArray(opts.adapters) ? opts.adapters : null;
  const loadBytes = (typeof opts.loadBytes === 'function')
    ? opts.loadBytes
    : ((db, documentId) => require('./document-bytes').loadDocumentBytes(db, documentId));

  return async function packetControlProcessor(job, ctx = {}) {
    const db = ctx.db;
    const jq = ctx.jq || require('./job-queue');
    const jobId = job && job.id;
    const payload = (job && job.payload) || {};
    const features = payload.features || (payload.docType ? { docType: payload.docType } : {});
    const documentId = (job && job.document_id) || payload.documentId || null;
    const loanId = (job && job.loan_id) || payload.loanId || null;

    // Track the recorded status of each stage locally so we can evaluate the stage MANIFEST at the
    // end (VSLICE-5): a job only "completes" if it actually finished the stages it was supposed to.
    const stageStatus = {};
    const safeStage = async (key, status, detail) => {
      stageStatus[key] = status;
      try { await jq.recordStage(db, jobId, key, status, detail || {}); } catch (_e) { /* stage recording is best-effort */ }
    };
    // Best-effort artifact recorder (Phase 3c) — persists a compact summary of WHAT the read
    // produced into document_pipeline_artifacts (a V2 audit table). Never throws; a recording
    // failure never fails the read. Advisory-only: writes no loan file, no V1 table.
    const safeArtifact = async (kind, meta) => {
      try {
        if (typeof jq.recordArtifact === 'function') await jq.recordArtifact(db, jobId, { kind, meta: meta || {} });
      } catch (_e) { /* artifact recording is best-effort */ }
    };

    try {
      // ── intake ── the HTTP request already validated + hashed + stored the file.
      await safeStage(STAGE.INTAKE, 'completed', { note: 'validated + stored in request', family: features.docType || null });

      // ── packet_control ── plan the route (never throws) + record it.
      await safeStage(STAGE.PACKET_CONTROL, 'running', {});
      const plan = router.planFor(features);
      let routeId = null;
      try {
        routeId = await router.recordRoute(db, {
          jobId, documentId, loanId,
          documentFamily: features.docType || null,
          provider: plan.primary ? plan.primary.provider : '',
          service: plan.primary ? plan.primary.service : null,
          reason: plan.reason,
          challengerProvider: plan.challenger ? plan.challenger.provider : null,
          challengerService: plan.challenger ? plan.challenger.service : null,
          materiality: plan.materiality,
          specialHandling: plan.specialHandling,
          outcome: 'planned',
        });
      } catch (_e) { routeId = null; }
      await safeStage(STAGE.PACKET_CONTROL, 'completed', {
        primary: plan.primary ? plan.primary.provider : null,
        challenger: plan.challenger ? plan.challenger.provider : null,
        reason: plan.reason, routeId,
      });

      // ── ocr_layout + classification ── the real vendor read. Only run when adapters are
      // injected AND the router's primary is a real adapter engine; otherwise SHADOW = not run.
      const primaryKey = plan.primary && plan.primary.adapterKey;
      if (adapters && primaryKey) {
        // A real read path exists — load the document bytes (Phase 3b) so the primary adapter
        // can read for REAL. The bytes come from the SAME storage V1 serves (in-process worker),
        // so this reads the real document; it still only writes V2 audit tables (advisory).
        let request = payload.request || {};
        const hasBytes = !!(request && (request.buffer || request.base64));
        if (!hasBytes && documentId) {
          const loaded = await loadBytes(db, documentId);
          if (loaded && (loaded.buffer || loaded.base64)) {
            request = { buffer: loaded.buffer, base64: loaded.base64, mimeType: loaded.mimeType, filename: loaded.filename };
          }
        }
        const stillNoBytes = !(request && (request.buffer || request.base64));
        if (stillNoBytes) {
          // No bytes to read (document/storage unavailable) — record the read as not-run rather
          // than call the adapter with an empty request (which would look like a failed vendor read).
          await safeStage(STAGE.OCR_LAYOUT, 'not_applicable', { note: 'read skipped: document bytes unavailable' });
          await safeStage(STAGE.CLASSIFICATION, 'not_applicable', { note: 'read skipped: document bytes unavailable' });
        } else {
          // Route the document through the primary adapter with the real bytes.
          const routed = await router.routeDocument({
            features, request, adapters,
            recordDb: db, documentId, jobId, loanId,
          });
          const okRead = routed && routed.outcome === 'completed';
          await safeStage(STAGE.OCR_LAYOUT, okRead ? 'completed' : 'failed_retryable', {
            outcome: routed ? routed.outcome : 'unknown',
            confidence: routed && routed.result ? routed.result.confidence : null,
          });
          // Phase 3c — persist a compact summary of WHAT the read produced (counts + metadata
          // only, no document text/PII) so the shadow surface can show the real read output.
          // Advisory: writes only the V2 artifact table. Best-effort (never fails the read).
          await safeArtifact('ocr_result', summarizeRead(routed));
          // VSLICE-3 — turn the read into evidence candidates WITH page-level provenance and
          // record them into the Stage-5 ledger (evidence-first canonical truth). Advisory:
          // writes only document_pipeline_evidence; makes no decision, clears no condition.
          // Best-effort + never throws (a recording failure never fails the read).
          if (okRead && routed && routed.result) {
            try {
              const candidates = require('./read-to-evidence').readToEvidence(routed.result, {
                jobId, documentId, loanId, family: features.docType || null,
              });
              const ec = require('./evidence-candidate');
              for (const cand of candidates) { await ec.recordCandidate(db, cand); }
            } catch (_e) { /* evidence recording is best-effort */ }
          }
          // Classification is deferred to a later phase even on the read path; mark pending.
          await safeStage(STAGE.CLASSIFICATION, 'pending', { note: 'classifier stage not yet wired' });
        }
      } else {
        await safeStage(STAGE.OCR_LAYOUT, 'not_applicable', { note: 'shadow: read not run' });
        await safeStage(STAGE.CLASSIFICATION, 'not_applicable', { note: 'shadow: read not run' });
      }

      // VSLICE-5 — evaluate the full stage MANIFEST and FAIL CLOSED. In 'read' mode (real adapters
      // injected → a real vendor read was expected) the ocr_layout stage MUST have completed; a job
      // whose read was skipped / not-applicable / failed is INCOMPLETE and must NEVER be reported
      // completed (the owner-flagged "marked completed when no document was read" defect). In shadow
      // mode (no adapters) the read stages are legitimately not required, so a planned job completes.
      const mode = (adapters && primaryKey) ? 'read' : 'shadow';
      const manifest = require('./stage-manifest').evaluateManifest(stageStatus, { mode });
      await safeArtifact('stage_manifest', manifest);
      if (!manifest.complete) {
        // Retry only when the incompleteness is a TRANSIENT stage failure (failed_*); a missing /
        // not_applicable required stage (e.g. no document bytes) won't improve on retry → terminal.
        const anyTransient = manifest.incomplete.some((x) => String(x.status || '').startsWith('failed_'));
        return {
          status: 'failed', retryable: anyTransient,
          error: 'stage manifest incomplete — ' + manifest.reason,
          result: { planned: true, primary: plan.primary ? plan.primary.provider : null, routeId, manifest },
        };
      }
      return { status: 'completed', result: { planned: true, primary: plan.primary ? plan.primary.provider : null, routeId, manifest } };
    } catch (e) {
      // A genuinely unexpected error — record it + let the worker retry (never crash the worker).
      await safeStage(STAGE.PACKET_CONTROL, 'failed_retryable', { error: (e && e.message) ? String(e.message).slice(0, 300) : 'packet-control threw' });
      return { status: 'failed', retryable: true, error: (e && e.message) ? String(e.message).slice(0, 300) : 'packet-control threw' };
    }
  };
}

module.exports = { makePacketControlProcessor, STAGE, _internals: { summarizeRead } };
