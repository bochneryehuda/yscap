'use strict';
/**
 * Document-underwriting desk (staff). Mounted at /api/underwriting.
 *
 *   GET  /:appId                                   -> every current document extraction on the
 *                                                     file + open per-document findings + the
 *                                                     cross-document findings + a fatal/warning
 *                                                     roll-up (the clear-to-close gate).
 *   POST /:appId/documents/:documentId/analyze     -> read + understand + check ONE stored
 *                                                     document (Azure Document Intelligence +
 *                                                     Azure OpenAI), persist the extraction and
 *                                                     its findings. Body: { docType }.
 *   POST /:appId/findings/:fid/resolve             -> the underwriter's decision on one finding
 *                                                     (post_condition | request_document |
 *                                                     fix_file | clear | grant_exception |
 *                                                     dismiss | decline). Gated by
 *                                                     sign_off_conditions.
 *
 * Staff-only; non-see-all staff are scoped to their assigned files (identical to the
 * appraisal desk). Every analyze/resolve is audited. Nothing is auto-applied — resolving a
 * finding is an explicit human action, and a value is never written onto the loan file from
 * a document read (the checks only ever RAISE findings, never overwrite the file).
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { can, assigneeExistsSql } = require('../lib/permissions');
const storage = require('../lib/storage');
const docint = require('../lib/ai/docint');
const azureOpenai = require('../lib/ai/azure-openai');
const engine = require('../lib/underwriting/engine');
const store = require('../lib/underwriting/store');
const registry = require('../lib/underwriting/registry');
const fileView = require('../lib/underwriting/file-view');
const { tieoutForFile } = require('../lib/underwriting/file-review');
const { underwriterActions } = require('../lib/underwriting/actions');
const { falseAlarmReport } = require('../lib/underwriting/feedback');
const { classify } = require('../lib/underwriting/classify');
const { conditionsForDoc, purposeForDoc, docReadiness, fileConditionCoverage } = require('../lib/underwriting/condition-map');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
// today as a calendar string — no `new Date()` math in the date paths (CLAUDE.md rule).
const todayISO = () => new Date().toISOString().slice(0, 10);

router.use(requireAuth, requireStaff);

// Authorization: the file must exist AND the staffer must see it (see_all or assigned).
async function fileFor(req, appId) {
  if (!isUuid(appId)) return null;
  if (can(req.actor, 'see_all_files')) {
    return (await db.query(`SELECT id, borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0] || null;
  }
  return (await db.query(
    `SELECT a.id, a.borrower_id FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`,
    [appId, req.actor.id])).rows[0] || null;
}

// Materialize the underwriting_review_cleared gate condition on a file (idempotent) — mirrors the
// appraisal desk's ensureAppraisalCondition. Only creates it if the file doesn't already have it.
async function ensureUnderwritingCondition(appId) {
  await db.query(
    `INSERT INTO checklist_items
       (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
        phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
        clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id)
     SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
            COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
            COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
            COALESCE(t.sort_order,455), t.tool_key, t.clickup_field_id,
            COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1
       FROM checklist_templates t
      WHERE t.code='underwriting_review_cleared' AND t.is_active=true
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`,
    [appId]);
}

async function audit(actorId, action, entityId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,$2,'application',$3,$4)`,
      [actorId, action, entityId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort; never block the action */ }
}

// Attach the underwriter's action menu to a finding. Stored rows carry the check's suggested
// verbs in `suggested_actions` (jsonb); freshly-computed findings carry them in `actions`. Feed
// whichever is present to underwriterActions so the GET reload offers the SAME menu the analyze
// response did (no drift), falling back to the severity default when neither is set.
function decorate(f) {
  const actions = Array.isArray(f.actions) ? f.actions
    : (Array.isArray(f.suggested_actions) ? f.suggested_actions : undefined);
  return Object.assign({}, f, { availableActions: underwriterActions(actions ? { ...f, actions } : f) });
}

// The file's data-comparison (tie-out) is computed by the shared lib (src/lib/underwriting/
// file-review.js) so the desk and the checklist sign-off gate never disagree.

// ---- GET /insights/feedback: the "training" report ------------------------
// Per finding type, how often the team ACTED on it (real) vs threw it away (false alarm),
// learned from how underwriters resolved findings — so the desk sees which checks earn their
// keep and which cry wolf. Portfolio-wide, so it's for staff who see every file (admins /
// underwriters); registered BEFORE '/:appId' so 'insights' isn't read as an application id.
router.get('/insights/feedback', async (req, res, next) => {
  try {
    if (!can(req.actor, 'see_all_files')) return res.status(403).json({ error: 'this report needs access to every file' });
    // Include 'open' too: a posted-condition / requested-document finding stays OPEN but was
    // still acted on, so feedback.js scores it REAL by its resolution verb. A finding with no
    // resolution yet is counted pending and never affects a rate. (Superseded rows are omitted.)
    const { rows } = await db.query(
      `SELECT code, severity, status, resolution FROM document_findings
        WHERE status IN ('resolved','dismissed','open')`);
    res.json(falseAlarmReport(rows));
  } catch (e) { next(e); }
});

