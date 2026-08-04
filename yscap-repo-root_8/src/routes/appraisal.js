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
const apprSubject = require('../lib/appraisal/finding-subject');

/**
 * THE APPRAISAL FINDINGS THE *DOCUMENT* DESK COMPUTES (owner-directed 2026-08-02).
 *
 * The Appraisal page must show EVERY appraisal finding, not only the ones in `appraisal_findings`.
 * Two producers live on the document side and read the appraisal as their evidence:
 *   • stored `document_findings` rows whose source is an appraisal source (today: the AVM-consensus
 *     panel's "AVM consensus disagrees with the appraisal ARV"). These carry a real id, so they are
 *     RESOLVABLE — from here, through the document desk's own resolve endpoint;
 *   • tie-out discrepancies whose only disagreeing document is the appraisal. These are DERIVED
 *     (no row to resolve) and clear when the underlying values agree — shown read-only, and
 *     deliberately NOT counted by the sign-off gate, or a file could be stuck behind a card with
 *     no button on it.
 * The predicate is the shared one (`finding-subject`), so this list and the document desk's
 * exclusion are the same decision made once.
 *
 * Best-effort by construction: any failure returns an empty list — the appraisal tab must render.
 */
async function deskAppraisalFindings(appId) {
  const out = [];
  try {
    const rows = await db.query(
      `SELECT id, source, code, severity, field, doc_value, file_value, title, how_to, blocks_ctc,
              suggested_actions, page_number, document_id
         FROM document_findings
        WHERE application_id=$1 AND COALESCE(status,'open')='open' AND source = ANY($2::text[])
        ORDER BY (severity='fatal') DESC, created_at`,
      [appId, apprSubject.APPRAISAL_SOURCE_LIST]);
    for (const r of rows.rows) {
      out.push({
        id: r.id, origin: 'document_desk', resolvable: true,
        source: r.source, code: r.code, severity: r.severity || 'warning', field: r.field,
        appraisal_value: r.doc_value, file_value: r.file_value,
        title: r.title, how_to: r.how_to,
        blocks_ctc: r.blocks_ctc === true, status: 'open',
        document_id: r.document_id || null,
      });
    }
  } catch (e) { console.error('[appraisal] desk findings (stored) failed:', e && e.message); }

  try {
    const { tieoutForFile } = require('../lib/underwriting/file-review');
    const tie = await tieoutForFile(db, appId);
    const derived = apprSubject.split(tie.discrepancies || []).appraisal;
    // A finding a human already settled anywhere (this page, the document desk, the escalation
    // queue) must not come back on a derived list — same durable ledger the document desk reads.
    // FAILS OPEN: an unreadable ledger shows the finding, never hides one.
    let keep = derived;
    try {
      const fdec = require('../lib/underwriting/finding-decisions');
      const settled = await fdec.suppressedKeys(db, appId);
      keep = fdec.filterSuppressed(settled, derived).kept;
    } catch (_) { keep = derived; }
    for (const f of keep) {
      out.push({
        id: null, origin: 'tie_out', resolvable: false,
        source: f.source, code: f.code, severity: f.severity || 'info', field: f.field,
        appraisal_value: f.docValue != null ? f.docValue : f.doc_value,
        file_value: f.fileValue != null ? f.fileValue : f.file_value,
        title: f.title, how_to: f.howTo != null ? f.howTo : f.how_to,
        // A derived row is advisory here: it has no resolve button, so it must never gate.
        blocks_ctc: false, status: 'open',
      });
    }
  } catch (e) { console.error('[appraisal] desk findings (tie-out) failed:', e && e.message); }
  return out;
}

/**
 * THE APPRAISAL'S OWN DATA COMPARISON — appraisal value vs loan-file value, fact by fact
 * (owner-directed 2026-08-02: "the data-comparison table should still show the data comparison of
 * the appraisal even if the flag is already raised on the appraisal findings screen … the file ARV
 * and the appraisal ARV, the file as-is and the appraisal as-is, the property type, the unit count,
 * the address and everything").
 *
 * Two separate things, and they must not be confused: a FINDING is the flag raised once, to be
 * answered once; the COMPARISON is the standing side-by-side an underwriter reads. Suppressing the
 * duplicate FINDING (so the appraisal's disagreements live on one page) must never remove the
 * appraisal from the comparison — so the tie-out MATRIX has always kept every appraisal cell, and
 * this lifts that column out onto the Appraisal page itself, next to the report it describes.
 *
 * Reuses `tieoutForFile` — the SAME engine the document desk's matrix renders — so the two screens
 * can never state different things about the same fact. Every fact the appraisal can carry is
 * listed, including the ones that AGREE and the ones neither side has, because "these match" is
 * exactly what a reviewer is looking for. Best-effort: a failure returns null and the tab renders.
 */
