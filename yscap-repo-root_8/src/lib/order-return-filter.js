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
 *   4. TOO SMALL TO BE A PAGE, or a strip (owner-reported 2026-08-03: "the small
 *      tiny pictures from the email signatures"). Read the image's own pixel
 *      dimensions out of its header: a picture whose LONG side is under
 *      IMAGE_MIN_LONG_SIDE (700px) cannot be a legible document — a US Letter
 *      page scanned at the lowest resolution anyone uses, 72 dpi, is already
 *      792px tall — and a picture wider than IMAGE_MAX_ASPECT (5:1) is a banner
 *      or a signature strip, never a page. This exists because rules 1 and 2 both
 *      have a hole: the mail provider does not always expose the inline /
 *      Content-ID metadata, and a modern @2x logo or headshot can be over 150 KB.
 *      Dimensions are the thing that is actually true about a signature image
 *      whatever its byte count, so they are judged independently of size.
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

// The smallest a real page can be. US Letter at 72 dpi — the lowest resolution
// any scanner or phone produces — is 612 x 792, so 700 sits UNDER every genuine
// page while a signature logo (a few hundred pixels at most) sits far over the
// line on the other side. A picture smaller than this is not readable as a
// document by a human either, so nothing that could be worked is lost.
const IMAGE_MIN_LONG_SIDE = (() => {
  const n = Number(process.env.ORDER_RETURN_IMAGE_MIN_PIXELS);
  return Number.isFinite(n) && n >= 0 ? n : 700;
})();
// A signature strip / email banner is long and thin. A page is not: US Letter is
// 1.29:1, legal 1.65:1, a cheque about 2.3:1 — 5:1 clears them all.
const IMAGE_MAX_ASPECT = 5;

function extOf(filename) {
  const m = String(filename || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Pixel dimensions from a raster image's own header — PNG, JPEG, GIF and BMP.
 * PURE, dependency-free, fully bounds-checked, and NEVER throws: anything it
 * cannot read confidently returns null, which means "no opinion" and leaves the
 * byte-size rule to decide. It must never be more than a reader — guessing a
 * size would throw away a real document.
 * @returns {{w:number,h:number}|null}
 */
function imageDimensions(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 16) return null;
    // PNG: an 8-byte signature, then the IHDR chunk carrying width/height big-endian.
    if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG'
      && buf.subarray(12, 16).toString('latin1') === 'IHDR' && buf.length >= 24) {
      return ok(buf.readUInt32BE(16), buf.readUInt32BE(20));
    }
    // GIF: "GIF87a"/"GIF89a", then width/height little-endian.
    if (buf.subarray(0, 4).toString('latin1') === 'GIF8' && buf.length >= 10) {
      return ok(buf.readUInt16LE(6), buf.readUInt16LE(8));
    }
    // BMP: "BM", then the DIB header's width/height little-endian (height may be
    // negative — a top-down bitmap — so take the magnitude).
    if (buf[0] === 0x42 && buf[1] === 0x4D && buf.length >= 26) {
      return ok(Math.abs(buf.readInt32LE(18)), Math.abs(buf.readInt32LE(22)));
    }
    // JPEG: walk the marker segments to the frame header (SOF0-SOF15, skipping
    // the four that are not frames), which states height then width.
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      let i = 2;
      // A frame header sits in the first few KB of every real JPEG. The walk is
      // bounded so a corrupt multi-megabyte file cannot turn a resync into a
      // byte-by-byte scan of the whole attachment.
      const end = Math.min(buf.length, 1 << 20);
      while (i + 9 < end) {
        if (buf[i] !== 0xFF) { i += 1; continue; }          // resync on padding
        const marker = buf[i + 1];
        if (marker === 0xFF) { i += 1; continue; }          // fill byte
        if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isFrame = marker >= 0xC0 && marker <= 0xCF
          && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;   // DHT / JPG / DAC
        if (isFrame) return ok(buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5));
        i += 2 + len;
      }
    }
    return null;
  } catch (_) { return null; }
  function ok(w, h) {
    return (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) ? { w, h } : null;
  }
}

/**
 * Classify one inbound attachment.
 * @param {object} a { filename, contentType, contentDisposition, contentId, buf (Buffer), sizeBytes }
 * @param {object} [opts] { imageMinBytes, imageMinLongSide } — overrides for tests
 * @returns {{file: boolean, reason: string|null}}
 *          reason ∈ embedded_image | signature_image | vector_image | tiny_image | banner_image
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

    // TOO SMALL TO BE A PAGE, or a strip. Judged on the picture's OWN pixel
    // dimensions, so it holds whatever the byte count is and whatever the
    // provider did or did not tell us about the disposition. `null` = the
    // header could not be read → no opinion, fall through to the size rule.
    const dim = a.buf ? imageDimensions(a.buf) : null;
    if (dim) {
      const minSide = Number.isFinite(opts.imageMinLongSide) ? opts.imageMinLongSide : IMAGE_MIN_LONG_SIDE;
      const long = Math.max(dim.w, dim.h);
      const short = Math.min(dim.w, dim.h);
      if (long < minSide) return { file: false, reason: 'tiny_image' };
      if (short > 0 && long / short >= IMAGE_MAX_ASPECT) return { file: false, reason: 'banner_image' };
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

module.exports = {
  classifyReturnAttachment, imageDimensions,
  IMAGE_MIN_BYTES, IMAGE_MIN_LONG_SIDE, IMAGE_MAX_ASPECT,
};
