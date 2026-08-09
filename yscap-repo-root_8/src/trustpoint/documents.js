'use strict';
/**
 * TrustPoint DOCUMENT + PHOTO archive (owner-directed 2026-07-27).
 *
 * TrustPoint hands every document to us as a PRE-SIGNED S3 link that expires in about a day
 * (`X-Amz-Expires≈86400`). Whatever is not pulled promptly is gone for good. This module pulls
 * them the moment we hear about a draw and files them where the desk and the borrower can
 * actually reach them:
 *
 *   · the DRAW REPORT (`/draw_requests/{id}/report/`) and every per-draw document
 *     (`/draw_requests/{id}/documents/` — "Inspection Result Document", "Service Invoice", …)
 *     become `documents` rows tied to THIS draw number, staff-only, idempotent by filename;
 *   · the inspector's PHOTOS become `draw_media` rows, so the branded PILOT report embeds them
 *     from OUR storage and can never break on an expired link.
 *
 * WHY THE PHOTOS COME OUT OF A PDF: TrustPoint publishes no photo endpoint. Verified against
 * the live account — every document on both the project and its draws is `application/pdf`.
 * The inspector's photos are embedded INSIDE the Inspection Result PDF (that file is ~6.7 MB
 * for a reason). Pulling them back out is mechanical and exact: an embedded JPEG in a PDF is a
 * raw DCTDecode stream whose bytes literally begin with the JPEG SOI marker, so we copy bytes
 * between known markers — no decoding, no layout inference, no guessing. That is deliberately
 * NOT true of the per-line dollar amounts in the same PDF, which would require reconstructing
 * table columns from per-character coordinates; those are left alone (see
 * docs/trustpoint/LINE-ITEM-SYNC-FINDINGS-2026-07-27.md).
 *
 * A re-inspection files a SECOND report with its own photos. Both sets are kept and stamped
 * with the document's own type + timestamp, so a revision is visible rather than silently
 * overwriting the first.
 *
 * Everything here is best-effort and idempotent: it can never block, reverse, or un-notify a
 * draw reaction. Off-switch `TRUSTPOINT_ARCHIVE_ENABLED=0`.
 */

const crypto = require('crypto');
// DB / API client are lazy so the PURE extractor (`extractJpegs`) unit-tests with no Postgres
// and no network — the same discipline as src/sitewire/draw-report.js.
const lazy = { get db() { return require('../db'); }, get client() { return require('./client'); } };

// Budgets — an inspection report can carry ~100 photos; keep one draw's pull bounded.
const MAX_PHOTOS_PER_DOC = 120;
const MIN_PHOTO_BYTES = 8 * 1024;          // skip logos/icons/spacers, keep real photographs
const PHOTO_BYTE_BUDGET = 60 * 1024 * 1024;
const MAX_DOC_BYTES = 40 * 1024 * 1024;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const enabled = () => process.env.TRUSTPOINT_ARCHIVE_ENABLED !== '0';

/**
 * Embedded JPEGs in a PDF are raw DCTDecode streams: the bytes between `stream` and
 * `endstream` begin with FFD8FF (SOI) and run to FFD9 (EOI). We copy that range verbatim.
 * PURE — a Buffer in, an array of Buffers out. No PDF parsing, no font tables, no guesswork.
 */
function extractJpegs(buf, { max = MAX_PHOTOS_PER_DOC, minBytes = MIN_PHOTO_BYTES } = {}) {
  const out = [];
  if (!Buffer.isBuffer(buf) || buf.length < 4) return out;
  let i = 0;
  while (out.length < max) {
    const s = buf.indexOf('stream', i);
    if (s < 0) break;
    let st = s + 6;
    if (buf[st] === 0x0D) st++;
    if (buf[st] === 0x0A) st++;
    const e = buf.indexOf('endstream', st);
    if (e < 0) break;
    if (buf[st] === 0xFF && buf[st + 1] === 0xD8 && buf[st + 2] === 0xFF) {
      let end = e;
      // trim back to the EOI marker so trailing whitespace never rides along
      while (end > st + 2 && !(buf[end - 2] === 0xFF && buf[end - 1] === 0xD9)) end--;
      const img = buf.slice(st, end > st + 2 ? end : e);
      if (img.length >= minBytes) out.push(img);
    }
    i = e + 9;
  }
  return out;
}