async function appraisalComparison(appId) {
  try {
    const { tieoutForFile } = require('../lib/underwriting/file-review');
    const tie = await tieoutForFile(db, appId);
    const rows = [];
    for (const m of (tie.matrix || [])) {
      const cells = m.cells || [];
      const file = cells.find((c) => c.source === 'file');
      const appr = cells.find((c) => c.source === 'appraisal');
      // A fact the appraisal is not expected to carry at all ('na') is not part of this comparison.
      if (!appr || appr.status === 'na') continue;
      rows.push({
        key: m.key, label: m.label, category: m.category,
        appraisalValue: appr.value == null ? null : appr.value,
        fileValue: file && file.value != null ? file.value : null,
        // agree | disagree | missing (the appraisal is silent) | noref (nothing to compare against)
        status: appr.status,
      });
    }
    const disagree = rows.filter((r) => r.status === 'disagree').length;
    return { rows, summary: { facts: rows.length, disagree, agree: rows.filter((r) => r.status === 'agree').length } };
  } catch (e) {
    console.error('[appraisal] comparison failed:', e && e.message);
    return null;
  }
}

// Upload cap: aligned to the per-file limit the JSON body-parser actually allows,
// so the decode cap can never exceed what express.json() accepts (no dead ceiling).
const MAX_UPLOAD_BYTES = Math.max(1, cfg.maxUploadMb) * 1024 * 1024;

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

router.use(requireAuth, requireStaff);

