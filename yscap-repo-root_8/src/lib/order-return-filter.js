'use strict';

/**
 * EMAIL-SIGNATURE IMAGES ARE NOT RETURNED DOCUMENTS (owner-reported 2026-07-29).
 *
 * A title company replied "Received." to an order email — no documents attached —
 * and the file still announced "Title documents came back", flipped the order to
 * 'documents_in' and nudged the title condition to 'received'. ROOT CAUSE: the
 * vendor's email SIGNATURE carries tiny embedded images (the agent's logo, a
 * headshot card — the reported one was 5 KB), the mail provider reports those as
 * attachments, and the inbound path filed every attachment as a returned document.
 * The same signature images were then sitting inside the condition as "documents".
 *
 * The owner's rule: a vendor genuinely returning documents sends a PDF (or a real
 * document format), not an email-signature image. So this module is the ONE
 * classifier both inbound document sinks (order-inbox.js returned documents,
 * closing-inbox.js closing correspondence) run every attachment through before
 * filing it. Three independent tells, any one of which marks junk:
 *
 *   1. EMBEDDED in the email body — the attachment is `inline` or carries a
 *      Content-ID (it renders inside the HTML, which is exactly what a signature
 *      image is). An embedded IMAGE never files, whatever its size. Only images:
 *      some mail clients mark real PDF attachments "inline" too, so a non-image
 *      type is never judged by its disposition.
 *   2. SMALL image — a signature/logo/social icon is a few KB to a few tens of KB;
 *      a real scanned document photo is hundreds of KB at minimum. Images under
 *      IMAGE_MIN_BYTES (150 KB, env ORDER_RETURN_IMAGE_MIN_BYTES) never file.
 *   3. SVG/ICO — vector logos and favicons are never a scanned document, at any
 *      size or disposition.
 *
 * Everything else files exactly as before: a PDF of any size (the normal case),
 * Word/Excel (zip), TIFF (a scan format, deliberately NOT in the image-junk set),
 * unknown binaries, and LARGE non-embedded images (a genuine photo of a document).
 * Nothing is ever lost either way — the reply email still forwards to the team
 * with every attachment; this only gates the AUTOMATIC filing, the order-status
 * flip, the condition nudge and the "documents came back" notification.
 *
 * PURE — no DB, no network, never throws.
 */

const { sniffKind } = require('./upload-bytes');

// A real scanned-page photo is essentially never under this; signature images,
// logos and social icons essentially never over it.
const IMAGE_MIN_BYTES = (() => {
  const n = Number(process.env.ORDER_RETURN_IMAGE_MIN_BYTES);
  return Number.isFinite(n) && n >= 0 ? n : 150 * 1024;
})();

// Raster image formats a signature/logo arrives as. TIFF is deliberately ABSENT:
// it is a document-scan format, never an email-signature format.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'heic', 'heif', 'webp', 'bmp']);
const IMAGE_SNIFFS = new Set(['png', 'jpg', 'gif', 'heic']);
// Never a document, at any size.
const VECTOR_EXTS = new Set(['svg', 'ico']);

function extOf(filename) {
  const m = String(filename || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Classify one inbound attachment.
 * @param {object} a { filename, contentType, contentDisposition, contentId, buf (Buffer), sizeBytes }
 * @param {object} [opts] { imageMinBytes } — override for tests
 * @returns {{file: boolean, reason: string|null}} reason ∈ embedded_image | signature_image | vector_image
 */
function classifyReturnAttachment(a = {}, opts = {}) {
  try {
    const ct = String(a.contentType || '').toLowerCase();
    const ext = extOf(a.filename);
    const size = (a.buf && a.buf.length) || Number(a.sizeBytes) || 0;
    const minBytes = Number.isFinite(opts.imageMinBytes) ? opts.imageMinBytes : IMAGE_MIN_BYTES;

    // Vector logos / favicons: never a returned document.
    if (ct.includes('svg') || VECTOR_EXTS.has(ext)) return { file: false, reason: 'vector_image' };

    // Is this a raster IMAGE? Judge by the bytes first (a signature image named
    // "image.png" with a wrong content type is still an image), then the declared
    // type/extension. TIFF sniffs as 'tiff' and is NOT in the set — it files.
    const sniffed = a.buf ? sniffKind(a.buf) : null;
    const isImage = sniffed
      ? IMAGE_SNIFFS.has(sniffed)
      : (ct.startsWith('image/') && !ct.includes('tif')) || IMAGE_EXTS.has(ext);
    if (!isImage) return { file: true, reason: null };

    // Embedded in the email body (inline / Content-ID) = part of the message,
    // not a document someone attached. This is what a signature image is.
    const disp = String(a.contentDisposition || '').toLowerCase();
    if (disp.includes('inline') || String(a.contentId || '').trim()) {
      return { file: false, reason: 'embedded_image' };
    }

    // A small standalone image is a signature/logo; a large one may be a real
    // photo scan of a document and still files.
    if (size > 0 && size < minBytes) return { file: false, reason: 'signature_image' };
    return { file: true, reason: null };
  } catch (_) {
    // Never let classification break the inbound path — when in doubt, file it
    // (the pre-existing behavior) rather than lose a real document.
    return { file: true, reason: null };
  }
}

module.exports = { classifyReturnAttachment, IMAGE_MIN_BYTES };