/** The application + TrustPoint ids for a draw we already mirror (null when unknown). */
async function drawContext(tpDrawId) {
  const r = await lazy.db.query(
    `SELECT application_id, tp_project_id, tp_draw_id, number, status,
            GREATEST(COALESCE(approved_at, to_timestamp(0)), COALESCE(completed_at, to_timestamp(0)),
                     COALESCE(submitted_at, to_timestamp(0)), COALESCE(tp_created_at, to_timestamp(0))) AS activity_at
       FROM trustpoint_draws WHERE tp_draw_id=$1`,
    [tpDrawId]);
  return r.rows[0] || null;
}

/** Store one PDF as a staff-only `documents` row tied to this draw. Idempotent by filename. */
async function storeDocument(appId, drawNumber, tpDrawId, doc, bytes) {
  const storage = require('../lib/storage');
  const label = String(doc.document_type || 'Document').replace(/[^A-Za-z0-9 ]+/g, '').trim() || 'Document';
  const stamp = String(doc.created_at || '').slice(0, 10) || 'undated';
  const drawTag = drawNumber != null ? `draw-${drawNumber}` : `draw-${String(tpDrawId).slice(0, 8)}`;
  // The document id keeps a re-inspection's SECOND report from colliding with the first.
  const idTag = String(doc.id || sha256(bytes).slice(0, 12)).slice(0, 12);
  const filename = `trustpoint-${drawTag}-${label.toLowerCase().replace(/\s+/g, '-')}-${stamp}-${idTag}.pdf`;

  const dup = (await lazy.db.query(
    `SELECT id FROM documents WHERE application_id=$1 AND filename=$2 AND is_current`, [appId, filename])).rows[0];
  if (dup) return { documentId: dup.id, stored: false };

  const saved = await storage.save(bytes, { filename, contentType: doc.mime_type || 'application/pdf' });
  const borrower = (await lazy.db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [appId])).rows[0];
  try {
    const row = (await lazy.db.query(
      `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes,
          storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id, doc_kind, source_type,
          visibility, is_current, review_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',NULL,'draw_inspection_report','system','staff_only',true,'accepted')
       RETURNING id`,
      [appId, borrower ? borrower.borrower_id : null, filename, doc.mime_type || 'application/pdf',
       bytes.length, saved.provider, saved.ref])).rows[0];
    return { documentId: row.id, stored: true };
  } catch (e) {
    if (e.code === '23505') {   // a concurrent pass won the filename — reuse its row
      const other = (await lazy.db.query(
        `SELECT id FROM documents WHERE application_id=$1 AND filename=$2 AND is_current`, [appId, filename])).rows[0];
      if (other) return { documentId: other.id, stored: false };
    }
    throw e;
  }
}

/** Store the photos found in one document. Idempotent per (draw, image bytes). */
async function storePhotos(appId, tpDrawId, doc, images) {
  const storage = require('../lib/storage');
  const { stripLocationExif } = require('../lib/image-exif');
  let stored = 0, budget = PHOTO_BYTE_BUDGET;
  for (let n = 0; n < images.length; n++) {
    let bytes = images[n];
    if (bytes.length > budget) break;
    // GPS out at the door — a borrower-visible report must never carry the inspector's
    // coordinates (the same rule the Sitewire media archive follows).
    try { bytes = stripLocationExif(bytes) || bytes; } catch (_) { /* keep the original */ }
    // Keyed on the IMAGE bytes, so a re-inspection that re-uses a photo stores it once while
    // genuinely new photographs are added — both sets survive, neither is duplicated.
    const key = sha256(bytes);
    const filename = `tp-draw-${String(tpDrawId).slice(0, 8)}-photo-${key.slice(0, 10)}.jpg`;
    try {
      const saved = await storage.save(bytes, { filename, contentType: 'image/jpeg' });
      const ins = await lazy.db.query(
        `INSERT INTO draw_media (application_id, trustpoint_draw_id, kind, source_url, source_key,
            storage_provider, storage_ref, content_type, bytes, sha256, tp_document_type, tp_document_at)
         VALUES ($1,$2,'image',$3,$4,$5,$6,'image/jpeg',$7,$8,$9,$10)
         ON CONFLICT DO NOTHING RETURNING id`,
        [appId, tpDrawId, String(doc.file || '').slice(0, 2000), key, saved.provider, saved.ref,
         bytes.length, key, doc.document_type || null, doc.created_at || null]);
      if (ins.rows[0]) { stored++; budget -= bytes.length; }
    } catch (e) { /* one bad photo never stops the pull */ }
  }
  return stored;
}

