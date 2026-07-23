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
// Route via the multi-engine OCR router (owner-directed 2026-07-21): Azure Doc
// Intelligence stays the primary; Google Doc AI kicks in automatically when
// Azure returns nothing on a scanned/rotated page. Same call shape as before.
const docint = require('../lib/ai/ocr-router');
const azureOpenai = require('../lib/ai/azure-openai');
const engine = require('../lib/underwriting/engine');
const store = require('../lib/underwriting/store');
const registry = require('../lib/underwriting/registry');
const fileView = require('../lib/underwriting/file-view');
const { tieoutForFile } = require('../lib/underwriting/file-review');
const { underwriterActions } = require('../lib/underwriting/actions');
const { falseAlarmReport, readabilityReport } = require('../lib/underwriting/feedback');
const { programGuidelineSnapshot } = require('../lib/underwriting/program-guidelines');
const { classify } = require('../lib/underwriting/classify');
const { conditionsForDoc, purposeForDoc, docReadiness, fileConditionCoverage, docTypesForCode, expectedDocTypeForCode } = require('../lib/underwriting/condition-map');
const { selectAutoReadQueue } = require('../lib/underwriting/auto-read');
const { ANALYZER_VERSION, subjectHash } = require('../lib/underwriting/fingerprint');
const { assessFile: assessStaleness } = require('../lib/underwriting/staleness');
const { computeMetrics, capsFromRegistration } = require('../lib/underwriting/metrics');
const { buildChain } = require('../lib/underwriting/entity-chain');
const { buildSellerChain } = require('../lib/underwriting/seller-chain');
const { assessBankLiquidity, readRequiredLiquidity } = require('../lib/underwriting/bank-liquidity');
// Fix 2026-07-23 (#211): similar-open + bulk-resolve referenced seesAll() without
// defining it in this file (staff.js has its own copy) — ReferenceError → 500.
const seesAll = (req) => can(req.actor, 'see_all_files');
const { assessExperienceForFile } = require('../lib/underwriting/experience');
const { assessCompleteness } = require('../lib/underwriting/completeness');
const { computeRiskScore } = require('../lib/underwriting/risk-score');
const { resolveEffectiveTerms } = require('../lib/underwriting/amendments');
const { computeVerdict } = require('../lib/underwriting/verdict');
const { assessReasonability } = require('../lib/underwriting/reasonability');
const { toISODate } = require('../lib/underwriting/compare');
const exceptions = require('../lib/underwriting/exceptions');
const escalations = require('../lib/underwriting/escalations');
const notify = require('../lib/notify');

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

// Doc types where a LOW authenticity score (see src/lib/underwriting/authenticity.js)
// warrants raising a "this document shows signs of tampering" finding. A photo ID
// or screenshot is NOT here — those legitimately come from Photoshop / Preview and
// the low-authenticity signal is expected.
const MATERIAL_DOC_TYPES = new Set([
  'bank_statement', 'credit_report', 'appraisal', 'insurance', 'insurance_invoice',
  'title', 'settlement', 'purchase_contract', 'contract_amendment',
  'signed_term_sheet', 'signed_application', 'ein_letter', 'good_standing',
  'llc_formation', 'background_report', 'flood',
]);
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
    // READABILITY self-audit (Item 13): root-cause "why can't PILOT read certain documents." Scores
    // the CURRENT read of each document (clean vs unreadable vs error) + how often the backup vision
    // second-look (#537) rescued it, per document type. Attached alongside the false-alarm report so
    // the existing shape is preserved (back-compat — old callers keep reading byCode/totals).
    const ext = await db.query(
      `SELECT doc_type, confidence, status, second_look FROM document_extractions WHERE is_current`);
    res.json(Object.assign(falseAlarmReport(rows), { readability: readabilityReport(ext.rows) }));
  } catch (e) { next(e); }
});

// ---- Reliability / calibration report (#194): how trustworthy is the AI? ------
// Closes the calibration loop: over the shadow decisions whose REAL outcome is now
// known, how often the AI's would-be verdict matched reality, how well-calibrated
// its stated confidence is (accuracy, Brier score, per-confidence-bucket calibration
// + ECE), and the dangerous-miss (confirmed false-clear) rate — plus per-component
// slices. ADVISORY / measurement only: read-only, changes no decision, promotes
// nothing (the release gate is what would CONSUME this signal). Portfolio-wide, so
// see-all staff only; best-effort (empty report until outcomes are ingested).
// Registered BEFORE '/:appId' so 'insights' isn't read as an application id.
router.get('/insights/reliability', async (req, res, next) => {
  try {
    if (!can(req.actor, 'see_all_files')) return res.status(403).json({ error: 'this report needs access to every file' });
    const days = Number(req.query.sinceDays);
    const report = await require('../lib/underwriting/reliability')
      .loadReliabilityReport(db, { sinceDays: Number.isFinite(days) && days > 0 ? days : 180 });
    res.json({ ok: true, report });
  } catch (e) { next(e); }
});