// ---- GET: the whole file's underwriting picture ----------------------------
router.get('/:appId', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });

    // Current extractions (one row per current document) + open findings + the file's conditions.
    const [exts, ff, conds] = await Promise.all([
      db.query(
        `SELECT id, document_id, doc_type, fields, ocr_engine, ai_model, page_count, confidence, status, reason, created_at
           FROM document_extractions WHERE application_id=$1 AND is_current ORDER BY created_at`, [app.id]),
      store.getFileFindings(db, app.id),
      db.query(
        `SELECT t.code, COALESCE(t.label, t.code) AS label, ci.status
           FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1`, [app.id]),
    ]);

    // Data-comparison / tie-out over the file's current extractions + the appraisal.
    const tieout = await tieoutForFile(db, app.id);
    const cross = tieout.discrepancies;

    // Enrich each analyzed document with the condition(s) it supports, its purpose, and its
    // readiness (clean / issues / blocked) from its own findings — so every document ties back to
    // the actual checklist. And a file-level coverage rollup: per document-condition, is it
    // analyzed and ready to clear?
    const extractions = exts.rows.map((e) => Object.assign({}, e, {
      conditions: conditionsForDoc(e.doc_type),
      purpose: purposeForDoc(e.doc_type),
      readiness: docReadiness(ff.findings.filter((f) => f.source === e.doc_type)),
    }));
    const conditionCoverage = fileConditionCoverage({ conditions: conds.rows, extractions: exts.rows, findings: ff.findings });

    const perDoc = ff.findings.map(decorate);
    // Roll the tie-out discrepancies into the same fatal/warning gate.
    const openAll = [...perDoc, ...cross];
    const summary = {
      fatal: openAll.filter((f) => f.severity === 'fatal').length,
      warning: openAll.filter((f) => f.severity === 'warning').length,
      info: openAll.filter((f) => f.severity === 'info').length,
      blocksCtc: openAll.some((f) => f.severity === 'fatal' && (f.blocks_ctc ?? f.blocksCtc)),
    };
    res.json({
      extractions,
      findings: perDoc,
      tieout: { columns: tieout.columns, matrix: tieout.matrix, summary: tieout.summary },
      crossDocument: cross,
      conditionCoverage,
      summary,
      docTypes: registry.docTypes(),
      analyzers: { reader: docint.configured(), ai: azureOpenai.available() },
    });
  } catch (e) { next(e); }
});

// The document must belong to THIS file, or be a PROFILE-LEVEL document of this file's borrower
// (application_id IS NULL). In this codebase government IDs / bank statements are uploaded UNDER an
// application (they carry that application_id), so they resolve via the first branch when they
// belong to this file; the NULL branch covers borrower-profile / LLC documents (e.g. an operating
// agreement). A document tied to a DIFFERENT application of the same borrower must NOT resolve here
// — otherwise file B's document could be analyzed and mis-filed onto file A (same borrower). Only
// the borrower is matched, not the file's LLC — the staff document picker is scoped the same way.
async function fileDoc(app, documentId) {
  return (await db.query(
    `SELECT id, application_id, borrower_id, filename, content_type, storage_provider, storage_ref
       FROM documents
      WHERE id=$1 AND is_current
        AND (application_id=$2 OR (application_id IS NULL AND borrower_id IS NOT NULL AND borrower_id=$3))`,
    [documentId, app.id, app.borrower_id])).rows[0] || null;
}

// ---- POST /documents/:documentId/classify: auto-detect the document's type -----
// "Know the purpose of every document" — read the document, guess its type from the text +
// filename, and return the suggestion + confidence so the desk can pre-select it (a human always
// confirms before findings are trusted). Never writes; best-effort (falls back to the filename
// when the OCR reader is off).
router.post('/:appId/documents/:documentId/classify', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.documentId)) return res.status(404).json({ error: 'document not found' });
    const doc = await fileDoc(app, req.params.documentId);
    if (!doc) return res.status(404).json({ error: 'document not found on this file' });

    let text = null;
    if (doc.storage_ref) {
      try {
        const buffer = await storage.read(doc.storage_ref);
        const ocr = await docint.read({ buffer, base64: buffer.toString('base64'), mimeType: doc.content_type || 'application/octet-stream' });
        if (ocr && ocr.ok) text = ocr.text;
      } catch (_) { /* OCR best-effort; fall back to the filename */ }
    }
    const guess = classify({ text, filename: doc.filename });
    res.json({ documentId: doc.id, filename: doc.filename, suggestedType: guess.docType, confidence: guess.confidence, usedText: !!text });
  } catch (e) { next(e); }
});

