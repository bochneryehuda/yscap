/**
 * Order returns — the inbound side of the Orders desk (#orders).
 *
 * A title / insurance order emails the vendor from a UNIQUE reply-to
 * (title+<id>@ / insurance+<id>@, see file-address.js). When the vendor replies
 * WITH documents, the inbound webhook (file-inbox.js) resolves the order and
 * hands the attachments here. We save each one as an ordinary `documents` row
 * tagged by doc_kind so it shows in the file's Documents list / TPR like any
 * upload — and it lands UNASSIGNED (slot_label NULL) so the team classifies it
 * (Binder / Invoice / Title commitment / CPL / …) and accepts it, exactly the
 * "put it in the condition as unassigned for us to assign" flow the owner asked
 * for. The order is flipped to 'documents_in'.
 *
 * Retry-safe: the inbound webhook can redeliver, so each save dedups on
 * (filename, size, doc_kind, application) within a short window (doc-dedup, #87)
 * — a redelivered attachment never double-files.
 *
 * Best-effort by contract: a persistence hiccup here NEVER fails the webhook
 * (the vendor's reply still forwards to the team through the normal path).
 */
const db = require('../db');
const storage = require('./storage');
const notify = require('./notify');

const DOC_KIND = { title: 'title_order_return', insurance: 'insurance_order_return' };
const MAX_RETURN_DOCS = 20;

/** The checklist item that best represents an order's condition, so a returned
    doc can hang off it (title/insurance contact condition — a document that
    comes back belongs to that condition's story). Null when the file has none. */
async function conditionItemFor(applicationId, orderType) {
  try {
    const toolKey = orderType === 'title' ? 'title_contact' : 'insurance_contact';
    const r = await db.query(
      `SELECT id FROM checklist_items
        WHERE application_id=$1 AND tool_key=$2
        ORDER BY created_at ASC LIMIT 1`, [applicationId, toolKey]);
    return r.rows[0] ? r.rows[0].id : null;
  } catch (_) { return null; }
}

/**
 * Persist a vendor's returned documents against an order.
 * @param {object} p { applicationId, orderType, attachments:[{filename,contentType,content(base64)}], fromEmail }
 * @returns {Promise<{saved:number}>}
 */
async function saveReturnedDocs({ applicationId, orderType, attachments, fromEmail }) {
  const kind = DOC_KIND[orderType];
  if (!kind) return { saved: 0 };
  const list = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.filename && a.content).slice(0, MAX_RETURN_DOCS);
  if (!list.length) return { saved: 0 };

  let borrowerId = null;
  try {
    const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [applicationId]);
    if (!a.rows[0]) return { saved: 0 };   // unknown / archived file — nothing to attach to
    borrowerId = a.rows[0].borrower_id;
  } catch (_) { return { saved: 0 }; }

  const itemId = await conditionItemFor(applicationId, orderType);
  const dedup = require('./doc-dedup');
  let saved = 0;
  for (const a of list) {
    try {
      const buf = Buffer.from(String(a.content), 'base64');
      if (!buf.length) continue;
      // Idempotent: a redelivered webhook must not double-file the same bytes.
      const dupId = await dedup.recentDuplicateDocId({
        filename: a.filename, sizeBytes: buf.length, uploadedByKind: 'staff', uploadedById: null,
        applicationId, checklistItemId: itemId, docKind: kind,
      }).catch(() => null);
      if (dupId) { saved += 1; continue; }
      const { ref, provider } = await storage.save(buf, { filename: a.filename });
      await db.query(
        `INSERT INTO documents
           (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',NULL,$9,'pending')`,
        [applicationId, borrowerId, itemId, String(a.filename).slice(0, 300),
         a.contentType || 'application/octet-stream', buf.length, provider, ref, kind]);
      saved += 1;
    } catch (_) { /* skip this attachment, keep going */ }
  }

  if (saved) {
    // Move the order to 'documents_in' (only from an active state — never revive a
    // cancelled order). Best-effort.
    try {
      await db.query(
        `UPDATE file_orders SET status='documents_in', updated_at=now()
          WHERE application_id=$1 AND order_type=$2 AND status IN ('ordered','documents_in')`,
        [applicationId, orderType]);
    } catch (_) { /* best-effort */ }
    // Tell the assigned team documents came back and need classifying — an in-app
    // nudge with a deep link to the file's Orders section. Best-effort.
    try {
      const ctx = await notify.fileContext(applicationId).catch(() => null);
      await notify.notifyAppStaff(applicationId, {
        type: 'order_docs_in',
        title: `${orderType === 'title' ? 'Title' : 'Insurance'} documents came back`,
        body: `${saved} document${saved === 1 ? '' : 's'}${fromEmail ? ` from ${fromEmail}` : ''} arrived on the ${orderType} order${ctx ? ` for ${ctx.addr}` : ''}. Open the file's Orders section to classify (binder / invoice / …) and accept.`,
        applicationId,
        subjectTag: ctx ? ctx.subjectTag : '',
        link: `/internal/app/${applicationId}`,
        ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }
  }
  return { saved };
}

module.exports = { saveReturnedDocs, conditionItemFor, DOC_KIND };
