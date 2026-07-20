'use strict';
/**
 * Location-metadata scrubber (audit F-3, owner-directed 2026-07-20).
 *
 * The borrower draw report already strips GPS from photo CAPTIONS, but the embedded photo's own EXIF can
 * still carry the capture location (the borrower's property — low sensitivity, but it should not travel in
 * a shared PDF). This removes the GPS location from a photo's bytes:
 *   • JPEG — surgically empties the EXIF GPS IFD (tag 0x8825) IN PLACE: every GPS entry and its externally
 *     stored value bytes are zeroed and the GPS IFD's entry-count is set to 0. Length is unchanged, so every
 *     other TIFF offset stays valid — Orientation and the rest of EXIF are untouched (the staff gallery keeps
 *     correct rotation; the report is a fresh render and jsPDF ignores EXIF orientation anyway).
 *   • PNG  — drops any `eXIf` chunk (self-contained; the rest of the stream is copied verbatim).
 *   • anything else (webp/gif/mp4/mov/pdf/garbage) — returned unchanged.
 *
 * PURE + dependency-free + NEVER throws: on any malformed structure it returns the ORIGINAL buffer, so a
 * caller's behavior is identical to not calling it (best-effort, like the rest of the media pipeline).
 */

// EXIF/TIFF field type → bytes per component (for computing whether a GPS value is stored inline or out-of-line).
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
const GPS_IFD_POINTER_TAG = 0x8825;

function isJpeg(b) { return b && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF; }
function isPng(b) {
  return b && b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
    b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
}

// Zero the GPS IFD at `gpsIfd` (absolute) within TIFF starting at `tiffStart`, bounded by `limit` (exclusive).
// Reads/writes are endianness-aware and fully bounds-checked. Returns true if it changed anything.
function emptyGpsIfd(buf, tiffStart, gpsIfd, limit, le) {
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const w16 = (o, v) => (le ? buf.writeUInt16LE(v, o) : buf.writeUInt16BE(v, o));
  if (gpsIfd < tiffStart || gpsIfd + 2 > limit) return false;
  const count = r16(gpsIfd);
  const entriesEnd = gpsIfd + 2 + count * 12;
  if (count < 0 || count > 4096 || entriesEnd + 4 > limit) return false; // sane cap + room for the next-IFD pointer
  for (let j = 0; j < count; j++) {
    const e = gpsIfd + 2 + j * 12;
    const type = r16(e + 2);
    const num = r32(e + 4);
    const compSize = TYPE_SIZE[type] || 1;
    const dataSize = compSize * num;
    if (dataSize > 4) {
      const valOff = tiffStart + r32(e + 8);
      if (valOff >= tiffStart && valOff + dataSize <= limit) buf.fill(0, valOff, valOff + dataSize);
    }
    buf.fill(0, e, e + 12);          // zero the entry (inline value included)
  }
  buf.fill(0, entriesEnd, entriesEnd + 4); // zero the next-IFD offset
  w16(gpsIfd, 0);                    // empty the GPS IFD — no GPS tags remain
  return true;
}

// Find the GPS IFD pointer in IFD0 and empty its target. `tiffStart` points at the 'II'/'MM' byte-order mark.
function scrubTiffGps(buf, tiffStart, limit) {
  if (tiffStart + 8 > limit) return false;
  const bom = buf.toString('ascii', tiffStart, tiffStart + 2);
  const le = bom === 'II';
  if (!le && bom !== 'MM') return false;
  const r16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const r32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (r16(tiffStart + 2) !== 42) return false;
  const ifd0 = tiffStart + r32(tiffStart + 4);
  if (ifd0 < tiffStart || ifd0 + 2 > limit) return false;
  const count = r16(ifd0);
  if (count < 0 || count > 4096 || ifd0 + 2 + count * 12 > limit) return false;
  let changed = false;
  for (let i = 0; i < count; i++) {
    const e = ifd0 + 2 + i * 12;
    if (r16(e) === GPS_IFD_POINTER_TAG) {
      const gpsIfd = tiffStart + r32(e + 8);
      if (emptyGpsIfd(buf, tiffStart, gpsIfd, limit, le)) changed = true;
      // leave the pointer entry in place — it now references an EMPTY GPS IFD, which every reader treats as
      // "no GPS". (Zeroing the tag id would risk confusing lenient parsers.)
    }
  }
  return changed;
}

function stripJpegGps(buf) {
  // Copy up front only if we actually find EXIF; walk segments on the original to decide.
  let out = null; // the working copy (allocated lazily on first EXIF hit)
  const len = buf.length;
  let i = 2; // past SOI
  while (i + 4 <= len) {
    if (buf[i] !== 0xFF) break;                 // not at a marker → malformed / entropy-coded data
    const marker = buf[i + 1];
    if (marker === 0xD9 || marker === 0xDA) break; // EOI / SOS (start of scan) — stop before compressed data
    if (marker >= 0xD0 && marker <= 0xD7) { i += 2; continue; } // RSTn (no length)
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) break;
    const payloadStart = i + 4;
    const segEnd = i + 2 + segLen;
    if (segEnd > len) break;
    if (marker === 0xE1 && payloadStart + 6 <= segEnd &&
        buf.toString('ascii', payloadStart, payloadStart + 4) === 'Exif' &&
        buf[payloadStart + 4] === 0 && buf[payloadStart + 5] === 0) {
      if (!out) out = Buffer.from(buf);
      scrubTiffGps(out, payloadStart + 6, segEnd);
    }
    i = segEnd;
  }
  return out || buf;
}

function stripPngExif(buf) {
  const len = buf.length;
  const keep = [];
  let off = 8; // past the PNG signature
  let found = false;
  while (off + 8 <= len) {
    const clen = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const chunkEnd = off + 12 + clen; // len(4) + type(4) + data(clen) + crc(4)
    if (clen < 0 || chunkEnd > len) return buf; // malformed → leave untouched
    if (type === 'eXIf') { found = true; }
    else { keep.push(buf.subarray(off, chunkEnd)); }
    if (type === 'IEND') break;
    off = chunkEnd;
  }
  if (!found) return buf;
  return Buffer.concat([buf.subarray(0, 8), ...keep]);
}

/** Remove GPS/location metadata from a photo buffer. Never throws; returns the original on any problem. */
function stripLocationExif(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 12) return buf;
    if (isJpeg(buf)) return stripJpegGps(buf);
    if (isPng(buf)) return stripPngExif(buf);
    return buf;
  } catch (_) { return buf; }
}

module.exports = { stripLocationExif, isJpeg, isPng };
