'use strict';
/**
 * HEIC → JPEG, at ONE chokepoint (owner-directed 2026-08-10: "the photos are in HEIC format,
 * the iPhone format… we need to add our site to be able to read this format").
 *
 * WHY CONVERT AT ALL. Every iPhone shoots HEIC by default, and a construction-draw workflow runs
 * on phone photos — but no browser renders HEIC, no email client previews it, and jsPDF (the
 * branded draw reports) can only embed JPEG/PNG. So a HEIC photo stored verbatim is a photo
 * nobody can open anywhere it matters. The fix is to convert ONCE, where the bytes ENTER PILOT,
 * so every downstream surface (previews, reports, emails, SharePoint, the investor package)
 * receives a format the whole world reads.
 *
 * WHY THIS SHAPE:
 *  - The decoder (`heic-convert` — pure JS + WASM, no native build, so Render's plain
 *    `npm install` stays clean) is LAZY-required: nothing on the request path pays for it until a
 *    HEIC actually arrives, and a deployment where the module is somehow missing degrades to
 *    "store the original" rather than crashing an upload.
 *  - `maybeConvert` NEVER throws. A failed conversion returns the ORIGINAL bytes — a photo we
 *    cannot convert is still evidence and must still be stored; only the preview convenience is
 *    lost. Losing the photo to gain a preview would be backwards.
 *  - Detection is by the BYTES (ISO-BMFF `ftyp` + a still-image brand), never a filename or a
 *    client-declared content type — the same vendor-header-not-evidence rule as every sniff here.
 *  - A conversion is bounded (`MAX_INPUT_BYTES`) so a mislabelled multi-hundred-MB file can't sit
 *    on the WASM decoder for minutes inside a request.
 */

const MAX_INPUT_BYTES = 40 * 1024 * 1024;   // a real iPhone photo is 1–5 MB; 40 MB is already absurd
const JPEG_QUALITY = 0.82;                  // visually lossless for documentation photos

/** Are these bytes a HEIC/HEIF still image? (Video brands — mp4/mov — deliberately do NOT match.) */
function isHeic(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf.subarray(4, 8).toString('latin1') !== 'ftyp') return false;
  return /^(heic|heix|heif|hevc|hevx|mif1|msf1)/.test(buf.subarray(8, 12).toString('latin1'));
}

/**
 * Convert HEIC bytes to JPEG. Anything that is not HEIC — or cannot be converted — comes back
 * UNCHANGED with `converted:false`, so callers can wire this in-line with zero risk:
 *
 *   const c = await heic.maybeConvert(buf);
 *   buf = c.buf; if (c.converted) { ct = 'image/jpeg'; filename = heic.jpegName(filename); }
 */
async function maybeConvert(buf) {
  if (!isHeic(buf)) return { buf, converted: false };
  if (buf.length > MAX_INPUT_BYTES) return { buf, converted: false, reason: 'too large to convert' };
  let convert;
  try { convert = require('heic-convert'); }
  catch (_) { return { buf, converted: false, reason: 'converter not installed' }; }
  try {
    const out = Buffer.from(await convert({ buffer: buf, format: 'JPEG', quality: JPEG_QUALITY }));
    // A converted photo must actually BE a JPEG — a decoder handing back something else is a
    // failure, and the original is the safer thing to keep.
    if (!out || out.length < 4 || out[0] !== 0xff || out[1] !== 0xd8) return { buf, converted: false, reason: 'bad output' };
    return { buf: out, converted: true };
  } catch (e) {
    return { buf, converted: false, reason: (e && e.message) || 'convert failed' };
  }
}

/** "IMG_0042.HEIC" → "IMG_0042.jpg" (the stored copy is a JPEG now, and its name must say so). */
function jpegName(filename) {
  const s = String(filename || 'photo');
  return /\.(heic|heif)$/i.test(s) ? s.replace(/\.(heic|heif)$/i, '.jpg') : `${s}.jpg`;
}

module.exports = { isHeic, maybeConvert, jpegName, MAX_INPUT_BYTES };