// #218 — STRICT production-metrics dashboard. Same scored outcomes as the
// reliability report, but the two SAFETY numbers a lender running an AI
// underwriter live actually cares about are the HEADLINE: the FALSE-CLEAR rate (a
// real problem waved through — the release bar is ZERO) and the MISSED-MATERIAL
// rate (a material finding the AI omitted). Returns a blunt production-readiness
// status (green / amber / red / insufficient_data) + the blockers. ADVISORY /
// measurement only — read-only, promotes nothing, gates nothing. Portfolio-wide,
// so see-all staff only; best-effort (insufficient_data until outcomes accrue).
router.get('/insights/production-metrics', async (req, res, next) => {
  try {
    if (!can(req.actor, 'see_all_files')) return res.status(403).json({ error: 'this report needs access to every file' });
    const days = Number(req.query.sinceDays);
    const metrics = await require('../lib/underwriting/production-metrics')
      .loadProductionMetrics(db, { sinceDays: Number.isFinite(days) && days > 0 ? days : 180 });
    res.json({ ok: true, metrics, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ---- Finding-escalation WORKLOAD (owner-directed 2026-07-21, Items 7 + 12) -----------------
// A staffer who can't decide a finding escalates it to a super-admin / processor / underwriter,
// creating a workload item that carries the file link, the finding, its explanation, and the
// framed options. These routes are the reviewer's queue. Registered BEFORE '/:appId' so
// 'escalations' isn't read as an application id.
//
// Any staffer with underwriting-desk access can SEE the queue scoped to what they should act on
// (routed to their role, assigned to them, or raised by them); a see-all staffer sees everything.
router.get('/escalations', async (req, res, next) => {
  try {
    const seeAll = can(req.actor, 'see_all_files');
    const status = ['open', 'resolved', 'dismissed', 'all'].includes(req.query.status) ? req.query.status : 'open';
    const rows = await escalations.listEscalations({ status, viewer: req.actor, seeAll });
    const pendingCount = await escalations.pendingCount({ viewer: req.actor, seeAll });
    // Who may DECIDE an escalation: a super-admin, or the person it was routed to
    // (their role / assigned to them). The client uses this to show the decide controls.
    res.json({ escalations: rows, pendingCount, canDecideAll: req.actor.role === 'super_admin' });
  } catch (e) { next(e); }
});

router.get('/escalations/count', async (req, res, next) => {
  try {
    const seeAll = can(req.actor, 'see_all_files');
    res.json({ pendingCount: await escalations.pendingCount({ viewer: req.actor, seeAll }) });
  } catch (e) { next(e); }
});

// Decide (advise + close) an escalation. The person it was routed to may act on it — a
// super-admin always, or a staffer whose role matches target_role or who it's assigned to.
// Raising a finding does NOT let you decide your own escalation (that would defeat the point).
router.post('/escalations/:id/decide', async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) return res.status(404).json({ error: 'not found' });
    const row = (await db.query(`SELECT * FROM finding_escalations WHERE id=$1`, [req.params.id])).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.status !== 'open') return res.status(409).json({ error: 'this escalation was already handled' });
    const isSuper = req.actor.role === 'super_admin';
    if (!isSuper) {
      // The person who RAISED it can't also decide it — that would defeat the purpose (and the
      // audit trail would show the same staffer raised + resolved). A super-admin is exempt.
      if (row.requested_by === req.actor.id) return res.status(403).json({ error: 'you raised this finding — another reviewer must decide it' });
      // Otherwise: it was assigned to me personally (a deliberate hand-off), OR routed to my role
      // AND I actually have access to the file (never let a scoped staffer decide on a file they
      // can't see — same per-file scope as everywhere else).
      let mayDecide = row.assigned_to === req.actor.id;
      if (!mayDecide && row.target_role === req.actor.role) mayDecide = !!(await fileFor(req, row.application_id));
      if (!mayDecide) return res.status(403).json({ error: 'this escalation was routed to someone else' });
    }
    const b = req.body || {};
    const decision = b.decision === 'dismissed' ? 'dismissed' : 'resolved';
    const note = (b.note || '').slice(0, 1000);
    let updated;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      updated = await escalations.decideEscalation(client, { id: row.id, decision, staffId: req.actor.id, note });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    if (!updated) return res.status(409).json({ error: 'this escalation was already handled' });
    await audit(req.actor.id, 'underwriting_finding_escalation_decide', row.application_id,
      { escalation: row.id, finding: row.code, decision, note: note.slice(0, 300) });
    // Let the person who raised it know it was handled (in-app; email only if they turned it on).
    if (row.requested_by && row.requested_by !== req.actor.id) {
      notify.notifyStaff(row.requested_by, {
        type: 'finding_escalation_decided', applicationId: row.application_id,
        title: `Your escalated finding was ${decision === 'dismissed' ? 'dismissed' : 'resolved'}`,
        body: `${row.title || 'A finding'} — ${note ? note : (decision === 'dismissed' ? 'no action needed.' : 'handled.')}`,
        link: `/internal/app/${row.application_id}`,
      }).catch(() => {});
    }
    res.json({ ok: true, escalation: updated });
  } catch (e) { next(e); }
});

// ---- GET: the whole file's underwriting picture ----------------------------
router.get('/:appId', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });

    // Current extractions (one row per current document) + open findings + the file's conditions +
    // the required-liquidity dollar (read off the assets condition, for the bank-liquidity view).
    const [exts, ff, conds, requiredLiquidity] = await Promise.all([
      db.query(
        `SELECT id, document_id, doc_type, fields, ocr_engine, ai_model, page_count, confidence, status, reason, created_at
           FROM document_extractions WHERE application_id=$1 AND is_current ORDER BY created_at`, [app.id]),
      store.getFileFindings(db, app.id),
      db.query(
        `SELECT t.code, COALESCE(t.label, t.code) AS label, ci.status
           FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
          WHERE ci.application_id=$1`, [app.id]),
      readRequiredLiquidity(db, app.id),
    ]);

    // Load the file context ONCE and reuse it for the tie-out, metrics, entity chain, and
    // completeness (avoids re-running the same multi-query context load several times per GET).
    const mctx = await fileView.loadContext(db, app.id);
    const a = (mctx && mctx.app) || {};

    // ----- Documents ON FILE, linked to their condition (the "where to find each document" bridge)
    // Every uploaded document is filed under a checklist condition; that condition tells us which
    // document type it is EXPECTED to be (the title commitment lives under the title condition, the
    // insurance binder under the insurance condition, …). We walk that link so the desk knows a
    // document is present the moment it's uploaded — never a false "missing" just because the AI
    // hasn't read it yet — and so the auto-reader has a concrete queue of what to read, as what type,
    // for each condition. Current, non-rejected documents only; chat attachments excluded.
    // LLC-stack documents (Articles / EIN / operating agreement / good standing) are stored
    // ENTITY-scoped with application_id = NULL (keyed by llc_id) — "done once, reused on every loan"
    // — so an application_id-only filter would miss them and an entity file would still show them
    // "not uploaded" (the exact false-missing class). Pull a document when it is EITHER this file's
    // own (application_id), OR filed under one of THIS file's conditions (ci.application_id — catches
    // any doc whose denormalized owner differs), OR one of this file's ENTITY's documents (llc_id).
    const docsOnFile = await db.query(
      `SELECT d.id, d.filename, d.doc_kind, d.checklist_item_id, t.code AS condition_code,
              COALESCE(t.label, t.code) AS condition_label, d.page_bounded,
              d.authenticity_score, d.authenticity_level, d.authenticity_signals
         FROM documents d
         LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE d.is_current = true
          AND COALESCE(d.review_status, '') <> 'rejected'
          AND COALESCE(d.source_type, '') <> 'chat_attachment'
          AND ( d.application_id = $1
                OR ci.application_id = $1
                OR (d.llc_id IS NOT NULL AND d.llc_id = $2) )
        ORDER BY d.created_at`, [app.id, a.llc_id || null]);
    const analyzedDocIds = new Set(exts.rows.filter((e) => e.document_id).map((e) => e.document_id));
    // Map each on-file document to its EXPECTED type (from the condition it's filed under, falling
    // back to its doc_kind) and whether it's been read. `attached` = the set of document types that
    // have a real document present, feeding the completeness engine so "missing" means truly-absent.
    const attached = new Set();
    const documentsOnFile = [];
    const autoReadQueue = [];
    for (const d of docsOnFile.rows) {
      // The condition it's filed under names the expected type; fall back to the document's OWN
      // doc_kind (a document TYPE, used directly — not looked up as a condition code, which always
      // missed, so a settlement statement never got read). The fallback keeps a doc_kind only when
      // it's a real readable type, so a photo_id / term sheet never pollutes the on-file type set.
      // (A condition-derived type is kept as-is even if the reader doesn't own it — e.g. 'appraisal'
      // stays in the on-file set for completeness but is excluded from the read queue below.)
      const expectedType = expectedDocTypeForCode(d.condition_code) ||
        (d.doc_kind && registry.get(d.doc_kind) ? d.doc_kind : null);
      const analyzed = analyzedDocIds.has(d.id);
      if (expectedType) attached.add(expectedType);
      const row = { documentId: d.id, filename: d.filename, conditionCode: d.condition_code || null,
        conditionLabel: d.condition_label || null, docKind: d.doc_kind || null, expectedType, analyzed,
        // Sovereign authenticity — surfaced as a chip on the document row (R2.5, 2026-07-22).
        authenticityScore: d.authenticity_score != null ? Number(d.authenticity_score) : null,
        authenticityLevel: d.authenticity_level || null,
        authenticitySignals: Array.isArray(d.authenticity_signals) ? d.authenticity_signals
          : (typeof d.authenticity_signals === 'string' ? (function() { try { return JSON.parse(d.authenticity_signals); } catch { return null; } }()) : d.authenticity_signals) };
      documentsOnFile.push(row);
      // Anything present, not yet read, AND that maps to a type the reader can actually read is the
      // auto-read queue. The registry.get gate MUST match the /auto-read endpoint's selectAutoReadQueue
      // (isReadable), or the count here would include a type the reader skips (e.g. a document under
      // the appraisal-documents condition → 'appraisal', which the appraisal desk owns, not this
      // reader) and the desk's "read them all" button would never clear a stuck count.
      // R5.1 — a failed-slice split child (page_bounded=false) still references
      // the whole package; keep it OUT of the auto-read queue so it's never read
      // as if it were one logical document. Matches selectAutoReadQueue's guard.
      if (!analyzed && expectedType && registry.get(expectedType) && d.page_bounded !== false) autoReadQueue.push(row);
    }

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
    // Acquisition leverage (LTP / as-is LTV) is measured on the INITIAL ADVANCE, not the total loan
    // (the rehab holdback is legitimately allowed above those caps) — pull the engine's own sized
    // initial advance from the current registration; absent it, those two metrics are skipped rather
    // than computed off the total loan.
    const reg = mctx && mctx.registration;

    // AUS PROGRAM GUIDELINES (Item 11): resolve the file's registered program (registration first,
    // application second — same precedence the beneficial-owner check uses) and compose the plain-
    // language snapshot of the thresholds it's underwritten against (KYC owner %, required bank-
    // statement months, Gold SOW contingency). Reads the canonical guideline sources; asserts no
    // number of its own. For a MANUAL file the required months are the registrant-stated count, so
    // fetch asset_months (Gold/Standard ignore it). Best-effort — never blocks the report.
    const uwProgram = (reg && reg.program) || (a && a.program) || null;
    let assetMonths = null;
    if (/manual/i.test(String(uwProgram || ''))) {
      try {
        const am = await db.query(
          `SELECT asset_months FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [app.id]);
        if (am.rows[0] && am.rows[0].asset_months != null) assetMonths = am.rows[0].asset_months;
      } catch (_) { assetMonths = null; }
    }
    // Resolve the SOW-contingency requirement from its authoritative source (Gold OR a Blue Lake
    // note buyer) so the snapshot matches the real SOW gate exactly — not just the Gold arm. That
    // function returns an OBJECT { required, reason, ... } (same as the staff.js caller), so read
    // `.required` — passing the object would be truthy for EVERY file. Best-effort: on any error
    // leave it undefined so the snapshot falls back to the program (Gold) arm.
    let sowContingencyReq;
    try {
      const contReq = await require('../lib/rehab-budget').sowContingencyRequired(app.id);
      sowContingencyReq = contReq && contReq.required;
    } catch (_) { sowContingencyReq = undefined; }
    const programGuidelines = programGuidelineSnapshot(uwProgram, { assetMonths, sowContingencyRequired: sowContingencyReq });

    const metrics = computeMetrics({
      loanAmount: a.loan_amount, initialAdvance: reg ? reg.initialAdvance : null,
      purchasePrice: a.purchase_price,
      asIsValue: a.as_is_value, arv: a.arv, rehabBudget: a.rehab_budget,
    }, capsFromRegistration(reg ? reg.caps : null, reg ? reg.program : null));

    // Entity-resolution chain: only meaningful for an entity (LLC) borrower — an individual file
    // would show every entity edge as "missing" (noise). Compose the signing-authority / ownership
    // chain into one status; the name-consistency edges are tie-out's findings, the chain adds the
    // >=25%-owner KYC gap.
    const isEntity = !!((mctx && mctx.vestingName) || a.llc_id ||
      exts.rows.some((e) => e.doc_type === 'operating_agreement'));
    const entityChain = isEntity ? buildChain(
      { vestingName: mctx && mctx.vestingName, borrowerName: fileView.borrowerName(mctx && mctx.borrower),
        // The beneficial-owner verification threshold is program-dependent (Standard 15% / Manual 20%
        // / Gold 25%) — prefer the REGISTERED program, falling back to the application's program.
        program: (reg && reg.program) || (a && a.program) || null }, exts.rows) : null;

    // Seller → buyer OWNERSHIP CHAIN: compose the visual purchase chain (owner of record → seller →
    // buyer/assignee → the vesting LLC) so the desk can SHOW how the property gets into our
    // borrower, and raise the one action the tie-out doesn't own: when the contract/assignment is in
    // the borrower's PERSONAL name, suggest the final-assignment-to-LLC condition. Non-duplicative:
    // the seller/buyer FATAL mismatch stays the tie-out's; this adds the view + that condition.
    const sellerChain = buildSellerChain(mctx || {}, exts.rows);

    // Bank LIQUIDITY aggregation: sum every current bank statement's ending balance across the
    // borrower's / verified-entity accounts and compare to the file's required liquidity (read off
    // the registered product's assets condition, above). Raises the "short of required liquidity" and
    // "no ending balance" advisories nobody else owns — the per-statement ownership FATAL (money in
    // an unverified LLC → require the operating agreement) already lives in the bank-statement check.
    const bankLiquidity = assessBankLiquidity(mctx || {}, exts.rows, { requiredLiquidity });

    // Experience / track record: for a HEAVY-rehab or GROUND-UP deal the borrower must have at least
    // one VERIFIED comparable "anchor" project (right level + size, exited within 3 years). A missing
    // or unverified anchor is a DEALBREAKER that blocks clear-to-close (owner-directed) — enforced at
    // the gate via fileFatalCount (file-review.js), surfaced here for the desk.
    const experience = await assessExperienceForFile(db, app.id, { today: todayISO() });

    // File completeness / stipulations: diff the required-document matrix (adapted to this deal)
    // against what's analyzed on file → outstanding-items list + a completeness %. A VIEW only.
    const completeness = assessCompleteness(
      { isEntity, isAssignment: !!a.is_assignment,
        program: programGuidelines.program, bankStmtMonths: programGuidelines.bankStatementMonths },
      exts.rows, ff.findings, attached);

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
    // metric warnings + reasonability data-integrity flags + seller-chain advisories into the same
    // fatal/warning gate (all warning-only → never change the CTC-blocking fatal count, but they
    // surface in the roll-up).
    const openRaw = [...perDoc, ...cross, ...staleness.findings, ...metrics.findings, ...amendments.findings,
      ...(entityChain ? entityChain.findings : []), ...reasonability.findings, ...sellerChain.findings,
      ...bankLiquidity.findings, ...(experience ? experience.findings : [])];
    // De-duplicate the few FILE-economic findings that legitimately appear on more than one document
    // — the assignment fee over the cap shows on BOTH the purchase contract and the assignment, but
    // the desk should count/show it ONCE.
    const DEDUP_ONCE = new Set(['assignment_fee_over_cap']);
    const seenDup = new Set();
    const openAll = openRaw.filter((f) => {
      if (!f || !DEDUP_ONCE.has(f.code)) return true;
      if (seenDup.has(f.code)) return false;
      seenDup.add(f.code); return true;
    });

    // Sync computed chain + bank findings → ai_suggestions (owner-directed 2026-07-22,
    // HARD RULE). Best-effort, fired AFTER the response so file view stays fast; dedupe
    // in ai-suggestions collapses re-fires to a single OPEN row per (source, dedupe_key).
    // The AI panel picks up new suggestions on its next refresh.
    const syncBankBridge = require('../lib/underwriting/bank-statement-suggestions');
    const syncEntityChain = require('../lib/underwriting/entity-chain-suggestions');
    const bankFindingsFlat = (bankLiquidity && bankLiquidity.findings || []);
    setImmediate(() => {
      (async () => {
        const c = await db.pool.connect();
        // Fix 2026-07-23 (#211): each step runs under its OWN SAVEPOINT. Before
        // this, one failing step aborted the shared transaction (25P02) — every
        // later step silently no-oped AND the rollback wiped the earlier steps'
        // suggestions. The concrete trigger: app.id was passed as the bank
        // bridge's documentId, violating the ai_suggestions.document_id FK
        // (23503) on ANY file with a bank finding — so the whole post-view
        // detector sync recorded NOTHING on those files, every render.
        const step = async (fn) => {
          try {
            await c.query('SAVEPOINT view_sync');
            await fn();
            await c.query('RELEASE SAVEPOINT view_sync');
          } catch (_) { await c.query('ROLLBACK TO SAVEPOINT view_sync').catch(() => {}); }
        };
        try {
          await c.query('BEGIN');
          if (entityChain || sellerChain) {
            await step(() => syncEntityChain.syncChainsToSuggestions(c, app.id, { entityChain, sellerChain }));
          }
          if (bankFindingsFlat.length) {
            // These liquidity roll-up findings are FILE-level (no single source
            // document) — documentId null records an app-level suggestion.
            await step(() => syncBankBridge.syncBankFindingsToSuggestions(c, app.id, null, bankFindingsFlat));
          }
          // R3.18 — Bad-clearance scan: for every satisfied condition on the file,
          // run the classifier on its attached doc and post a "may have been cleared
          // with the wrong document" suggestion when the type doesn't match.
          // Dormant when the classifier isn't configured; capped per run.
          await step(() => require('../lib/underwriting/bad-clearance').scanFile(c, app.id, { maxConditions: 15 }));
          // R4.2 — Identity chain deep check: SSN/DOB/name mismatches across
          // every borrower-carrying doc → ai_suggestions. Best-effort.
          await step(() => require('../lib/underwriting/identity-chain').analyzeAndRecord(c, {
            applicationId: app.id, extractions: exts.rows,
          }));
          // R3.23 — Public-records cross-check (advisory): seller/grantor/appraisal
          // owner + vesting/buyer chain mismatches → ai_suggestions. Best-effort.
          await step(() => require('../lib/underwriting/public-records-crosscheck').analyzeAndRecord(c, {
            applicationId: app.id,
            fileCtx: { vestingName: mctx && mctx.vestingName },
            extractions: exts.rows,
          }));
          // #199 — party collusion (independence-required parties sharing an
          // identity) + double-pledged collateral (this property on another live
          // loan). Advisory — records ai_suggestions, never auto-blocks.
          await step(() => require('../lib/underwriting/party-collusion').analyzeAndRecord(c, {
            applicationId: app.id,
            fileCtx: { vestingName: mctx && mctx.vestingName },
            extractions: exts.rows,
          }));
          await step(() => require('../lib/underwriting/party-collusion').checkDoublePledgeAndRecord(c, {
            applicationId: app.id,
          }));
          await c.query('COMMIT');
        } catch (_) { await c.query('ROLLBACK').catch(() => {}); }
        finally { c.release(); }
      })().catch(() => {});
    });

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

    // Which findings on this file are already sitting in someone's escalation workload — so the desk
    // shows an "Escalated" badge instead of offering to escalate it again (best-effort).
    let escalatedByFinding = {};
    try {
      const escRows = await escalations.forFile(app.id, db);
      for (const e of escRows) if (e.finding_id) escalatedByFinding[e.finding_id] = { id: e.id, targetRole: e.target_role, status: e.status };
    } catch (_) { escalatedByFinding = {}; }

    // Major fraud/authenticity banner (R3.14) — cheap read of open ai_suggestions.
    // Best-effort, never blocks the file view.
    let fraudBanner = null;
    try {
      fraudBanner = await require('../lib/underwriting/fraud-alert').fileBanner(app.id, db);
    } catch (_) { fraudBanner = null; }
    // Best-effort admin alert for any NEW signal (dedupe stamp inside the helper).
    if (fraudBanner && Array.isArray(fraudBanner.signals)) {
      setImmediate(() => {
        (async () => {
          const fa = require('../lib/underwriting/fraud-alert');
          for (const s of fraudBanner.signals) {
            await fa.alertAdminsOncePerSignal(app.id, s, { link: `/staff/applications/${app.id}` }).catch(() => {});
          }
        })().catch(() => {});
      });
    }

    // R5.20/R5.24 — root-cause clustering: group the open findings into the
    // smallest set of upstream causes, each with the single most likely fix and
    // the symptoms it would clear. Deterministic + pure; organizes existing
    // findings into a hypothesis, never clears anything.
    let rootCauses = [];
    try {
      const { analyzeRootCauses } = require('../lib/underwriting/root-cause');
      rootCauses = analyzeRootCauses(openAll.map((f) => ({
        id: f.id || null, code: f.code, severity: f.severity, title: f.title,
      }))).rootCauses;
    } catch (_) { rootCauses = []; }

    res.json({
      escalatedFindings: escalatedByFinding,
      fraudBanner,
      verdict,
      rootCauses,
      // AUS: which program this file is underwritten against + that program's governing thresholds.
      programGuidelines,
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
      sellerChain: { status: sellerChain.status, nodes: sellerChain.nodes, edges: sellerChain.edges,
        finalHolder: sellerChain.finalHolder, reachesVesting: sellerChain.reachesVesting,
        findings: sellerChain.findings.map(decorate) },
      bankLiquidity: { requiredLiquidity: bankLiquidity.requiredLiquidity, qualifyingTotal: bankLiquidity.qualifyingTotal,
        excludedTotal: bankLiquidity.excludedTotal, shortfall: bankLiquidity.shortfall,
        accounts: bankLiquidity.accounts, statementsCount: bankLiquidity.statementsCount,
        findings: bankLiquidity.findings.map(decorate) },
      experience: experience ? { demandTier: experience.demandTier, demandLabel: experience.demandLabel,
        requiredLabel: experience.requiredLabel, gated: experience.gated, hasVerifiedAnchor: experience.hasVerifiedAnchor,
        exceptionGranted: experience.exceptionGranted, anchors: experience.anchors, trackRecordCount: experience.trackRecordCount,
        findings: experience.findings.map(decorate) } : null,
      completeness: { completenessPct: completeness.completenessPct, counts: completeness.counts,
        stipulations: completeness.stipulations, outstanding: completeness.outstanding,
        ctcBlockers: completeness.ctcBlockers, docsComplete: completeness.docsComplete,
        trulyMissing: completeness.trulyMissing },
      // The documents actually ON FILE (linked to their condition) + which still need reading — so
      // the desk shows "on file" vs "not uploaded", and the reader knows what to auto-read.
      documentsOnFile,
      autoReadPending: autoReadQueue.length,
      risk: { score: risk.score, band: risk.band, sarRecommended: risk.sarRecommended,
        reasons: risk.reasons, finding: risk.finding ? decorate(risk.finding) : null },
      amendments: { effective: amendments.effective, provenance: amendments.provenance,
        hasAmendments: amendments.hasAmendments, unexecuted: amendments.unexecuted,
        findings: amendments.findings.map(decorate) },
      reasonability: { checks: reasonability.checks, findings: reasonability.findings.map(decorate) },
      // ONE consolidated list of every open finding the summary counts — so "2 warnings" maps to a
      // visible list of exactly 2 items (owner-reported: "it says 2 warnings and I can't see them").
      // It's the same de-duplicated roll-up (openWithRisk) the counts come from, decorated so each is
      // actionable; the desk shows it once at the top instead of scattering findings across sections.
      // A persisted per-document finding (has an id) is resolvable; a derived advisory (tie-out /
      // metric / staleness) is display-only and clears when its underlying data changes.
      allFindings: openWithRisk.map(decorate),
      summary,
      docTypes: registry.docTypes(),
      analyzers: { reader: docint.configured(), ai: azureOpenai.available() },
      // --- Sovereign additions (owner-directed 2026-07-21) ---
      // Twin canonical facts + the file's condition clearance proofs. Both are
      // additive read-only sections the file view renders below the classic
      // findings list. Best-effort — a failure here degrades the panel
      // gracefully (empty section) instead of breaking the whole load.
      twinFacts: await (async () => {
        try { return await require('../lib/underwriting/twin').factsForFile(app.id, db); }
        catch (_) { return []; }
      })(),
      cureProofs: await (async () => {
        try {
          const rows = await db.query(
            `SELECT DISTINCT ON (checklist_item_id) *
               FROM condition_clearance_proofs
              WHERE application_id = $1
              ORDER BY checklist_item_id, created_at DESC`, [app.id]);
          return rows.rows;
        } catch (_) { return []; }
      })(),
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
    `SELECT id, application_id, borrower_id, filename, content_type, storage_provider, storage_ref, sha256, page_bounded
       FROM documents
      WHERE id=$1 AND is_current
        AND (application_id=$2 OR (application_id IS NULL AND borrower_id IS NOT NULL AND borrower_id=$3))`,
    [documentId, app.id, app.borrower_id])).rows[0] || null;
}

// Read + check ONE document — the SHARED core of the manual /analyze endpoint AND the auto-reader.
// Reuses the analyze-once idempotency cache (db/203) so an unchanged document is never re-read for a
// paid Azure call, the per-(user,document) cost cooldown, and the size guard. Returns a RESULT object
// (never throws for an expected per-document failure) so a batch (auto-read) can never die on one bad
// document — heavy per-document error handling. `opts.actorId` audits + arms the cooldown; omit it in
// contexts that shouldn't (a system pass). The manual endpoint maps the result's `error` to HTTP.
async function analyzeOneDocument(app, doc, docType, opts = {}) {
  const actorId = opts.actorId || null;
  const force = !!opts.force;
  const base = { documentId: doc.id, filename: doc.filename, docType };
  try {
    if (!doc.storage_ref) return { ...base, ok: false, error: 'no_stored_file' };
    // R5.1 — a split child whose physical slice FAILED (page_bounded=false) still
    // references the WHOLE source package. Refuse to analyze it as one logical
    // document here too (the auto paths already skip it) — analyzing it would
    // reproduce the packet contamination this fix prevents. Re-split or re-upload.
    if (doc.page_bounded === false) return { ...base, ok: false, error: 'unbounded_split_child' };

    const ctx = await fileView.loadContext(db, app.id);
    const subject = fileView.subjectFor(docType, ctx);
    const subjHash = subjectHash({ subject, today: todayISO() });

    if (!force && doc.sha256) {
      const cached = await store.findReusableExtraction(db, {
        documentId: doc.id, applicationId: app.id, docType, analyzedSha256: doc.sha256,
        analyzerVersion: ANALYZER_VERSION, subjectHash: subjHash,
      });
      if (cached) {
        const findings = await store.findingsForExtraction(db, cached.id);
        if (actorId) await audit(actorId, 'underwriting_analyze', app.id, { documentId: doc.id, docType, ok: true, cached: true });
        return { ...base, ok: true, cached: true, extractionId: cached.id, status: cached.status, confidence: cached.confidence, findings };
      }
    }

    // Past the cache — this makes a paid Azure read. Cost cooldown (armed only when we have an actor).
    const cool = actorId ? paidCooldownRemaining(actorId, doc.id, 'analyze') : 0;
    if (cool) return { ...base, ok: false, error: 'cooldown', retryAfterSeconds: cool };

    let buffer;
    try { buffer = await storage.read(doc.storage_ref); }
    catch (_) { return { ...base, ok: false, error: 'storage_read_failed' }; }
    if (!buffer) return { ...base, ok: false, error: 'storage_read_failed' };
    if (buffer.length > MAX_ANALYZE_BYTES) return { ...base, ok: false, error: 'too_large' };
    const base64 = buffer.toString('base64');

    const result = await engine.analyzeDocument({
      docType, buffer, base64, mimeType: doc.content_type || 'application/octet-stream',
      subject, today: todayISO(),
    });

    const client = await db.pool.connect();
    let saved;
    let authFatalSignal = null; // set inside the tx, recorded AFTER COMMIT (audit M2)
    try {
      await client.query('BEGIN');
      saved = await store.saveAnalysis(client, {
        documentId: doc.id, applicationId: app.id, borrowerId: doc.borrower_id || app.borrower_id,
        docType, extraction: result.extraction, findings: result.findings,
        analyzedSha256: doc.sha256 || null, analyzerVersion: ANALYZER_VERSION, subjectHash: subjHash,
      });
      // Authenticity scoring (Sovereign, blueprint 2026-07-22): score the PDF
      // bytes for tampering signals + stash on the documents row. If the score
      // is 'low' on a MATERIAL doc type (bank statement, appraisal, credit,
      // insurance, ...), spawn a warning finding so the underwriter looks
      // BEFORE trusting the extracted values. Best-effort — never blocks.
      try {
        const auth = require('../lib/underwriting/authenticity').analyzePdf(buffer, { docType });
        await client.query(
          `UPDATE documents SET authenticity_score=$2, authenticity_level=$3, authenticity_signals=$4::jsonb, authenticity_checked_at=now() WHERE id=$1`,
          [doc.id, auth.score, auth.level, JSON.stringify(auth.signals || [])]);
        if (auth.level === 'low' && MATERIAL_DOC_TYPES.has(docType)) {
          const signalsFired = (auth.signals || []).filter((s) => s.present && s.weight > 0).map((s) => s.name.replace(/_/g, ' ')).slice(0, 4).join(', ');
          await client.query(
            `INSERT INTO document_findings
               (application_id, borrower_id, document_id, extraction_id, source, code, severity,
                title, how_to, blocks_ctc)
             VALUES ($1,$2,$3,$4,'authenticity','doc_low_authenticity','warning',$5,$6,false)`,
            [app.id, doc.borrower_id || app.borrower_id, doc.id, saved.extractionId,
             'This document shows signs of tampering',
             `Signals: ${signalsFired || 'metadata anomalies'}. Ask the borrower for a fresh copy sent DIRECTLY by the source (bank, insurance carrier, appraiser). Do not act on the extracted values until a clean copy is on file.`]);
          // R3.14 fix (2026-07-23): the major-fraud banner reads ai_suggestions
          // (source='authenticity', severity='fatal') — the document_findings row
          // above never reaches it, so the banner's authenticity branch was dead
          // code. Stash the high-alert signal and record it AFTER COMMIT (audit
          // M2: an in-transaction record() failure — e.g. a dedupe-race 23505 —
          // would abort/poison the tx and silently roll back the whole analysis).
          authFatalSignal = { docType, score: auth.score, signalsFired: signalsFired || null };
        }
      } catch (_) { /* authenticity is additive */ }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }

    // R3.14 fix (2026-07-23): record the low-authenticity high-alert signal as
    // an ai_suggestion AFTER the analyze tx committed — an in-tx record()
    // failure (dedupe-race 23505 etc.) would have poisoned the transaction and
    // silently rolled back the whole analysis (pre-merge audit M2). Advisory
    // only — the banner blocks nothing; deduped per document.
    if (authFatalSignal) {
      try {
        await require('../lib/underwriting/ai-suggestions').record(null, {
          applicationId: app.id, documentId: doc.id,
          source: 'authenticity', kind: 'finding', severity: 'fatal',
          title: 'A key document shows strong signs of tampering',
          body: `Signals: ${authFatalSignal.signalsFired || 'metadata anomalies'}. The AI changed nothing — review the document and request a fresh copy directly from the source.`,
          evidence: { code: 'doc_low_authenticity', docType: authFatalSignal.docType, score: authFatalSignal.score, signals: authFatalSignal.signalsFired },
          dedupeKey: `doc_low_authenticity:${doc.id}`,
        });
      } catch (_) { /* additive — never fails the analyze result */ }
    }
    if (actorId) await audit(actorId, 'underwriting_analyze', app.id, { documentId: doc.id, docType, ok: result.ok, findings: (result.findings || []).map((f) => f.code), reason: result.reason || null });
    // Materialize the CTC gate condition when analysis produced a blocking fatal (mirrors the manual path).
    if ((result.findings || []).some((f) => f.severity === 'fatal' && f.blocksCtc)) {
      await ensureUnderwritingCondition(app.id).catch(() => {});
    }
    return {
      ...base, ok: result.ok, cached: false, extractionId: saved.extractionId,
      status: result.extraction && result.extraction.status,
      confidence: result.extraction && result.extraction.confidence,
      findings: result.findings || [], reason: result.reason || null,
    };
  } catch (e) {
    // Keep the ORIGINAL error object (with .code/.status) so the manual endpoint can propagate it to
    // the global handler unchanged — a DB outage mid-persist must still surface as 503, a 22P02 as
    // 400, not a bare 500. The auto-read batch ignores `cause` and just records the failure.
    return { ...base, ok: false, error: 'analyze_failed', message: e && e.message, cause: e };
  }
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

    // The analyze-once idempotency cache, cost cooldown, read+check, persist, audit, and gate
    // materialization all live in the shared analyzeOneDocument (reused by the auto-reader). Map its
    // result `error` back to the manual endpoint's exact HTTP codes.
    const force = !!(req.body && req.body.force);
    const r = await analyzeOneDocument(app, doc, docType, { actorId: req.actor.id, force });
    if (r.error === 'cooldown') return res.status(429).json({ error: `this document was just analyzed — try again in ${r.retryAfterSeconds}s`, retryAfterSeconds: r.retryAfterSeconds });
    if (r.error === 'too_large') return res.status(413).json({ error: `this document is too large to analyze (limit ${Math.round(MAX_ANALYZE_BYTES / (1024 * 1024))} MB)` });
    if (r.error === 'storage_read_failed' || r.error === 'no_stored_file') return res.status(422).json({ error: 'could not read the stored document' });
    if (r.error === 'unbounded_split_child') return res.status(422).json({ error: 'this split part could not be page-bounded to its own pages — re-split or re-upload it before analyzing' });
    if (r.error === 'analyze_failed') return next(r.cause || new Error(r.message || 'analyze failed'));
    res.json({
      ok: r.ok, docType, cached: !!r.cached, extractionId: r.extractionId,
      status: r.status, confidence: r.confidence,
      findings: (r.findings || []).map(decorate), reason: r.reason || null,
    });
  } catch (e) { next(e); }
});

// ---- POST /auto-read: read + check EVERY on-file document that hasn't been read yet -------------
// The heart of "read and check automatically" (owner-directed 2026-07-20): walk the documents the
// file already has (each filed under a condition — title commitment under the title condition,
// insurance under insurance, …) and read+check each AS the type that condition expects, posting the
// findings — with NO per-document click. Idempotent: the analyze-once cache makes an unchanged
// re-read free, so the desk can call this every time it opens. Dormant-safe: when the Azure reader/AI
// aren't configured it does NOTHING but report how many are waiting (never fakes a result). Bounded:
// a kill-switch env + a per-call cap so one file can't run away. Per-document errors are contained
// (analyzeOneDocument returns them) so one bad document never stops the batch.
const AUTOREAD_ENABLED = process.env.UNDERWRITING_AUTOREAD_ENABLED !== '0';
const AUTOREAD_MAX_PER_CALL = Math.max(1, parseInt(process.env.UNDERWRITING_AUTOREAD_MAX || '25', 10) || 25);

// Build the on-file-but-unread queue (shared shape with the GET): each current, non-rejected
// document filed under a condition mapped to a readable document type, that has no current
// extraction yet. Pulls this file's own docs, its entity's LLC docs, and anything under its
// conditions (mirrors the GET's documentsOnFile query).
async function buildAutoReadQueue(app) {
  const a0 = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [app.id])).rows[0] || {};
  const [docs, exts] = await Promise.all([
    db.query(
      `SELECT d.id, d.filename, d.doc_kind, d.page_bounded, t.code AS condition_code
         FROM documents d
         LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE d.is_current = true
          AND COALESCE(d.review_status, '') <> 'rejected'
          AND COALESCE(d.source_type, '') <> 'chat_attachment'
          AND ( d.application_id = $1 OR ci.application_id = $1 OR (d.llc_id IS NOT NULL AND d.llc_id = $2) )
        ORDER BY d.created_at`, [app.id, a0.llc_id || null]),
    db.query(`SELECT document_id FROM document_extractions WHERE application_id=$1 AND is_current AND document_id IS NOT NULL`, [app.id]),
  ]);
  return selectAutoReadQueue({
    documents: docs.rows,
    analyzedIds: new Set(exts.rows.map((r) => r.document_id)),
    isReadable: (t) => !!registry.get(t),
  });
}

router.post('/:appId/auto-read', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!AUTOREAD_ENABLED) return res.json({ readerOn: false, disabled: true, read: 0, cached: 0, pending: 0, total: 0, results: [] });

    const readerOn = docint.configured() && azureOpenai.available();
    const queue = await buildAutoReadQueue(app);

    // Reader not configured → report the waiting queue, read nothing (the desk shows "on file — will
    // read automatically once the reader is switched on"). Never make a paid call we can't fulfill.
    if (!readerOn) return res.json({ readerOn: false, read: 0, cached: 0, pending: queue.length, total: queue.length, results: [] });

    const batch = queue.slice(0, AUTOREAD_MAX_PER_CALL);
    const results = [];
    let read = 0, cached = 0, unreadable = 0;
    for (const item of batch) {
      const doc = await fileDoc(app, item.id);
      if (!doc) { results.push({ documentId: item.id, filename: item.filename, docType: item.expectedType, ok: false, error: 'not_found', unreadable: false, findings: 0 }); continue; }
      const r = await analyzeOneDocument(app, doc, item.expectedType, { actorId: req.actor.id });
      // The read succeeded but the document's fields couldn't be extracted as THIS type — the document
      // filed under this condition may be the WRONG document (e.g. not actually a title commitment) or
      // a poor scan. The desk flags it for the underwriter to confirm the right document is here.
      const notReadable = !!(r.ok && r.confidence === 'unreadable');
      if (r.ok && r.cached) cached++;
      else if (r.ok) read++;
      if (notReadable) unreadable++;
      results.push({ documentId: item.id, filename: item.filename, docType: item.expectedType, conditionCode: item.conditionCode, ok: !!r.ok, cached: !!r.cached, unreadable: notReadable, error: r.error || null, findings: (r.findings || []).length });
    }
    await audit(req.actor.id, 'underwriting_auto_read', app.id, { total: queue.length, read, cached, unreadable, failed: results.filter((x) => !x.ok).length });
    return res.json({ readerOn: true, read, cached, unreadable, pending: Math.max(0, queue.length - batch.length), total: queue.length, results });
  } catch (e) { next(e); }
});

// ---- AVM Consensus (Sovereign, API landscape Tier 1) ---------------------
// Cross-check the appraisal ARV against every configured AVM source
// (HouseCanary / Clear Capital / ATTOM). GET returns the current consensus
// report from the twin's observations; POST /verify calls every AVM
// connector to feed fresh api_verification observations, then re-reports.
router.get('/:appId/avm-consensus', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const report = await require('../lib/underwriting/avm-consensus').analyzeFileARV(app.id, db);
    res.json({ ok: true, report });
  } catch (e) { next(e); }
});
router.post('/:appId/avm-consensus/verify', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const hub = require('../lib/integrations/direct-source-hub');
    const avm = require('../lib/underwriting/avm-consensus');
    const client = await db.pool.connect();
    let hubResults; let report; let finding;
    try {
      await client.query('BEGIN');
      hubResults = await hub.verifyFile(client, app.id, { kind: 'avm' });
      report = await avm.analyzeFileARV(app.id, client);
      finding = report && report.comparison && report.comparison.disagrees
        ? await avm.persistFindingIfDisagreement(client, app.id, report)
        : null;
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, hubResults: hubResults && hubResults.results || [], report, finding });
  } catch (e) { next(e); }
});

// #192 — advisory guideline evaluation. Runs the file's flat rule CONTEXT (the
// same one the conditions engine builds) through the active knowledge-graph rules
// (registered program + any note-buyer investor), returning per-rule verdicts +
// plain citations + an investor-fit ranking. READ-ONLY and advisory — it changes
// no decision, clears no condition, sizes no loan, and touches NO frozen pricing/
// guideline number; it explains the frozen baselines db/260 recorded as data.
// Staff-only (inherits requireAuth+requireStaff on the router); best-effort — an
// unseeded knowledge graph returns an empty-but-valid report, never an error.
router.get('/:appId/guideline-evaluation', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const gi = require('../lib/underwriting/guideline-intelligence');
    const report = await gi.evaluateApplicationGuidelines(app.id);
    if (report) report.generatedAt = new Date().toISOString();
    res.json({ ok: true, report: report || { empty: true, applicationId: app.id, sets: [], fit: { ranked: [], best: null, anyFit: false, comparison: [] } } });
  } catch (e) { next(e); }
});

// ISG-3 — Investor-Specific Soft Guidelines desk. For the file's NOTE BUYER, works out
// which note-buyer condition guidelines apply, then judges each against the file: satisfied
// (the mapped PILOT condition is cleared), outstanding, or CONFLICTS with the guideline
// (a value contradicts the buyer's limit), plus which applicable-but-unmapped conditions to
// suggest posting, and the deferred (attorney-hold / post-closing) set shown separately.
// READ-ONLY / advisory — it posts nothing, blocks nothing, clears no condition, and touches
// NO frozen number; it explains the note buyer's own guidelines against this file. Staff-only
// (inherits requireAuth+requireStaff); best-effort — a file with no note-buyer guidelines
// returns a valid empty result, never an error.
router.get('/:appId/investor-guidelines', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const deskMod = require('../lib/underwriting/investor-guidelines/desk');
    const desk = await deskMod.runInvestorGuidelineDesk(app.id, db);
    if (desk) desk.generatedAt = new Date().toISOString();
    res.json({ ok: true, desk });
  } catch (e) { next(e); }
});

// #197 — whole-loan run cockpit. Reads the latest immutable underwriting run
// (schema db/266) for the file and folds it into ONE staff panel: the current
// decision (status + the three gates), what CHANGED since the previous run
// (run-diff), the ordered "what to do next" worklist (next-actions), and the
// findings rolled up by category (findings-digest). READ-ONLY / advisory — it
// summarizes an already-computed, already-persisted run; it runs nothing, decides
// nothing, clears no condition, and touches NO frozen pricing number. Staff-only
// (inherits requireAuth+requireStaff on the router); best-effort — a file that has
// never been run returns a valid hasRun:false payload, never an error.
router.get('/:appId/underwriting-run', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const cockpit = await require('../lib/underwriting/run-cockpit').loadRunCockpit(app.id, db);
    if (cockpit) cockpit.generatedAt = new Date().toISOString();
    res.json({ ok: true, cockpit: cockpit || { hasRun: false } });
  } catch (e) { next(e); }
});

// #217 — the never-block ISSUANCE verdict at every issuance point. For each action
// (term sheet / CTC / funding) it returns the two-tier answer from the shared
// issuance POLICY (issuance-policy.js): CLEAR (proceed, no warning), ADVISORY (any
// staff member proceeds — a heads-up, not a gate), or FATAL (a super-admin-
// overridable HARD WARNING — a super-admin can ALWAYS proceed). It NEVER returns an
// un-overridable block: the AI never hard-blocks a loan (owner-directed). READ-ONLY
// / advisory — it reads the latest run's issuance gate and applies policy; it
// decides nothing, clears nothing, and touches NO frozen pricing number. Best-effort:
// a file with no run, or any read error, degrades to a non-blocking advisory (the
// policy fails OPEN), never a 500. The UI's term-sheet / CTC / funding actions
// consult this so a genuine fatal shows as a super-admin-overridable warning and
// everything else is a proceed-past advisory. Staff-only (router requireAuth+requireStaff).
router.get('/:appId/issuance-check', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const policy = require('../lib/underwriting/issuance-policy');
    const gate = require('../lib/underwriting/issuance-gate');
    const actorRole = (req.actor && req.actor.role) || null;
    const only = String((req.query && req.query.action) || '').trim();
    const actions = gate.ACTIONS.includes(only) ? [only] : gate.ACTIONS;
    const issuance = {};
    for (const a of actions) {
      issuance[a] = await policy.resolveFromLatestRun(app.id, a, db, { actorRole });
    }
    res.json({ ok: true, actorRole, issuance, generatedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

// ---- Section 1071 coverage classifier (R2.10, blueprint compliance) ------
// The CFPB Section 1071 small-business lending data-collection rule takes
// effect January 1, 2028. This endpoint tells staff whether PILOT is on the
// hook to report on a given loan — considering the borrower's revenue, the
// product carve-outs, PILOT's material-terms authority (correspondent /
// table-funded structures), and PILOT's institutional threshold.
router.get('/:appId/section-1071', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const s1071 = require('../lib/underwriting/section-1071');
    const cur = await s1071.currentForFile(app.id, db);
    res.json({ ok: true, coverage: cur, institutionCovered: s1071.institutionCovered() });
  } catch (e) { next(e); }
});
router.post('/:appId/section-1071/classify', requirePermission('manage_pricing'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const s1071 = require('../lib/underwriting/section-1071');
    const client = await db.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await s1071.classifyAndPersist(client, app.id);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, ...result });
  } catch (e) { next(e); }
});

// ---- Twin fact history (Sovereign 1/4 drilldown) --------------------------
// Every observation of a fact + every state event, so the file view can show
// the reconciliation trail behind a canonical value (WHY this value is
// accepted, WHERE each source landed, WHEN each change was made).
router.get('/:appId/twin/fact/:factKey', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const factKey = String(req.params.factKey || '').slice(0, 120);
    if (!factKey) return res.status(400).json({ error: 'fact key required' });
    const twin = require('../lib/underwriting/twin');
    const history = await twin.factWithHistory(app.id, factKey, db);
    res.json({ ok: true, factKey, ...history });
  } catch (e) { next(e); }
});

// Twin — HUMAN CONFIRM a canonical fact (Sovereign 1/4 write surface,
// R2.1 owner-directed 2026-07-22). Lets an underwriter freeze a disputed
// value: the twin's confirmByHuman writes a new canonical row at
// status='human_confirmed' + records a fact_correction for the learning
// loop. Subsequent reconciliations preserve the human confirmation.
router.post('/:appId/twin/fact/:factKey/confirm', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const factKey = String(req.params.factKey || '').slice(0, 120);
    if (!factKey) return res.status(400).json({ error: 'fact key required' });
    const b = req.body || {};
    // Accept either a scalar `value` or a full `valueJson` object. A scalar becomes { value: <scalar> }.
    let valueJson;
    if (b.valueJson !== undefined) valueJson = b.valueJson;
    else if (b.value !== undefined) valueJson = { value: b.value };
    else return res.status(400).json({ error: 'value or valueJson required' });
    const reason = b.reason ? String(b.reason).slice(0, 500) : null;
    const twin = require('../lib/underwriting/twin');
    const client = await db.pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      row = await twin.confirmByHuman(client, {
        appId: app.id, factKey, valueJson, staffId: req.actor.id, reason,
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, fact: row });
  } catch (e) { next(e); }
});

// ---- Counterfactual structuring (Sovereign, blueprint sec. 12) ------------
// "What would make this deal work?" Runs a set of ALTERNATIVE structures
// through the frozen pricing engine and reports which levers move a file from
// MANUAL / INELIGIBLE to ELIGIBLE — reduce loan by 1-10%, swap program,
// longer term, interest-only. Read-only; never registers anything.
router.get('/:appId/structuring', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    // Load the file's current pricing basis + current registration.
    const staffRoutes = require('./staff');
    const loadFileForPricing = staffRoutes.loadFileForPricing;   // export path may vary; the direct call below covers absence
    let f = null;
    if (typeof loadFileForPricing === 'function') f = await loadFileForPricing(app.id);
    if (!f) {
      // Fallback direct SQL — mirrors the shape loadFileForPricing returns.
      const rowQ = await db.query(`SELECT * FROM applications WHERE id=$1`, [app.id]);
      f = { app: rowQ.rows[0], exp: null };
    }
    const regQ = await db.query(
      `SELECT program, quote, inputs FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`,
      [app.id]);
    const reg = regQ.rows[0] || null;
    const currentProgram = reg ? reg.program : 'standard';
    const quote = reg && (typeof reg.quote === 'string' ? JSON.parse(reg.quote) : reg.quote);
    const inputs = reg && (typeof reg.inputs === 'string' ? JSON.parse(reg.inputs) : reg.inputs);
    if (!inputs || !quote) return res.json({ ok: false, reason: 'no registered scenario to explore counterfactuals from' });
    const alternatives = require('../lib/underwriting/structuring').explore(inputs, currentProgram, quote);
    res.json({ ok: true, currentProgram, currentQuote: { totalLoan: quote.totalLoan, noteRate: quote.noteRate, status: quote.status }, alternatives });
  } catch (e) { next(e); }
});

// ---- Decision Certificates (Sovereign, blueprint sec. 18/19) --------------
// Issue an immutable signed snapshot of the file at a material milestone
// (clear_to_close, pre_funding, purchase_review, ...). The snapshot captures
// the canonical facts, open + resolved findings, exceptions granted, the
// registered program, and the versions in play. Hashed sha256 so a later
// audit can prove the file's state at the time of the decision. After issue,
// continuous surveillance flags the certificate `validation_required` if any
// canonical fact changes since.
router.post('/:appId/certificate/issue', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const cert = require('../lib/underwriting/certificate');
    const milestone = String(req.body && req.body.milestone || '').trim();
    if (!cert.MILESTONES.includes(milestone)) return res.status(400).json({ error: `milestone must be one of: ${cert.MILESTONES.join(', ')}` });
    const client = await db.pool.connect();
    let row;
    try {
      await client.query('BEGIN');
      row = await cert.issueCertificate(client, {
        appId: app.id, milestone, staffId: req.actor.id,
        reason: req.body && req.body.reason,
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, certificate: row });
  } catch (e) { next(e); }
});

router.get('/:appId/certificate', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const cert = require('../lib/underwriting/certificate');
    const all = await cert.allForFile(app.id, db);
    const withIntegrity = all.map((c) => Object.assign({}, c, { integrity: cert.verifyDigestIntegrity(c) }));
    res.json({ certificates: withIntegrity });
  } catch (e) { next(e); }
});

router.post('/:appId/certificate/survey', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const cert = require('../lib/underwriting/certificate');
    const client = await db.pool.connect();
    let results;
    try {
      await client.query('BEGIN');
      results = await cert.surveillanceCheck(client, app.id);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, results });
  } catch (e) { next(e); }
});

// ---- Real-time shadow training (Sovereign 4/4 extension) -----------------
// Right after an underwriter decides a finding, look at every OTHER open
// finding with the same code across the pipeline and surface them for
// bulk-action — instead of waiting for the nightly aggregator to notice the
// systemic false positive. Read-only lookup + a permissioned bulk-resolve.
router.get('/:appId/findings/:fid/similar-open', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.fid)) return res.status(404).json({ error: 'finding not found' });
    const f = (await db.query(
      `SELECT id, code, severity, application_id FROM document_findings WHERE id=$1 AND application_id=$2`,
      [req.params.fid, app.id])).rows[0];
    if (!f) return res.status(404).json({ error: 'finding not found' });
    const shadow = require('../lib/underwriting/shadow-training');
    // Filter to files the caller is permitted to see. see_all_files gets
    // everything the shadow returns; a scoped LO/processor only sees findings
    // on their own files.
    const rows = await shadow.findSimilarOpenFindings(db, f, { limit: 25 });
    const filtered = seesAll(req) ? rows : rows.filter((r) => r.application_id && String(r.application_id) === String(app.id));
    res.json({ ok: true, anchor: { id: f.id, code: f.code }, similar: filtered });
  } catch (e) { next(e); }
});

router.post('/:appId/findings/similar/bulk-resolve', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const findingIds = Array.isArray(b.findingIds) ? b.findingIds.filter(isUuid).slice(0, 100) : [];
    const action = String(b.action || '');
    if (!findingIds.length) return res.status(400).json({ error: 'no findingIds provided' });
    if (!['dismiss', 'clear', 'post_condition', 'request_document', 'acknowledge'].includes(action)) {
      return res.status(400).json({ error: 'action must be one of: dismiss | clear | post_condition | request_document | acknowledge (no grant_exception allowed in bulk — do that on the file individually)' });
    }
    // Refuse to bulk-touch findings on files the caller can't see. This is
    // authorization enforcement — every bulk id gets a fresh scope check.
    const scopeQ = await db.query(
      `SELECT df.id, df.application_id FROM document_findings df WHERE df.id = ANY($1::uuid[])`, [findingIds]);
    const seesAllFlag = seesAll(req);
    const allowedIds = [];
    for (const row of scopeQ.rows) {
      if (seesAllFlag) { allowedIds.push(row.id); continue; }
      const scoped = await fileFor(req, row.application_id).catch(() => null);
      if (scoped) allowedIds.push(row.id);
    }
    const client = await db.pool.connect();
    let out;
    try {
      await client.query('BEGIN');
      const shadow = require('../lib/underwriting/shadow-training');
      out = await shadow.bulkResolve(client, {
        findingIds: allowedIds, action, note: b.note || null, value: b.value || null, by: req.actor.id,
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, requested: findingIds.length, allowed: allowedIds.length, ...out });
  } catch (e) { next(e); }
});

// ---- POST /findings/:fid/committee-review ---------------------------------
// Run the multi-model reasoning committee on ONE finding (Sovereign 3/4,
// owner-directed 2026-07-21). Specialist reviewers (identity, entity, credit,
// fraud, appraisal, title, insurance) independently confirm or REFUTE the
// finding via strict-JSON verdicts; a pure adjudicator combines them into a
// committee opinion. The result is persisted on the finding (committee_action /
// committee_severity / committee_confidence / committee_reviewed_at) and in a
// dedicated finding_committee_reviews row so multiple review rounds don't
// overwrite each other. Best-effort — a committee failure never blocks the
// finding from being resolved via the normal /resolve route below.
router.post('/:appId/findings/:fid/committee-review', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.fid)) return res.status(404).json({ error: 'finding not found' });
    const fnd = (await db.query(
      `SELECT df.id, df.code, df.severity, df.title, df.field, df.doc_value, df.file_value, df.how_to,
              a.property_address, a.program, a.loan_amount,
              b.first_name, b.last_name,
              l.llc_name AS entity_name
         FROM document_findings df
         JOIN applications a ON a.id = df.application_id
         LEFT JOIN borrowers b ON b.id = a.borrower_id
         LEFT JOIN llcs l ON l.id = a.llc_id
        WHERE df.id=$1 AND df.application_id=$2 AND df.status='open'`,
      [req.params.fid, app.id])).rows[0];
    if (!fnd) return res.status(404).json({ error: 'finding not found or already resolved' });
    const context = {
      borrowerName: [fnd.first_name, fnd.last_name].filter(Boolean).join(' ') || null,
      entityName:   fnd.entity_name || null,
      propertyAddress: fnd.property_address && (fnd.property_address.line1 || fnd.property_address.address) || null,
      program:      fnd.program || null,
      loanAmount:   fnd.loan_amount || null,
    };
    const committee = require('../lib/ai/committee');
    const opinion = await committee.review({
      id: fnd.id, code: fnd.code, severity: fnd.severity, title: fnd.title,
      docValue: fnd.doc_value, fileValue: fnd.file_value, field: fnd.field, howTo: fnd.how_to,
    }, context, { all: !!(req.body && req.body.all) });

    // Persist: one row per review round + snapshot columns on the finding.
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO finding_committee_reviews
           (application_id, finding_id, committee_version, action, original_severity,
            adjudicated_severity, confidence, reasoning, votes_json, dissents_json,
            abstained_json, failed_json, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13)`,
        [app.id, fnd.id, opinion.committee_version || 'v1',
         opinion.committee.action, opinion.committee.original_severity,
         opinion.committee.adjudicated_severity, opinion.committee.confidence,
         opinion.committee.reasoning, JSON.stringify(opinion.committee.votes || []),
         JSON.stringify(opinion.committee.dissents || []),
         JSON.stringify(opinion.committee.abstained || []),
         JSON.stringify(opinion.committee.failed || []),
         req.actor.id]);
      await client.query(
        `UPDATE document_findings
            SET committee_action=$2, committee_severity=$3, committee_confidence=$4,
                committee_reviewed_at=now()
          WHERE id=$1`,
        [fnd.id, opinion.committee.action, opinion.committee.adjudicated_severity,
         opinion.committee.confidence]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, opinion });
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

    // The finding must be open and belong to this file. `field` is the canonical
    // fact key (purchase_price / arv / …) — used to APPLY a "fix the file" value
    // to the real application column below.
    const fnd = (await db.query(
      `SELECT id, code, severity, blocks_ctc, field FROM document_findings WHERE id=$1 AND application_id=$2 AND status='open'`,
      [req.params.fid, app.id])).rows[0];
    if (!fnd) return res.status(404).json({ error: 'finding not found or already resolved' });

    // Tiered exception authority: granting an exception on a fatal, clear-to-close-blocking
    // finding — approving the loan despite an unmet hard requirement — needs senior authority
    // (waive_conditions) above the base sign_off_conditions gate. The reason is still recorded on
    // the finding for the audit trail. Everything else clears under the base permission.
    const auth = exceptions.canApply(req.actor, action, fnd, can);
    if (!auth.ok) return res.status(403).json({ error: auth.reason, requiredPermission: auth.requiredPermission });

    // "Fix the file": when the corrected value maps to a real application column
    // (purchase price / as-is / ARV / rehab budget), APPLY it to the loan file —
    // not just record it on the finding. Honors the economics freeze: a frozen
    // file returns 409 and the finding is NOT resolved (clear the freeze / term-
    // sheet package first). A field with no application column stays records-only.
    let fileFix = null;
    if (action === 'fix_file' && value != null) {
      const applyFix = require('../lib/underwriting/apply-fix');
      if (applyFix.fixableColumn(fnd.field)) {
        try {
          fileFix = await applyFix.applyFindingFixToFile({ appId: app.id, field: fnd.field, value, actor: req.actor, db });
        } catch (e) {
          if (e && e.status === 409 && e.expose) return res.status(409).json({ error: e.message, locked: true });
          throw e;
        }
      }
    }

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
        elevated: auth.elevated || null,
        appliedToFile: fileFix && fileFix.applied ? { field: fileFix.field, column: fileFix.column, value: fileFix.value } : undefined });

    // Remaining open fatal findings gate clear-to-close — the stored per-document fatals AND
    // the derived tie-out fatals (which have no stored row but still block). Both are folded in
    // so this gate matches exactly what GET reports.
    const openFatal = (await db.query(
      `SELECT count(*)::int n FROM document_findings
        WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [app.id])).rows[0].n;
    const tieout = await tieoutForFile(db, app.id);
    const crossFatal = tieout.discrepancies.filter((f) => f.severity === 'fatal' && f.blocksCtc).length;

    res.json({ ok: true, finding: decorate(updated), openFatal, crossFatal, blocksCtc: (openFatal + crossFatal) > 0, fileFix });
  } catch (e) { next(e); }
});

// ---- POST /findings/escalate : send a finding to the super-admin workload ----------------------
// Any staffer with underwriting-desk access can ESCALATE a finding they can't decide — to a
// super-admin, a processor, or an underwriter (optionally a specific person). This does NOT
// require sign_off_conditions: the WHOLE point is that the person stuck on the finding can't
// resolve it and needs help. The escalation carries a SNAPSHOT of the finding (title, explanation,
// the two values, the framed options) so it stays readable even if the finding later changes;
// stored findings (a real uuid) dedupe to one open escalation, derived findings pass their snapshot.
router.post('/:appId/findings/escalate', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    const snap = b.finding && typeof b.finding === 'object' ? b.finding : {};
    // A stored finding is identified by a uuid; a derived finding has none. When a uuid is given,
    // load the authoritative row so the snapshot can't be spoofed and we can dedupe.
    let findingId = null;
    let finding = snap;
    if (b.findingId && isUuid(b.findingId)) {
      const row = (await db.query(
        `SELECT id, document_id, borrower_id, code, severity, field, title, how_to, doc_value, file_value, suggested_actions, page_number
           FROM document_findings WHERE id=$1 AND application_id=$2`, [b.findingId, app.id])).rows[0];
      if (row) { findingId = row.id; finding = row; }
    }
    if (!finding || (!finding.title && !finding.code)) return res.status(400).json({ error: 'nothing to escalate' });
    const targetRole = escalations.normTargetRole(b.targetRole);
    const question = (b.note || b.question || '').slice(0, 2000);
    // Route to a specific staffer only if they exist, are active, AND hold one of the reviewer
    // roles — a finding is never assigned to a scoped loan-officer (who would then be able to
    // decide it). Otherwise it routes to the role.
    let assignedTo = null;
    if (b.assignedTo && isUuid(b.assignedTo)) {
      const st = (await db.query(
        `SELECT id FROM staff_users WHERE id=$1 AND is_active=true AND role IN ('super_admin','processor','underwriter')`,
        [b.assignedTo])).rows[0];
      if (st) assignedTo = st.id;
    }
    let esc;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      esc = await escalations.openEscalation(client, {
        appId: app.id, findingId, finding, targetRole, assignedTo, question,
        borrowerId: app.borrower_id, requestedBy: req.actor.id,
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }

    await audit(req.actor.id, 'underwriting_finding_escalate', app.id,
      { escalation: esc.id, finding: finding.code || null, targetRole, assignedTo: assignedTo || null,
        note: question.slice(0, 300) });

    // Notify the workload: a specific assignee gets it directly; otherwise everyone who can act on
    // the target role is told. Best-effort — the escalation is already saved.
    const title = `Finding escalated for review — ${finding.title || finding.code || 'underwriting'}`;
    const body = question
      ? `${req.actor.full_name || 'A staffer'} needs a decision: ${question}`
      : `${req.actor.full_name || 'A staffer'} escalated a finding on this file for your review.`;
    const link = `/internal/app/${app.id}`;
    try {
      if (assignedTo) {
        notify.notifyStaff(assignedTo, { type: 'finding_escalation', applicationId: app.id, title, body, link, inAppOnly: false }).catch(() => {});
      } else if (targetRole === 'super_admin') {
        // Super-admins are notified via notifyAdmins; it fans out to admins + super-admins.
        notify.notifyAdmins({ type: 'finding_escalation', applicationId: app.id, title, body, link }).catch(() => {});
      } else {
        // Route to everyone active in the target role (processor / underwriter).
        const staff = (await db.query(`SELECT id FROM staff_users WHERE role=$1 AND is_active=true`, [targetRole])).rows;
        for (const s of staff) notify.notifyStaff(s.id, { type: 'finding_escalation', applicationId: app.id, title, body, link, inAppOnly: false }).catch(() => {});
      }
    } catch (_) { /* notification is best-effort */ }

    res.json({ ok: true, escalation: esc });
  } catch (e) { next(e); }
});

// ---- POST /experience-exception : senior override of the experience gate ----------------------
// The experience dealbreaker is DERIVED (no finding row), so it can't be waived through the normal
// finding-exception path. This records a senior-authority exception ON THE FILE — assessExperience
// then stops emitting the blocking finding and the CTC gate opens. Requires waive_conditions (the
// same senior authority that grants an exception on any fatal, CTC-blocking finding). Pass
// { grant:false } to REVOKE. Audited either way.
router.post('/:appId/experience-exception', requirePermission('waive_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const grant = !(req.body && req.body.grant === false);
    const note = ((req.body && req.body.note) || '').slice(0, 2000);
    if (grant && !note.trim()) return res.status(400).json({ error: 'a reason is required to grant an experience exception' });
    // The column write and its audit-log entry share ONE transaction so a gate-opening exception can
    // never be persisted without its audit trail (this is a privileged CTC-gate override).
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (grant) {
        await client.query(
          `UPDATE applications SET experience_exception_at=now(), experience_exception_by=$2, experience_exception_note=$3 WHERE id=$1`,
          [app.id, req.actor.id, note]);
      } else {
        await client.query(
          `UPDATE applications SET experience_exception_at=NULL, experience_exception_by=NULL, experience_exception_note=NULL WHERE id=$1`,
          [app.id]);
      }
      await client.query(
        `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
         VALUES ('staff',$1,'underwriting_experience_exception','application',$2,$3)`,
        [req.actor.id, app.id, JSON.stringify({ grant, note: note.slice(0, 300) })]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    res.json({ ok: true, granted: grant });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// GPT-5 cross-doc consistency check (R3.27, owner-directed 2026-07-22).
// Manual trigger — costs money per run. Requires sign_off_conditions.
// -------------------------------------------------------------------------
router.post('/:appId/ai-crossdoc', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    // Pull current extractions on the file.
    // Fix 2026-07-23: extraction status is 'analyzed' (db/200) — a status='ok'
    // filter matched NOTHING, so this ran on zero extractions every time.
    const exts = await db.query(
      `SELECT doc_type, document_id, fields
         FROM document_extractions
        WHERE application_id=$1 AND is_current AND status='analyzed'
        ORDER BY created_at DESC LIMIT 40`, [app.id]);
    const client = await db.pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await require('../lib/underwriting/ai-cross-doc').analyzeFile(client, {
        applicationId: app.id, extractions: exts.rows,
        appMeta: { app_id: app.id, source: 'staff-triggered' },
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json(result);
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// Investor Knowledge Graph (R3.28) — per-file slice of the portfolio graph.
// -------------------------------------------------------------------------
router.get('/:appId/knowledge-graph', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const graph = await require('../lib/underwriting/knowledge-graph').fileGraph(app.id, db);
    res.json({ ok: true, graph });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// AI cost telemetry (R2.11, owner-directed 2026-07-22) — per-file rollup.
// -------------------------------------------------------------------------
/**
 * R4.1 — File-level AI risk score. Single 0–100 number that aggregates every
 * open ai_suggestion on the file:
 *   fatal   = 25 points each
 *   warning = 8
 *   info    = 2
 * capped at 100. Bucketed as low(<20), moderate(20-49), elevated(50-79),
 * critical(80+). Zero when the AI hasn't found anything. Pure count — no cost.
 * Composes with R3.40's pipeline chip: the chip signals COUNT, this signals
 * SEVERITY-WEIGHTED risk.
 */
/**
 * R4.6 — Bulk-dismiss every OPEN AI suggestion on this file. Admin-only.
 * Useful for a test file, a closed file, or a file where the team has already
 * eyeballed every suggestion outside the panel. Every dismissal goes through
 * ai-suggestions.decide() so the R3.42 auto-close-linked-admin-questions and
 * the ai_audit trail both fire per row. Body optional: { reason }.
 */
/**
 * R4.7 — Manual "Re-run AI checks" trigger. Runs every deterministic detector
 * (entity chain / seller chain / bank / bad-clearance / public-records /
 * identity chain) in one shot so an LO who just uploaded a doc can force a
 * re-check without waiting for the next file view render. Zero paid AI cost —
 * the crossdoc + committee AI calls stay behind their own explicit buttons.
 */
router.post('/:appId/ai-suggestions/rerun-checks', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const client = await db.pool.connect();
    const ran = { entity_chain: 0, bank: 0, bad_clearance: 0, public_records: 0, identity_chain: 0 };
    try {
      await client.query('BEGIN');
      // Fix 2026-07-23: same dead status='ok' filter — the "Re-run AI checks"
      // button fed every detector an EMPTY extraction set.
      const exts = await client.query(
        `SELECT doc_type, document_id, fields FROM document_extractions
          WHERE application_id=$1 AND is_current AND status='analyzed' ORDER BY created_at DESC LIMIT 60`, [app.id]);
      const mctx = await fileView.loadContext(client, app.id).catch(() => ({}));
      // Fix 2026-07-23 (#211): entity-chain and bank-statement-checks never
      // exported analyzeAndRecord — both arms were dead TypeErrors swallowed by
      // the per-bridge catch, so "Re-run AI checks" silently skipped them. Use
      // the REAL file-view pipeline: build the chains / liquidity, then sync
      // through the same suggestion bridges the file view uses.
      const requiredLiquidity = await readRequiredLiquidity(client, app.id).catch(() => null);
      const bridges = [
        ['entity_chain', () => {
          const a2 = (mctx && mctx.app) || {};
          const isEntity = !!((mctx && mctx.vestingName) || a2.llc_id ||
            exts.rows.some((e) => e.doc_type === 'operating_agreement'));
          const entityChain = isEntity ? buildChain(
            { vestingName: mctx && mctx.vestingName,
              borrowerName: fileView.borrowerName(mctx && mctx.borrower),
              program: (mctx.registration && mctx.registration.program) || a2.program || null },
            exts.rows) : null;
          const sellerChain = buildSellerChain(mctx || {}, exts.rows);
          if (!entityChain && !sellerChain) return { recorded: 0 };
          return require('../lib/underwriting/entity-chain-suggestions')
            .syncChainsToSuggestions(client, app.id, { entityChain, sellerChain });
        }],
        ['bank', () => {
          const bl = assessBankLiquidity(mctx || {}, exts.rows, { requiredLiquidity });
          const findings = (bl && bl.findings) || [];
          if (!findings.length) return { recorded: 0 };
          return require('../lib/underwriting/bank-statement-suggestions')
            .syncBankFindingsToSuggestions(client, app.id, null, findings);
        }],
        ['bad_clearance',   () => require('../lib/underwriting/bad-clearance').scanFile(client, app.id, { maxConditions: 15 })],
        ['public_records',  () => require('../lib/underwriting/public-records-crosscheck').analyzeAndRecord(client, { applicationId: app.id, fileCtx: { vestingName: mctx && mctx.vestingName }, extractions: exts.rows })],
        ['identity_chain',  () => require('../lib/underwriting/identity-chain').analyzeAndRecord(client, { applicationId: app.id, extractions: exts.rows })],
        // #199 — party collusion (independence-required parties sharing an identity)
        // + double-pledged collateral (this property on another live loan). Advisory.
        ['party_collusion', () => require('../lib/underwriting/party-collusion').analyzeAndRecord(client, { applicationId: app.id, extractions: exts.rows, fileCtx: { vestingName: mctx && mctx.vestingName } })],
        ['double_pledge',   () => require('../lib/underwriting/party-collusion').checkDoublePledgeAndRecord(client, { applicationId: app.id })],
      ];
      for (const [k, fn] of bridges) {
        // SAVEPOINT per bridge — one failure must never abort the shared tx and
        // silently no-op the remaining bridges (the poisoned-tx class).
        try {
          await client.query('SAVEPOINT rerun_bridge');
          const r = await fn();
          await client.query('RELEASE SAVEPOINT rerun_bridge');
          // bad-clearance reports {scanned, flagged}; the sync bridges {recorded}.
          ran[k] = (r && (r.recorded != null ? r.recorded : r.flagged)) || 0;
        } catch (_) { await client.query('ROLLBACK TO SAVEPOINT rerun_bridge').catch(() => {}); }
      }
      // R4.16 — stamp the file so the AI Findings panel can show a 'Last re-run' time.
      try {
        await client.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           VALUES ('staff',$1,'ai_checks_rerun','application',$2,$3::jsonb)`,
          [req.actor.id, app.id, JSON.stringify({ ran, at: new Date().toISOString() })]);
      } catch (_) { /* additive */ }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, ran });
  } catch (e) { next(e); }
});

