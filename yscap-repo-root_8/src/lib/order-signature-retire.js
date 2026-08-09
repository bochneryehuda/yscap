'use strict';

/**
 * PREVIOUS FILES for the email-signature filter (owner-reported 2026-08-03:
 * "the small tiny pictures from the email signatures of the reply agent … is
 * still coming in as documents and we still need to manually reject it on every
 * file — maybe it's still from the past").
 *
 * WHY THE OWNER IS STILL SEEING THEM. Two changes landed hours apart on 2026-08-02
 * and between them they put every signature image the system had EVER filed in
 * front of the team at once:
 *
 *   · `order-return-filter.js` (the 2026-07-29 fix) stops a vendor's signature
 *     logo becoming a returned document — GOING FORWARD ONLY. Every image filed
 *     before it shipped was still sitting in `documents`, exactly where it was.
 *   · `db/420` + the file screen then made those old rows VISIBLE: the migration
 *     attaches every orphaned order return to its title / insurance condition,
 *     and the condition began rendering the documents that are not in a slot.
 *
 * So the filter worked and the complaint was still true: nothing had ever cleaned
 * up what the pre-filter months had already filed, and the team was rejecting the
 * same images by hand, one file at a time. This pass is that missing half — the
 * repo's standing "previous AND future" rule applied to the July fix.
 *
 * IT IS JAVASCRIPT, NOT A MIGRATION, ON PURPOSE. The decision is made by calling
 * `classifyReturnAttachment` — the SAME function the two inbound sinks run on a
 * live attachment — so "what is a signature image" has ONE definition. A PL/pgSQL
 * twin of that rule would drift from it the first time the rule changed (the
 * `pilot_term_norm` / `pilot_property_type_norm` class this codebase has already
 * been bitten by twice).
 *
 * WHAT IT DOES TO A ROW, and why that is the honest state:
 *   is_current = false  — the picture is not part of the current file. That one
 *     column is what every surface already reads: the condition's document list,
 *     the Orders desk's returned-documents list, the closing chain's box, the
 *     TPR / closing packages (accepted + current), and db/420's own re-attach
 *     predicate — so this cannot be undone by the next boot's migrations.
 *   review_status = 'superseded' — only when nobody has decided yet. It is a
 *     DECIDED state (`document-acceptance.isAwaiting`), so the condition can be
 *     signed off without a human clicking Reject on a company logo; and it is
 *     deliberately NOT 'rejected', because the condition row displays the newest
 *     REJECTED document's reason and a logo must never become the reason a
 *     borrower is shown. A human's own accept or reject is never overwritten.
 *
 * NOTHING IS DELETED. The bytes stay in storage, the row stays on the file with
 * its provenance intact (doc_kind still says it came back on the insurance
 * order, checklist_item_id still says which condition), the SharePoint mirror
 * keeps its copy — and because `sharepoint-shelf` reads is_current FIRST, that
 * copy is shelved into "Old Versions" rather than sitting in the live folder.
 * Every retirement writes an audit row on the file, so the one place the change
 * is recorded is the file's own audit log. Pressing Accept still restores it.
 *
 * SAFE BY CONSTRUCTION — it can only ever touch a raster image (never a PDF,
 * never a TIFF scan) that nobody has accepted and nobody has filed into a slot.
 * Bounded per boot, self-draining (a retired row no longer matches), never
 * throws. Off-switch: ORDER_SIGNATURE_RETIRE_DISABLED=1.
 */

const db = require('../db');
const storage = require('./storage');
const { classifyReturnAttachment } = require('./order-return-filter');
// Which order type a returned document belongs to — the ONE mapping, shared with
// order-inbox and the Orders desk.
const { RETURN_DOC_KIND } = require('./order-slots');

// The three doc kinds an inbound email can file on its own. A human upload is
// deliberately out of scope: somebody chose that file.
const INBOUND_KINDS = ['title_order_return', 'insurance_order_return', 'closing_correspondence'];

// Read the bytes only when they could plausibly be a signature image — that is
// what lets the pixel-dimension rule run on the back book too. Anything larger
// is not a logo, so the read would be pure cost.
const READ_BYTES_UNDER = 2 * 1024 * 1024;

const RETIRE_REASON = 'email signature image';

// RESUMABLE, because most candidates are KEPT. A genuine photo scan of a page is
// an image on an order return too, so it matches the candidate query forever —
// without a cursor those rows would be re-read from storage on every boot and,
// once there were more of them than the per-boot limit, they would starve the
// newer rows behind them out of the pass entirely (a silent cap).
const STATE_KEY = 'order_signature_retire_cursor';