// ---- POST /documents/:documentId/analyze -----------------------------------
router.post('/:appId/documents/:documentId/analyze', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.documentId)) return res.status(404).json({ error: 'document not found' });

    const docType = String((req.body && req.body.docType) || '').trim();
    if (!registry.get(docType)) {
      return res.status(400).json({ error: `unknown document type — choose one of: ${registry.docTypes().join(', ')}` });
    }

    const doc = await fileDoc(app, req.params.documentId);
    if (!doc) return res.status(404).json({ error: 'document not found on this file' });
    if (!doc.storage_ref) return res.status(422).json({ error: 'this document has no stored file to read' });

    // Read the bytes (best-effort; a storage miss is a clear 422, never a crash).
    let buffer;
    try { buffer = await storage.read(doc.storage_ref); }
    catch (e) { return res.status(422).json({ error: `could not read the stored document: ${e && e.message}` }); }
    const base64 = buffer.toString('base64');

    // Build the subject this document type compares against, from the loan file.
    const ctx = await fileView.loadContext(db, app.id);
    const subject = fileView.subjectFor(docType, ctx);

    const result = await engine.analyzeDocument({
      docType, buffer, base64, mimeType: doc.content_type || 'application/octet-stream',
      subject, today: todayISO(),
    });

    // Persist (supersede prior read of this document + insert the new one) in a transaction.
    const client = await db.pool.connect();
    let saved;
    try {
      await client.query('BEGIN');
      saved = await store.saveAnalysis(client, {
        documentId: doc.id, applicationId: app.id, borrowerId: doc.borrower_id || app.borrower_id,
        docType, extraction: result.extraction, findings: result.findings,
      });
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    await audit(req.actor.id, 'underwriting_analyze', app.id, {
      documentId: doc.id, docType, ok: result.ok,
      findings: (result.findings || []).map((f) => f.code), reason: result.reason || null,
    });

    // Materialize the clear-to-close gate condition when analysis produced a blocking fatal, so
    // there IS a condition for signOffGate (+ the db/164 trigger) to hold until it's resolved —
    // mirrors how the appraisal desk ensures appraisal_review_cleared on import. Best-effort.
    if ((result.findings || []).some((f) => f.severity === 'fatal' && f.blocksCtc)) {
      await ensureUnderwritingCondition(app.id).catch(() => {});
    }

    res.json({
      ok: result.ok,
      docType,
      extractionId: saved.extractionId,
      status: result.extraction && result.extraction.status,
      confidence: result.extraction && result.extraction.confidence,
      findings: (result.findings || []).map(decorate),
      reason: result.reason || null,
    });
  } catch (e) { next(e); }
});

// ---- POST /findings/:fid/resolve -------------------------------------------
// Resolving a finding gates clear-to-close and records an underwriter decision — the same
// capability that signs off conditions on the appraisal desk. Loan officers may SEE findings
// via GET but never act on them.
router.post('/:appId/findings/:fid/resolve', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.fid)) return res.status(404).json({ error: 'finding not found' });
    const b = req.body || {};
    const action = String(b.action || '');
    const note = (b.note || '').slice(0, 2000);
    const value = b.value != null ? String(b.value).slice(0, 500) : null;

    // The finding must be open and belong to this file.
    const fnd = (await db.query(
      `SELECT id, code FROM document_findings WHERE id=$1 AND application_id=$2 AND status='open'`,
      [req.params.fid, app.id])).rows[0];
    if (!fnd) return res.status(404).json({ error: 'finding not found or already resolved' });

    let updated;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        updated = await store.resolveFinding(client, {
          findingId: fnd.id, action, note, value, by: req.actor.id,
        });
      } catch (e) {
        // validateResolution rejects unknown actions / a missing required note or value.
        await client.query('ROLLBACK').catch(() => {});
        return res.status(400).json({ error: e.message });
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    if (!updated) return res.status(409).json({ error: 'finding was already resolved' });

    await audit(req.actor.id, 'underwriting_finding_resolve', app.id,
      { finding: fnd.code, action, status: updated.status, note: note.slice(0, 300) });

    // Remaining open fatal findings gate clear-to-close — the stored per-document fatals AND
    // the derived tie-out fatals (which have no stored row but still block). Both are folded in
    // so this gate matches exactly what GET reports.
    const openFatal = (await db.query(
      `SELECT count(*)::int n FROM document_findings
        WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [app.id])).rows[0].n;
    const tieout = await tieoutForFile(db, app.id);
    const crossFatal = tieout.discrepancies.filter((f) => f.severity === 'fatal' && f.blocksCtc).length;

    res.json({ ok: true, finding: decorate(updated), openFatal, crossFatal, blocksCtc: (openFatal + crossFatal) > 0 });
  } catch (e) { next(e); }
});

module.exports = router;
