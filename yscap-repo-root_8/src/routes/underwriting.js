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
              COALESCE(t.label, t.code) AS condition_label
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
        conditionLabel: d.condition_label || null, docKind: d.doc_kind || null, expectedType, analyzed };
      documentsOnFile.push(row);
      // Anything present, not yet read, AND that maps to a type the reader can actually read is the
      // auto-read queue. The registry.get gate MUST match the /auto-read endpoint's selectAutoReadQueue
      // (isReadable), or the count here would include a type the reader skips (e.g. a document under
      // the appraisal-documents condition → 'appraisal', which the appraisal desk owns, not this
      // reader) and the desk's "read them all" button would never clear a stuck count.
      if (!analyzed && expectedType && registry.get(expectedType)) autoReadQueue.push(row);
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

    res.json({
      escalatedFindings: escalatedByFinding,
      verdict,
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
    `SELECT id, application_id, borrower_id, filename, content_type, storage_provider, storage_ref, sha256
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
        }
      } catch (_) { /* authenticity is additive */ }
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }

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
      `SELECT d.id, d.filename, d.doc_kind, t.code AS condition_code
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
        `SELECT id, document_id, borrower_id, code, severity, field, title, how_to, doc_value, file_value, suggested_actions
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

module.exports = router;
