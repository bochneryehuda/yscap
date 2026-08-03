/**
 * Order returns — the inbound side of the Orders desk (#orders).
 *
 * A title / insurance order emails the vendor from a UNIQUE reply-to
 * (title+<id>@ / insurance+<id>@, see file-address.js). When the vendor replies
 * WITH documents, the inbound webhook (file-inbox.js) resolves the order and
 * hands the attachments here. We save each one as an ordinary `documents` row
 * ATTACHED TO THE REAL TITLE / INSURANCE DOCUMENT CONDITION (rtl_cond_title /
 * rtl_cond_insurance) — so it shows up right inside that condition (and the file
 * Documents list / TPR) — and it lands UNASSIGNED (slot_label NULL) so the team
 * classifies it (Insurance: Binder / Invoice; Title: Commitment / CPL / …) and
 * accepts it. Assigning "binder"/"invoice" is exactly what the condition's
 * existing sign-off gate looks for, so a classified + accepted binder+invoice
 * completes the insurance condition with no extra wiring. The order is flipped to
 * 'documents_in', and the condition is nudged to 'received' (never reopening a
 * signed-off/waived one).
 *
 * Integrity: bytes are decoded through the shared `decodeUploadBase64` chokepoint
 * (never a bare Buffer.from — a data:-prefixed or malformed payload is rejected,
 * not silently garbled) and the sha256 is stored, so the SharePoint integrity
 * audit can verify the mirror. The mirror is kicked so returned PDFs flow into
 * the file's SharePoint folder like any upload.
 *
 * Retry-safe: the inbound webhook can redeliver, so each save dedups on
 * (filename, size, doc_kind, application, condition) within a short window
 * (doc-dedup, #87) — and file-inbox additionally marks the order 'saved' in its
 * per-webhook results so a redelivery minutes later never re-files.
 *
 * Best-effort by contract: a persistence hiccup here NEVER fails the webhook.
 */
const db = require('../db');
const storage = require('./storage');
const notify = require('./notify');
const { decodeUploadBase64, sniffKind, expectedKind } = require('./upload-bytes');
const { classifyReturnAttachment } = require('./order-return-filter');
// The slot vocabulary + the condition each order files into live in ONE place,
// shared with the Orders desk and the condition's own slot picker (order-slots.js).
const { CONDITION_CODE } = require('./order-slots');

const DOC_KIND = { title: 'title_order_return', insurance: 'insurance_order_return' };
const MAX_RETURN_DOCS = 20;

/**
 * The document condition an order files into (rtl_cond_title / rtl_cond_insurance),
 * so a returned document lands INSIDE the title / insurance condition.
 *
 * IT IS CREATED WHEN IT IS MISSING (owner-directed 2026-08-03: "the insurance
 * order should be tied directly to the insurance condition"). Both templates are
 * `auto_apply IS NULL` and `applies_loan_type='rtl'`, so they are instantiated by
 * `generateChecklist` at file creation for an RTL file and by db/051's one-time
 * back-fill for the statuses it named — and NOWHERE ELSE. Any file outside that
 * intersection (a non-RTL file the team still orders insurance on, a file created
 * before the back-fill's status window, a file whose condition a human removed)
 * took the old `return null` branch: the document was saved to the file with NO
 * condition, so it showed on the Orders desk and nowhere else, and the condition
 * it was ordered for went on reading "nothing uploaded". Ordering the thing is the
 * proof the file needs the condition, so the condition is created rather than the
 * document orphaned.
 *
 * Creation is the repo's guarded one-statement shape (`INSERT … SELECT … WHERE
 * NOT EXISTS` on application+template — the same guard `closing.js`, `vesting.js`
 * and `appraisal/desk.js` carry), so a webhook redelivery, or two attachments in
 * one delivery, can never leave a file with two copies of the condition. It
 * still returns null (document saved, unattached) when the template is missing
 * or the insert fails: filing the document is the thing that must never be lost.
 */
async function conditionItemFor(applicationId, orderType) {
  const code = CONDITION_CODE[orderType];
  if (!code) return null;
  const find = async () => {
    const r = await db.query(
      `SELECT id FROM checklist_items
        WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code=$2)
        ORDER BY created_at ASC LIMIT 1`, [applicationId, code]);
    return r.rows[0] ? r.rows[0].id : null;
  };
  try {
    const found = await find();
    if (found) return found;
  } catch (_) { return null; }
  try {
    // `slots` is read from the TEMPLATE at display time, so it is deliberately
    // not copied here — the condition picks up the binder/invoice slots for free.
    await db.query(
      `INSERT INTO checklist_items
         (template_id, scope, application_id, label, borrower_label, audience, item_kind,
          role_scope, phase, category, hint, borrower_hint, is_gate, is_milestone,
          sort_order, tool_key, field_key, clickup_field_id, tpr_exclude,
          is_required, status, origin_kind, created_by_kind)
       SELECT t.id, 'application', $1, t.label, t.borrower_label, t.audience, t.item_kind,
              COALESCE(t.role_scope,'any'), t.phase, t.category, t.hint, t.borrower_hint,
              COALESCE(t.is_gate,false), COALESCE(t.is_milestone,false),
              COALESCE(t.sort_order,100), t.tool_key, t.field_key, t.clickup_field_id,
              COALESCE(t.tpr_exclude,false),
              COALESCE(t.is_required,true), 'outstanding', 'auto', 'system'
         FROM checklist_templates t
        WHERE t.code = $2 AND t.is_active = true
          AND NOT EXISTS (SELECT 1 FROM checklist_items ci
                           WHERE ci.application_id = $1 AND ci.template_id = t.id)`,
      [applicationId, code]);
    return await find();
  } catch (e) {
    console.error('[order-inbox] could not create the', code, 'condition for', applicationId, '-', (e && e.message) || e);
    return null;
  }
}