// Authorization: the file must exist AND the staffer must see it (see_all or assigned).
async function fileFor(req, appId) {
  if (!isUuid(appId)) return null;
  // `loan_type` rides along because the reprice door has to know whether this
  // file even HAS a purchase price to write back to (2026-08-02) — a refinance
  // is sized on the as-is value and carries none.
  if (can(req.actor, 'see_all_files')) {
    return (await db.query(`SELECT id, borrower_id, loan_type FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0] || null;
  }
  return (await db.query(
    `SELECT a.id, a.borrower_id, a.loan_type FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${assigneeExistsSql('a', '$2')}`,
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
    if (!appr) return res.json({ appraisal: null, comparables: [], units: [], findings: [], photos: [], summary: { fatal: 0, warning: 0, info: 0, blocksCtc: false, open: 0 } });
    // "Property type" must answer what the property IS, not whether the building touches its
    // neighbour (owner-reported 2026-08-02). db/405 + the importer store the real category going
    // forward; this re-derives it for any row the boot repair has not reached yet, and moves the
    // Detached / Attached style into its own field instead of dropping it.
    require('../lib/appraisal/property-category').applyPropertyType(appr);
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
    // ONE list: the appraisal desk's own findings PLUS the appraisal findings the document desk
    // computes (owner-directed 2026-08-02). The desk's own rows come first — they are the
    // appraisal-vs-file comparison and carry the write-back actions.
    const open = findings.rows.concat(await deskAppraisalFindings(app.id));
    const summary = {
      fatal: open.filter((f) => f.severity === 'fatal').length,
      warning: open.filter((f) => f.severity === 'warning').length,
      info: open.filter((f) => f.severity === 'info').length,
      blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocks_ctc),
      // EVERY open finding, whatever its severity — the appraisal review can't be signed off until
      // each one has been resolved (owner-directed: "appraisal findings should need to be resolved
      // before you clear the appraisal review condition"), so the tab shows the number the gate
      // actually uses. `resolvable` counts only the ones that HAVE a button; a derived tie-out row
      // is advisory and never holds the sign-off.
      open: open.length,
      openResolvable: open.filter((f) => f.resolvable !== false).length,
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
    // WHAT KIND OF BUILDING EACH COMPARABLE IS, AND HOW MANY DOORS. A MISMO
    // sales grid has no element for either, so the table cannot answer it and
    // the column was simply absent — on the one screen where an underwriter
    // reviews the appraiser's own comps. The warehouse answers it (this report's
    // own reading first, then what every other report says about that address);
    // see `research/comp-identity`.
    const comparables = await require('../lib/research/comp-identity')
      .attachCompIdentity(comps.rows, { db, appraisal: appr });
    res.json({ appraisal: appr, comparables, units: units.rows, findings: open, photos: photos.rows, summary, score,
      // The standing appraisal-vs-file side-by-side. Independent of the findings above: a fact stays
      // in this table whether or not a finding was ever raised on it, and whether or not that finding
      // has been answered.
      comparison: await appraisalComparison(app.id) });
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
      // review_status='accepted': these are SYSTEM/staff source docs, not human submissions to vet —
      // without it they default to 'pending' (db/013) and show a stray "Accept" button on the staff
      // Documents list (same class as the appraisal-photo fix, db/186). source_type stays
      // 'staff_upload' so the staff "Replace" action remains available on the source files.
      xmlDocId = (await db.query(
        `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type,review_status,reviewed_at)
         VALUES ($1,$2,$3,'application/xml',$4,$5,$6,'staff',$7,'appraisal_xml','staff_only','staff_upload','accepted',now()) RETURNING id`,
        [app.id, app.borrower_id, b.filename || 'appraisal.xml', xbuf.length, s.provider, s.ref, req.actor.id])).rows[0].id;

      // PDF: use the uploaded slot if given, else the PDF embedded in the XML.
      if (pdfB64) {
        const { buf: pbuf } = decodeUploadBase64(pdfB64, { maxBytes: MAX_UPLOAD_BYTES });
        const ps = await storage.save(pbuf, { filename: (b.filename || 'appraisal').replace(/\.xml$/i, '') + '.pdf' });
        pdfDocId = (await db.query(
          `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,visibility,source_type,review_status,reviewed_at)
           VALUES ($1,$2,$3,'application/pdf',$4,$5,$6,'staff',$7,'appraisal_pdf','staff_only','staff_upload','accepted',now()) RETURNING id`,
          [app.id, app.borrower_id, 'appraisal.pdf', pbuf.length, ps.provider, ps.ref, req.actor.id])).rows[0].id;
      }
      // Retire the PRIOR current source docs ONLY NOW — after the fresh ones are safely stored —
      // excluding the just-inserted ids. A re-import must not leave two 'current' appraisal_xml/pdf
      // side by side (duplicates on the Documents list, in TPR, mirrored twice); but doing this AFTER
      // the inserts means a storage/DB failure above can never leave the file with ZERO current source
      // docs (the old ones simply stay). Mirrors the slot-supersede pattern.
      await db.query(
        `UPDATE documents SET is_current=false,
           review_status = CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
          WHERE application_id=$1 AND is_current=true AND doc_kind IN ('appraisal_xml','appraisal_pdf')
            AND id <> $2 AND ($3::uuid IS NULL OR id <> $3)`,
        [app.id, xmlDocId, pdfDocId]);
    } catch (e) { console.error('[appraisal] document storage failed (import continues):', e && e.message); }

    // A FAILED APPRAISAL IMPORT MUST NOT COST THE COMPARABLES (owner-directed
    // 2026-08-04, db/462). The desk import does far more than read a grid — it
    // reconciles against the file, materialises two conditions, extracts photos, may
    // move the As-Is and reprice — and ANY of that failing used to take the market
    // data down with it, even when the comparable-sales grid itself read perfectly.
    // So on the failure paths (and only those: a SUCCESSFUL import already feeds the
    // warehouse through `desk.fireResearchIngest`, richer, with the photographs) the
    // report is filed into the warehouse on its own. It writes nothing to the loan
    // file, so it cannot make a failed import worse.
    const rescueGrid = () => require('../lib/research/xml-catch').fireCatch({
      bytes: Buffer.from(xml, 'utf8'), filename: b.filename || 'appraisal.xml',
      contentType: 'application/xml', documentId: xmlDocId,
      uploadedByStaffId: req.actor && req.actor.kind === 'staff' ? req.actor.id : null,
      why: 'a loan file (appraisal import that did not complete)',
    });

    // Shared desk flow: import + reconcile + materialize the two internal conditions +
    // fire the advisory OCR. Identical to the auto-import from the appraisal-docs condition.
    let out;
    try {
      out = await runAppraisalImport({
        appId: app.id, xml, importedBy: req.actor.id,
        xmlDocumentId: xmlDocId, pdfDocumentId: pdfDocId, pdfBase64: pdfB64,
      });
    } catch (e) { rescueGrid(); throw e; }
    if (!out.ok) { rescueGrid(); return res.status(422).json({ error: out.error }); }

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
        const claimId = await require('../lib/throttle-claim').claimOncePerPeriod({ action: 'appraisal_received_emailed', entityId: app.id, interval: '20 hours' });
        if (claimId) {
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

// ---- As-Is value: what PILOT read, and the officer's own entry --------------
// The internal field the owner asked for (2026-07-28): "a field … where you can see how much data's
// value came in and you can overwrite". GET is the read (staff-only, like everything on this
// router); POST is the human's answer — it always wins over anything PILOT read.

router.get('/:appId/as-is', async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    res.json(await require('../lib/appraisal/as-is-desk').asIsState(app.id, req.actor));
  } catch (e) { next(e); }
});

// Entering the As-Is re-prices the loan (As-Is drives the As-Is LTV and LTC caps), so it is gated
// exactly like resolving a finding with "replace" — sign_off_conditions, i.e. processor /
// underwriter / admin / super_admin. A loan officer can SEE the reading but not write it.
router.post('/:appId/as-is', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const out = await require('../lib/appraisal/as-is-desk').setAsIsByHuman(app.id, (req.body || {}).value, {
      actorId: req.actor.id, actor: req.actor, note: (req.body || {}).note,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error, locked: out.locked });
    res.json({ ok: true, value: out.value, previous: out.previous });
  } catch (e) { next(e); }
});

// The ARV's own entry — the twin of the As-Is box. Without it PILOT could rewrite the ARV and the
// officer had nowhere to correct it (the only other door, PATCH /details, is frozen once the term
// sheet is sent). Same gate as the As-Is write: it re-prices the loan.
router.post('/:appId/arv', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const out = await require('../lib/appraisal/as-is-desk').setArvByHuman(app.id, (req.body || {}).value, {
      actorId: req.actor.id, actor: req.actor, note: (req.body || {}).note,
    });
    if (!out.ok) return res.status(out.status || 400).json({ error: out.error, locked: out.locked });
    res.json({ ok: true, value: out.value, previous: out.previous });
  } catch (e) { next(e); }
});

// Re-run the read on demand (the PDF arrived after the XML, or the OCR service was down at import).
// Reading is free of side effects beyond the same owner-directed rule the import applies, so it is
// gated at the same level as entering the value by hand.
router.post('/:appId/as-is/read', requirePermission('sign_off_conditions'), async (req, res, next) => {
  try {
    const app = await fileFor(req, req.params.appId);
    if (!app) return res.status(404).json({ error: 'not found' });
    const out = await require('../lib/appraisal/desk').runAsIsRead(app.id, { actorId: req.actor.id });
    if (!out.ran) return res.status(422).json({ error: out.reason || 'the As-Is could not be read' });
    await audit(req.actor.id, 'appraisal_as_is_reread', app.id, { applied: !!out.applied, value: out.value, confidence: out.confidence, source: out.source, why: out.why });
    res.json({ ok: true, ...out, state: await require('../lib/appraisal/as-is-desk').asIsState(app.id, req.actor) });
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
// property_type is DELIBERATELY excluded, and STAYS excluded. The original reason was that the
// appraisal never yielded a valid portal CATEGORY (it gave a unit count or a MISMO form code) —
// that half is now fixed (lib/appraisal/property-category.js derives a real portal category from
// the form + unit count + ownership signals, owner-reported 2026-08-02), but the exclusion is not
// about the value's shape: property_type is a PRICING INPUT (db/071/072 reopen Products & Pricing
// on any change) and the one validated door for it is the application form, which refuses an
// appraisal form code outright (property-type.sanitizePropertyType). A property-type finding stays
// keep/dismiss; a wrong property type is corrected on the application. `units` stays — the
// appraisal's unit count IS a real int.
const REPRICE_COLS = { arv: 'numeric', as_is_value: 'numeric', purchase_price: 'numeric', units: 'int' };
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
    // AN APPRAISAL FINDING THE *DOCUMENT* DESK STORED IS RESOLVED FROM HERE TOO (owner-directed
    // 2026-08-02). The Appraisal page now lists them, so its buttons must work on them — otherwise
    // moving a finding onto this page would strand it, which is worse than the split it fixes.
    // Scoped to the appraisal sources only (a reviewer on this page can never reach an unrelated
    // document finding), and it goes through the document desk's OWN resolution path — same
    // validation, same durable decision ledger, same AI-mirror close — so the two desks can never
    // record a decision differently.
    if (!fnd) {
      const deskRow = (await db.query(
        `SELECT * FROM document_findings
          WHERE id=$1 AND application_id=$2 AND COALESCE(status,'open')='open' AND source = ANY($3::text[])`,
        [req.params.fid, app.id, apprSubject.APPRAISAL_SOURCE_LIST])).rows[0];
      if (!deskRow) return res.status(404).json({ error: 'finding not found or already resolved' });
      // Same tiered authority as the document desk: granting an exception on a fatal,
      // clear-to-close-blocking finding needs waive_conditions on top of sign_off_conditions.
      const canon = require('../lib/underwriting/actions').canon(action);
      const auth = require('../lib/underwriting/exceptions').canApply(req.actor, canon, deskRow, can);
      if (!auth.ok) return res.status(403).json({ error: auth.reason, requiredPermission: auth.requiredPermission });
      const store = require('../lib/underwriting/store');
      const client2 = await db.getClient();
      let updated = null;
      try {
        await client2.query('BEGIN');
        updated = await store.resolveFinding(client2, {
          findingId: deskRow.id, action: canon, note: (b.note || '').slice(0, 2000),
          value: b.value != null ? b.value : null, by: req.actor.id,
        });
        await client2.query('COMMIT');
      } catch (e) {
        await client2.query('ROLLBACK').catch(() => {});
        client2.release();
        // validateResolution throws a plain Error with a safe, user-facing reason; a pg error
        // carries a SQLSTATE and must go to the global handler rather than leak its internals.
        if (e && e.code) return next(e);
        return res.status(400).json({ error: e.message });
      }
      client2.release();
      if (!updated) return res.status(409).json({ error: 'this finding was already resolved' });
      await audit(req.actor.id, 'appraisal_desk_finding_resolve', app.id,
        { finding: deskRow.code, source: deskRow.source, action: canon, note: (b.note || '').slice(0, 300) });
      const counts = (await db.query(
        `SELECT count(*) FILTER (WHERE severity='fatal' AND blocks_ctc=true)::int AS fatal,
                count(*)::int AS open
           FROM appraisal_findings WHERE application_id=$1 AND status='open'`, [app.id])).rows[0];
      return res.json({ ok: true, repriced: false, openFatal: counts.fatal, blocksCtc: counts.fatal > 0, openFindings: counts.open });
    }

    let repriced = false, newValue = null, col = null;
    if (action === 'replace' || action === 'custom') {
      col = fnd.field;
      if (!Object.prototype.hasOwnProperty.call(REPRICE_COLS, col)) {
        return res.status(400).json({ error: `this finding's field (${col}) cannot be written back automatically — use keep/dismiss or edit the file` });
      }
      /* A REFINANCE CARRIES NO PURCHASE PRICE (owner-directed 2026-08-02) — it is
         sized on the as-is value, and every other door now refuses to write one
         onto one. This is the same class of door as the #FNM1025 property-type
         exclusion above it: the appraisal desk may propose a value, but it may
         not put a figure on the loan file that the file's own purpose says does
         not exist. The as-is value, the ARV and the units are unaffected — those
         are exactly what an appraisal IS authoritative about. */
      if (col === 'purchase_price' && require('../lib/deal-basis').sizesOnAsIsValue(app.loan_type)) {
        return res.status(400).json({
          error: 'This is a refinance, so there is no purchase price to write back — it is sized on the as-is value. '
            + 'Use keep or dismiss, or record what was paid at acquisition as the original purchase price on the file.' });
      }
      const raw = action === 'replace' ? fnd.appraisal_value : b.value;
      const kind = REPRICE_COLS[col];
      if (kind === 'numeric') { newValue = Number(String(raw).replace(/[,$]/g, '')); if (!Number.isFinite(newValue) || newValue <= 0) return res.status(400).json({ error: 'a positive number is required' }); }
      else if (kind === 'int') {
        /* A `custom` value is free text a staffer typed, so it must READ as a
           whole number. Deleting every non-digit instead SILENTLY REINTERPRETS
           it (post-merge audit round 2, 2026-08-02): "1e10" stored 110 units and
           "2-4" — the property-type spelling, an easy thing to type in a units
           box — stored 24, on an input the loan is PRICED off. The three create
           doors already refuse both (fields.APP_RAW_COUNT_FIELDS); this one
           quietly accepted a different number than the one on the screen.
           A `replace` value is OUR OWN extracted string ("3 units"), which has
           always been stripped and must keep working, so only `custom` tightens. */
        const txt = String(raw == null ? '' : raw).trim();
        if (action === 'custom' && !/^[+-]?\d+$/.test(txt)) return res.status(400).json({ error: 'a whole number is required' });
        newValue = parseInt(action === 'custom' ? txt : txt.replace(/\D/g, ''), 10);
        if (!Number.isInteger(newValue)) return res.status(400).json({ error: 'a whole number is required' });
        /* AND IT MUST BE A REAL COUNT. Accepting the sign was a REGRESSION this
           guard introduced (pre-merge audit, 2026-08-02): the `\D` strip it
           replaced silently deleted a minus, so "-3" used to store 3, and the
           tightened regex stored -3 — a NEGATIVE unit count on a pricing input,
           with no CHECK on the column to catch it. The money branch above has
           always required a positive number; a count is no different, and
           `change-requests.normalizeValue` already refuses anything under 1. */
        if (newValue < 1) return res.status(400).json({ error: 'a whole number of at least 1 is required' });
      }
      else { newValue = String(raw || '').trim(); if (!newValue) return res.status(400).json({ error: 'a value is required' }); }
      /* …and whatever it is, it has to FIT the column it is about to be written
         to. Without this an oversized ARV or unit count reached Postgres and came
         back as a 500 "Something went wrong on our end", on a door whose whole job
         is rewriting the loan's economics. Same limit and wording as every other
         door (lib/number-bounds). */
      {
        const bad = require('../lib/number-bounds').applicationColumnProblem(col, newValue);
        if (bad) return res.status(400).json({ error: bad });
      }
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
      // THE DECISION IS DURABLE (owner-reported 2026-07-27). Recorded against the
      // finding's IDENTITY (db/333) inside the SAME transaction as the resolve, so
      // a re-import of the appraisal carries it forward instead of re-raising a
      // finding this reviewer already dealt with. Best-effort by construction
      // (finding-decisions never throws) — it can't fail the resolve.
      await require('../lib/underwriting/finding-decisions').record(client, {
        applicationId: app.id, finding: fnd, origin: 'appraisal_finding',
        decision: action, note: b.note || null, decidedBy: req.actor.id,
      });
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

    // What's left gates the review-cleared condition: every open finding must be resolved before
    // the appraisal review can be signed off (owner-directed 2026-08-02), and an open FATAL one
    // additionally holds term sheets (the 2026-07-31 rule). Both counts are reported so the tab can
    // say what is still standing between this file and a cleared appraisal review.
    const left = (await db.query(
      `SELECT count(*) FILTER (WHERE severity='fatal' AND blocks_ctc=true)::int AS fatal,
              count(*)::int AS open
         FROM appraisal_findings WHERE application_id=$1 AND status='open'`, [app.id])).rows[0];

    res.json({ ok: true, repriced, openFatal: left.fatal, blocksCtc: left.fatal > 0, openFindings: left.open });
  } catch (e) { next(e); }
});

module.exports = router;
// Exported for the DB test: the appraisal findings the DOCUMENT desk computes, which this page
// lists and resolves. Test-only surface — nothing in the app calls it through the module.
module.exports._deskAppraisalFindings = deskAppraisalFindings;
module.exports._appraisalComparison = appraisalComparison;
