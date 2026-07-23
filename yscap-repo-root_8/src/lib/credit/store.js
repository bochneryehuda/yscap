'use strict';
/**
 * Persist an imported credit report (owner-directed 2026-07-22; per-borrower 2026-07-23).
 *
 * Saves the PDF + the source XML as staff-only `documents` rows attached to the
 * credit condition for THIS borrower (the file-level rtl_cond_credit for the
 * primary, or a co-borrower's own rtl_cond_credit when one was split out),
 * supersedes that borrower's prior current credit docs (mirrors the appraisal
 * importer), inserts the parsed `credit_reports` row (system-of-record for the
 * credit-details section + underwriting), reopens the condition to 'received',
 * and writes the middle score back to that borrower's fico (which auto-reopens
 * Products & Pricing via the db/126 trigger). Best-effort on the document side:
 * a storage failure logs but never loses the parsed data.
 *
 * Everything here is scoped to ONE borrower: a two-borrower "pull both" import
 * calls storeImport once per borrower, so the primary's docs are never retired
 * when the co-borrower's report lands (borrower-scoped supersede).
 */
const db = require('../../db');
const cfg = require('../../config');
const storage = require('../storage');
const { decodeUploadBase64, sha256hex } = require('../upload-bytes');
const { reopenConditionEvidence } = require('../checklist-evidence');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');
const { sanitizeFico } = require('../fields');
const { CO_CREDIT_MARKER } = require('./co-condition');

const MAX_BYTES = (cfg.maxUploadMb || 20) * 1024 * 1024;

// The credit condition a report attaches to. A credit condition is
// application-scoped (chk_one_owner forbids a borrower_id on it), so the
// co-borrower's own condition is marked with field_key='cob_credit' instead:
//   • isCo + a marked condition exists (split flow) → the co-borrower's condition
//   • otherwise → the file-level credit condition (the rtl_cond_credit that is NOT
//     the co-borrower marker) — this holds BOTH reports in the default "pull both".
async function creditConditionItemId(appId, { isCo } = {}) {
  if (isCo) {
    const c = await db.query(
      `SELECT id FROM checklist_items
        WHERE application_id=$1 AND field_key=$2
          AND template_id = (SELECT id FROM checklist_templates WHERE code='rtl_cond_credit')
        ORDER BY created_at LIMIT 1`, [appId, CO_CREDIT_MARKER]);
    if (c.rows[0]) return c.rows[0].id;
  }
  const r = await db.query(
    `SELECT id FROM checklist_items
      WHERE application_id=$1
        AND template_id = (SELECT id FROM checklist_templates WHERE code='rtl_cond_credit')
        AND COALESCE(field_key,'') <> $2
      ORDER BY created_at LIMIT 1`, [appId, CO_CREDIT_MARKER]);
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
 * @param {object} a.file     { id }  the application
 * @param {object} a.borrower { id, ssn_last4, isCo }  the borrower this report is FOR
 * @param {object} a.parsed   parseCreditXml() output
 * @param {string} [a.xml]
 * @param {string} [a.pdfBase64]
 * @param {object} a.request  { pullType, requestType, bureaus, version }
 * @param {string} a.actorId  staff id
 * @param {'api'|'upload'} a.source
 * @param {boolean} [a.consentAttested] the actor attested borrower permissible-purpose (live pulls)
 */
async function storeImport({ file, borrower, parsed, xml, pdfBase64, request, actorId, source, consentAttested }) {
  const appId = file.id;
  const borrowerId = borrower.id;
  const itemId = await creditConditionItemId(appId, { isCo: !!borrower.isCo });
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
          appId, borrowerId, itemId, uploadedById: actorId, buf: xbuf,
          filename: 'credit-report.xml', contentType: 'application/xml',
          docKind: 'credit_xml', slotLabel: 'Credit report (data)', sourceType });
      }
    }
    if (pdfBuf) {
      pdfDocId = await insertDoc({
        appId, borrowerId, itemId, uploadedById: actorId, buf: pdfBuf,
        filename: 'credit-report.pdf', contentType: 'application/pdf',
        docKind: 'credit_pdf', slotLabel: 'Credit report', sourceType });
    }
    // Retire THIS borrower's prior current credit docs AFTER the fresh ones are
    // stored, so a failure above never leaves them with zero credit docs. Scoped
    // to borrower_id so a co-borrower's import never retires the primary's docs
    // (both borrowers' reports coexist on the file-level condition in "pull both").
    await db.query(
      `UPDATE documents SET is_current=false,
         review_status = CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND is_current=true AND doc_kind IN ('credit_xml','credit_pdf')
          AND borrower_id IS NOT DISTINCT FROM $4::uuid
          AND ($2::uuid IS NULL OR id <> $2) AND ($3::uuid IS NULL OR id <> $3)`,
      [appId, xmlDocId, pdfDocId, borrowerId]);
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
    [appId, borrowerId, request.pullType, request.requestType, request.bureaus, request.version,
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

  // 4) FICO write-back: middle score → this borrower's fico (auto-reopens P&P via
  //    db/126). SAFETY: if the returned report names a different last-4 than the
  //    borrower on file, DON'T auto-overwrite FICO — surface a mismatch instead.
  let ficoWritten = null, ficoMismatch = false, ficoUnverified = false;
  const returned4 = parsed.borrower && parsed.borrower.ssnLast4;
  const onFile4 = borrower.ssn_last4 || null;
  if (returned4 && onFile4 && String(returned4) !== String(onFile4)) {
    ficoMismatch = true;                    // report names a DIFFERENT person — never auto-set
  } else if (returned4 && !onFile4) {
    ficoUnverified = true;                  // no SSN on file to confirm identity — don't silently overwrite FICO
  } else if (borrowerId && parsed.middleScore != null) {
    const f = sanitizeFico(parsed.middleScore);
    if (f != null) {
      await db.query('UPDATE borrowers SET fico=$1, updated_at=now() WHERE id=$2', [f, borrowerId]);
      ficoWritten = f;
    }
  }

  return { creditReportId, xmlDocId, pdfDocId, itemId, ficoWritten, ficoMismatch, ficoUnverified };
}

module.exports = { storeImport, creditConditionItemId };
