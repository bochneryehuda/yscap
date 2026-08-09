'use strict';
/**
 * SUPPORTING DOCUMENTS ON A DRAW — invoices, receipts and extra photos
 * (owner-directed 2026-08-09: "when we override something, we should be able to add invoices,
 * receipts, or additional photos, and that should also be delivered to the investor on investor
 * delivery. Anything that's added on there for a certain draw should be saved as a PDF, pictures,
 * anything. It should be part of the investor delivery.")
 *
 * THE GAP. Every override on a draw took a typed note and nothing else — approving more than the
 * borrower requested, releasing more than was approved, amending, reopening. So the PROOF behind
 * the decision lived in somebody's inbox and never reached the investor who funds it.
 *
 * THE BYTES ARE ORDINARY `documents` ROWS (doc_kind='draw_support'), so they inherit the upload
 * chokepoint, the duplicate guard, the file's document list and the SharePoint mirror for free.
 * `draw_attachments` is ONLY the per-draw binding, because `documents` has a deliberately
 * mutually-exclusive owner set and a draw is none of those. `draw_media` — the inspector's
 * archived photos — is untouched and answers a different question (db/170: a `documents` row per
 * inspection photo "would flood the file's SharePoint folder"; these are a handful of real loan
 * documents a human chose to add, which SHOULD be there).
 *
 * BORN ACCEPTED, STAFF-ONLY BY DEFAULT. A staff upload here is somebody deliberately filing proof
 * on a draw, so it is `review_status='accepted'` at the INSERT — the same treatment db/186/189
 * already give appraisal photos and PILOT's own generated documents, and what lets it travel to
 * the investor without a second human pressing Accept on their own upload (db/424: nothing
 * un-accepted leaves the building). A BORROWER's upload is NOT born accepted: it is somebody
 * outside the company adding a document, and a reviewer decides.
 *
 * EVERY UPLOAD GOES THROUGH THE SHARED CHOKEPOINTS, never a private one: `decodeUploadBase64`
 * (which alone stops the data:-URL mis-decode that silently garbles a file), a magic-byte sniff so
 * the type comes from the BYTES and not the client, `stripLocationExif` on every image, and
 * `recentDuplicateDocId` so a double-submit does not send the investor two copies of one invoice.
 *
 * Never throws out of the read helpers — a draw card missing its attachments list is a smaller
 * problem than a draw card that will not load.
 */

const db = require('../db');
const storage = require('../lib/storage');
const { decodeUploadBase64, sniffKind } = require('../lib/upload-bytes');
const { stripLocationExif } = require('../lib/image-exif');
const { recentDuplicateDocId } = require('../lib/doc-dedup');

const DOC_KIND = 'draw_support';
const CATEGORIES = ['invoice', 'receipt', 'photo', 'other'];
const MAX_BYTES = 25 * 1024 * 1024;      // one loan document; the investor package has its own budget
const MAX_PER_CALL = 10;

const CATEGORY_LABEL = {
  invoice: 'Invoice',
  receipt: 'Receipt',
  photo: 'Photo',
  other: 'Supporting document',
};

/**
 * What kind of file is this, from its own bytes? Returns a content type, or null when it is not
 * something a loan file should carry.
 *
 * The list is deliberately SHORT and closed: the documents a draw actually carries are a PDF, a
 * photo, or a scan/spreadsheet of an invoice. Anything else — an HTML page, an SVG, a script, an
 * archive — is refused rather than stored, because these are attached to an outgoing email and
 * served back to staff, and "we did not recognise it" must never become "so we stored it anyway".
 */
