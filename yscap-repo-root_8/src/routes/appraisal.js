'use strict';
/**
 * Appraisal desk (staff). Mounted at /api/appraisal.
 *
 *   GET  /:appId                         -> current appraisal + comps + units + open findings
 *   POST /:appId/import                  -> import an appraisal XML (+ optional PDF slot); the
 *                                           XML is parsed and reconciled against the file, the
 *                                           embedded PDF is stored, and the two internal
 *                                           conditions are materialized. Never overwrites the
 *                                           loan file (the shield in lib/appraisal/import).
 *   POST /:appId/findings/:fid/resolve   -> underwriter action on one PILOT finding
 *                                           (replace|keep|custom|dismiss|decline|acknowledge|
 *                                            grant_exception|request_revision). A value change
 *                                            is written to applications (audited) which trips the
 *                                            existing pricing-reopen trigger -> re-price.
 *
 * Staff-only; non-see-all staff are scoped to their assigned files. Every value change is
 * audited. Nothing here is auto-applied — resolving a finding is an explicit human action.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const cfg = require('../config');
const { requireAuth, requireStaff, requirePermission } = require('../auth');
const { can, assigneeExistsSql } = require('../lib/permissions');
const storage = require('../lib/storage');
const { decodeUploadBase64 } = require('../lib/upload-bytes');
const { importAppraisal } = require('../lib/appraisal/import');
const { ocrAsIsCandidate, buildOcrNote } = require('../lib/appraisal/ocr');
const X = require('../lib/appraisal/xml');

// Upload cap: aligned to the per-file limit the JSON body-parser actually allows,
// so the decode cap can never exceed what express.json() accepts (no dead ceiling).
const MAX_UPLOAD_BYTES = Math.max(1, cfg.maxUploadMb) * 1024 * 1024;

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

router.use(requireAuth, requireStaff);

// Today's date as a 'YYYY-MM-DD' string from the DB (NY) — never new Date() in a date path.
async function today() {
  try { return (await db.query(`SELECT to_char(now() AT TIME ZONE 'America/New_York','YYYY-MM-DD') d`)).rows[0].d; }
  catch (_) { return null; }
}

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

async function audit(actorId, action, entityId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,$2,'application',$3,$4)`,
      [actorId, action, entityId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort; never block the action */ }
}

