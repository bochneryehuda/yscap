'use strict';
/**
 * ONE place that starts the Pipeline V2 document worker (owner defect #7, 2026-07-26).
 *
 * The worker used to be booted only from inside the web service. That is the defect: the document
 * reader competed with borrower page loads for the same CPU and the same process, so a heavy read
 * could slow the site, and a web deploy restarted the reader mid-job. It now runs as its OWN Render
 * service — but the START-UP SEQUENCE (build the provider adapters when reading is on, then hand
 * the processor to the worker) must be IDENTICAL in both, or the two services would quietly drift
 * into reading documents differently. So the sequence lives here, and both `src/server.js` and the
 * standalone `src/worker.js` call this and nothing else.
 *
 * ADVISORY ONLY, unchanged: the worker writes only the V2 audit tables
 * (document_pipeline_jobs/stages/attempts/artifacts, document_processing_routes,
 * document_pipeline_evidence). It never writes a condition, status, finding, or anything else on a
 * real loan file.
 *
 * Inert by default: `startWorker` is a no-op unless UW_WORKER_ENABLED, so calling this from the web
 * service stays behavior-identical to before until the switch is flipped per service.
 */

/**
 * Build the processor (with real read adapters when enabled) and start the durable worker.
 *
 * @param {object} o
 *   db   the pg pool
 *   cfg  the config object
 *   log  optional console-like sink (defaults to console) — the standalone worker labels its lines
 * @returns whatever startWorker returns: { enabled, holder, stop() } — `enabled:false` when the
 *          UW_WORKER_ENABLED switch is off. NEVER throws: a worker that cannot start must not stop
 *          the web service from serving, and must not crash-loop the worker service either. The
 *          caller decides what to do with a disabled/failed start.
 */
function startPipelineWorker({ db, cfg, log } = {}) {
  const out = log || console;
  try {
    const { startWorker } = require('./worker');
    const { makePacketControlProcessor } = require('./packet-control-processor');
    // Phase 3b — when UW_PIPELINE_V2_READ is on, inject the REAL document-provider adapters so the
    // worker READS each document for real (loads its bytes → primary OCR engine) and records the
    // actual read outcome. Still advisory: the read writes only the V2 audit tables. With the
    // switch OFF (default) no adapters are injected and the line only PLANS a route.
    let adapters = null;
    if (cfg && cfg.pipeline && cfg.pipeline.v2ReadEnabled) {
      try { adapters = require('./provider-adapters').buildDocumentAdapters(); }
      catch (e) { out.warn('pipeline v2 adapters not built:', e.message); adapters = null; }
    }
    return startWorker({ db, cfg, processor: makePacketControlProcessor(adapters ? { adapters } : {}) });
  } catch (e) {
    out.warn('pipeline worker not started:', (e && e.message) || e);
    return { enabled: false, holder: null, stop() {} };
  }
}

module.exports = { startPipelineWorker };
