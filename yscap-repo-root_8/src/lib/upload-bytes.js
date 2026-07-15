'use strict';

/**
 * THE upload-decoding chokepoint (owner-directed 2026-07-15, corruption root
 * fix). Every server path that turns a client's `dataBase64` into bytes MUST
 * go through decodeUploadBase64() — never a bare Buffer.from(x, 'base64').
 *
 * Why this exists: Node's base64 decoder silently SKIPS invalid characters.
 * If a client ever sends a full `data:application/pdf;base64,JVBERi…` URL
 * (instead of the raw base64 the contract requires), the prefix's valid
 * base64 letters ("data", "application", …) shift the 4-character alignment
 * of the ENTIRE payload — every byte of the decoded file is garbage, the
 * file opens nowhere (verified: '%PDF' appears at no offset in the decode).
 * The same silent-skip corrupts payloads with stray junk characters. A file
 * corrupted this way at ingest is then faithfully mirrored to SharePoint as
 * garbage — "the document is corrupted, it won't open".
 *
 * Rules enforced here, once, for every upload path:
 *  1. A `data:…;base64,` prefix is STRIPPED (defense in depth — the portal's
 *     normalizeUpload() already strips it client-side, but any other client,
 *     an old cached bundle, or an integration must not be able to corrupt).
 *  2. Whitespace is removed (RFC 2045 line-wrapped base64 stays valid).
 *  3. URL-safe base64 (-/_) is accepted and normalized.
 *  4. Anything ELSE that is not base64 is REJECTED with a 400-style error —
 *     never silently skipped into a garbled file.
 *  5. An empty decode is rejected (a zero-byte "document" is always a bug).
 *
 * Returns { buf, sha256 } — the sha256 (hex) travels with the bytes so save
 * paths can stamp documents.sha256 without re-hashing.
 */

const crypto = require('crypto');

const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/**
 * Normalize a client-supplied base64 payload to strict standard base64.
 * Throws (status 400) on anything that is not cleanly decodable.
 */
function normalizeBase64String(input) {
  let s = String(input == null ? '' : input);
  // 1) strip a data: URL wrapper if one slipped through
  if (/^data:/i.test(s)) {
    const comma = s.indexOf(',');
    if (comma < 0) throw badRequest('invalid file data (data: URL without payload)');
    s = s.slice(comma + 1);
  }
  // 2) whitespace (line-wrapped base64, trailing newlines) is legal — remove it
  s = s.replace(/\s+/g, '');
  // 3) percent-encoded commas/plus from sloppy form encodings
  if (/^%[0-9a-f]{2}/i.test(s)) s = decodeURIComponent(s);
  // 4) URL-safe alphabet → standard
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!s) throw badRequest('empty file data');
  // 5) strict validation — reject rather than let Node silently skip chars
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) {
    throw badRequest('invalid file data (not base64) — upload the raw base64 bytes, not a data: URL or text');
  }
  if (s.length % 4 === 1) throw badRequest('invalid file data (truncated base64)');
  return s;
}

/**
 * Decode a client upload to bytes, strictly.
 * opts.maxBytes — optional hard cap (throws 413-style error above it).
 */
function decodeUploadBase64(input, opts = {}) {
  const clean = normalizeBase64String(input);
  const buf = Buffer.from(clean, 'base64');
  if (!buf.length) throw badRequest('empty file');
  if (opts.maxBytes && buf.length > opts.maxBytes) {
    const e = new Error(`file too large (max ${Math.floor(opts.maxBytes / (1024 * 1024))} MB)`);
    e.status = 413;
    throw e;
  }
  return { buf, sha256: sha256hex(buf) };
}

/**
 * Best-effort magic-byte sniff of common document types — used by the
 * integrity audit to flag files that were ALREADY garbage when they were
 * uploaded (e.g. an HTML error page saved as ".pdf" from a e-sign portal).
 * Returns a short tag or null when unrecognized.
 */
function sniffKind(buf) {
  if (!buf || buf.length < 4) return null;
  const head = buf.subarray(0, 8);
  if (head.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf';
  if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return 'png';
  if (head[0] === 0xFF && head[1] === 0xD8 && head[2] === 0xFF) return 'jpg';
  if (head[0] === 0x50 && head[1] === 0x4B) return 'zip';           // docx/xlsx/zip
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (buf.length >= 12 && buf.subarray(4, 12).toString('latin1').startsWith('ftyp')) return 'heic';
  if (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2A) return 'tiff';
  if (head[0] === 0x4D && head[1] === 0x4D && head[2] === 0x00) return 'tiff';
  const text = buf.subarray(0, 256).toString('latin1').trimStart().toLowerCase();
  if (text.startsWith('<!doctype html') || text.startsWith('<html')) return 'html';
  return null;
}

/** What we'd EXPECT from the filename/content type, for mismatch flagging. */
function expectedKind(filename, contentType) {
  const ct = String(contentType || '').toLowerCase();
  const ext = (String(filename || '').match(/\.([a-z0-9]{1,8})$/i) || [, ''])[1].toLowerCase();
  if (ct.includes('pdf') || ext === 'pdf') return 'pdf';
  if (ct.includes('png') || ext === 'png') return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg') || ext === 'jpg' || ext === 'jpeg') return 'jpg';
  if (ext === 'docx' || ext === 'xlsx' || ext === 'pptx' || ct.includes('officedocument')) return 'zip';
  if (ct.includes('zip') || ext === 'zip') return 'zip';
  if (ct.includes('gif') || ext === 'gif') return 'gif';
  if (ext === 'heic' || ext === 'heif' || ct.includes('heic') || ct.includes('heif')) return 'heic';
  if (ext === 'tif' || ext === 'tiff' || ct.includes('tiff')) return 'tiff';
  if (ct.includes('html') || ext === 'html' || ext === 'htm') return 'html';
  return null;
}

module.exports = { decodeUploadBase64, normalizeBase64String, sniffKind, expectedKind, sha256hex };
