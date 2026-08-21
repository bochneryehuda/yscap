'use strict';
/**
 * FILING THE "GENERAL CONTRACTOR INFORMATION" SHEET ONTO THE LOAN FILE — the IO half
 * under the pure builder in ./gc-pdf.js (owner-directed 2026-08-21: "in the TPR export
 * and in the SharePoint sync, you need to take this information and lay it out on a PDF
 * GC contractor information nicely to include in the invested delivery TPR export
 * SharePoint").
 *
 * IT NEEDED NO NEW EXPORT MACHINERY, and that is the point of filing it as an ORDINARY
 * document on the GC condition: `tpr-export` already maps `rtl_cond_gc_info` to the
 * Scope-of-Work folder, and the SharePoint mirror shares that same categorizer — so one
 * `documents` row reaches the investor package and the team site in the right folder,
 * with the version stream, the shelf rules and the mirror all inherited.
 *
 * IT IS BORN ACCEPTED, like every other document PILOT generates from data it already
 * holds (db/424): nobody uploaded it, so there is nobody to ask to review it, and an
 * un-accepted document would be held back from the very export it exists for.
 *
 * IT SUPERSEDES ITS OWN PREDECESSOR AND NOTHING ELSE. The filename carries a hash of
 * the record it was drawn from, so re-filing an unchanged record RETURNS THE COPY THAT
 * IS ALREADY THERE rather than minting a second one — which is what keeps the mirror's
 * Version-N folders from filling up with identical sheets.
 */
const crypto = require('crypto');
const db = require('../../db');
const storage = require('../storage');
const GC = require('./gc-record');
const { buildGcPdf } = require('./gc-pdf');

const DOC_KIND = 'gc_information';
const BASE = 'GC Contractor Information';

/** A stable fingerprint of everything the sheet prints — the same record always yields the same name. */
function recordVersion(rec, app) {
  const parts = ['company_name', 'contact_name', 'email', 'phone', 'address', 'contact_notes',
    ...GC.CREDENTIAL_FIELDS.map((f) => f.key)].map((k) => `${k}=${rec && rec[k] != null ? String(rec[k]) : ''}`);
  parts.push(`loan=${(app && app.loanNo) || ''}`, `addr=${(app && app.address) || ''}`, `who=${(app && app.borrowerName) || ''}`);
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 12);
}

/**
 * Draw the sheet from what is on the file and file it onto the GC condition.
 * @returns {{made:boolean, documentId?:string, filename?:string, reason?:string}}
 *   `made:false` with a reason is an ordinary outcome, never an error: most files have
 *   no contractor recorded, and a file with nothing to say must not produce a sheet.
 */
async function refreshForApplication(appId, opts = {}) {
  if (!appId) return { made: false, reason: 'no_application' };
  const rec = await GC.loadForApplication(appId);
  if (!GC.hasAnything(rec)) return { made: false, reason: 'nothing_recorded' };

  const app = (await db.query(
    `SELECT a.ys_loan_number, a.property_address, a.borrower_id, NULLIF(b.full_name,'') AS borrower_name
       FROM applications a LEFT JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId])).rows[0];
  if (!app) return { made: false, reason: 'no_application' };
  const meta = {
    loanNo: app.ys_loan_number || '',
    address: (app.property_address && (app.property_address.oneLine || app.property_address.line1)) || '',
    borrowerName: app.borrower_name || '',
  };

  const filename = `${BASE}-${recordVersion(rec, meta)}.pdf`;
  const already = (await db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND doc_kind=$2 AND filename=$3 AND is_current=true LIMIT 1`,
    [appId, DOC_KIND, filename])).rows[0];
  if (already) return { made: false, reason: 'unchanged', documentId: already.id, filename };

  // The GC condition is where it belongs — that is what puts it in the Scope-of-Work
  // folder of the export and the mirror with no second map to keep in step.
  const item = (await db.query(
    `SELECT ci.id FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_cond_gc_info' ORDER BY ci.created_at LIMIT 1`, [appId])).rows[0];

  const bytes = buildGcPdf(rec, meta, { today: opts.today });
  const { ref, provider } = await storage.save(Buffer.from(bytes), { filename });
  const ins = await db.query(
    `INSERT INTO documents
       (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
        storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind,
        source_type, visibility, is_current, review_status)
     -- BORN ACCEPTED: PILOT drew it from data it already holds, so there is nobody to
     -- ask to review it, and a pending copy would be held back from the export it is for.
     VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,'staff',NULL,$8,'system','staff_only',true,'accepted')
     RETURNING id`,
    [appId, app.borrower_id || null, item ? item.id : null, filename, Buffer.from(bytes).length, provider, ref, DOC_KIND]);

  // Supersede only OUR OWN earlier sheets on this file — never anything a human filed
  // on the same condition (their licence certificate, their W-9).
  await db.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE application_id=$1 AND doc_kind=$2 AND id<>$3 AND is_current=true`,
    [appId, DOC_KIND, ins.rows[0].id]);

  try { require('../sharepoint-backup').kick(); } catch (_) { /* the mirror drains on its own schedule too */ }
  return { made: true, documentId: ins.rows[0].id, filename };
}

module.exports = { DOC_KIND, BASE, recordVersion, refreshForApplication };