function sniffDocMime(buf) {
  if (!buf || !buf.length) return null;
  const head = buf.subarray(0, 12);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && head.subarray(0, 8).toString('latin1') === '\x89PNG\r\n\x1a\n') return 'image/png';
  if (head.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (buf.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // HEIC: an ISO-BMFF `ftyp` box whose MAJOR BRAND is a still-image brand. The bare `ftyp` match
  // also catches MP4/MOV, so the brand is checked rather than a video being mislabelled a photo.
  if (buf.length >= 12 && head.subarray(4, 8).toString('latin1') === 'ftyp'
      && /^(heic|heix|heif|hevc|hevx|mif1|msf1)/.test(head.subarray(8, 12).toString('latin1'))) return 'image/heic';
  // A ZIP container — .xlsx / .docx, how a scanned invoice or a contractor's estimate often arrives.
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
    const k = (() => { try { return sniffKind(buf); } catch (_) { return null; } })();
    if (k === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    if (k === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return null;                                  // a bare zip is not a loan document
  }
  return null;
}

const isImage = (ct) => /^image\//.test(String(ct || ''));

/** The draw this attachment belongs to. The two id spaces are never interchangeable. */
function drawRef(ref = {}) {
  if (ref.sitewireDrawId != null && /^\d+$/.test(String(ref.sitewireDrawId))) {
    return { col: 'sitewire_draw_id', value: String(ref.sitewireDrawId) };
  }
  if (ref.portalRequestId != null && /^\d+$/.test(String(ref.portalRequestId))) {
    return { col: 'portal_request_id', value: String(ref.portalRequestId) };
  }
  return null;
}

/**
 * Attach one or more files to a draw.
 *
 *   items   [{ filename, dataBase64, contentType?, category?, note? }]
 *   ref     { sitewireDrawId } | { portalRequestId }
 *   by      { kind:'staff'|'borrower', id }
 *   supports  one plain sentence saying WHAT this backs up ("approved $2,400 over requested")
 *
 * Returns { added:[{id, document_id, filename, category}], skipped:[{what, reason}] }.
 *
 * NOTHING IS EVER SILENTLY DROPPED: a file that is too big, unreadable, of a type a loan file does
 * not carry, or a duplicate of one already on this draw comes back in `skipped` WITH A REASON, so
 * the person who attached it is told rather than left believing it went through.
 */
async function attach(appId, ref, items, { by = { kind: 'staff', id: null }, supports = null } = {}) {
  const out = { added: [], skipped: [] };
  const r = drawRef(ref);
  if (!appId || !r) { out.skipped.push({ what: 'all', reason: 'no draw was named' }); return out; }
  const list = Array.isArray(items) ? items : [items];
  const byKind = by && by.kind === 'borrower' ? 'borrower' : 'staff';

  if (list.length > MAX_PER_CALL) {
    for (const extra of list.slice(MAX_PER_CALL)) {
      out.skipped.push({ what: String((extra && extra.filename) || 'file'), reason: `only ${MAX_PER_CALL} files can be attached at a time` });
    }
  }

  for (const it of list.slice(0, MAX_PER_CALL)) {
    const name = String((it && it.filename) || 'attachment').slice(0, 180);
    if (!it || typeof it !== 'object' || !it.dataBase64) { out.skipped.push({ what: name, reason: 'no file was uploaded' }); continue; }

    let buf, sha256;
    try { ({ buf, sha256 } = decodeUploadBase64(it.dataBase64, { maxBytes: MAX_BYTES })); }
    catch (e) {
      out.skipped.push({ what: name, reason: /too large|maxBytes|413/i.test(String(e && e.message)) ? `it is larger than ${Math.round(MAX_BYTES / 1024 / 1024)} MB` : 'the file could not be read' });
      continue;
    }
    if (!buf || !buf.length) { out.skipped.push({ what: name, reason: 'the file was empty' }); continue; }

    // The type comes from the BYTES. A client-declared content type is never trusted — that is how
    // an HTML page ends up stored as a PDF and served back inline.
    const ct = sniffDocMime(buf);
    if (!ct) { out.skipped.push({ what: name, reason: 'that file type is not accepted here — attach a PDF, a photo, or an invoice document' }); continue; }
    if (isImage(ct)) { try { buf = stripLocationExif(buf, ct) || buf; } catch (_) { /* keep the original */ } }

    // A double-submit, or a retry after a timeout, must not send the investor two copies of one
    // invoice. The shared duplicate guard answers on the file; the unique index on
    // draw_attachments.document_id is the belt-and-suspenders underneath.
    try {
      // The guard's key is (file, name, size, uploader, kind) within its own short window — the
      // same shape every other upload path passes it. `sizeBytes` is required: without it the
      // helper answers null and the guard silently does nothing.
      const dupId = await recentDuplicateDocId({
        applicationId: appId, filename: name, sizeBytes: buf.length,
        uploadedByKind: byKind, uploadedById: (by && by.id) || null, docKind: DOC_KIND,
      });
      if (dupId) {
        const already = (await db.query(`SELECT id FROM draw_attachments WHERE document_id=$1`, [dupId])).rows[0];
        if (already) { out.skipped.push({ what: name, reason: 'that file is already attached to this draw' }); continue; }
      }
    } catch (_) { /* the guard is an optimisation; the index below is the guarantee */ }

    let saved;
    try { saved = await storage.save(buf, { filename: name }); }
    catch (_) { out.skipped.push({ what: name, reason: 'the file could not be stored — please try again' }); continue; }

    const category = CATEGORIES.includes(String(it.category || '')) ? String(it.category) : (isImage(ct) ? 'photo' : 'other');

    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      // Born ACCEPTED for a staff upload (somebody deliberately filing proof), PENDING for a
      // borrower's (somebody outside the company adding a document — a reviewer decides).
      const doc = (await client.query(
        `INSERT INTO documents
           (application_id, filename, content_type, size_bytes, storage_provider, storage_ref,
            uploaded_by_kind, uploaded_by_id, doc_kind, review_status, sha256, source_type, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [appId, name, ct, buf.length, saved.provider, saved.ref, byKind, by && by.id ? by.id : null,
          DOC_KIND, byKind === 'staff' ? 'accepted' : 'pending', sha256 || null,
          // `source_type` is a governed enum (documents_source_type_check) — a value outside it
          // fails the whole insert, which the caller would only ever see as "it could not be filed".
          byKind === 'staff' ? 'staff_upload' : 'borrower_upload',
          byKind === 'staff' ? 'staff_only' : 'borrower'])).rows[0];
      const att = (await client.query(
        `INSERT INTO draw_attachments (application_id, ${r.col}, document_id, category, note, supports, uploaded_by_kind, uploaded_by_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [appId, r.value, doc.id, category, it.note ? String(it.note).slice(0, 1000) : null,
          supports ? String(supports).slice(0, 500) : null, byKind, by && by.id ? by.id : null])).rows[0];
      await client.query('COMMIT');
      out.added.push({ id: att.id, document_id: doc.id, filename: name, category, content_type: ct, size_bytes: buf.length });
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      out.skipped.push({ what: name, reason: e && e.code === '23505' ? 'that file is already attached to this draw' : 'it could not be filed — please try again' });
    } finally { client.release(); }
  }
  return out;
}

/**
 * Everything attached to one draw, oldest first. Returns [] on any failure.
 * `documentsOnly` narrows to attachments whose document still exists and is current.
 */
async function listFor(appId, ref) {
  try {
    const r = drawRef(ref);
    if (!appId || !r) return [];
    return (await db.query(
      `SELECT da.id, da.document_id, da.category, da.note, da.supports, da.uploaded_by_kind, da.created_at,
              d.filename, d.content_type, d.size_bytes, d.review_status, d.is_current
         FROM draw_attachments da JOIN documents d ON d.id = da.document_id
        WHERE da.application_id=$1 AND da.${r.col}=$2 AND d.is_current
        ORDER BY da.created_at ASC, da.id ASC`, [appId, r.value])).rows;
  } catch (_) { return []; }
}

/** Every attachment across a file's draws, for the whole-project report. Returns [] on failure. */
async function listForFile(appId) {
  try {
    if (!appId) return [];
    return (await db.query(
      `SELECT da.id, da.document_id, da.sitewire_draw_id, da.portal_request_id, da.category, da.note,
              da.supports, da.uploaded_by_kind, da.created_at,
              d.filename, d.content_type, d.size_bytes, d.review_status,
              sd.number AS draw_number
         FROM draw_attachments da
         JOIN documents d ON d.id = da.document_id
         LEFT JOIN sitewire_draws sd ON sd.sitewire_draw_id = da.sitewire_draw_id
        WHERE da.application_id=$1 AND d.is_current
        ORDER BY da.created_at ASC, da.id ASC`, [appId])).rows;
  } catch (_) { return []; }
}

/**
 * Remove one attachment. The BYTES are not deleted — the `documents` row stays on the file (and in
 * SharePoint, which never deletes) exactly as it would if it had been filed anywhere else; only
 * the binding to this draw is removed, so it stops travelling to the investor. Staff only.
 */
async function detach(appId, attachmentId) {
  try {
    const r = await db.query(`DELETE FROM draw_attachments WHERE id=$1 AND application_id=$2 RETURNING document_id`, [attachmentId, appId]);
    return { removed: !!r.rowCount, documentId: r.rows[0] && r.rows[0].document_id };
  } catch (_) { return { removed: false }; }
}

/**
 * One short sentence naming what a set of attachments is — for the investor email body and the
 * report's section header, so the reader knows what arrived without opening anything.
 * Returns null when there is nothing to describe.
 */
function summarize(rows) {
  const list = (rows || []).filter(Boolean);
  if (!list.length) return null;
  const counts = new Map();
  for (const a of list) {
    const k = CATEGORIES.includes(String(a.category)) ? String(a.category) : 'other';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const parts = [];
  for (const k of CATEGORIES) {
    const c = counts.get(k);
    if (!c) continue;
    const noun = CATEGORY_LABEL[k].toLowerCase();
    parts.push(`${c} ${c === 1 ? noun : (k === 'photo' ? 'photos' : noun + 's')}`);
  }
  return parts.join(', ');
}

module.exports = {
  DOC_KIND, CATEGORIES, CATEGORY_LABEL, MAX_BYTES, MAX_PER_CALL,
  attach, listFor, listForFile, detach, summarize,
  _internals: { sniffDocMime, drawRef, isImage },
};