/**
 * Persist a vendor's returned documents against an order.
 * @param {object} p { applicationId, orderType, attachments:[{filename,contentType,content(base64)}], fromEmail }
 * @returns {Promise<{saved:number, suspect:number, skipped:number}>}
 */
async function saveReturnedDocs({ applicationId, orderType, attachments, fromEmail }) {
  const kind = DOC_KIND[orderType];
  if (!kind) return { saved: 0, suspect: 0, skipped: 0 };
  const list = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.filename && a.content).slice(0, MAX_RETURN_DOCS);
  if (!list.length) return { saved: 0, suspect: 0, skipped: 0 };

  let borrowerId = null;
  try {
    const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [applicationId]);
    if (!a.rows[0]) return { saved: 0, suspect: 0, skipped: 0 };   // unknown / archived file — nothing to attach to
    borrowerId = a.rows[0].borrower_id;
  } catch (_) { return { saved: 0, suspect: 0, skipped: 0 }; }

  const itemId = await conditionItemFor(applicationId, orderType);
  const dedup = require('./doc-dedup');
  let saved = 0;
  let suspect = 0;   // decoded fine but the bytes don't look like the claimed type
  let skipped = 0;   // email-signature/logo images — never returned documents
  for (const a of list) {
    try {
      // Decode through the integrity chokepoint (rejects a data:-prefixed or
      // malformed payload instead of silently corrupting the file) and keep the
      // sha256 for the SharePoint integrity audit.
      let buf, sha256;
      try { ({ buf, sha256 } = decodeUploadBase64(String(a.content))); }
      catch (_) { continue; }   // undecodable attachment — skip, never store garbage
      if (!buf.length) continue;
      // An email-SIGNATURE image (the vendor's logo/headshot embedded in their
      // reply — inline/Content-ID, or a small standalone image) is not a returned
      // document. Filing one used to flip the order to 'documents_in', nudge the
      // condition to 'received' and announce "documents came back" off a reply
      // that said only "Received." — see order-return-filter.js. Real documents
      // (PDFs, Word/Excel, TIFF scans, large photo scans) are unaffected, and the
      // reply itself still forwards to the team with every attachment.
      const cls = classifyReturnAttachment({ ...a, buf });
      if (!cls.file) {
        skipped += 1;
        console.log(`[order-inbox] skipped a ${cls.reason} attachment ("${String(a.filename).slice(0, 80)}", ${buf.length} bytes) on the ${orderType} order — not filed as a returned document.`);
        continue;
      }
      // Magic-byte sniff: flag a file whose bytes don't match its name/type (an
      // HTML error page saved as .pdf) so a corrupt return doesn't masquerade as
      // a real binder. We still store it (staff decide), but tag it corrupt.
      const want = expectedKind(a.filename, a.contentType);
      const got = sniffKind(buf);
      const corrupt = !!(want && got && got !== want && !(want === 'zip' && got === 'zip'));
      if (corrupt) suspect += 1;
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
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',NULL,$9,'pending',$10)`,
        [applicationId, borrowerId, itemId, String(a.filename).slice(0, 300),
         a.contentType || 'application/octet-stream', buf.length, provider, ref, kind, sha256 || null]);
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
    // Nudge the linked document condition to 'received' so it reflects that
    // documents arrived — but NEVER reopen one already satisfied/waived.
    if (itemId) {
      try {
        await db.query(
          `UPDATE checklist_items SET status='received', updated_at=now()
            WHERE id=$1 AND status NOT IN ('satisfied','waived')`, [itemId]);
      } catch (_) { /* best-effort */ }
    }
    // Mirror the returned PDFs into the file's SharePoint folder like any upload.
    try { require('./sharepoint-backup').kick(); } catch (_) { /* best-effort */ }
    // Tell the assigned team documents came back and need classifying — an in-app
    // nudge with a deep link to the file's Orders section. Best-effort.
    try {
      const ctx = await notify.fileContext(applicationId).catch(() => null);
      await notify.notifyAppStaff(applicationId, {
        type: 'order_docs_in',
        title: `${orderType === 'title' ? 'Title' : 'Insurance'} documents came back`,
        body: `${saved} document${saved === 1 ? '' : 's'}${fromEmail ? ` from ${fromEmail}` : ''} arrived on the ${orderType} order${ctx ? ` for ${ctx.addr}` : ''}${suspect ? ` (${suspect} may be unreadable — check before accepting)` : ''}. Open the file's Orders section to classify (binder / invoice / …) and accept.`,
        applicationId,
        subjectTag: ctx ? ctx.subjectTag : '',
        link: `/internal/app/${applicationId}`,
        ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }
  }
  return { saved, suspect, skipped };
}

module.exports = { saveReturnedDocs, conditionItemFor, DOC_KIND, CONDITION_CODE };
