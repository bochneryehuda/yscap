'use strict';
/**
 * Richer Values — filing the finished report onto the loan file.
 *
 * ONE document comes back from this product: the PDF report. There is no MISMO
 * XML and there never will be (that is the whole reason this desk waives the data
 * file), so unlike the other two appraisal vendors NOTHING here hands anything to
 * `lib/appraisal/desk.runAppraisalImport` — there is nothing for it to read, and
 * calling it with a PDF would either fail or, worse, half-succeed.
 *
 * WHERE THE PDF GOES, and why each part of that matters:
 *
 *   • ONTO THE APPRAISAL-DOCUMENTS CONDITION, IN ITS `pdf` SLOT. That condition's
 *     sign-off gate looks for a slot whose label contains "pdf", so filing it with
 *     the right slot label is literally what lets the condition be signed off. A
 *     document filed on the file but not on the condition would leave a reviewer
 *     holding the report and unable to clear the very condition it satisfies.
 *
 *   • BORN ACCEPTED. db/424's rule: nothing un-accepted leaves the building, and a
 *     document PILOT ITSELF ORDERED is born `accepted` at its insert rather than
 *     waiting for a human to vouch for a report we commissioned. That is the same
 *     treatment the flood certificate, the appraisal source documents and every
 *     generated export already get.
 *
 *   • STAFF ONLY. It is the lender's own valuation. The borrower sees the property
 *     report through the appraisal panel's borrower-safe view or not at all.
 *
 *   • ITS OWN `doc_kind`. Deliberately NOT `appraisal_pdf`: that kind belongs to
 *     the MISMO importer, and `undoAppraisalImport` DELETES every `appraisal_pdf`
 *     on a file when somebody undoes an appraisal import. Reusing it would mean
 *     undoing an unrelated import silently destroys a report we paid for.
 *
 * IDEMPOTENT BY CONTENT. The poll runs every few minutes and their PDF endpoint
 * answers with the same bytes each time, so a re-fetch must not file a second
 * copy: the order row holds `pdf_document_id`, and the sha256 is checked against
 * what is already on the condition before anything is written.
 */

const crypto = require('crypto');
const store = require('../lib/storage');
const client = require('./client');

/** Their PDF arrives base64 inside the JSON envelope, not as a binary body. */
function decodePdf(envelope) {
  const b64 = envelope && envelope.data && envelope.data.pdf_file;
  if (!b64 || typeof b64 !== 'string') return null;
  // Tolerate a data: prefix and url-safe base64 — the same leniency the repo's
  // upload chokepoint applies, and for the same reason: a mis-encoded prefix
  // shifts the alignment and garbles every byte of a file that then looks filed.
  const cleaned = b64.replace(/^data:[^;]*;base64,/, '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  let bytes;
  try { bytes = Buffer.from(cleaned, 'base64'); } catch (_) { return null; }
  if (!bytes || bytes.length < 100) return null;
  // Prove it is a PDF from its own magic bytes rather than trusting the field
  // name — an HTML error page base64'd into that slot would otherwise be filed as
  // the appraisal report and nobody would notice until somebody opened it.
  if (bytes.slice(0, 5).toString('latin1') !== '%PDF-') return null;
  return bytes;
}

function reportFilename(order) {
  const loan = order.client_loan_number ? `-${String(order.client_loan_number).replace(/[^\w-]+/g, '')}` : '';
  return `Richer-Value-Hybrid-Appraisal${loan}.pdf`;
}

/**
 * Fetch the finished report and file it. Returns
 * `{filed:boolean, documentId, reason}` and NEVER throws — a report we could not
 * file must not stop the poll from recording that the order is complete.
 */
async function fileReport(db, order) {
  if (!order || !order.intake_token || !order.order_token) return { filed: false, reason: 'no_tokens' };
  if (order.pdf_document_id) return { filed: false, documentId: order.pdf_document_id, reason: 'already_filed' };

  let envelope;
  try {
    envelope = await client.pdfFile(order.intake_token, order.order_token);
  } catch (e) {
    // "not completed yet" is their ordinary answer while the report is being
    // written — an expected state, not a failure worth recording as an error.
    return { filed: false, reason: 'not_ready', detail: (e && e.message) || String(e) };
  }
  const bytes = decodePdf(envelope);
  if (!bytes) return { filed: false, reason: 'no_pdf' };

  const sha = crypto.createHash('sha256').update(bytes).digest('hex');

  // Already on this file under any name? Then this is a re-fetch of the same
  // report and the existing row is adopted rather than duplicated.
  try {
    const dup = await db.query(
      `SELECT id FROM documents
        WHERE application_id=$1 AND sha256=$2 AND is_current = true LIMIT 1`,
      [order.application_id, sha]);
    if (dup.rows[0]) {
      await db.query(`UPDATE rv_orders SET pdf_document_id=$2 WHERE id=$1`, [order.id, dup.rows[0].id]);
      return { filed: false, documentId: dup.rows[0].id, reason: 'already_on_file' };
    }
  } catch (_) { /* the dedupe is an optimization; filing twice is recoverable, losing the report is not */ }

  const app = (await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [order.application_id])).rows[0];
  const filename = reportFilename(order);

  let saved;
  try { saved = await store.save(bytes, { filename }); } catch (e) {
    return { filed: false, reason: 'storage_failed', detail: (e && e.message) || String(e) };
  }

  try {
    const ins = await db.query(
      `INSERT INTO documents
         (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256,
          source_type, visibility, slot_label)
       VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,$7,'staff',NULL,'hybrid_appraisal_pdf','accepted',$8,
               'system','staff_only',$9)
       RETURNING id`,
      [order.application_id, app ? app.borrower_id : null, order.checklist_item_id || null,
        filename, bytes.length, saved.provider, saved.ref, sha,
        // The slot label the appraisal condition's own gate looks for. It must
        // CONTAIN "pdf" — the gate matches on a substring — and it is worded the
        // way db/144 words that slot so the two read as the same thing.
        'Appraisal report (PDF)']);
    const documentId = ins.rows[0].id;
    await db.query(`UPDATE rv_orders SET pdf_document_id=$2 WHERE id=$1`, [order.id, documentId]);
    return { filed: true, documentId };
  } catch (e) {
    return { filed: false, reason: 'insert_failed', detail: (e && e.message) || String(e) };
  }
}

module.exports = { fileReport, _internals: { decodePdf, reportFilename } };
