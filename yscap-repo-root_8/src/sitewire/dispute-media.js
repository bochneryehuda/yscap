'use strict';

// SINGLE DEFINITION of borrower/broker DISPUTE-EVIDENCE normalization: turn freshly-uploaded photo
// bytes into DURABLE stored copies, GPS-stripped, size/count-capped, with the image type derived
// from the BYTES — never the client's declared content-type (a borrower/broker-supplied
// 'image/svg+xml' / 'text/html' served inline is stored XSS against the staff who open the
// evidence, audit H1 on the borrower route).
//
// This lived INLINE in the BORROWER draw routes; it is now shared so the BORROWER portal and the
// TPO (broker) portal store dispute evidence IDENTICALLY and can never drift. This is the
// security-critical sniff / strip / cap layer — exactly the place a divergence between an
// authenticated borrower and an external broker would open a hole. We only ever accept real
// uploads ({filename, dataBase64, contentType}); a client-supplied storage ref is NEVER honored
// (that would let an actor point at someone else's stored file).
const storage = require('../lib/storage');
const { decodeUploadBase64, sniffKind } = require('../lib/upload-bytes');
const { stripLocationExif } = require('../lib/image-exif');

const EVIDENCE_MAX_PER_LINE = 8;
const EVIDENCE_MAX_BYTES = 12 * 1024 * 1024;

// The REAL image type from the bytes' magic number. Returns a safe image mime, or null to REJECT
// (svg / html / pdf / zip / unknown all sniff to something we don't allow → dropped, never stored).
function sniffImageMime(buf) {
  const k = sniffKind(buf);
  if (k === 'png') return 'image/png';
  if (k === 'jpg') return 'image/jpeg';
  if (k === 'gif') return 'image/gif';
  if (buf && buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // HEIC: an ISO-BMFF `ftyp` box whose MAJOR BRAND is a HEIF still-image brand. sniffKind's plain
  // `ftyp` match also catches MP4/MOV video, so verify the brand here rather than mislabel a video
  // as a HEIC image. A video attached as photo evidence is simply not stored.
  if (buf && buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp'
      && /^(heic|heix|heif|hevc|hevx|mif1|msf1)/.test(buf.subarray(8, 12).toString('latin1'))) return 'image/heic';
  return null;
}

// Normalize dispute evidence into DURABLE stored copies. Each image has its GPS stripped (privacy)
// and is capped in size + count. Returns [{storage_ref, storage_provider, filename, content_type,
// kind, bytes}] — durable refs the caller stores on the dispute line (never a client-supplied ref).
async function normalizeDisputeMedia(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const m of items.slice(0, EVIDENCE_MAX_PER_LINE)) {
    if (!m || typeof m !== 'object' || !m.dataBase64) continue;   // only accept real uploads
    let buf;
    try { buf = decodeUploadBase64(m.dataBase64, { maxBytes: EVIDENCE_MAX_BYTES }).buf; } catch (_) { continue; }  // {buf, sha256}; caps size (413)
    if (!buf || !buf.length) continue;
    // Derive the type from the BYTES, not the client. Anything that isn't a real photo (svg / html /
    // pdf / unknown) is rejected here so a malicious "image" can never be stored or served inline.
    const ct = sniffImageMime(buf);
    if (!ct) continue;
    try { buf = stripLocationExif(buf, ct) || buf; } catch (_) { /* keep original on any failure */ }
    let saved;
    try { saved = await storage.save(buf, { filename: m.filename || 'evidence' }); } catch (_) { continue; }
    out.push({ storage_ref: saved.ref, storage_provider: saved.provider, filename: String(m.filename || 'evidence').slice(0, 180), content_type: ct, kind: 'image', bytes: buf.length });
  }
  return out;
}

module.exports = { sniffImageMime, normalizeDisputeMedia, EVIDENCE_MAX_PER_LINE, EVIDENCE_MAX_BYTES };
