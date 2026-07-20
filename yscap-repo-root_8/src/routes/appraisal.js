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
const { runAppraisalImport, undoAppraisalImport } = require('../lib/appraisal/desk');
const { collateralScore, arvDefensibility, compImpliedValue } = require('../lib/appraisal/scoring');
const X = require('../lib/appraisal/xml');

// Upload cap: aligned to the per-file limit the JSON body-parser actually allows,
// so the decode cap can never exceed what express.json() accepts (no dead ceiling).
const MAX_UPLOAD_BYTES = Math.max(1, cfg.maxUploadMb) * 1024 * 1024;

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

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

async function audit(actorId, action, entityId, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('staff',$1,$2,'application',$3,$4)`,
      [actorId, action, entityId, JSON.stringify(detail || {})]);
  } catch (_) { /* audit is best-effort; never block the action */ }
}

// ---- GET: the stored appraisal for the file --------------------------------
router.get('/:appId', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const appr = (await db.query(
      `SELECT * FROM appraisals WHERE application_id=$1 AND superseded=false ORDER BY imported_at DESC LIMIT 1`,
      [app.id])).rows[0];
    if (!appr) return res.json({ appraisal: null, comparables: [], units: [], findings: [], photos: [], summary: { fatal: 0, warning: 0, info: 0, blocksCtc: false } });
    const [comps, units, findings, photos] = await Promise.all([
      db.query(`SELECT * FROM appraisal_comparables WHERE appraisal_id=$1 ORDER BY seq`, [appr.id]),
      db.query(`SELECT * FROM appraisal_units WHERE appraisal_id=$1 ORDER BY unit_seq`, [appr.id]),
      db.query(`SELECT * FROM appraisal_findings WHERE application_id=$1 AND status='open' ORDER BY (severity='fatal') DESC, created_at`, [app.id]),
      db.query(
        `SELECT ap.id, ap.document_id, ap.category, ap.caption, ap.sequence, ap.width, ap.height
           FROM appraisal_photos ap JOIN documents d ON d.id=ap.document_id
          WHERE ap.appraisal_id=$1 AND d.is_current AND ap.document_id IS NOT NULL
          ORDER BY ap.sequence`, [appr.id]),
    ]);
    const open = findings.rows;
    const summary = {
      fatal: open.filter((f) => f.severity === 'fatal').length,
      warning: open.filter((f) => f.severity === 'warning').length,
      info: open.filter((f) => f.severity === 'info').length,
      blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocks_ctc),
    };
    // Advisory PILOT reads, recomputed live (never stored/stale): the collateral score and the
    // ARV-defensibility cross-check against the file's rehab budget.
    const rehab = (await db.query(`SELECT rehab_budget FROM applications WHERE id=$1`, [app.id])).rows[0] || {};
    // Match findings.js isReno (which excludes condo 1073) so the card and the finding agree.
    const isReno = appr.form_type !== 'FNM1073' && (appr.arv_value != null || /subject|hypothetical|as.?repair|as.?complet/i.test(String(appr.condition_of_appraisal || '')));
    // The implied-value cross-check must run over ONE grid's comps — mixing As-Is and ARV comps
    // into a single median is the exact lumping the split exists to prevent. Use the operative
    // grid (ARV on a reno file, else As-Is). Pre-split appraisals (no comp_set) keep the old
    // all-comps behavior so their advisory read doesn't blank out.
    const gridKey = appr.arv_value != null ? 'arv' : 'as_is';
    const hasSplit = comps.rows.some((c) => c.comp_set);
    const impliedComps = hasSplit ? comps.rows.filter((c) => c.comp_set === gridKey) : comps.rows;
    const score = {
      collateral: collateralScore({ a: appr, comps: comps.rows, summary }),
      arv: arvDefensibility({ arv: appr.arv_value, asIs: appr.as_is_value, rehab: rehab.rehab_budget, isReno }),
      impliedValue: compImpliedValue({ comps: impliedComps, subjectGla: appr.gla }),
    };
    res.json({ appraisal: appr, comparables: comps.rows, units: units.rows, findings: open, photos: photos.rows, summary, score });
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
      else if (b.xml) {
        xml = String(b.xml);
        // Same ceiling as the base64 path — the raw-string branch must not be a larger door.
        if (Buffer.byteLength(xml, 'utf8') > MAX_UPLOAD_BYTES) { const err = new Error('the appraisal XML is too large'); err.status = 413; throw err; }
      }
      else { xml = null; }
    } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    if (!xml) return res.status(400).json({ error: 'the appraisal XML is required' });

    // Store the XML + (embedded or uploaded) PDF documents. Best-effort: a storage/DB
    // failure here must not lose the imported data, but we LOG it (a silent null doc-id
    // means the appraisal has no source document on file — worth surfacing).
    let xmlDocId = null, pdfDocId = null;
    // PDF base64 kept at function scope so the advisory OCR step (below) can read it.
    // embeddedPdfBase64 is pure regex, but guard it so nothing in this path can throw.
    let pdfB64 = null;
    try { pdfB64 = b.pdfBase64 || X.embeddedPdfBase64(xml); } catch (_) { pdfB64 = null; }
    try {
      const xbuf = Buffer.from(xml, 'utf8');
      const s = await storage.save(xbuf, { filename: b.filename || 'appraisal.xml' });
      // STAFF-ONLY: the source appraisal XML carries lender_name/amc_name/owner_of_record/
      // lender_address + the raw value & findings basis — the exact data safeAppr/SCRUTINY_CODES
      // scrub from the borrower. Without an explicit visibility it defaults to 'borrower' (db/014)
      // and the borrower could download the whole appraisal, bypassing the scrub. Force staff_only.
      xmlDocId = (await db.query(
        `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type)
         VALUES ($1,$2,$3,'application/xml',$4,$5,$6,'staff',$7,'appraisal_xml','staff_only','staff_upload') RETURNING id`,
        [app.id, app.borrower_id, b.filename || 'appraisal.xml', xbuf.length, s.provider, s.ref, req.actor.id])).rows[0].id;

      // PDF: use the uploaded slot if given, else the PDF embedded in the XML.
      if (pdfB64) {
        const { buf: pbuf } = decodeUploadBase64(pdfB64, { maxBytes: MAX_UPLOAD_BYTES });
        const ps = await storage.save(pbuf, { filename: (b.filename || 'appraisal').replace(/\.xml$/i, '') + '.pdf' });
        pdfDocId = (await db.query(
          `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type)
           VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'staff',$7,'appraisal_pdf','staff_only','staff_upload') RETURNING id`,
          [app.id, app.borrower_id, 'appraisal.pdf', pbuf.length, ps.provider, ps.ref, req.actor.id])).rows[0].id;
      }
    } catch (e) { console.error('[appraisal] document storage failed (import continues):', e && e.message); }

    // Shared desk flow: import + reconcile + materialize the two internal conditions +
    // fire the advisory OCR. Identical to the auto-import from the appraisal-docs condition.
    const out = await runAppraisalImport({
      appId: app.id, xml, importedBy: req.actor.id,
      xmlDocumentId: xmlDocId, pdfDocumentId: pdfDocId, pdfBase64: pdfB64,
    });
    if (!out.ok) return res.status(422).json({ error: out.error });

    await audit(req.actor.id, 'appraisal_import', app.id,
      { appraisalId: out.appraisalId, findings: out.summary, warnings: (out.warnings || []).map((w) => w.code) });

    // Milestone → borrower (owner-directed 2026-07-20): the appraisal report has
    // arrived. Borrower-safe — it says the appraisal was RECEIVED and is under
    // review; it NEVER exposes the appraised value, condition, or any finding.
    // Gated to once per file per ~day so a re-import doesn't re-notify.
    try {
      if (app.borrower_id) {
        // Atomically CLAIM the ~day slot (stamp-first) so a double/re-import in the
        // same instant can't send the milestone twice.
        const claim = await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           SELECT 'system', NULL, 'appraisal_received_emailed', 'application', $1, '{}'::jsonb
            WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE action='appraisal_received_emailed' AND entity_id=$1 AND created_at > now() - interval '20 hours')
           RETURNING id`, [app.id]);
        if (claim.rows[0]) {
          await require('../lib/notify').notifyAppBorrowers(app.id, {
            type: 'milestone',
            title: 'Your property appraisal has been received',
            badge: { text: 'Milestone', tone: 'teal' },
            body: 'Good news — the appraisal report for your property has come in and is now with your loan team for review.',
            lines: ['There\'s nothing you need to do right now. If anything from the appraisal needs your attention, we\'ll reach out.'],
            applicationId: app.id, link: `/app/${app.id}`, ctaLabel: 'View your file' });
        }
      }
    } catch (_) { /* milestone email is best-effort */ }

    res.json({ ok: true, appraisalId: out.appraisalId, summary: out.summary, needsAsIsCondition: out.needsAsIsCondition, warnings: out.warnings });
  } catch (e) { next(e); }
});

