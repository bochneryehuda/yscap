'use strict';

/**
 * Upload idempotency guard (owner-directed 2026-07-14, #87).
 *
 * Symptom: "New document uploaded" emailed TWICE in the same minute for one
 * upload. Root cause: the client POSTed the upload twice (a React double-invoke,
 * a drag-drop firing twice, or a retry on a slow request) — each POST inserted
 * its own `documents` row and fired its own notification. The fix is a
 * create-once idempotency guard (the repo's standard remedy for repeatable POST
 * endpoints): before saving/inserting, collapse a byte-identical re-upload of
 * the SAME file to the SAME context within a short window onto the already-saved
 * document, so exactly one row exists and exactly one notification fires.
 *
 * Only a still-CURRENT identical upload dedups — a real replacement (different
 * bytes, or a fresh upload after a rejection/supersede) has a different size or
 * is no longer current, so it inserts normally through the existing path.
 */
const db = require('../db');

async function recentDuplicateDocId(keys, { windowSec = 120, client = db } = {}) {
  const k = keys || {};
  if (!k.filename || !(Number(k.sizeBytes) > 0)) return null;
  // A TERM SHEET also has to carry the SAME printed stamp to count as the same
  // upload (owner-directed 2026-08-02). The INITIAL/FINAL wording is drawn into
  // the PDF, so two sheets that differ ONLY in that wording are genuinely
  // different documents — and collapsing the FINAL one onto an initial row would
  // leave the file holding a sheet whose face says "NOT FINAL" while the send
  // guard read the row as settled. Term sheets only: every other doc_kind passes
  // NULL on both sides, so this clause is a no-op for them.
  const stampClause = (k.docKind === 'term_sheet')
    ? 'AND term_sheet_final IS NOT DISTINCT FROM $12::boolean'
    : '';
  const r = await client.query(
    `SELECT id FROM documents
      WHERE is_current = true
        AND filename = $1 AND size_bytes = $2
        AND uploaded_by_kind = $3
        AND COALESCE(uploaded_by_id::text,'')   = COALESCE($4::text,'')
        AND COALESCE(application_id::text,'')    = COALESCE($5::text,'')
        AND COALESCE(checklist_item_id::text,'') = COALESCE($6::text,'')
        AND COALESCE(llc_id::text,'')            = COALESCE($7::text,'')
        AND COALESCE(track_record_id::text,'')   = COALESCE($8::text,'')
        AND COALESCE(slot_label,'')              = COALESCE($9,'')
        AND COALESCE(doc_kind,'')                = COALESCE($11,'')
        ${stampClause}
        AND created_at > now() - (($10)::text || ' seconds')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    // A placeholder Postgres never sees BINDS NOTHING — the extra parameter is
    // appended only when the clause above references it (the same params
    // discipline as the viewer-scope SQL; an unreferenced $12 fails the bind).
    [k.filename, Number(k.sizeBytes), k.uploadedByKind || null, k.uploadedById || null,
     k.applicationId || null, k.checklistItemId || null, k.llcId || null,
     k.trackRecordId || null, k.slotLabel || null, Number(windowSec), k.docKind || null,
     ...(stampClause ? [k.termSheetFinal === true] : [])]);
  return r.rows[0] ? r.rows[0].id : null;
}

module.exports = { recentDuplicateDocId };
