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
 * STAFF-ONLY, ALWAYS. `rtl_cond_title` / `rtl_cond_insurance` are `audience='staff'`
 * conditions, but the borrower's document library and download route gate on the
 * DOCUMENT's `visibility` column, not on the owning condition's audience — and this
 * insert used to omit both classification columns, so every returned document took
 * db/014's defaults (`visibility='borrower'`, `source_type='borrower_upload'`). A
 * borrower could therefore list and download the title commitment, the CPL, the tax
 * certificate and the title company's WIRING INSTRUCTIONS. Exactly the same omission,
 * with exactly the same consequence, as the appraisal source documents db/175 closed.
 * They still ride into the TPR investor package (that selector filters chat
 * attachments and regenerable artifacts, never visibility).
 *
 * Retry-safe: the inbound webhook can redeliver, so each save dedups on the CONTENT
 * HASH with no time window (`alreadyFiled`) — which is what lets file-inbox withhold
 * its per-order 'saved' marker on a recoverable failure and actually retry.
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
const { CONDITION_CODE, RETURN_DOC_KIND } = require('./order-slots');

const DOC_KIND = RETURN_DOC_KIND;
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
 * IS THIS EXACT DOCUMENT ALREADY FILED ON THIS ORDER?
 *
 * Identity is the CONTENT — the sha256 this module has always computed and stored
 * for the SharePoint integrity audit, and never once queried. That omission is what
 * forced the caller's always-write marker: `doc-dedup.recentDuplicateDocId` only
 * looks back 120 SECONDS, so a webhook redelivery arriving minutes later (Resend
 * retries up to 8 times, with backoff) sailed straight past it and re-filed the whole
 * package. With no safe retry available, file-inbox had to mark the order handled
 * even when a storage or database blip had just lost documents — trading a duplicate
 * risk for a silent-loss risk, on the vendor package the file is waiting for.
 *
 * A content hash has no window, so a retry is idempotent HOWEVER much later it
 * arrives. That is the whole point: it lets the caller withhold the marker on a
 * TRANSIENT failure and genuinely recover, without the duplicates that made
 * withholding it wrong before. Same fix, same reasoning, as closing-inbox.alreadyFiled.
 *
 * Keyed on (file, kind, bytes, name) and only against a CURRENT row, so a document a
 * human deliberately superseded can still be re-filed when the vendor resends it.
 * Deliberately NOT keyed on the condition: `conditionItemFor` can create the condition
 * on a later pass, so including it would make the same bytes file twice the moment the
 * condition appeared. The same bytes under a genuinely different filename file
 * normally — on a vendor return the name is part of what arrived.
 */
