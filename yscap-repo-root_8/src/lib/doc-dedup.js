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
        AND created_at > now() - (($10)::text || ' seconds')::interval
      ORDER BY created_at DESC
      LIMIT 1`,
    [k.filename, Number(k.sizeBytes), k.uploadedByKind || null, k.uploadedById || null,
     k.applicationId || null, k.checklistItemId || null, k.llcId || null,
     k.trackRecordId || null, k.slotLabel || null, Number(windowSec), k.docKind || null]);
  return r.rows[0] ? r.rows[0].id : null;
}

module.exports = { recentDuplicateDocId };
