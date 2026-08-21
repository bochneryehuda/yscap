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

// base64 door → the JSON ceiling (config.js explains why the two limits differ)
const MAX_BYTES = () => require('../upload-stream').jsonUploadBytes();

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
 * @param {object} [a.reuseDocs] { xmlDocId, pdfDocId } — a MERGED report is ONE physical
 *   document covering both borrowers, so the second borrower's row points at the SAME
 *   stored PDF/XML instead of filing a duplicate copy of the same file on the loan.
 * @param {object} [a.filenames] { xml, pdf, xmlLabel, pdfLabel } — override the stored
 *   document names (a merged report is filed as such, so staff can see what it is).
 */
async function storeImport({ file, borrower, parsed, xml, pdfBase64, request, actorId, source, consentAttested, reuseDocs, filenames }) {
  const appId = file.id;
  const borrowerId = borrower.id;
  const itemId = await creditConditionItemId(appId, { isCo: !!borrower.isCo });
  const sourceType = source === 'upload' ? 'staff_upload' : 'system';
  const names = filenames || {};
  let xmlDocId = (reuseDocs && reuseDocs.xmlDocId) || null;
  let pdfDocId = (reuseDocs && reuseDocs.pdfDocId) || null;
  const alreadyFiled = !!(reuseDocs && (reuseDocs.xmlDocId || reuseDocs.pdfDocId));

  // Decode the PDF up-front so a corrupt PDF can NEVER abort the XML store or
  // skip the supersede (m2): a bad decode logs and we proceed data-file-only.
  let pdfBuf = null;
  if (pdfBase64 && !alreadyFiled) {
    try { pdfBuf = decodeUploadBase64(pdfBase64, { maxBytes: MAX_BYTES() }).buf; }
    catch (e) { console.error('[credit] PDF decode failed — storing the data file only:', (e && e.message) || e); }
  }

  // 1) Store source documents (best-effort — never lose the parsed data). A merged
  //    report's second borrower reuses the documents filed for the first, so one
  //    physical report is filed once, not twice.
  try {
    if (xml && !alreadyFiled) {
      const xbuf = Buffer.from(String(xml), 'utf8');
      if (xbuf.length <= MAX_BYTES()) {
        xmlDocId = await insertDoc({
          appId, borrowerId, itemId, uploadedById: actorId, buf: xbuf,
          filename: names.xml || 'credit-report.xml', contentType: 'application/xml',
          docKind: 'credit_xml', slotLabel: names.xmlLabel || 'Credit report (data)', sourceType });
      }
    }
    if (pdfBuf) {
      pdfDocId = await insertDoc({
        appId, borrowerId, itemId, uploadedById: actorId, buf: pdfBuf,
        filename: names.pdf || 'credit-report.pdf', contentType: 'application/pdf',
        docKind: 'credit_pdf', slotLabel: names.pdfLabel || 'Credit report', sourceType });
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

  // 4) FICO write-back: this borrower's MIDDLE SCORE → borrowers.fico. That is the
  //    ONE field Products & Pricing, the Term Sheet Studio, the investor tapes, the
  //    whole-loan underwriting context AND the application all read (each as the
  //    HIGHER-OF-TWO across the file's borrowers — the score that prices the deal),
  //    so writing the report's middle score HERE is what makes the imported credit
  //    score flow EVERYWHERE, and it auto-reopens P&P via the db/126 trigger — so
  //    importing / re-importing / updating credit directly updates the file
  //    (owner-directed 2026-08-05: "everywhere should be updated according to the
  //    imported credit score … the middle score of one borrower and the higher
  //    middle score of two borrowers … directly when you import, re-import, and
  //    update").
  //    SAFETY: the ONE case we still refuse is a report whose SSN names a DIFFERENT
  //    person than the borrower on file — that is someone else's score and must never
  //    price this deal (the isg_fico_mismatch finding still flags it). A report for a
  //    borrower with NO SSN on file IS now written — the staff imported it for THIS
  //    borrower and the credit condition already shows it as theirs, and previously
  //    withholding it left pricing on the stale estimate while the condition showed
  //    the real score (owner-reported). It is flagged `ficoUnverified` ONLY so the
  //    import result can note the identity wasn't SSN-confirmed; the score still flows.
  let ficoWritten = null, ficoMismatch = false, ficoUnverified = false;
  const returned4 = parsed.borrower && parsed.borrower.ssnLast4;
  const onFile4 = borrower.ssn_last4 || null;
  if (returned4 && onFile4 && String(returned4) !== String(onFile4)) {
    ficoMismatch = true;                    // report names a DIFFERENT person — never auto-set
  } else if (borrowerId && parsed.middleScore != null) {
    const f = sanitizeFico(parsed.middleScore);
    if (f != null) {
      await db.query('UPDATE borrowers SET fico=$1, updated_at=now() WHERE id=$2', [f, borrowerId]);
      ficoWritten = f;
      // Wrote it, but there was no SSN on file to confirm the report is this
      // borrower's — carry that caveat to the import result (the score still flows
      // into pricing/tapes/term sheet exactly like a confirmed one).
      if (returned4 && !onFile4) ficoUnverified = true;
    }
  }

  // 5) SSN-verification auto-sign-off RETIRED (owner-directed 2026-07-24). PILOT used
  //    to auto-clear the CorrFirst SSN condition once a matching credit report landed
  //    (gated OFF by default). PILOT no longer signs off a Condition Center condition
  //    itself — a human clears it; the ssnCompleteness() helper now feeds the ADVISORY
  //    overlay below instead. The sign-off pass is no longer called here.

  // Refresh PILOT's ADVISORY overlay across the file's conditions (SSN + credit both change
  // on a credit import). PILOT never signs a condition off itself — advisory only. Gated ON
  // by default (PILOT_READY_STAMP) inside the engine; best-effort, never throws.
  try {
    await require('../underwriting/pilot-advice-engine').runFileAdvice(db, appId);
  } catch (e) {
    console.error('[credit] PILOT advisory (import continues):', (e && e.message) || e);
  }

  return { creditReportId, xmlDocId, pdfDocId, itemId, ficoWritten, ficoMismatch, ficoUnverified };
}

module.exports = { storeImport, creditConditionItemId };
