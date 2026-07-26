'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Layer 1 shadow enqueue gate (Phase 1h).
 *
 * The ONE guarded chokepoint that decides whether a document should also be processed by the new
 * evidence-first pipeline IN SHADOW. When the shadow flag is on and the document's family is
 * enrolled, it enqueues a durable document-processing job (which the background worker drains
 * through the packet-control processor) — a copy that runs BESIDE Pipeline V1 and is never exposed.
 *
 * Governing guarantees:
 *  - INERT BY DEFAULT: does nothing unless `cfg.pipeline` has shadow (or v2) enabled AND the
 *    family is in UW_PIPELINE_V2_FAMILIES. With the default config (everything OFF) every call is a
 *    no-op that returns { enqueued:false, reason:'disabled' } — so wiring this into a live path is
 *    behavior-identical to today until the owner flips the switch.
 *  - NEVER THROWS: enqueuing is best-effort; a DB error is swallowed and returns
 *    { enqueued:false, reason:'error' }, so a shadow enqueue can never break the real upload/read.
 *  - IDEMPOTENT: job-queue.enqueue adopts an existing live job for the same document+version, so
 *    calling this repeatedly for the same document never creates duplicate shadow jobs.
 *  - SHADOW-ONLY: this only WRITES a job row; it exposes no V2 decision and touches no V1 table.
 */
const cfg = require('../config');

function fam(v) { return (v == null) ? '' : String(v).trim().toLowerCase(); }

/**
 * Should a document of this family be shadow-processed under the current config?
 * Pure — no DB. Returns { on, reason }.
 */
function shadowGate(family, pipelineCfg) {
  const p = pipelineCfg || cfg.pipeline || {};
  // Shadow OR full-v2 both mean "run the v2 path"; shadow is the safe default for Phase 1.
  if (!p.v2Shadow && !p.v2Enabled) return { on: false, reason: 'disabled' };
  const f = fam(family);
  if (!f) return { on: false, reason: 'no_family' };
  const families = Array.isArray(p.v2Families) ? p.v2Families.map(fam) : [];
  // "all" / "*" enrolls EVERY document family (owner-directed 2026-07-26: widen the shadow line to
  // all document types). Still advisory + shadow-only — this only controls which families get a
  // background copy processed; it changes no loan file. Set UW_PIPELINE_V2_FAMILIES=all to opt in.
  if (families.includes('all') || families.includes('*')) return { on: true, reason: 'enrolled_all' };
  if (!families.includes(f)) return { on: false, reason: 'family_not_enrolled' };
  return { on: true, reason: 'enrolled' };
}

/**
 * Enqueue a shadow document-processing job for `documentId` IF the shadow gate is open.
 * Best-effort + NEVER throws. Returns:
 *   { enqueued:true, jobId, created }  when a job was enqueued/adopted
 *   { enqueued:false, reason }         when the gate is closed or an error was swallowed
 *
 * @param {object} db     a pg pool/client with .query
 * @param {object} opts   { documentId, loanId?, family, pipelineCfg? }
 */
async function maybeEnqueueUpload(db, { documentId = null, loanId = null, family = null, pipelineCfg = null } = {}) {
  const gate = shadowGate(family, pipelineCfg);
  if (!gate.on) return { enqueued: false, reason: gate.reason };
  if (!documentId) return { enqueued: false, reason: 'no_document' };
  try {
    const jq = require('./job-queue');
    const res = await jq.enqueue(db, {
      documentId, loanId,
      pipelineVersion: 'v2',
      documentFamily: fam(family),
      // Idempotent per document+family: a re-upload/re-read never spawns a duplicate shadow job.
      idempotencyKey: `shadow:${documentId}:${fam(family)}`,
      payload: { shadow: true, features: { docType: fam(family) }, documentId, loanId },
    });
    return { enqueued: true, jobId: res.id, created: res.created !== false };
  } catch (e) {
    try { console.warn('[enqueue-on-upload] shadow enqueue failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return { enqueued: false, reason: 'error' };
  }
}

/**
 * VSLICE-7 — enqueue a shadow job for EVERY eligible UPLOAD, not just the docs V1 chose to
 * auto-read. Called from the upload routes right after the `documents` row is created. It derives
 * the document family at upload time the SAME way V1's auto-read does (no AI classification needed):
 * the checklist item's template code → its expected doc type, else the `doc_kind` tag — then defers
 * to `maybeEnqueueUpload` (gate + idempotent enqueue).
 *
 * Governing guarantees (identical to the rest of this module):
 *  - INERT BY DEFAULT: with the shadow flags off it does ZERO db work and returns
 *    { enqueued:false, reason:'disabled' } BEFORE any query — so wiring it into the live upload
 *    path is behavior-identical to today until the owner flips UW_PIPELINE_V2_SHADOW on.
 *  - NEVER THROWS: every step is caught; a family-lookup or enqueue error returns
 *    { enqueued:false, reason:'error' } so a shadow enqueue can NEVER break a real upload.
 *  - ADVISORY / SHADOW-ONLY: only ever WRITES a v2 job row; touches no V1 table, exposes no decision.
 *  - IDEMPOTENT: `maybeEnqueueUpload` → job-queue.enqueue adopts an existing job per document+version,
 *    so a re-upload never spawns a duplicate shadow job.
 *
 * @param {object} db     a pg pool/client with .query
 * @param {object} opts   { documentId, loanId?, checklistItemId?, docKind?, pipelineCfg? }
 */
async function enqueueUploadedDocument(db, { documentId = null, loanId = null, checklistItemId = null, docKind = null, pipelineCfg = null } = {}) {
  // Cheap gate FIRST — no db work at all when the shadow line is off (behavior-identical to today).
  const p = pipelineCfg || cfg.pipeline || {};
  if (!p.v2Shadow && !p.v2Enabled) return { enqueued: false, reason: 'disabled' };
  if (!documentId) return { enqueued: false, reason: 'no_document' };
  try {
    // Derive the family exactly as src/lib/underwriting/auto-read.js does: the checklist item's
    // template code → expected doc type takes precedence, else the doc_kind tag. A loose upload
    // with neither has no family, and maybeEnqueueUpload returns { reason:'no_family' } (no job).
    let family = null;
    if (checklistItemId) {
      try {
        const r = await db.query(
          `SELECT t.code AS condition_code
             FROM checklist_items ci LEFT JOIN checklist_templates t ON t.id = ci.template_id
            WHERE ci.id = $1`,
          [checklistItemId]);
        const code = r.rows[0] && r.rows[0].condition_code;
        if (code) {
          const mapped = require('../lib/underwriting/condition-map').expectedDocTypeForCode(code);
          if (mapped) family = fam(mapped);
        }
      } catch (_) { /* fall back to the doc_kind family below */ }
    }
    if (!family) family = fam(docKind) || null;
    return await maybeEnqueueUpload(db, { documentId, loanId, family, pipelineCfg });
  } catch (e) {
    try { console.warn('[enqueue-on-upload] enqueueUploadedDocument failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return { enqueued: false, reason: 'error' };
  }
}

module.exports = { maybeEnqueueUpload, shadowGate, enqueueUploadedDocument };
