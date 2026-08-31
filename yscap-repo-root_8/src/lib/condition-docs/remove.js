'use strict';

/**
 * REMOVE A CONDITION DOCUMENT — the delete, and the supersede that is not one.
 *
 * Lifted VERBATIM out of `src/routes/staff.js`'s `DELETE /documents/:id` under
 * the 2026-08-30 share-the-code directive. Two different removals live here and
 * they must never be confused with one another:
 *
 *   • SUPERSEDE (`supersede`) is the ordinary one — the `is_current` flip.
 *     The row stays, the bytes stay, the history stays; the document simply
 *     stops being the live one. Every replacement, every one-current kind and
 *     every new version goes this way, which is why an old appraisal is still
 *     there to look at a year later. It is used by the upload door.
 *
 *   • DELETE (`removeDocument`) is the deliberate, permanent one
 *     (owner-directed 2026-07-14): a mistake-upload shouldn't linger as a "not
 *     accepted" version forever, and — critically — a deleted document must
 *     NEVER be mirrored to SharePoint (it was never needed, it's not just an old
 *     version). This hard-deletes the DB row and the stored bytes; because the
 *     SharePoint reconciler only ever mirrors documents where
 *     `sharepoint_backed_up_at IS NULL`, a doc deleted before the async sync runs
 *     is simply gone and never reaches a Version-1 folder. SharePoint's own
 *     no-delete policy is honored: no Graph delete is ever issued — if the doc
 *     had already been mirrored, that copy stays.
 *
 * Works for EVERY document surface (pipeline conditions, entity docs,
 * track-record docs, and now Long-Term loan conditions) since they all live in
 * one `documents` table, keyed by the doc id.
 *
 * `owner` is OPTIONAL and is what makes the delete safe to expose on a
 * product-scoped door: welded into the statement, a document belonging to the
 * other product is not merely refused, it is unreachable. RTL's own door has no
 * owner in its path and authorizes through `canSeeDocument`, so it passes none
 * and behaves exactly as it always has.
 */

const { ownerWhere } = require('../condition-owner');
const storage = require('../storage');
const { defaultHooks } = require('./hooks-rtl');

/** The columns the delete path reads before it removes the row. */
const REMOVE_COLUMNS =
  `id,filename,storage_provider,storage_ref,application_id,lt_loan_id,borrower_id,llc_id,
   checklist_item_id,track_record_id,review_status,is_current,sharepoint_backed_up_at`;

async function loadDocument(q, id, owner = null) {
  if (!owner) return (await q.query(`SELECT ${REMOVE_COLUMNS} FROM documents WHERE id=$1`, [id])).rows[0] || null;
  const w = ownerWhere(owner, null, 2);
  const r = await q.query(`SELECT ${REMOVE_COLUMNS} FROM documents WHERE id=$1 AND ${w.sql}`, [id, ...w.params]);
  return r.rows[0] || null;
}

/**
 * The `is_current` flip — a document stops being the live one and its pending or
 * rejected review state becomes 'superseded'. An already-ACCEPTED document keeps
 * its accepted stamp and simply drops out of "current", which is what makes a
 * superseded accepted copy fall off the sign-off gate.
 *
 * Scoped by `checklistItemId` so a replace can only ever reach a document on the
 * condition the caller named — the guard that keeps "Replace" from touching a
 * sibling slot.
 */
async function supersede(q, { documentId, checklistItemId }) {
  const r = await q.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE id=$1 AND checklist_item_id=$2`,
    [documentId, checklistItemId]);
  return { superseded: r.rowCount > 0 };
}

/**
 * PERMANENTLY delete one document.
 *
 * `hooks.beforeDelete(q, doc)` runs while the row still exists and whatever it
 * returns is handed to `hooks.afterDelete(q, doc, carried)` once it is gone —
 * that pair exists because RTL must READ a Sitewire pull's source key before the
 * CASCADE takes it and RECORD the removal after (without it the next poll
 * re-files the document forever).
 */
async function removeDocument(q, { doc, owner = null, hooks = null }) {
  const use = hooks || defaultHooks(owner);

  // Remove the stored bytes best-effort (never block the DB delete on a
  // storage hiccup). local unlinks; s3/sharepoint providers are no-op removes.
  try { if (doc.storage_ref) await storage.remove(doc.storage_ref); } catch (_) { /* orphan bytes are acceptable */ }

  const carried = use.beforeDelete ? await use.beforeDelete(q, doc) : null;

  // Hard-delete the row. Most FKs into documents are ON DELETE SET NULL
  // (borrowers.photo_id_document_id); draw_attachments.document_id CASCADES (db/507) — a
  // binding to a deleted document is meaningless — which is exactly why anything the
  // caller needed off those rows was captured above, before the delete.
  const del = owner
    ? await (async () => {
      const w = ownerWhere(owner, null, 2);
      return q.query(`DELETE FROM documents WHERE id=$1 AND ${w.sql}`, [doc.id, ...w.params]);
    })()
    : await q.query(`DELETE FROM documents WHERE id=$1`, [doc.id]);
  // An owner-scoped delete that matched nothing is a document of the OTHER
  // product. Say so rather than reporting a success that never happened.
  if (!del.rowCount) return { deleted: false };

  if (use.afterDelete) await use.afterDelete(q, doc, carried);

  // If this was the current document on a checklist condition and nothing
  // accepted remains, reopen the condition so it's re-requested (unless it was
  // already signed off — a signed-off item stays; staff can reopen it
  // explicitly). Mirrors the review path's condition handling.
  if (doc.checklist_item_id) {
    const remain = await q.query(
      `SELECT 1 FROM documents WHERE checklist_item_id=$1 AND is_current=true AND review_status='accepted' LIMIT 1`,
      [doc.checklist_item_id]);
    if (!remain.rows[0]) {
      await q.query(
        `UPDATE checklist_items SET status='outstanding', updated_at=now()
          WHERE id=$1 AND status IN ('received','issue','requested') AND signed_off_at IS NULL`,
        [doc.checklist_item_id]);
      // AWAITED here, unlike the upload/review doors — that is what the delete
      // door has always done, and the difference is preserved rather than tidied.
      if (use.conditionTouched) await use.conditionTouched(doc.checklist_item_id);
    }
  }
  return { deleted: true, wasMirrored: !!doc.sharepoint_backed_up_at };
}

module.exports = { REMOVE_COLUMNS, loadDocument, supersede, removeDocument };