/**
 * Pull and file EVERYTHING TrustPoint holds for one draw: the draw report, every per-draw
 * document, and the photos inside them. Safe to call repeatedly — every write is idempotent.
 */
async function archiveDrawEverything(tpDrawId, { includePhotos = true } = {}) {
  if (!enabled()) return { skipped: 'off' };
  const mirror = require('./mirror');
  const ctx = await drawContext(tpDrawId);
  if (!ctx || !ctx.application_id) return { skipped: 'unknown_draw' };
  const { application_id: appId, tp_project_id: projectId, number } = ctx;

  const items = [];
  try {
    const list = await lazy.client.call(
      `${String(process.env.TRUSTPOINT_PATH_PREFIX || '/public-api').replace(/\/+$/, '')}` +
      `/projects/${projectId}/draw_requests/${tpDrawId}/documents/`, { query: { limit: 100 } });
    for (const d of (Array.isArray(list && list.results) ? list.results : [])) items.push(d);
  } catch (e) { /* the report below may still be reachable */ }
  try {
    const rep = await lazy.client.getDrawReport(projectId, tpDrawId);
    if (rep && rep.file) items.push({ ...rep, document_type: rep.document_type || 'Draw Report' });
  } catch (e) { /* a draw with no report yet is normal, not an error */ }

  let docs = 0, photos = 0, failed = 0;
  for (const doc of items) {
    if (!doc || !doc.file) continue;
    let bytes = null;
    try {
      bytes = await mirror._fetchDocumentBytes(doc.file);
    } catch (e) {
      failed++;
      console.warn(`[trustpoint] document pull failed (${doc.document_type || '?'}): ${e && e.message}`);
      continue;
    }
    if (!bytes || !bytes.length || bytes.length > MAX_DOC_BYTES) { failed++; continue; }
    try {
      const r = await storeDocument(appId, number, tpDrawId, doc, bytes);
      if (r.stored) docs++;
      // Only the inspection paperwork carries photographs; an invoice does not.
      if (includePhotos && /inspection|report/i.test(String(doc.document_type || ''))) {
        photos += await storePhotos(appId, tpDrawId, doc, extractJpegs(bytes));
      }
    } catch (e) {
      failed++;
      console.warn(`[trustpoint] document store failed: ${e && e.message}`);
    }
  }
  if (docs || photos) console.log(`[trustpoint] archived draw ${number == null ? tpDrawId : '#' + number}: ${docs} document(s), ${photos} photo(s)`);
  return { ok: true, documents: docs, photos, failed, seen: items.length };
}

// How long after a draw last moved a retry is still worth attempting. TrustPoint's document
// links are pre-signed and expire in about a day; the window is deliberately a little wider so
// a service outage spanning a night is still covered, and it is what makes the retry
// SELF-LIMITING — no counter, no schema, and it can never loop on an old draw forever.
const ARCHIVE_RETRY_DAYS = 3;

/**
 * RETRY an archive that never landed.
 *
 * archiveDrawEverything fires exactly once — on the APPROVED transition and on the inspection's
 * COMPLETED claim — and it counts a failed pull into `failed` and moves on. Since the links
 * expire in about a day, one network blip or one TrustPoint hiccup at that moment lost the
 * inspection report AND its photographs permanently, with nothing to notice or repair it. The
 * owner asked for the reports to save themselves and for the photos to be pulled in; a
 * one-shot pull does not deliver that.
 *
 * "Incomplete" is read from the DATA (this draw has no archived document) rather than from a
 * stored attempt counter, so nothing has to be migrated and the state can never drift from
 * reality. Re-running is safe by construction: storeDocument dedupes on the content hash and
 * storePhotos is ON CONFLICT DO NOTHING, so a retry that races the original stores nothing
 * twice. Best-effort and silent — it must never delay or break a mirror pass.
 */