router.post('/:appId/ai-suggestions/dismiss-all', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const reason = String((req.body && req.body.reason) || 'Bulk-dismissed from file view').slice(0, 200);
    const client = await db.pool.connect();
    let dismissed = 0;
    try {
      await client.query('BEGIN');
      const open = await client.query(
        `SELECT id FROM ai_suggestions
          WHERE application_id=$1
            AND status IN ('open','marked_important','escalated','asked_admin')
          LIMIT 500`, [app.id]);
      const aiSug = require('../lib/underwriting/ai-suggestions');
      for (const row of open.rows) {
        try {
          await aiSug.decide(client, row.id, { action: 'dismiss', reason, staffId: req.actor.id });
          dismissed += 1;
        } catch (_) { /* one bad row doesn't stop the batch */ }
      }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true, dismissed });
  } catch (e) { next(e); }
});

router.get('/:appId/ai-risk-score', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const r = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE severity='fatal')::int   AS fatal,
         COUNT(*) FILTER (WHERE severity='warning')::int AS warning,
         COUNT(*) FILTER (WHERE severity='info')::int    AS info,
         COUNT(*) FILTER (WHERE severity NOT IN ('fatal','warning','info') OR severity IS NULL)::int AS other,
         EXTRACT(EPOCH FROM (now() - MIN(created_at) FILTER (WHERE severity='fatal')))/86400 AS oldest_fatal_days
        FROM ai_suggestions
       WHERE application_id=$1
         AND status IN ('open','marked_important','escalated','asked_admin')`,
      [app.id]);
    const c = r.rows[0] || { fatal: 0, warning: 0, info: 0, other: 0 };
    const raw = (c.fatal * 25) + (c.warning * 8) + (c.info * 2) + (c.other * 4);
    const score = Math.min(100, raw);
    let bucket;
    if (score >= 80) bucket = 'critical';
    else if (score >= 50) bucket = 'elevated';
    else if (score >= 20) bucket = 'moderate';
    else bucket = 'low';
    // R4.19 — the single worst open finding, so the file view can print a
    // one-line triage summary. Worst = highest severity, then most recent.
    let topFinding = null;
    try {
      const t = await db.query(
        `SELECT title, severity, source
           FROM ai_suggestions
          WHERE application_id=$1
            AND status IN ('open','marked_important','escalated','asked_admin')
          ORDER BY CASE severity WHEN 'fatal' THEN 0 WHEN 'warning' THEN 1 WHEN 'info' THEN 2 ELSE 3 END,
                   created_at DESC
          LIMIT 1`, [app.id]);
      if (t.rows[0]) topFinding = { title: t.rows[0].title, severity: t.rows[0].severity, source: t.rows[0].source };
    } catch (_) { /* additive */ }
    res.json({
      ok: true, score, bucket,
      breakdown: { fatal: c.fatal || 0, warning: c.warning || 0, info: c.info || 0, other: c.other || 0 },
      oldestFatalDays: c.oldest_fatal_days != null ? Number(c.oldest_fatal_days) : null,
      topFinding,
    });
  } catch (e) { next(e); }
});

router.get('/:appId/ai-cost', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const costMeter = require('../lib/ai/cost-meter');
    const summary = await costMeter.fileSummary(app.id, db);
    // Also return the latest N events so the UI can render a mini-log.
    const events = (await db.query(
      `SELECT op_name, provider, model, tokens_total, cost_cents, duration_ms, ok, reason, created_at
         FROM ai_cost_events WHERE application_id=$1
         ORDER BY created_at DESC LIMIT 50`, [app.id])).rows;
    res.json({ ok: true, summary, events });
  } catch (e) { next(e); }
});

// R5.55/R5.56 — Underwriting memory: funded loans similar to THIS file + their
// aggregate stats (avg loan size, LTV, condition count, common investor). Read-
// only, deterministic; empty until there are similar funded files on record.
router.get('/:appId/similar-loans', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const memory = require('../lib/underwriting/underwriting-memory');
    const result = await memory.findSimilarFunded(db, app.id, {});
    res.json({ ok: true, memory: result });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// AI SUGGESTIONS — the file's non-autonomous "AI panel" backend (R3.5/R3.6).
// Owner hard rule (2026-07-22): the AI writes suggestions here — a human
// clicks Escalate / Add note / Convert to condition / Convert to task /
// Mark important / Dismiss / Ask super-admin.
// -------------------------------------------------------------------------
router.get('/:appId/ai-suggestions', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const aiSug = require('../lib/underwriting/ai-suggestions');
    const suggestions = await aiSug.listForFile(app.id, {
      status: req.query.status || undefined,
      source: req.query.source || undefined,
      includeDismissed: req.query.include_dismissed === '1',
      limit: Number(req.query.limit) || undefined,
    }, db);
    // R4.16 — expose the most recent AI checks re-run time so the panel header can
    // show "Last re-run: N minutes ago". Best-effort; absence is not an error.
    let lastRerunAt = null;
    try {
      const r = await db.pool.query(
        `SELECT max(created_at) AS at
           FROM audit_log
          WHERE action='ai_checks_rerun'
            AND entity_type='application'
            AND entity_id=$1`, [app.id]);
      lastRerunAt = (r.rows[0] && r.rows[0].at) || null;
    } catch (_) { /* additive */ }
    res.json({ ok: true, suggestions, lastRerunAt });
  } catch (e) { next(e); }
});

// Human decides on ONE suggestion. Action semantics live in ai-suggestions.decide().
// convert_to_condition takes an OPTIONAL templateCode: when provided the route also
// creates the checklist_items row + links it — a true "click to create the condition
// I proposed" one-shot. Otherwise the caller passes an already-created conditionId.
router.post('/:appId/ai-suggestions/:id/decide', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const aiSug = require('../lib/underwriting/ai-suggestions');
    const body = req.body || {};
    const action = String(body.action || '').toLowerCase();
    if (!action) return res.status(400).json({ error: 'action required' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      // Refuse to decide on someone else's file — the fileFor gate above already
      // scoped to a visible file, but the suggestion also has to belong to that app.
      const sc = await client.query(`SELECT application_id FROM ai_suggestions WHERE id=$1`, [req.params.id]);
      if (!sc.rows[0] || sc.rows[0].application_id !== app.id) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'suggestion not found on this file' }); }

      // Special path — "convert to condition" from a proposedAction can create
      // the checklist_items row in the same tx and link it back on the suggestion.
      let opts = { action, staffId: req.actor.id, reason: body.reason, note: body.note };
      if (action === 'convert_to_condition' && !body.conditionId) {
        const sug = (await client.query(`SELECT * FROM ai_suggestions WHERE id=$1`, [req.params.id])).rows[0];
        const pa = sug && sug.proposed_action || {};
        const tplCode = body.templateCode || pa.templateCode || pa.fields && pa.fields.opensCondition || null;
        if (!tplCode) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'templateCode required for convert_to_condition' }); }
        // Look up the template and create a checklist_items row on this file — mirrors the
        // pattern in src/lib/appraisal/desk.js / src/lib/vesting.js: pull every template
        // column, insert as a scope='application' row against this file.
        const tplQ = await client.query(
          `INSERT INTO checklist_items
             (template_id, scope, label, borrower_label, audience, item_kind, role_scope,
              phase, hint, borrower_hint, is_gate, is_milestone, sort_order, tool_key,
              clickup_field_id, tpr_exclude, created_by_kind, is_required, application_id,
              status, notes)
           SELECT t.id, t.scope, t.label, t.borrower_label, t.audience, t.item_kind,
                  COALESCE(t.role_scope,'any'), t.phase, t.hint, t.borrower_hint,
                  COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
                  COALESCE(t.sort_order,900), t.tool_key, t.clickup_field_id,
                  COALESCE(t.tpr_exclude,false), 'system', COALESCE(t.is_required,true), $1,
                  'issue', $3
             FROM checklist_templates t
            WHERE t.code = $2 AND t.scope = 'application'
            RETURNING id`,
          [app.id, tplCode, `[from AI suggestion] ${sug.title}`]);
        if (!tplQ.rows[0]) { await client.query('ROLLBACK'); return res.status(400).json({ error: `unknown template ${tplCode}` }); }
        opts.conditionId = tplQ.rows[0].id;
      }
      if (action === 'convert_to_task' && !body.taskId) {
        // Task id is the caller's responsibility (ClickUp id or internal); require it.
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'taskId required for convert_to_task' });
      }
      const r = await aiSug.decide(client, req.params.id, opts);
      await client.query('COMMIT');
      res.json({ ok: true, suggestion: r.row });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  } catch (e) { next(e); }
});

/**
 * Splitter action (R3.19). Turn a `splitter` suggestion into one child `documents`
 * row per segment, filed under a human-picked target condition. Body:
 *   { segments: [ { pages:[1,2,3], docType:'bank_statement', checklistItemId:'ci-uuid', slotLabel? } ] }
 * Preserves the ORIGINAL document bytes (each child points at the same storage_ref with
 * a slot_label naming the page range) — a follow-up will physically slice the PDF once
 * pdf-lib lands as a dep. Per HARD RULE the AI never files anything on its own; this route
 * only runs after a human clicks 'Split + File' on the AI Findings panel.
 */
router.post('/:appId/ai-suggestions/:id/split-and-file', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const sug = (await client.query(`SELECT * FROM ai_suggestions WHERE id=$1 AND application_id=$2`, [req.params.id, app.id])).rows[0];
      if (!sug) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'suggestion not found on this file' }); }
      if (sug.source !== 'splitter') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'not a splitter suggestion' }); }
      const src = sug.document_id ? (await client.query(`SELECT id, filename, content_type, storage_provider, storage_ref, size_bytes, borrower_id FROM documents WHERE id=$1`, [sug.document_id])).rows[0] : null;
      if (!src) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'source document not found' }); }
      const body = req.body || {};
      const segments = Array.isArray(body.segments) ? body.segments : [];
      if (!segments.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'segments[] required' }); }

      // R5.1 — load the SOURCE bytes once so each child can be physically sliced
      // to only its own pages. Best-effort: if the read fails we fall back to a
      // page-range record (page_bounded=false) rather than blocking the split.
      let srcBytes = null;
      try { srcBytes = await storage.read(src.storage_ref); }
      catch (_) { srcBytes = null; }
      const { slicePdfPages } = require('../lib/underwriting/pdf-slice');
      const crypto = require('crypto');

      const created = [];
      for (const seg of segments) {
        // Number.isInteger (not isFinite): a fractional page like 2.5 would pass
        // isFinite and then break the `page_range int[]` bind (Postgres rejects
        // '{2.5}'::int[]) → 500. The slicer re-normalizes anyway; keep parity here.
        const pages = Array.isArray(seg.pages) ? seg.pages.filter(Number.isInteger).sort((a, b) => a - b) : [];
        if (!pages.length || !seg.checklistItemId) continue;
        const slotLabel = String(seg.slotLabel || `${prettyType(seg.docType)} (pp ${pages.join(', ')} of ${src.filename})`).slice(0, 80);
        // Confirm the target checklist_item belongs to this file.
        const target = (await client.query(`SELECT id FROM checklist_items WHERE id=$1 AND application_id=$2`, [seg.checklistItemId, app.id])).rows[0];
        if (!target) continue;

        // R5.1 — physically slice the source PDF to exactly this child's pages,
        // store the sliced bytes as the child's OWN storage object, and point the
        // child there. A page-bounded child is safe to analyze in isolation; the
        // old behavior (child references the whole package) contaminated the read.
        let childRef = src.storage_ref, childProvider = src.storage_provider,
            childBytes = src.size_bytes, childSha = null, pageBounded = false,
            recordedPages = pages;
        if (srcBytes) {
          const sliced = await slicePdfPages(srcBytes, pages);
          if (sliced.ok && sliced.buf) {
            try {
              const saved = await storage.save(sliced.buf, { filename: `${(seg.docType || 'part')}.pdf` });
              childRef = saved.ref; childProvider = saved.provider; childBytes = saved.bytes;
              childSha = crypto.createHash('sha256').update(sliced.buf).digest('hex');
              pageBounded = true;
              // Record the pages ACTUALLY in the slice (out-of-range requests dropped).
              if (Array.isArray(sliced.pages) && sliced.pages.length) recordedPages = sliced.pages;
            } catch (_) { /* fall back to source ref below */ }
          }
        }
        const ins = await client.query(
          `INSERT INTO documents (application_id, checklist_item_id, borrower_id, filename, content_type,
                                  size_bytes, storage_provider, storage_ref,
                                  uploaded_by_kind, uploaded_by_id, slot_label, visibility,
                                  source_document_id, page_range, page_bounded, sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,'staff_only',$11,$12,$13,$14)
           RETURNING id`,
          [app.id, seg.checklistItemId, src.borrower_id, `${(seg.docType || 'part')}—${src.filename}`,
           (pageBounded ? 'application/pdf' : src.content_type), childBytes, childProvider, childRef,
           req.actor.id, slotLabel, src.id, recordedPages, pageBounded, childSha]);
        created.push({ id: ins.rows[0].id, checklistItemId: seg.checklistItemId, pages, pageBounded });
      }

      // Close the suggestion — dismiss with a note that names the resulting child docs.
      await require('../lib/underwriting/ai-suggestions').decide(client, req.params.id, {
        action: 'dismiss',
        reason: `Split into ${created.length} child document(s) via the splitter suggestion.`,
        staffId: req.actor.id,
      });
      await client.query('COMMIT');
      res.json({ ok: true, created });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  } catch (e) { next(e); }
});
function prettyType(t) {
  return ({ bank_statement: 'Bank statement', insurance: 'Insurance dec', operating_agreement: 'Operating agreement',
    drivers_license: 'ID', settlement: 'Settlement', purchase_contract: 'Purchase contract' }[t]) || String(t || 'Part');
}

router.post('/:appId/ai-suggestions/:id/note', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const aiSug = require('../lib/underwriting/ai-suggestions');
    // Same scope guard as decide.
    const sc = await db.query(`SELECT application_id FROM ai_suggestions WHERE id=$1`, [req.params.id]);
    if (!sc.rows[0] || sc.rows[0].application_id !== app.id) return res.status(404).json({ error: 'not found on this file' });
    await aiSug.addNote(db, req.params.id, { staffId: req.actor.id, text: String(req.body && req.body.text || '') });
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// #191 activation 1 — CLEARANCE PREVIEW (read-only, ADVISORY).
// "Would the documents on this condition clear it?" — runs the SAME
// deterministic cure analysis the extraction pipeline records proofs with
// (condition intent → cure.analyze per current document → clearance-outcome
// aggregation) but WRITES NOTHING: no proof row, no status change, no
// suggestion, no notification. Sign-off still goes ONLY through staff.js
// signOffGate — this endpoint is a preview beside that gate, never a way
// around it. First reader of checklist_items.intent_override (db/233).
// -------------------------------------------------------------------------
router.get('/:appId/checklist/:itemId/clearance-preview', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.itemId)) return res.status(404).json({ error: 'condition not found' });
    const itemQ = await db.query(
      `SELECT ci.id, ci.status, ci.intent_override,
              ct.code, COALESCE(ct.label, ct.code) AS label
         FROM checklist_items ci
         LEFT JOIN checklist_templates ct ON ct.id = ci.template_id
        WHERE ci.id = $1 AND ci.application_id = $2`, [req.params.itemId, app.id]);
    const item = itemQ.rows[0];
    if (!item) return res.status(404).json({ error: 'condition not found' });

    const cure = require('../lib/underwriting/cure');
    const twin = require('../lib/underwriting/twin');
    const preview = require('../lib/underwriting/clearance-preview');

    const intent = (item.intent_override && typeof item.intent_override === 'object')
      ? item.intent_override
      : (item.code ? await cure.intentForCode(item.code, db) : null);
    if (!intent) {
      return res.json({ ok: true, available: false, advisory: true,
        reason: 'This condition has no registered intent — the preview covers intent-backed conditions only.',
        item: { id: item.id, code: item.code, label: item.label, status: item.status } });
    }

    // The item's CURRENT analyzed documents (extraction status is 'analyzed' —
    // db/200). Audit F2: a staff-REJECTED document is a recorded human decision
    // — it must not feed a "would clear" preview (same filter signOffGate uses).
    const exts = await db.query(
      `SELECT de.document_id, de.doc_type, de.fields, d.filename
         FROM document_extractions de
         JOIN documents d ON d.id = de.document_id
        WHERE d.checklist_item_id = $1 AND d.is_current
          AND COALESCE(d.review_status, '') <> 'rejected'
          AND de.is_current AND de.status = 'analyzed'
        ORDER BY de.created_at DESC LIMIT 12`, [item.id]);

    const twinRows = await twin.factsForFile(app.id, db).catch(() => []);
    const twinFacts = Object.fromEntries((twinRows || []).map((r) => [r.fact_key, r]));
    const { subject, expected } = await cure.loadCureContext(app.id, db);

    const { documents, overall } = preview.previewDocuments({
      intent,
      documents: exts.rows.map((r) => ({ documentId: r.document_id, docType: r.doc_type, filename: r.filename, fields: r.fields })),
      twinFacts, subject, expected,
    });

    // Audit F1: signOffGate is per-SLOT on four template codes (staff.js
    // signOffGate is the AUTHORITY — this only mirrors its presence check so
    // the preview never says "would clear" while the gate still wants another
    // slot's document). Missing slots force overall.clears=false with the gap
    // named; the analysis sections above stay as-is.
    const SLOT_REQUIREMENTS = {
      rtl_cond_insurance: ['binder', 'invoice'],
      rtl_cond_appraisaldocs: ['xml', 'pdf'],
      rtl_cond_fraud: ['background'],           // + 'criminal' on a Gold file (below)
      rtl_cond_title: [],                        // any one document; presence handled by no_documents
    };
    if (Object.prototype.hasOwnProperty.call(SLOT_REQUIREMENTS, String(item.code))) {
      const required = [...SLOT_REQUIREMENTS[item.code]];
      if (item.code === 'rtl_cond_fraud') {
        const gp = await db.query(
          `SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [app.id]);
        if (gp.rows[0] && /gold/i.test(String(gp.rows[0].program || ''))) required.push('criminal');
      }
      const missingSlots = [];
      if (required.length) {
        const slotRows = await db.query(
          `SELECT lower(coalesce(slot_label,'')) AS slot FROM documents
            WHERE checklist_item_id=$1 AND is_current AND COALESCE(review_status,'') <> 'rejected'`, [item.id]);
        const have = slotRows.rows.map((r) => r.slot);
        for (const need of required) if (!have.some((s) => s.includes(need))) missingSlots.push(need);
      }
      // Appraisal docs: signOffGate additionally requires a non-superseded
      // appraisals row (the XML actually IMPORTED), not merely an uploaded file
      // slot — mirror that so the preview can't report "would clear" before the
      // import lands. Defense-in-depth: unreachable today (no seeded intent for
      // this code → available:false above), but a future intent-seed or a manual
      // intent_override would otherwise let the preview overstate clearance.
      if (item.code === 'rtl_cond_appraisaldocs') {
        const appr = await db.query(
          `SELECT 1 FROM appraisals WHERE application_id=$1 AND superseded=false LIMIT 1`, [app.id]);
        if (!appr.rows.length) missingSlots.push('imported appraisal (XML)');
      }
      if (missingSlots.length) {
        overall.clears = false;
        overall.slotsIncomplete = true;
        overall.missingSlots = missingSlots;
        overall.reason = `The sign-off gate also requires: ${missingSlots.join(', ')} — this condition needs every required document slot filled, not just one clearing document.`;
      }
    }
    res.json({
      ok: true, available: true, advisory: true,
      item: { id: item.id, code: item.code, label: item.label, status: item.status },
      intent: { code: item.code, version: intent.version || null, primaryGoal: intent.primary_goal || null },
      documents, overall,
    });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// R3.32 — Snooze/dismiss the fraud alert banner on a file. Snooze records an