// ---- POST /:appId/undo-import ----------------------------------------------
// Undo the current appraisal import (owner-directed 2026-07-20): the wrong
// appraisal was uploaded and must be removed before a replacement exists. Clears
// the findings + imported appraisal data, restores the file fields the import
// changed, and resets the two internal conditions + the source documents so the
// appraisal-documents condition is ready for a fresh upload. Gated like a
// sign-off (processor / underwriter / admin) since it discards review data.
router.post('/:appId/undo-import', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    // #84 — undoing an import reverts the loan's economics (arv / as-is / price /
    // units / type) back to their pre-appraisal values, so it is frozen on a
    // clear-to-close / funded file (a super_admin can unlock to correct it).
    const lock = await require('../lib/file-lock').structuralLockReason(app.id, db, { actor: req.actor });
    if (lock) return res.status(409).json({ error: lock, locked: true });
    const out = await undoAppraisalImport(app.id, { actor: req.actor.id });
    if (!out.ok) return res.status(400).json({ error: out.error });
    await audit(req.actor.id, 'appraisal_import_undone', app.id, { removedAppraisalId: out.removedAppraisalId });
    res.json({ ok: true, removedAppraisalId: out.removedAppraisalId });
  } catch (e) { next(e); }
});

// ---- POST /:appId/photos/refresh -------------------------------------------
// Re-pull the property photos for the current appraisal from its stored PDF (embedded in the XML
// or the uploaded PDF slot), on demand. For files imported before the photo feature, or where the
// PDF arrived after the XML. Best-effort; returns how many photos were stored.
router.post('/:appId/photos/refresh', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const stored = await require('../lib/appraisal/desk').repullAppraisalPhotos(app.id);
    try { await audit(req.actor.id, 'appraisal_photos_refresh', app.id, { stored }); } catch (_) { /* audit best-effort */ }
    res.json({ ok: true, stored });
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

    let repriced = false, newValue = null, col = null;
    if (action === 'replace' || action === 'custom') {
      col = fnd.field;
      if (!Object.prototype.hasOwnProperty.call(REPRICE_COLS, col)) {
        return res.status(400).json({ error: `this finding's field (${col}) cannot be written back automatically — use keep/dismiss or edit the file` });
      }
      const raw = action === 'replace' ? fnd.appraisal_value : b.value;
      const kind = REPRICE_COLS[col];
      if (kind === 'numeric') { newValue = Number(String(raw).replace(/[,$]/g, '')); if (!Number.isFinite(newValue) || newValue <= 0) return res.status(400).json({ error: 'a positive number is required' }); }
      else if (kind === 'int') { newValue = parseInt(String(raw).replace(/\D/g, ''), 10); if (!Number.isInteger(newValue)) return res.status(400).json({ error: 'a whole number is required' }); }
      else { newValue = String(raw || '').trim(); if (!newValue) return res.status(400).json({ error: 'a value is required' }); }
      // #84 — repricing off a finding rewrites the loan's economics (arv / as-is /
      // price / units / type), so it is frozen on a clear-to-close / funded file
      // (a super_admin can unlock to correct it). Non-reprice resolutions
      // (keep / dismiss / acknowledge) are unaffected — they don't change the loan.
      // The actual reprice write happens in the atomic transaction below (#429).
      const lock = await require('../lib/file-lock').structuralLockReason(app.id, db, { actor: req.actor });
      if (lock) return res.status(409).json({ error: lock, locked: true });
      repriced = true;
    }

    // Apply the file reprice (if any) AND the finding resolution ATOMICALLY. Previously these were
    // two independent writes: a failure between them left the loan file's value permanently changed
    // (reprice trigger already fired) while the finding stayed open and re-appliable — a divergent,
    // double-appliable state. One transaction (mirrors undoAppraisalImport) makes it all-or-nothing.
    let beforeVal = null;
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      if (repriced) {
        const before = (await client.query(`SELECT ${col} AS v FROM applications WHERE id=$1`, [app.id])).rows[0];
        beforeVal = before && before.v;
        // Parameterized value; column is from the REPRICE_COLS whitelist above (never user input).
        await client.query(`UPDATE applications SET ${col}=$2, updated_at=now() WHERE id=$1`, [app.id, newValue]);
      }
      await client.query(
        `UPDATE appraisal_findings SET status=$3, resolution=$4, resolution_value=$5, resolution_note=$6, resolved_by=$7, resolved_at=now()
         WHERE id=$1 AND application_id=$2`,
        [fnd.id, app.id, action === 'dismiss' ? 'dismissed' : 'resolved', action,
         newValue != null ? String(newValue) : null, (b.note || '').slice(0, 2000), req.actor.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return next(e);
    }
    client.release();

    // Audit only after the commit actually succeeded (never record a reprice that rolled back).
    if (repriced) {
      await audit(req.actor.id, 'appraisal_finding_apply', app.id,
        { finding: fnd.code, field: col, from: beforeVal, to: newValue, source: action });
    } else {
      await audit(req.actor.id, 'appraisal_finding_resolve', app.id, { finding: fnd.code, action, note: (b.note || '').slice(0, 300) });
    }

    // Remaining open fatal findings gate the review-cleared condition.
    const openFatal = (await db.query(
      `SELECT count(*)::int n FROM appraisal_findings WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [app.id])).rows[0].n;

    res.json({ ok: true, repriced, openFatal, blocksCtc: openFatal > 0 });
  } catch (e) { next(e); }
});

module.exports = router;