async function archiveDrawIfIncomplete(tpDrawId) {
  if (!enabled()) return { skipped: 'off' };
  const ctx = await drawContext(tpDrawId);
  if (!ctx || !ctx.application_id) return { skipped: 'unknown_draw' };
  // Only the two states where the archive actually fires. A DRAFT or IN_REVIEW draw has no
  // inspection paperwork by definition, so retrying one is pure API burn.
  if (ctx.status !== 'APPROVED' && ctx.status !== 'COMPLETED') return { skipped: 'not_ready' };
  // Already have something for this draw — the archive landed, nothing to redo.
  if ((await documentsFor(ctx.application_id, tpDrawId, ctx.number)).length) return { skipped: 'archived' };
  const at = ctx.activity_at ? new Date(ctx.activity_at).getTime() : NaN;
  if (!Number.isFinite(at)) return { skipped: 'no_date' };
  const ageDays = (Date.now() - at) / 86400000;
  // Past the window the links are dead, so a retry would only burn API calls forever. A draw
  // dated in the FUTURE (a clock skew) is treated as current rather than skipped.
  if (ageDays > ARCHIVE_RETRY_DAYS) return { skipped: 'too_old' };

  // HOURLY BACK-OFF. The draw poll runs every 5 minutes, so an approved draw whose documents
  // TrustPoint has genuinely not produced yet would otherwise be re-listed ~860 times across
  // the window. The claim is a single conditional UPDATE, so two overlapping passes cannot
  // both win it, and the row is written before the attempt — a crash mid-pull costs one hour,
  // never a hot loop.
  const key = `tp_archive_retry:${tpDrawId}`;
  const claimed = (await lazy.db.query(
    `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1, '{}'::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET updated_at = now()
      WHERE sync_runtime_state.updated_at < now() - interval '1 hour'
     RETURNING key`, [key])).rowCount === 1;
  if (!claimed) return { skipped: 'backoff' };

  const r = await archiveDrawEverything(tpDrawId);
  // Nothing left to retry — drop the marker so these rows cannot accumulate for ever.
  if (r && r.ok && r.documents > 0) {
    await lazy.db.query(`DELETE FROM sync_runtime_state WHERE key=$1`, [key]).catch(() => {});
  }
  return r;
}

/** The archived photos for a TrustPoint draw, newest document first (for the branded report). */
async function photosFor(tpDrawId, limit = 40) {
  const r = await lazy.db.query(
    `SELECT id, storage_provider, storage_ref, content_type, bytes, tp_document_type, tp_document_at
       FROM draw_media
      WHERE trustpoint_draw_id=$1 AND kind='image'
      ORDER BY tp_document_at DESC NULLS LAST, id ASC
      LIMIT $2`, [tpDrawId, limit]);
  return r.rows;
}

/**
 * The archived staff documents for a TrustPoint draw, newest first.
 *
 * The predicate MUST mirror storeDocument's own naming, and it did not: it searched for the
 * draw's UUID prefix, while storeDocument names a numbered draw `trustpoint-draw-2-…` and only
 * falls back to the id for a draw with no number. So on every ordinary draw this matched
 * nothing at all — it had no callers, so nobody saw it, and it would have silently reported
 * "nothing archived" the moment one was added. The tag is now built the same way in both
 * places, and the LIKE is ANCHORED with the trailing `-` so draw 1 cannot swallow draw 10.
 */
async function documentsFor(appId, tpDrawId, drawNumber) {
  let n = drawNumber;
  if (n === undefined) {
    const c = await drawContext(tpDrawId);
    n = c ? c.number : null;
  }
  const tag = n != null ? `draw-${n}` : `draw-${String(tpDrawId).slice(0, 8)}`;
  const r = await lazy.db.query(
    `SELECT id, filename, size_bytes, created_at FROM documents
      WHERE application_id=$1 AND is_current AND doc_kind='draw_inspection_report'
        AND filename LIKE 'trustpoint-' || $2 || '-%'
      ORDER BY created_at DESC`, [appId, tag]);
  return r.rows;
}

module.exports = {
  archiveDrawEverything, archiveDrawIfIncomplete, extractJpegs, photosFor, documentsFor,
  _storeDocument: storeDocument, _storePhotos: storePhotos, _drawContext: drawContext,
};