async function alreadyFiled({ applicationId, sha256, filename, kind }) {
  if (!sha256 || !applicationId || !kind) return null;
  const r = await db.query(
    `SELECT id FROM documents
      WHERE sha256 = $1 AND application_id = $2
        AND COALESCE(doc_kind,'') = $3 AND filename = $4
        AND is_current = true
      -- id breaks the tie so a capped read is deterministic.
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [sha256, applicationId, kind, String(filename).slice(0, 300)]);
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Persist a vendor's returned documents against an order.
 *
 * The two failure counts are NOT cosmetic — file-inbox decides from them whether a
 * webhook redelivery may retry, so collapsing them (as this did, by swallowing every
 * attachment error into a bare `catch (_)`) is what made a recoverable blip
 * indistinguishable from an unrecoverable one:
 *   · failedPermanent — retrying produces the identical result (bytes that will not
 *     decode, an empty attachment, a file we cannot look up because it is gone).
 *     Holding the delivery open for these buys nothing and blocks the marker forever.
 *   · failedTransient — storage or the database threw. Retrying can genuinely
 *     succeed, so the caller must NOT mark the order handled.
 *
 * @param {object} p { applicationId, orderType, attachments:[{filename,contentType,content(base64)}], fromEmail }
 * @returns {Promise<{saved:number, deduped:number, failed:number, failedPermanent:number, failedTransient:number, suspect:number, skipped:number}>}
 */
async function saveReturnedDocs({ applicationId, orderType, attachments, fromEmail }) {
  const empty = { saved: 0, deduped: 0, failed: 0, failedPermanent: 0, failedTransient: 0, suspect: 0, skipped: 0 };
  const kind = DOC_KIND[orderType];
  if (!kind) return { ...empty };
  const list = (Array.isArray(attachments) ? attachments : []).filter((a) => a && a.filename && a.content).slice(0, MAX_RETURN_DOCS);
  if (!list.length) return { ...empty };

  let borrowerId = null;
  try {
    const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [applicationId]);
    // The file is gone or archived. PERMANENT — no redelivery brings it back, and
    // holding the order open for it would block the marker for good.
    if (!a.rows[0]) return { ...empty, failed: list.length, failedPermanent: list.length };
    borrowerId = a.rows[0].borrower_id;
  } catch (_) {
    // The lookup itself threw: the database, not the data. Retryable.
    return { ...empty, failed: list.length, failedTransient: list.length };
  }

  const itemId = await conditionItemFor(applicationId, orderType);
  let saved = 0;
  let deduped = 0;
  let failedPermanent = 0;
  let failedTransient = 0;
  let suspect = 0;   // decoded fine but the bytes don't look like the claimed type
  let skipped = 0;   // email-signature/logo images — never returned documents
  for (const a of list) {
    try {
      // Decode through the integrity chokepoint (rejects a data:-prefixed or
      // malformed payload instead of silently corrupting the file) and keep the
      // sha256 for the SharePoint integrity audit.
      let buf, sha256;
      try { ({ buf, sha256 } = decodeUploadBase64(String(a.content))); }
      // Undecodable bytes are not a transient failure — retrying cannot fix them —
      // but they are still a document the vendor believes we received, so they are
      // COUNTED. Silently returning "0 problems" is how six PDFs became four.
      catch (_) { failedPermanent += 1; console.error('[order-inbox] undecodable attachment', String(a.filename || '')); continue; }
      if (!buf.length) { failedPermanent += 1; continue; }
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
      // IDEMPOTENT FOREVER, not for 120 seconds — see alreadyFiled. This is what lets
      // file-inbox retry a delivery that half-failed instead of writing it off. A
      // lookup failure here is the DATABASE, so it is transient: filing anyway could
      // duplicate, and the retry re-checks cleanly.
      let dupId = null;
      try { dupId = await alreadyFiled({ applicationId, sha256, filename: a.filename, kind }); }
      catch (e) {
        failedTransient += 1;
        console.error('[order-inbox] could not check for a duplicate returned attachment:', (e && e.message) || e);
        continue;
      }
      // Already on the file — success, but NOT a new document. Counting it as `saved`
      // (which is what this did) overstated what came back, and re-fired the
      // "documents came back" notice on every webhook redelivery.
      if (dupId) { deduped += 1; continue; }
      const { ref, provider } = await storage.save(buf, { filename: a.filename });
      await db.query(
        // source_type='system', visibility='staff_only' — see the module header. These
        // two columns were omitted, so db/014's borrower-facing defaults applied and a
        // borrower could download the title company's wiring instructions.
        `INSERT INTO documents
           (application_id, borrower_id, checklist_item_id, filename, content_type, size_bytes,
            storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256,
            source_type, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',NULL,$9,'pending',$10,'system','staff_only')`,
        [applicationId, borrowerId, itemId, String(a.filename).slice(0, 300),
         a.contentType || 'application/octet-stream', buf.length, provider, ref, kind, sha256 || null]);
      saved += 1;
      /* AND IF THE APPRAISER JUST EMAILED US THE DATA FILE, THE MARKET DATA IN IT GOES
         TO THE RESEARCH WAREHOUSE (db/462). This is the door the report most often
         arrives through — the vendor replies to the order with the PDF and the MISMO
         XML attached — and it was filing the bytes and throwing every comparable sale
         away. Fire-and-forget, warehouse-only: it cannot affect the order, the
         condition or the loan file, and it cannot fail this filing. */
      try {
        require('./research/xml-catch').fireCatch({
          bytes: buf, filename: a.filename, contentType: a.contentType,
          why: 'a vendor emailed it back on an order',
        });
      } catch (_) { /* never let the warehouse touch an order return */ }
    } catch (e) {
      // A storage or DB failure IS transient and IS recoverable — but only if somebody
      // knows, AND only if the caller is allowed to try again. Swallowed and uncounted,
      // file-inbox marked the order handled and the webhook redelivery skipped it, so
      // the documents were gone with no log line and no sign on the file.
      failedTransient += 1;
      console.error('[order-inbox] could not file a returned attachment:', (e && e.message) || e);
    }
  }
  const failed = failedPermanent + failedTransient;

  if (saved) {
    // Move the order to 'documents_in' (only from an active state — never revive a
    // cancelled order). Best-effort.
    try {
      await db.query(
        `UPDATE file_orders SET status='documents_in', updated_at=now()
          WHERE application_id=$1 AND order_type=$2 AND status IN ('ordered','documents_in')`,
        [applicationId, orderType]);
    } catch (_) { /* best-effort */ }
    // STOP THE CLOCK ON THE VENDOR, and start it on us. `first_response_at` is
    // fill-only (the FIRST reply is the responsiveness fact a scorecard wants —
    // a later one says nothing new), and the event line is what makes the order's
    // own timeline answer "when did they finally come back?". Both best-effort:
    // the documents are filed either way, and a history one row short is a far
    // smaller problem than a webhook that failed.
    try {
      const tracking = require('./order-tracking');
      await tracking.noteFirstResponse(applicationId, orderType);
      await tracking.recordEvent({
        applicationId, orderType, kind: 'documents_in',
        detail: { saved, from: fromEmail || null, suspect: suspect || 0 },
      });
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
        // Straight to the order that has work waiting, not the top of the file.
        // A LITERAL anchor per type, never `#sec-order-${orderType}`: the link
        // contract test (test-file-stations-pure) scans this file for the anchors it
        // emits and checks each one resolves to a room, and a COMPUTED anchor is
        // unverifiable by that scan — which is precisely how two dead deep links
        // survived a green suite once already.
        link: `/internal/app/${applicationId}${orderType === 'title' ? '#sec-order-title' : '#sec-order-insurance'}`,
        ctaLabel: 'Open the loan file',
      });
    } catch (_) { /* best-effort */ }
  }
  return { saved, deduped, failed, failedPermanent, failedTransient, suspect, skipped };
}

module.exports = { saveReturnedDocs, alreadyFiled, conditionItemFor, DOC_KIND, CONDITION_CODE };