// audit_log stamp with `until` (24h default); the /:appId view suppresses the
// banner (still shows the underlying suggestions in the panel) until the stamp
// expires. Dismiss is a permanent snooze the human can undo by dismissing the
// underlying suggestions.
// -------------------------------------------------------------------------
router.post('/:appId/fraud-banner/snooze', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const hours = Math.max(1, Math.min(168, Number((req.body && req.body.hours) || 24))); // 1h..7d
    const until = new Date(Date.now() + hours * 3600000).toISOString();
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,'fraud_banner_snoozed','application',$2,$3::jsonb)`,
      [req.actor.id, app.id, JSON.stringify({ until, hours, note: (req.body && req.body.note) || null })]);
    res.json({ ok: true, until });
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// File-wide "Ask super-admin" — a human on the file can hand the whole file
// (not a specific finding) to the super-admin as a question. Creates an
// ai_admin_question tied to this application; the super-admin's answer lands
// in the /internal/ai-inbox screen (R3.7). R3.25.
// -------------------------------------------------------------------------
router.post('/:appId/ask-admin', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ error: 'question required' });
    const aiSug = require('../lib/underwriting/ai-suggestions');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const r = await aiSug.askAdmin(client, {
        applicationId: app.id, agent: 'staff_request',
        question,
        context: { asked_by_staff_id: req.actor.id, at: new Date().toISOString() },
      });
      await client.query('COMMIT');
      res.json({ ok: true, ...r });
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  } catch (e) { next(e); }
});

// -------------------------------------------------------------------------
// AI-to-super-admin questions (R3.7). AI agents call ai-suggestions.askAdmin(...)
// which creates a suggestion (kind='question') AND an ai_admin_questions row.
// The super-admin answers here — the answer feeds learning + closes the suggestion.
// -------------------------------------------------------------------------
router.get('/ai-admin/questions', requirePermission('promote_training'), async (req, res, next) => {
  try {
    const aiSug = require('../lib/underwriting/ai-suggestions');
    const rows = await aiSug.listOpenAdminQuestions({ appId: req.query.appId || undefined,
      limit: Number(req.query.limit) || undefined }, db);
    // #200 — attach an SLA clock to each open question (how long it's waited, when
    // it's due, whether it's overdue) + a roll-up, and surface the most overdue
    // first. Advisory / read-only — computed from asked_at + the agent's SLA (no
    // schema change); an explicit decision_deadline wins when set.
    const aged = require('../lib/underwriting/admin-question-sla').ageQuestions(rows, {});
    aged.rows.sort((a, b) => (Number(b._sla && b._sla.overdue) - Number(a._sla && a._sla.overdue))
      || ((b._sla && b._sla.hoursOpen || 0) - (a._sla && a._sla.hoursOpen || 0)));
    res.json({ ok: true, questions: aged.rows, sla: aged.summary });
  } catch (e) { next(e); }
});
router.post('/ai-admin/questions/:id/answer', requirePermission('promote_training'), async (req, res, next) => {
  try {
    const aiSug = require('../lib/underwriting/ai-suggestions');
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await aiSug.answerAdminQuestion(client, req.params.id, {
        staffId: req.actor.id,
        answer: String((req.body && req.body.answer) || ''),
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// R2.9 — Expose the auto-read machinery so the scheduled sweep (notification-
// digests.autoReadSweepOnce) can drive the same pipeline the /:appId/auto-read
// button drives. Read-only exports: analyzeOneDocument, fileFor, buildAutoReadQueue.
// Reusing the exact same functions keeps the sweep from re-implementing (and
// drifting from) the paid-cooldown / idempotency / audit logic the route
// already gets right.
module.exports = router;
module.exports.analyzeOneDocument = analyzeOneDocument;
module.exports.buildAutoReadQueue = buildAutoReadQueue;
module.exports.fileForById = async function fileForById(appId) {
  const r = await db.query(
    `SELECT id, borrower_id, llc_id, status, deleted_at FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId]);
  return r.rows[0] || null;
};
module.exports.fileDocById = fileDoc;
module.exports.AUTOREAD_ENABLED = AUTOREAD_ENABLED;
module.exports.AUTOREAD_MAX_PER_CALL = AUTOREAD_MAX_PER_CALL;
