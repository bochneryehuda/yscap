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
const { ANALYZER_VERSION, subjectHash } = require('../lib/underwriting/fingerprint');
const { assessFile: assessStaleness } = require('../lib/underwriting/staleness');
const { computeMetrics } = require('../lib/underwriting/metrics');
const { buildChain } = require('../lib/underwriting/entity-chain');
const { assessCompleteness } = require('../lib/underwriting/completeness');
const { computeRiskScore } = require('../lib/underwriting/risk-score');
const { resolveEffectiveTerms } = require('../lib/underwriting/amendments');
const { computeVerdict } = require('../lib/underwriting/verdict');
const { assessReasonability } = require('../lib/underwriting/reasonability');
const { toISODate } = require('../lib/underwriting/compare');
const exceptions = require('../lib/underwriting/exceptions');

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));
// today as a calendar string — no `new Date()` math in the date paths (CLAUDE.md rule).
const todayISO = () => new Date().toISOString().slice(0, 10);

// Analyze and classify each hit PAID Azure endpoints (OCR + GPT). A scoped staffer on their own
// file could otherwise loop them — `force:true` bypasses the analyze idempotency cache, and
// classify has no cache at all — and burn unbounded Azure spend (cost-DoS, audit 2026-07-20). A
// lightweight in-process cooldown bounds one paid read per (user, document, kind) per window; the
// idempotency cache already makes an unchanged re-analyze free, so this only bites a rapid loop.
// In-process is enough to stop a runaway loop; it is NOT a security boundary (authz is elsewhere).
const PAID_COOLDOWN_MS = 8000;
const MAX_ANALYZE_BYTES = 50 * 1024 * 1024; // reject an oversized stored document before base64 amplification
const _lastPaidCall = new Map(); // `${actorId}:${documentId}:${kind}` -> ms of last paid call
function paidCooldownRemaining(actorId, documentId, kind) {
  const key = `${actorId}:${documentId}:${kind}`;
  const now = Date.now();
  const prev = _lastPaidCall.get(key);
  if (prev != null && now - prev < PAID_COOLDOWN_MS) return Math.ceil((PAID_COOLDOWN_MS - (now - prev)) / 1000);
  _lastPaidCall.set(key, now);
  if (_lastPaidCall.size > 5000) { // opportunistic cleanup so the map can't grow unbounded
    for (const [k, t] of _lastPaidCall) if (now - t > PAID_COOLDOWN_MS) _lastPaidCall.delete(k);
  }
  return 0;
}

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

    // Load the file context ONCE and reuse it for the tie-out, metrics, entity chain, and
    // completeness (avoids re-running the same multi-query context load several times per GET).
    const mctx = await fileView.loadContext(db, app.id);
    const a = (mctx && mctx.app) || {};

    // Data-comparison / tie-out over the file's current extractions + the appraisal.
    const tieout = await tieoutForFile(db, app.id, mctx);
    const cross = tieout.discrepancies;

    // Enrich each analyzed document with the condition(s) it supports, its purpose, and its
    // readiness (clean / issues / blocked) from its own findings — so every document ties back to
    // the actual checklist. And a file-level coverage rollup: per document-condition, is it
    // analyzed and ready to clear?
    const extractions = exts.rows.map((e) => Object.assign({}, e, {
      conditions: conditionsForDoc(e.doc_type),
      purpose: purposeForDoc(e.doc_type),
      readiness: docReadiness(ff.findings.filter((f) => f.document_id === e.document_id || f.source === e.doc_type)),
    }));
    const conditionCoverage = fileConditionCoverage({ conditions: conds.rows, extractions: exts.rows, findings: ff.findings });

    // Staleness / re-verification: project every dated document to the file's target closing
    // date (from the current purchase contract) and surface a freshness board + the forward-
    // looking advisories the today-based per-document checks can't produce ("fresh now, stale by
    // closing"). These are non-blocking warnings, folded into the same roll-up.
    const pc = exts.rows.find((e) => e.doc_type === 'purchase_contract');

    // Amendments / versioning: resolve the GOVERNING contract terms (base overlaid by the latest
    // fully-executed amendment) and flag when the file is stale vs the amended terms. The effective
    // closing date (amended if applicable) drives staleness below.
    const amendmentExts = exts.rows.filter((e) => e.doc_type === 'contract_amendment').map((e) => e.fields || {});
    const amendments = resolveEffectiveTerms(pc && pc.fields ? pc.fields : null, amendmentExts,
      { purchase_price: a.purchase_price });
    // Normalize to strict YYYY-MM-DD before it drives staleness (daysBetween needs ISO) — a valid
    // but non-ISO amended date would otherwise silently disable the closing horizon.
    const closingDate = toISODate(amendments.effective.closingDate) ||
      toISODate(pc && pc.fields ? pc.fields.closingDate : null) || null;
    const staleness = assessStaleness(exts.rows, { today: todayISO(), closingDate });

    // Derived metrics: recompute LTP/LTV/LTC/ARV-LTV from the file's registered economics, report
    // the binding cap, and warn on over-leverage. Pure math over the loan file (no document read).
    const metrics = computeMetrics({
      loanAmount: a.loan_amount, purchasePrice: a.purchase_price,
      asIsValue: a.as_is_value, arv: a.arv, rehabBudget: a.rehab_budget,
    });

    // Entity-resolution chain: only meaningful for an entity (LLC) borrower — an individual file
    // would show every entity edge as "missing" (noise). Compose the signing-authority / ownership
    // chain into one status; the name-consistency edges are tie-out's findings, the chain adds the
    // >=25%-owner KYC gap.
    const isEntity = !!((mctx && mctx.vestingName) || a.llc_id ||
      exts.rows.some((e) => e.doc_type === 'operating_agreement'));
    const entityChain = isEntity ? buildChain({ vestingName: mctx && mctx.vestingName }, exts.rows) : null;

    // File completeness / stipulations: diff the required-document matrix (adapted to this deal)
    // against what's analyzed on file → outstanding-items list + a completeness %. A VIEW only.
    const completeness = assessCompleteness(
      { isEntity, isAssignment: !!a.is_assignment },
      exts.rows, ff.findings);

    // Reasonability / data-integrity: value-level plausibility of what the documents and the file
    // actually say (a negative price, a loan bigger than the purchase, an ID that expired before it
    // was issued, a credit report dated in the future, a settlement that doesn't balance). All
    // warning/info — a distinct layer from the tie-out (agreement), the per-doc checks (semantics),
    // and metrics (leverage); it surfaces in the roll-up but never flips the fatal gate.
    const reasonability = assessReasonability({
      extractions: exts.rows, today: todayISO(),
      economics: { purchasePrice: a.purchase_price, loanAmount: a.loan_amount, asIsValue: a.as_is_value,
        arv: a.arv, rehabBudget: a.rehab_budget, assignmentFee: a.assignment_fee, underlyingPrice: a.underlying_contract_price },
    });

    const perDoc = ff.findings.map(decorate);
    // Roll the tie-out discrepancies + the forward-looking staleness advisories + over-leverage
    // metric warnings + reasonability data-integrity flags into the same fatal/warning gate (all
    // warning-only → never change the CTC-blocking fatal count, but they surface in the roll-up).
    const openAll = [...perDoc, ...cross, ...staleness.findings, ...metrics.findings, ...amendments.findings, ...(entityChain ? entityChain.findings : []), ...reasonability.findings];

    // Fraud / red-flag score: aggregate every open signal above + the economic red flags into one
    // explainable 0-100 score. Its HIGH-band advisory is a non-blocking warning (folded into the
    // roll-up); the score itself never re-decides the fatal gate.
    const risk = computeRiskScore({ findings: openAll,
      economics: { purchasePrice: a.purchase_price, asIsValue: a.as_is_value, arv: a.arv } });
    const openWithRisk = risk.finding ? [...openAll, risk.finding] : openAll;

    const summary = {
      fatal: openWithRisk.filter((f) => f.severity === 'fatal').length,
      warning: openWithRisk.filter((f) => f.severity === 'warning').length,
      info: openWithRisk.filter((f) => f.severity === 'info').length,
      blocksCtc: openWithRisk.some((f) => f.severity === 'fatal' && (f.blocks_ctc ?? f.blocksCtc)),
    };
    // One plain-English headline tying every roll-up together — the owner's at-a-glance read.
    const verdict = computeVerdict({ summary, risk, completeness, entityChain, extractionsCount: exts.rows.length });

    res.json({
      verdict,
      extractions,
      findings: perDoc,
      tieout: { columns: tieout.columns, matrix: tieout.matrix, summary: tieout.summary },
      crossDocument: cross,
      conditionCoverage,
      staleness: { closingDate, board: staleness.board, findings: staleness.findings.map(decorate) },
      metrics: { loanAmount: metrics.loanAmount, maxLoan: metrics.maxLoan, binding: metrics.binding,
        rows: metrics.metrics, findings: metrics.findings.map(decorate) },
      entityChain: entityChain ? { status: entityChain.status, edges: entityChain.edges, owners: entityChain.owners,
        vestingName: entityChain.vestingName, findings: entityChain.findings.map(decorate) } : null,
      completeness: { completenessPct: completeness.completenessPct, counts: completeness.counts,
        stipulations: completeness.stipulations, outstanding: completeness.outstanding,
        ctcBlockers: completeness.ctcBlockers, docsComplete: completeness.docsComplete },
      risk: { score: risk.score, band: risk.band, sarRecommended: risk.sarRecommended,
        reasons: risk.reasons, finding: risk.finding ? decorate(risk.finding) : null },
      amendments: { effective: amendments.effective, provenance: amendments.provenance,
        hasAmendments: amendments.hasAmendments, unexecuted: amendments.unexecuted,
        findings: amendments.findings.map(decorate) },
      reasonability: { checks: reasonability.checks, findings: reasonability.findings.map(decorate) },
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
    `SELECT id, application_id, borrower_id, filename, content_type, storage_provider, storage_ref, sha256
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
    // Read+OCR is a PAID call — skip it (fall back to the filename) when this (user, document)
    // asked within the cooldown, so a rapid loop can't run up Azure spend. Classify is best-effort
    // anyway, so throttling degrades gracefully rather than erroring.
    if (doc.storage_ref && !paidCooldownRemaining(req.actor.id, doc.id, 'classify')) {
      try {
        const buffer = await storage.read(doc.storage_ref);
        if (buffer && buffer.length <= MAX_ANALYZE_BYTES) {
          const ocr = await docint.read({ buffer, base64: buffer.toString('base64'), mimeType: doc.content_type || 'application/octet-stream' });
          if (ocr && ocr.ok) text = ocr.text;
        }
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

    // Build the subject this document type compares against, from the loan file.
    const ctx = await fileView.loadContext(db, app.id);
    const subject = fileView.subjectFor(docType, ctx);
    // Fingerprint EVERYTHING the checks compare against — the file subject AND `today` (several
    // checks are date-relative: an insurance/ID expiry or a staleness window turns on the
    // calendar day, not the document). Folding `today` in means the cache only reuses a result
    // computed on the SAME day, so an expired-since-analysis fatal can never be served stale.
    const subjHash = subjectHash({ subject, today: todayISO() });

    // IDEMPOTENCY (db/180): if this exact document (same content hash) was already analyzed as
    // THIS type, by THIS analyzer version, against THIS same file state, re-reading it would
    // spend a paid Azure call for a result we already have. Return the stored extraction + its
    // open findings instead. Never triggers for a legacy doc with no content hash (re-runs), and
    // an explicit `force:true` always re-reads. This is safe because the subject hash is part of
    // the key — any change to the loan file the check compares against re-analyzes.
    const force = !!(req.body && req.body.force);
    if (!force && doc.sha256) {
      const cached = await store.findReusableExtraction(db, {
        documentId: doc.id, applicationId: app.id, docType, analyzedSha256: doc.sha256,
        analyzerVersion: ANALYZER_VERSION, subjectHash: subjHash,
      });
      if (cached) {
        const findings = await store.findingsForExtraction(db, cached.id);
        await audit(req.actor.id, 'underwriting_analyze', app.id,
          { documentId: doc.id, docType, ok: true, cached: true });
        return res.json({
          ok: true, docType, cached: true, extractionId: cached.id,
          status: cached.status, confidence: cached.confidence,
          findings: findings.map(decorate), reason: null,
        });
      }
    }

    // Past the cache — this WILL make a paid Azure read+GPT call. Throttle one paid analyze per
    // (user, document) per cooldown so a force:true loop can't run up unbounded spend (cost-DoS).
    const cool = paidCooldownRemaining(req.actor.id, doc.id, 'analyze');
    if (cool) return res.status(429).json({ error: `this document was just analyzed — try again in ${cool}s`, retryAfterSeconds: cool });

    // Read the bytes (best-effort; a storage miss is a clear 422, never a crash).
    let buffer;
    try { buffer = await storage.read(doc.storage_ref); }
    catch (e) { return res.status(422).json({ error: 'could not read the stored document' }); }
    // Guard against an oversized stored document (memory / base64 amplification before Azure).
    if (buffer.length > MAX_ANALYZE_BYTES) {
      return res.status(413).json({ error: `this document is too large to analyze (limit ${Math.round(MAX_ANALYZE_BYTES / (1024 * 1024))} MB)` });
    }
    const base64 = buffer.toString('base64');

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
        analyzedSha256: doc.sha256 || null, analyzerVersion: ANALYZER_VERSION, subjectHash: subjHash,
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
    // there IS a condition for signOffGate (+ the db/179 trigger) to hold until it's resolved —
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
      `SELECT id, code, severity, blocks_ctc FROM document_findings WHERE id=$1 AND application_id=$2 AND status='open'`,
      [req.params.fid, app.id])).rows[0];
    if (!fnd) return res.status(404).json({ error: 'finding not found or already resolved' });

    // Tiered exception authority: granting an exception on a fatal, clear-to-close-blocking
    // finding — approving the loan despite an unmet hard requirement — needs senior authority
    // (waive_conditions) above the base sign_off_conditions gate. The reason is still recorded on
    // the finding for the audit trail. Everything else clears under the base permission.
    const auth = exceptions.canApply(req.actor, action, fnd, can);
    if (!auth.ok) return res.status(403).json({ error: auth.reason, requiredPermission: auth.requiredPermission });

    let updated;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        updated = await store.resolveFinding(client, {
          findingId: fnd.id, action, note, value, by: req.actor.id,
        });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // validateResolution throws a plain Error with a safe, user-facing reason (unknown action /
        // missing required note or value). A DB error carries a pg SQLSTATE in e.code — never leak
        // its internals (column/constraint names) to the client; hand it to the global handler.
        if (e && e.code) throw e;
        return res.status(400).json({ error: e.message });
      }
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    if (!updated) return res.status(409).json({ error: 'finding was already resolved' });

    await audit(req.actor.id, 'underwriting_finding_resolve', app.id,
      { finding: fnd.code, action, status: updated.status, note: note.slice(0, 300),
        elevated: auth.elevated || null });

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