async function readCursor() {
  try {
    const r = await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [STATE_KEY]);
    const v = r.rows[0] && r.rows[0].value;
    return (v && v.afterCreatedAt && v.afterId) ? v : null;
  } catch (_) { return null; }
}
async function writeCursor(row) {
  try {
    await db.query(
      `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1,$2::jsonb,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      // created_at is carried as TEXT straight out of Postgres. A round trip
      // through a JS Date truncates timestamptz's microseconds, which makes the
      // stored cursor sort BEFORE the row it names — so every row would compare
      // greater and the pass would re-examine the whole page on the next boot.
      [STATE_KEY, JSON.stringify({ afterCreatedAt: row.created_at_txt, afterId: row.id })]);
  } catch (_) { /* best-effort — the worst case is re-examining these rows */ }
}

/** doc_kind → order type, from the one shared mapping rather than a second copy. */
const ORDER_TYPE_OF_KIND = Object.freeze(Object.fromEntries(
  Object.entries(RETURN_DOC_KIND).map(([type, kind]) => [kind, type])));

/**
 * TAKE BACK A "THE VENDOR DELIVERED" THAT THIS PASS JUST INVALIDATED.
 *
 * `order-inbox` flips an order to 'documents_in' and stamps `first_response_at`
 * when ANY attachment files, so an order that turned over on what we now know was
 * a signature strip is left claiming the vendor answered. With the image retired
 * it then reads "waiting on us" with nothing to classify, the desk's Chase button
 * is withheld (that needs 'ordered'), and the overdue ladder emails the team "N
 * days of documents waiting to be filed" every two days — escalating to the
 * administrators — about nothing at all.
 *
 * NARROW BY CONSTRUCTION, in three ways that all have to hold:
 *   · only for the two VENDOR order types. The attorney order's chain is running
 *     correspondence, not a delivery, and its status is not a promise about
 *     documents.
 *   · only when NOTHING current is left on that order. One real commitment
 *     alongside the logo means the vendor did answer, and the order stays put.
 *   · only from 'documents_in'. A completed or cancelled order is a human's
 *     decision and is never rewritten by a cleanup pass.
 *
 * `first_response_at` goes back to NULL with it, because that column is the
 * vendor's responsiveness score and a signature image is not a response.
 * Best-effort: this must never fail the retirement it follows.
 */
async function unwindEmptyDelivery(applicationId, docKind) {
  const orderType = ORDER_TYPE_OF_KIND[String(docKind || '')];
  if (!orderType || !applicationId) return false;
  try {
    const r = await db.query(
      `UPDATE file_orders o
          SET status = 'ordered', first_response_at = NULL, updated_at = now()
        WHERE o.application_id = $1 AND o.order_type = $2
          AND o.status = 'documents_in'
          AND NOT EXISTS (
            SELECT 1 FROM documents d
             WHERE d.application_id = o.application_id
               AND d.doc_kind = $3::text
               AND d.is_current = true)
      RETURNING o.id`, [applicationId, orderType, docKind]);
    if (!r.rows[0]) return false;
    await require('./order-tracking').recordEvent({
      applicationId, orderType, kind: 'note', orderId: r.rows[0].id,
      detail: { note: 'the only returned document was an email-signature image — still waiting on the vendor' },
    });
    return true;
  } catch (e) {
    console.error('[order-signature-retire] could not unwind an empty delivery:', (e && e.message) || e);
    return false;
  }
}

/**
 * One bounded pass.
 * @param {object} [opts] { limit }
 * @returns {Promise<{scanned:number, retired:number, kept:number, skipped?:boolean}>}
 */
async function retireSignatureImagesOnce({ limit = 200 } = {}) {
  if (process.env.ORDER_SIGNATURE_RETIRE_DISABLED === '1') return { scanned: 0, retired: 0, kept: 0, skipped: true };
  const n = Math.max(1, Math.min(2000, Number(limit) || 200));
  const cursor = await readCursor();
  let rows;
  try {
    // CANDIDATES are selected broadly — anything that LOOKS like a picture — and
    // the verdict is left to the shared classifier below. The SQL never decides.
    const args = [INBOUND_KINDS, n];
    let after = '';
    if (cursor) {
      after = ` AND (d.created_at, d.id) > ($3::timestamptz, $4::uuid)`;
      args.push(cursor.afterCreatedAt, cursor.afterId);
    }
    const r = await db.query(
      `SELECT d.id, d.application_id, d.doc_kind, d.filename, d.content_type, d.size_bytes,
              d.storage_ref, d.review_status, d.created_at::text AS created_at_txt
         FROM documents d
        WHERE d.doc_kind = ANY($1)
          AND d.is_current = true
          AND d.slot_label IS NULL
          AND COALESCE(d.review_status,'pending') <> 'accepted'
          AND (lower(COALESCE(d.content_type,'')) LIKE 'image/%'
               OR d.filename ~* '\\.(png|jpe?g|gif|bmp|webp|heic|heif|svg|ico)$')${after}
        ORDER BY d.created_at ASC, d.id ASC
        LIMIT $2`, args);
    rows = r.rows;
  } catch (e) {
    console.error('[order-signature-retire] could not read candidates:', (e && e.message) || e);
    return { scanned: 0, retired: 0, kept: 0 };
  }

  let retired = 0;
  let kept = 0;
  // The cursor may only advance past a row whose verdict is FINAL. A row we kept
  // because its bytes could not be read this boot is not settled — a transient
  // storage failure must not permanently exempt it from the pixel rule.
  let settled = null;
  let stalled = false;
  for (const row of rows) {
    try {
      // The bytes make the verdict as strong as it is on a live attachment (the
      // pixel rule needs a header). A read failure is not a reason to guess —
      // the classifier simply decides on the metadata, as it always could.
      const size = Number(row.size_bytes) || 0;
      const wantBytes = size > 0 && size < READ_BYTES_UNDER && !!row.storage_ref;
      let buf = null;
      if (wantBytes) {
        try { buf = await storage.read(row.storage_ref); } catch (_) { buf = null; }
        if (!Buffer.isBuffer(buf) || !buf.length) buf = null;
      }
      const cls = classifyReturnAttachment({
        filename: row.filename, contentType: row.content_type,
        sizeBytes: row.size_bytes, buf: buf || undefined,
      });
      // Settled = there is nothing more this pass could ever learn about the row.
      // Bytes we WANTED and could not read leave it unsettled, so a transient
      // storage failure cannot permanently exempt it from the pixel rule.
      const final = () => { if (!stalled) settled = row; };
      if (cls.file) { if (!wantBytes || buf) final(); else stalled = true; kept += 1; continue; }

      // Pinned to is_current=true so a concurrent human action wins, and the
      // review status is only DECIDED for a row nobody has decided on.
      const upd = await db.query(
        `UPDATE documents
            SET is_current = false,
                review_status = CASE WHEN COALESCE(review_status,'pending') = 'pending'
                                     THEN 'superseded' ELSE review_status END
          WHERE id = $1 AND is_current = true
          RETURNING id`, [row.id]);
      if (!upd.rows.length) { final(); kept += 1; continue; }   // a human moved it first — settled either way
      retired += 1;
      final();
      // AN ORDER MUST NOT BE LEFT WAITING ON DOCUMENTS THAT ARE NO LONGER THERE.
      // `order-inbox` flips an order to 'documents_in' and stamps
      // `first_response_at` when ANY attachment files, so an order that turned over
      // on what we now know was a signature strip is left claiming the vendor
      // delivered. It then sits on the desk reading "waiting on us" with nothing to
      // classify, the Chase button withheld (that needs 'ordered'), and — since the
      // order desk grew a chasing ladder — the team emailed "N days of documents
      // waiting to be filed" every two days, escalating to the administrators,
      // about nothing. The vendor's scorecard keeps credit for the "delivery" too.
      // Only put back what THIS retirement invalidated: an order with no returned
      // document left standing.
      if (row.application_id) await unwindEmptyDelivery(row.application_id, row.doc_kind);
      // The row is off every screen now, so the audit log is the only place that
      // says it was ever here. Best-effort — it may never reverse the retirement.
      try {
        await db.query(
          `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
           VALUES ('system', NULL, 'order_signature_image_retired', 'document', $1, $2::jsonb)`,
          [row.id, JSON.stringify({
            applicationId: row.application_id || null,
            filename: row.filename, sizeBytes: row.size_bytes,
            reason: cls.reason, what: RETIRE_REASON,
          })]);
      } catch (_) { /* best-effort */ }
    } catch (e) {
      stalled = true;   // an unexplained failure is never settled — look again next boot
      console.error('[order-signature-retire] skipped a document:', (e && e.message) || e);
    }
  }
  if (settled) await writeCursor(settled);
  if (retired) {
    console.log(`[order-signature-retire] retired ${retired} email-signature image(s) that had been filed as returned documents (${kept} candidate(s) kept).`);
  }
  return { scanned: rows.length, retired, kept };
}

module.exports = { retireSignatureImagesOnce, INBOUND_KINDS, RETIRE_REASON };
