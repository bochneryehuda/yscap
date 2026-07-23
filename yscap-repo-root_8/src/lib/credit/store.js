'use strict';
/**
 * Persist an imported credit report (owner-directed 2026-07-22).
 *
 * Saves the PDF + the source XML as staff-only `documents` rows attached to the
 * internal Credit report condition (rtl_cond_credit), supersedes any prior
 * current credit docs (mirrors the appraisal importer), inserts the parsed
 * `credit_reports` row (system-of-record for the credit-details section +
 * underwriting), reopens the condition to 'received', and writes the middle
 * score back to borrowers.fico (which auto-reopens Products & Pricing via the
 * db/126 trigger). Best-effort on the document side: a storage failure logs but
 * never loses the parsed data.
 */
const db = require('../../db');
const cfg = require('../../config');
const storage = require('../storage');
const { decodeUploadBase64, sha256hex } = require('../upload-bytes');
const { reopenConditionEvidence } = require('../checklist-evidence');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');
const { sanitizeFico } = require('../fields');

const MAX_BYTES = (cfg.maxUploadMb || 20) * 1024 * 1024;

// The internal Credit report condition item for a file (db/076 rtl_cond_credit).
async function creditConditionItemId(appId) {
  const r = await db.query(
    `SELECT ci.id FROM checklist_items ci
      WHERE ci.application_id=$1
        AND ci.template_id = (SELECT id FROM checklist_templates WHERE code='rtl_cond_credit')
      ORDER BY ci.created_at LIMIT 1`, [appId]);
  return r.rows[0] ? r.rows[0].id : null;
}

async function insertDoc({ appId, borrowerId, itemId, uploadedById, buf, filename, contentType, docKind, slotLabel, sourceType }) {
  const s = await storage.save(buf, { filename });
  const row = await db.query(
    `INSERT INTO documents
       (application_id,checklist_item_id,borrower_id,filename,content_type,size_bytes,
        storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,
        visibility,source_type,review_status,reviewed_at,sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,$11,'staff_only',$12,'accepted',now(),$13)
     RETURNING id`,
    [appId, itemId, borrowerId, filename, contentType, buf.length, s.provider, s.ref,
      uploadedById || null, docKind, slotLabel, sourceType, sha256hex(buf)]);
  return row.rows[0].id;
}

/**
 * @param {object} a
 * @param {object} a.app     { id, borrower_id, ssn_last4 }
 * @param {object} a.parsed  parseCreditXml() output
 * @param {string} [a.xml]
 * @param {string} [a.pdfBase64]
 * @param {object} a.request { pullType, requestType, bureaus, version }
 * @param {string} a.actorId staff id
 * @param {'api'|'upload'} a.source
 * @param {boolean} [a.consentAttested] the actor attested borrower permissible-purpose (live pulls)
 */
async function storeImport({ app, parsed, xml, pdfBase64, request, actorId, source, consentAttested }) {
  const itemId = await creditConditionItemId(app.id);
  const sourceType = source === 'upload' ? 'staff_upload' : 'system';
  let xmlDocId = null, pdfDocId = null;

  // Decode the PDF up-front so a corrupt PDF can NEVER abort the XML store or
  // skip the supersede (m2): a bad decode logs and we proceed data-file-only.
  let pdfBuf = null;
  if (pdfBase64) {
    try { pdfBuf = decodeUploadBase64(pdfBase64, { maxBytes: MAX_BYTES }).buf; }
    catch (e) { console.error('[credit] PDF decode failed — storing the data file only:', (e && e.message) || e); }
  }

  // 1) Store source documents (best-effort — never lose the parsed data).
  try {
    if (xml) {
      const xbuf = Buffer.from(String(xml), 'utf8');
      if (xbuf.length <= MAX_BYTES) {
        xmlDocId = await insertDoc({
          appId: app.id, borrowerId: app.borrower_id, itemId, uploadedById: actorId, buf: xbuf,
          filename: 'credit-report.xml', contentType: 'application/xml',
          docKind: 'credit_xml', slotLabel: 'Credit report (data)', sourceType });
      }
    }
    if (pdfBuf) {
      pdfDocId = await insertDoc({
        appId: app.id, borrowerId: app.borrower_id, itemId, uploadedById: actorId, buf: pdfBuf,
        filename: 'credit-report.pdf', contentType: 'application/pdf',
        docKind: 'credit_pdf', slotLabel: 'Credit report', sourceType });
    }
    // Retire prior current credit docs AFTER the fresh ones are stored, so a
    // failure above never leaves the file with zero credit docs.
    await db.query(
      `UPDATE documents SET is_current=false,
         review_status = CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND is_current=true AND doc_kind IN ('credit_xml','credit_pdf')
          AND ($2::uuid IS NULL OR id <> $2) AND ($3::uuid IS NULL OR id <> $3)`,
      [app.id, xmlDocId, pdfDocId]);
  } catch (e) {
    console.error('[credit] document storage failed (import continues):', (e && e.message) || e);
  }

  // 2) Insert the parsed credit_reports row (system-of-record).
  const ins = await db.query(
    `INSERT INTO credit_reports
       (application_id,borrower_id,vendor,pull_type,request_type,bureaus,interface_version,
        status,source,vendor_report_id,report_date,middle_score,scores,summary,parsed,
        xml_document_id,pdf_document_id,checklist_item_id,pulled_by,
        consent_attested,consent_by,consent_at)
     VALUES ($1,$2,'xactus',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20, CASE WHEN $19 THEN now() ELSE NULL END)
     RETURNING id`,
    [app.id, app.borrower_id, request.pullType, request.requestType, request.bureaus, request.version,
      parsed.parseError ? 'error' : 'completed', source, parsed.reportId || null,
      parsed.reportDate || null, sanitizeFico(parsed.middleScore),
      JSON.stringify(parsed.scores || []), JSON.stringify(parsed.summary || {}),
      JSON.stringify(parsed), xmlDocId, pdfDocId, itemId, actorId,
      !!consentAttested, consentAttested ? (actorId || null) : null]);
  const creditReportId = ins.rows[0].id;

  // 3) Move the condition to 'received' + mirror to the ClickUp dropdown.
  if (itemId) {
    try {
      await reopenConditionEvidence(db, itemId, 'received');
      enqueueChecklistStatusPush(itemId).catch(() => {});
    } catch (_) { /* condition update is best-effort */ }
  }

  // 4) FICO write-back: middle score → borrowers.fico (auto-reopens P&P via db/126).
  //    SAFETY: if the returned report names a different last-4 than the file's
  //    borrower, DON'T auto-overwrite FICO — surface a mismatch instead.
  let ficoWritten = null, ficoMismatch = false, ficoUnverified = false;
  const returned4 = parsed.borrower && parsed.borrower.ssnLast4;
  const onFile4 = app.ssn_last4 || null;
  if (returned4 && onFile4 && String(returned4) !== String(onFile4)) {
    ficoMismatch = true;                    // report names a DIFFERENT person — never auto-set
  } else if (returned4 && !onFile4) {
    ficoUnverified = true;                  // no SSN on file to confirm identity — don't silently overwrite FICO
  } else if (app.borrower_id && parsed.middleScore != null) {
    const f = sanitizeFico(parsed.middleScore);
    if (f != null) {
      await db.query('UPDATE borrowers SET fico=$1, updated_at=now() WHERE id=$2', [f, app.borrower_id]);
      ficoWritten = f;
    }
  }

  return { creditReportId, xmlDocId, pdfDocId, itemId, ficoWritten, ficoMismatch, ficoUnverified };
}

module.exports = { storeImport, creditConditionItemId };
