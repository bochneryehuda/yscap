'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — Phase 3b document byte loader.
 *
 * The shadow packet-control processor plans a route but, until now, never actually READ the
 * document, because the durable job payload carries no bytes (we deliberately never store a
 * document's bytes in the job row — that would bloat the queue and duplicate the file). This
 * module is the missing link: given a documentId, it loads the real bytes from the SAME storage
 * the V1 reader uses (src/lib/storage.js) and shapes them into the normalized adapter request
 * ({ buffer, base64, mimeType, filename }) the Layer-2 provider adapters expect.
 *
 * Because the V2 worker runs IN-PROCESS inside the web service (server.js boot), it can reach the
 * local-disk / configured storage directly — the same bytes V1 serves.
 *
 * GOVERNING GUARANTEES:
 *  - READ-ONLY + ADVISORY: this only READS document bytes + metadata. It writes nothing, touches
 *    no loan file, no V1 table, no frozen number. It is one half of the shadow read path.
 *  - NEVER THROWS: a missing document, a missing storage ref, or an unreadable file returns null
 *    (the processor then records the read stage as not-run) — a shadow read can never crash the
 *    worker or affect the real upload.
 */
const storage = require('../lib/storage');

/**
 * Load a document's real bytes + a normalized adapter request. Best-effort + NEVER throws.
 * Returns { documentId, filename, mimeType, buffer, base64, bytes } or null when the document /
 * its stored bytes cannot be loaded.
 *
 * @param {object} db          a pg pool/client with .query
 * @param {string} documentId  the documents.id to load
 */
async function loadDocumentBytes(db, documentId) {
  if (!db || typeof db.query !== 'function' || !documentId) return null;
  try {
    const res = await db.query(
      `SELECT id, filename, content_type, storage_ref
         FROM documents
        WHERE id = $1
        LIMIT 1`,
      [documentId],
    );
    const doc = res.rows && res.rows[0];
    if (!doc || !doc.storage_ref) return null;

    const buffer = await storage.read(doc.storage_ref);
    if (!buffer || !buffer.length) return null;

    return {
      documentId: doc.id,
      filename: doc.filename || null,
      mimeType: (doc.content_type && String(doc.content_type).trim()) || 'application/octet-stream',
      buffer,
      base64: buffer.toString('base64'),
      bytes: buffer.length,
    };
  } catch (e) {
    try { console.warn('[document-bytes] loadDocumentBytes failed:', (e && e.message) || e); } catch (_) { /* ignore */ }
    return null;
  }
}

module.exports = { loadDocumentBytes };
