'use strict';
/**
 * FIT A PHOTO TO WHAT A PAGE CAN ACTUALLY SHOW — the ONE definition (owner-directed 2026-08-13).
 *
 * THE REPORT ALREADY THROWS THE PIXELS AWAY. The draw report prints an inspection photo into a
 * cell 118pt wide (1.64in; the biggest cell in the document is 160pt / 2.22in). A modern phone
 * photo is ~4,032px across, so it is embedded at roughly 2,460 DPI into a box that can show about
 * 492px at professional-print 300 DPI — jsPDF `addImage` copies the JPEG bytes in VERBATIM, so
 * every one of those pixels is carried into the file and then discarded by the renderer. Measured:
 * a 3.57 MB 4032x3024 photo becomes 256 KB at 1600px with nothing visible lost, because 1600px in
 * a 1.64in cell is still ~975 DPI.
 *
 * SO THIS IS NOT "COMPRESSION" IN THE SENSE THAT COSTS QUALITY — it is declining to carry pixels
 * the page cannot render. The FULL-QUALITY ORIGINAL IS NEVER TOUCHED: callers store this result
 * BESIDE the original (draw_media.display_ref) and the original bytes stay in PILOT exactly as the
 * inspector took them. Nothing here ever overwrites a source.
 *
 * WHY IT IS CACHED AND NEVER DONE PER REPORT BUILD: `jpeg-js` is pure JavaScript (the repo's
 * no-native-dependency rule), and decoding one 12-megapixel photo takes ~3 SECONDS and BLOCKS THE
 * EVENT LOOP. A 100-photo draw would be ~5 minutes per report — so the fit runs ONCE per photo, on
 * the archive path and the paced backfill, exactly like `lib/heic.js`. Never call this from a
 * request handler in a loop.
 *
 * THE SIX RULES, each of which exists because breaking it loses or damages a photo:
 *   1. NEVER THROWS — a failure returns the ORIGINAL buffer. Losing evidence to gain a smaller
 *      file is backwards; a draw photo is the proof the money moved against.
 *   2. JPEG ONLY. `jpeg-js` cannot decode PNG and this repo has no PNG decoder (lib/appraisal/
 *      photos.js has an ENCODER only). A PNG is returned untouched rather than guessed at.
 *   3. NEVER UPSCALES, and an already-small photo is returned BYTE-FOR-BYTE — re-encoding a JPEG
 *      that is already the right size only adds a second round of generation loss for no saving.
 *   4. NEVER RETURNS A BIGGER BUFFER. Re-encoding can grow a heavily-compressed source; if it
 *      does, the original wins.
 *   5. THE SOURCE IS BOUNDED BEFORE THE DECODE. A decode allocates width*height*4 bytes and an
 *      out-of-memory kill is NOT catchable, so an absurd source is declined rather than attempted.
 *   6. THE RESULT IS RE-READ, not assumed: the encoder's output must itself be a JPEG.
 */
const photos = require('./appraisal/photos');

// Long side, in pixels, of the copy the reports embed. 1600 is ~3.2x what the 118pt photo grid can
// show at 300 DPI and ~2.4x the 160pt attachment cell, so a reader zooming into a PDF still has
// real detail — while a 100-photo draw lands at ~25 MB instead of blowing a 60 MB ceiling at 15
// photos. Env-overridable so the number can move without a deploy.
const DISPLAY_MAX_SIDE = Math.max(320, Number(process.env.REPORT_PHOTO_MAX_SIDE) || 1600);
// JPEG quality for the re-encode. 82 is visually transparent for photographic content.
const DISPLAY_QUALITY = Math.min(95, Math.max(40, Number(process.env.REPORT_PHOTO_QUALITY) || 82));
// Refuse to decode a source above this many megapixels. jpeg-js allocates w*h*4 for the pixels, so
// 60 MP is ~240 MB of RGBA — already far beyond any camera a field inspector carries, and an OOM
// cannot be caught. Passed to the decoder too, so IT refuses rather than us guessing from a header.
const MAX_SRC_MEGAPIXELS = 60;
const MAX_DECODE_MB = 512;

