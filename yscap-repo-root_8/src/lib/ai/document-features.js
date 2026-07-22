'use strict';
/**
 * P1 — Document feature probe for the routing matrix (ADVISORY, best-effort).
 *
 * The routing matrix (routing-matrix.js) can read a clean DIGITAL-BORN PDF's
 * native text layer directly instead of paying for OCR — but only if someone
 * tells it the PDF actually HAS a reliable native text layer. This probe answers
 * that: given a PDF's bytes it extracts the embedded text with unpdf (Mozilla
 * pdf.js, pure JS, no native deps — already used by the appraisal photo
 * extractor) and reports how much native text there is per page. A scanned PDF
 * has a near-empty text layer; a digital-born PDF has a dense one.
 *
 * It also flags an appraisal that arrives AS a MISMO/XML document — the matrix
 * prefers parsing that XML over OCR (exact, no misread).
 *
 * NEVER throws (a bad/locked/huge PDF returns hasNativeText:false so the matrix
 * safely falls back to OCR) and NEVER blocks the caller for long — it caps the
 * bytes it will open and swallows every error. Purely a feature reading; it
 * changes no decision.
 */

// Don't open a PDF larger than this just to sniff its text layer (the OCR path
// handles big scans anyway). Matches the appraisal extractor's spirit.
const MAX_PROBE_BYTES = 25 * 1024 * 1024;

function isPdf(mimeType, buf) {
  const m = String(mimeType || '').toLowerCase();
  if (m.indexOf('pdf') !== -1) return true;
  // Magic bytes: '%PDF'
  return !!(buf && buf.length >= 4 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
}
function isXml(mimeType, filename) {
  const m = String(mimeType || '').toLowerCase();
  if (m.indexOf('xml') !== -1) return true;
  return /\.xml$/i.test(String(filename || ''));
}

/**
 * detectFeatures({ buffer|base64, mimeType, docType, filename }) →
 *   { mimeType, pageCount, hasNativeText, nativeTextChars, appraisalXmlPresent }
 * All fields are best-effort; on any failure hasNativeText is false.
 */
async function detectFeatures(args = {}) {
  const out = {
    mimeType: args.mimeType || null,
    pageCount: null,
    hasNativeText: false,
    nativeTextChars: 0,
    appraisalXmlPresent: false,
  };

  let buf = args.buffer;
  if (!buf && args.base64) {
    try { const { decodeUploadBase64 } = require('../upload-bytes'); buf = decodeUploadBase64(args.base64).buf; }
    catch (_) { buf = null; }
  }

  // Appraisal delivered as XML → the matrix should parse the XML, not OCR.
  if (args.docType === 'appraisal' && isXml(args.mimeType, args.filename)) {
    out.appraisalXmlPresent = true;
  }

  if (!buf || !isPdf(args.mimeType, buf) || buf.length > MAX_PROBE_BYTES) return out;

  try {
    const { getDocumentProxy, extractText } = await import('unpdf');
    const bytes = new Uint8Array(buf);
    const pdf = await getDocumentProxy(bytes);
    out.pageCount = Number(pdf.numPages) || null;
    const res = await extractText(pdf, { mergePages: true });
    const text = res && typeof res.text === 'string' ? res.text : (Array.isArray(res && res.text) ? res.text.join('\n') : '');
    const chars = String(text || '').replace(/\s+/g, '').length;
    out.nativeTextChars = chars;
    // "Reliable" is decided by the matrix (chars-per-page threshold); we just
    // report the raw counts + that a text layer exists at all.
    out.hasNativeText = chars > 0;
  } catch (_) {
    // Locked / corrupt / unsupported → leave hasNativeText false (OCR fallback).
  }
  return out;
}

module.exports = { detectFeatures, _internals: { isPdf, isXml }, MAX_PROBE_BYTES };