// Materialize an internal condition from its template (auto_apply='manual' templates don't
// self-attach). Mirrors src/lib/vesting.js ensureLlcCondition — items reference the template
// by template_id, and the guard dedups on template_id. Idempotent.
async function ensureCondition(appId, code) {
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
      WHERE t.code=$2 AND t.is_active=true
        AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.application_id=$1 AND ci.template_id=t.id)`,
    [appId, code]);
}

// ---- GET: the stored appraisal for the file --------------------------------
router.get('/:appId', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const appr = (await db.query(
      `SELECT * FROM appraisals WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC LIMIT 1`,
      [app.id])).rows[0];
    if (!appr) return res.json({ appraisal: null, comparables: [], units: [], findings: [], summary: { fatal: 0, warning: 0, info: 0, blocksCtc: false } });
    const [comps, units, findings] = await Promise.all([
      db.query(`SELECT * FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY seq`, [appr.id]),
      db.query(`SELECT * FROM appraisal_units WHERE appraisal_id=$1 ORDER BY unit_seq`, [appr.id]),
      db.query(`SELECT * FROM appraisal_findings WHERE application_id=$1 AND status='open' ORDER BY (severity='fatal') DESC, created_at`, [app.id]),
    ]);
    const open = findings.rows;
    res.json({
      appraisal: appr, comparables: comps.rows, units: units.rows, findings: open,
      summary: {
        fatal: open.filter((f) => f.severity === 'fatal').length,
        warning: open.filter((f) => f.severity === 'warning').length,
        info: open.filter((f) => f.severity === 'info').length,
        blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocks_ctc),
      },
    });
  } catch (e) { next(e); }
});

// ---- POST /import ----------------------------------------------------------
router.post('/:appId/import', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const b = req.body || {};
    // decodeUploadBase64 returns { buf, sha256 } — destructure the Buffer (not the object).
    let xml;
    try {
      if (b.xmlBase64) { const { buf } = decodeUploadBase64(b.xmlBase64, { maxBytes: MAX_UPLOAD_BYTES }); xml = buf.toString('utf8'); }
      else if (b.xml) { xml = String(b.xml); }
      else { xml = null; }
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (!xml) return res.status(400).json({ error: 'the appraisal XML is required' });

    // Store the XML + (embedded or uploaded) PDF documents. Best-effort: a storage/DB
    // failure here must not lose the imported data, but we LOG it (a silent null doc-id
    // means the appraisal has no source document on file — worth surfacing).
    let xmlDocId = null, pdfDocId = null;
    // PDF base64 kept at function scope so the advisory OCR step (below) can read it.
    const pdfB64 = b.pdfBase64 || X.embeddedPdfBase64(xml);
    try {
      const xbuf = Buffer.from(xml, 'utf8');
      const s = await storage.save(xbuf, { filename: b.filename || 'appraisal.xml' });
      xmlDocId = (await db.query(
        `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
         VALUES ($1,$2,$3,'application/xml',$4,$5,$6,'staff',$7,'appraisal_xml') RETURNING id`,
        [app.id, app.borrower_id, b.filename || 'appraisal.xml', xbuf.length, s.provider, s.ref, req.actor.id])).rows[0].id;

      // PDF: use the uploaded slot if given, else the PDF embedded in the XML.
      if (pdfB64) {
        const { buf: pbuf } = decodeUploadBase64(pdfB64, { maxBytes: MAX_UPLOAD_BYTES });
        const ps = await storage.save(pbuf, { filename: (b.filename || 'appraisal').replace(/\.xml$/i, '') + '.pdf' });
        pdfDocId = (await db.query(
          `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
           VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'staff',$7,'appraisal_pdf') RETURNING id`,
          [app.id, app.borrower_id, 'appraisal.pdf', pbuf.length, ps.provider, ps.ref, req.actor.id])).rows[0].id;
      }
    } catch (e) { console.error('[appraisal] document storage failed (import continues):', e && e.message); }

    const out = await importAppraisal(db, {
      applicationId: app.id, xml, importedBy: req.actor.id,
      sourceXmlDocumentId: xmlDocId, pdfDocumentId: pdfDocId, today: await today(),
    });
    if (!out.ok) return res.status(422).json({ error: out.error });

    // Materialize the review gate; open the verify-As-Is task only when needed.
    await ensureCondition(app.id, 'appraisal_review_cleared');
    if (out.needsAsIsCondition) {
      await ensureCondition(app.id, 'appraisal_as_is_verify');
      // Advisory only: try to READ a candidate As-Is off the PDF and attach it to the
      // verify task as a note. NEVER written to the loan file — the officer confirms by
      // hand. Fully best-effort so it can never break the import; audited either way.
      try {
        const adv = await ocrAsIsCandidate({ pdfBase64: pdfB64 });
        await db.query(
          `UPDATE checklist_items ci SET notes = $2
             FROM checklist_templates t
            WHERE ci.template_id = t.id AND t.code = 'appraisal_as_is_verify' AND ci.application_id = $1`,
          [app.id, buildOcrNote(adv)]);
        await audit(req.actor.id, 'appraisal_ocr_advisory', app.id,
          { attempted: !!adv.attempted, candidate: adv.candidate != null ? adv.candidate : null, confidence: adv.confidence || null });
      } catch (e) { console.error('[appraisal] OCR advisory failed (non-fatal):', e && e.message); }
    }
    await audit(req.actor.id, 'appraisal_import', app.id,
      { appraisalId: out.appraisalId, findings: out.summary, warnings: (out.warnings || []).map((w) => w.code) });

    res.json({ ok: true, appraisalId: out.appraisalId, summary: out.summary, needsAsIsCondition: out.needsAsIsCondition, warnings: out.warnings });
  } catch (e) { next(e); }
});

// ---- POST /findings/:fid/resolve -------------------------------------------
// Fields a "replace"/"custom" may write to the loan file (each trips the reprice trigger).
const REPRICE_COLS = { arv: 'numeric', as_is_value: 'numeric', purchase_price: 'numeric', units: 'int', property_type: 'text' };
const ACTIONS = new Set(['replace', 'keep', 'custom', 'dismiss', 'decline', 'acknowledge', 'grant_exception', 'request_revision']);

// Resolving a PILOT finding can rewrite a reprice-affecting value on the loan file and
// gates clear-to-close — an underwriter/processor action. Loan officers (review_conditions
// only, not sign_off_conditions) may SEE findings via GET but never act on them; the
// borrower view is read-only. Mirrors every other money-affecting write (sitewire → a
// capability gate). super_admin/admin/underwriter/processor carry sign_off_conditions.
router.post('/:appId/findings/:fid/resolve', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    if (!isUuid(req.params.fid)) return res.status(404).json({ error: 'finding not found' });
    const b = req.body || {};
    const action = String(b.action || '');
    if (!ACTIONS.has(action)) return res.status(400).json({ error: 'unknown action' });

    const fnd = (await db.query(
      `SELECT * FROM appraisal_findings WHERE id=$1 AND application_id=$2 AND status='open'`,
      [req.params.fid, app.id])).rows[0];
    if (!fnd) return res.status(404).json({ error: 'finding not found or already resolved' });

    let repriced = false, newValue = null;
    if (action === 'replace' || action === 'custom') {
      const col = fnd.field;
      if (!Object.prototype.hasOwnProperty.call(REPRICE_COLS, col)) {
        return res.status(400).json({ error: `this finding's field (${col}) cannot be written back automatically — use keep/dismiss or edit the file` });
      }
      const raw = action === 'replace' ? fnd.appraisal_value : b.value;
      const kind = REPRICE_COLS[col];
      if (kind === 'numeric') { newValue = Number(String(raw).replace(/[,$]/g, '')); if (!Number.isFinite(newValue) || newValue <= 0) return res.status(400).json({ error: 'a positive number is required' }); }
      else if (kind === 'int') { newValue = parseInt(String(raw).replace(/\D/g, ''), 10); if (!Number.isInteger(newValue)) return res.status(400).json({ error: 'a whole number is required' }); }
      else { newValue = String(raw || '').trim(); if (!newValue) return res.status(400).json({ error: 'a value is required' }); }
      const before = (await db.query(`SELECT ${col} AS v FROM applications WHERE id=$1`, [app.id])).rows[0];
      // Parameterized value; column is from the whitelist above (never user input).
      await db.query(`UPDATE applications SET ${col}=$2, updated_at=now() WHERE id=$1`, [app.id, newValue]);
      repriced = true;
      await audit(req.actor.id, 'appraisal_finding_apply', app.id,
        { finding: fnd.code, field: col, from: before && before.v, to: newValue, source: action });
    }

    await db.query(
      `UPDATE appraisal_findings SET status=$3, resolution=$4, resolution_value=$5, resolution_note=$6, resolved_by=$7, resolved_at=now()
       WHERE id=$1 AND application_id=$2`,
      [fnd.id, app.id, action === 'dismiss' ? 'dismissed' : 'resolved', action,
       newValue != null ? String(newValue) : null, (b.note || '').slice(0, 2000), req.actor.id]);
    if (!repriced) await audit(req.actor.id, 'appraisal_finding_resolve', app.id, { finding: fnd.code, action, note: (b.note || '').slice(0, 300) });

    // Remaining open fatal findings gate the review-cleared condition.
    const openFatal = (await db.query(
      `SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [app.id])).rows[0].n;

    res.json({ ok: true, repriced, openFatal, blocksCtc: openFatal > 0 });
  } catch (e) { next(e); }
});

module.exports = router;