function isJpeg(buf) {
  return !!buf && buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

/** Read a JPEG's pixel dimensions from its SOFn marker without decoding it. null when unreadable. */
function jpegSize(buf) {
  if (!isJpeg(buf)) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const marker = buf[i + 1];
    // Standalone markers carry no length payload.
    if (marker === 0xD8 || marker === 0xD9 || (marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15, excluding the DHT/JPG/DAC markers that share the range.
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Shrink a JPEG to `maxSide` on its long edge. Returns the ORIGINAL buffer whenever it cannot
 * confidently do better. NEVER throws.
 *
 * @returns {{buf:Buffer, changed:boolean, reason:string, from:?{w:number,h:number},
 *            to:?{w:number,h:number}, bytesBefore:number, bytesAfter:number}}
 */
function fitJpeg(buf, opts) {
  const o = opts || {};
  const maxSide = Math.max(64, Number(o.maxSide) || DISPLAY_MAX_SIDE);
  const quality = Math.min(95, Math.max(40, Number(o.quality) || DISPLAY_QUALITY));
  const original = {
    buf, changed: false, reason: '', from: null, to: null,
    bytesBefore: buf ? buf.length : 0, bytesAfter: buf ? buf.length : 0,
  };
  try {
    if (!buf || !buf.length) return { ...original, reason: 'empty' };
    // RULE 2 — a format we cannot decode is carried through untouched, never guessed at.
    if (!isJpeg(buf)) return { ...original, reason: 'not_jpeg' };

    const size = jpegSize(buf);
    // RULE 5 — bound BEFORE the decode; an OOM kill cannot be caught.
    if (size && (size.w * size.h) > MAX_SRC_MEGAPIXELS * 1e6) {
      return { ...original, reason: 'source_too_large', from: size };
    }
    // RULE 3 — already small enough: return the SAME BYTES. Re-encoding here would only add a
    // second generation of JPEG loss and could even grow the file.
    if (size && Math.max(size.w, size.h) <= maxSide) {
      return { ...original, reason: 'already_small', from: size, to: size };
    }

    const jpeg = require('jpeg-js');
    // The decoder enforces its own ceilings too, so a header that LIED about the dimensions still
    // cannot make us allocate without bound.
    const dec = jpeg.decode(buf, {
      useTArray: true,
      maxResolutionInMP: MAX_SRC_MEGAPIXELS,
      maxMemoryUsageInMB: MAX_DECODE_MB,
    });
    if (!dec || !dec.width || !dec.height || !dec.data || !dec.data.length) {
      return { ...original, reason: 'undecodable' };
    }
    const from = { w: dec.width, h: dec.height };
    // Re-check against the DECODED dimensions (the header may have been unreadable above).
    if (Math.max(from.w, from.h) <= maxSide) {
      return { ...original, reason: 'already_small', from, to: from };
    }
    // A VIEW over the decoder's own memory, never a copy — a 12 MP frame is 48 MB of RGBA and
    // copying it doubles the peak for no reason.
    const px = Buffer.from(dec.data.buffer, dec.data.byteOffset, dec.data.length);
    // ONE definition of the box filter — the same area-average resampler the appraisal photo
    // pipeline uses. Never re-implement it here.
    const ds = photos.downscale(px, from.w, from.h, 4, maxSide);
    if (!ds || !ds.w || !ds.h || !ds.px || !ds.px.length) return { ...original, reason: 'resize_failed', from };

    const enc = jpeg.encode({ data: ds.px, width: ds.w, height: ds.h }, quality);
    const out = enc && enc.data ? Buffer.from(enc.data) : null;
    // RULE 6 — trust the bytes, not the call returning.
    if (!out || !out.length || !isJpeg(out)) return { ...original, reason: 'encode_failed', from };
    // RULE 4 — a "smaller" copy that is bigger is not an improvement.
    if (out.length >= buf.length) return { ...original, reason: 'no_saving', from, to: { w: ds.w, h: ds.h } };

    return {
      buf: out,
      changed: true,
      reason: 'resized',
      from,
      to: { w: ds.w, h: ds.h },
      bytesBefore: buf.length,
      bytesAfter: out.length,
    };
  } catch (_) {
    // RULE 1 — every failure path ends here with the photo intact.
    return { ...original, reason: 'error' };
  }
}

module.exports = {
  fitJpeg,
  isJpeg,
  jpegSize,
  DISPLAY_MAX_SIDE,
  DISPLAY_QUALITY,
  MAX_SRC_MEGAPIXELS,
};
