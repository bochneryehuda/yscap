/**
 * Chat attachments — any file sent in a conversation (photo, video, voice
 * note, PDF, document) is stored through the same storage backend + documents
 * table as formal uploads, so it inherits the persistent disk, size caps, and
 * download authorization. Returns { documentId, kind, size }.
 */
const db = require('../db');
const cfg = require('../config');
const storage = require('./storage');

function kindOf(contentType, filename) {
  const ct = String(contentType || '').toLowerCase();
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.startsWith('audio/')) return 'audio';
  if (ct === 'application/pdf' || /\.pdf$/i.test(filename || '')) return 'pdf';
  return 'file';
}

// `channel` decides visibility: an attachment on the borrower channel is
// borrower-visible; anything on an internal (staff-only) channel is locked to
// staff and MUST never reach a borrower surface. source_type='chat_attachment'
// keeps these out of the borrower document library (they render inside chat).
async function saveChatAttachment({ applicationId, borrowerId, filename, contentType, dataBase64, byKind, byId, channel }) {
  const buf = Buffer.from(String(dataBase64 || ''), 'base64');
  if (!buf.length) { const e = new Error('empty attachment'); e.status = 400; throw e; }
  const max = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > max) { const e = new Error(`attachment too large (max ${cfg.maxUploadMb} MB)`); e.status = 413; throw e; }
  const visibility = channel === 'borrower' ? 'borrower' : 'staff_only';
  const { ref, provider } = await storage.save(buf, { filename });
  const r = await db.query(
    `INSERT INTO documents (application_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,source_type,visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'chat_attachment',$10) RETURNING id`,
    [applicationId || null, borrowerId || null, String(filename || 'attachment').slice(0, 300),
     contentType || 'application/octet-stream', buf.length, provider, ref, byKind, byId, visibility]);
  try { require('./sharepoint-backup').kick(); } catch (_) { /* mirror is best-effort */ }
  return { documentId: r.rows[0].id, kind: kindOf(contentType, filename), size: buf.length };
}

module.exports = { saveChatAttachment, kindOf };
