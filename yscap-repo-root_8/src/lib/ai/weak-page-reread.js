'use strict';
/**
 * P1 — Weak-page RE-READ + splice (ADVISORY, best-effort).
 *
 * The owner's routing example: "Pages 1-3 confidence 98%, page 4 confidence 63%
 * → re-read page 4 using Mistral OCR. The system should NOT reread the entire
 * document because one page is weak." This module does exactly that: given the
 * pages a read came back weak on, it slices ONLY those pages out of the source
 * PDF, re-OCRs that small sub-PDF with a different (challenger) engine, and
 * splices the better text back onto just those pages — leaving every good page
 * untouched.
 *
 * Pure splice core (`spliceReread`) + a best-effort orchestrator
 * (`rereadWeakPages`) whose PDF-slice and OCR steps are injected so it unit-tests
 * with no pdf-lib / no OCR keys. NEVER throws and NEVER blocks — any failure
 * returns the original pages unchanged. Advisory: it improves the read; it
 * changes no decision.
 */
const { slicePdfPages } = require('../underwriting/pdf-slice');

// Sort + dedupe a page-number list ascending (matches how slicePdfPages orders
// the sub-PDF it builds, so sub-page i ↔ sortedWeak[i]).
function sortWeak(weakPages) {
  const seen = new Set();
  const out = [];
  for (const p of weakPages || []) {
    const n = Math.trunc(Number(p));
    if (Number.isFinite(n) && n >= 1 && !seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out.sort((a, b) => a - b);
}

/**
 * spliceReread(originalPages, rereadByPage) → { pages, text, replaced }.
 * Replaces a weak page's text with the re-read text ONLY when the re-read
 * produced real (non-empty) text. Every non-weak page is copied through
 * untouched. `rereadByPage` maps ORIGINAL pageNumber → { text, confidence? }.
 * The merged whole-document `text` is the pages re-joined in order.
 */
function spliceReread(originalPages, rereadByPage) {
  const map = rereadByPage || {};
  const replaced = [];
  const pages = (originalPages || []).map((p) => {
    const pageNumber = p && p.pageNumber != null ? Number(p.pageNumber) : null;
    const rr = pageNumber != null ? map[pageNumber] : null;
    if (rr && typeof rr.text === 'string' && rr.text.trim()) {
      replaced.push(pageNumber);
      return Object.assign({}, p, {
        text: rr.text,
        rereadEngine: rr.engine || null,
        rereadConfidence: rr.confidence != null ? rr.confidence : null,
        wasReread: true,
      });
    }
    return p;
  });
  const text = pages.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n');
  return { pages, text, replaced };
}

/**
 * rereadWeakPages({ buffer|base64, weakPages, engine, read, slice }) →
 *   { attempted, ok, replaced, pages?, text?, reason? }.
 * Best-effort. `read(engine, {buffer})` re-OCRs the sub-PDF; `slice(buf, pages)`
 * builds it (both injectable — default to the real pdf-slice + the passed
 * reader). NEVER throws; on any problem returns { ok:false } and the caller keeps
 * the original read.
 *
 * @param {object} args
 *   originalPages  the primary read's per-page array (spliced into)
 *   weakPages      1-based page numbers to re-read
 *   engine         the challenger engine name to re-read with
 *   read           async (engine, {buffer}) → { ok, text?, pages? }
 *   slice          async (buf, pages) → { ok, buf?, pages? }  (default pdf-slice)
 */
async function rereadWeakPages(args = {}) {
  const originalPages = Array.isArray(args.originalPages) ? args.originalPages : [];
  const weak = sortWeak(args.weakPages);
  if (!weak.length) return { attempted: false, ok: false, reason: 'no weak pages', replaced: [] };
  if (typeof args.read !== 'function') return { attempted: false, ok: false, reason: 'no reader', replaced: [] };

  let buf = args.buffer;
  if (!buf && args.base64) {
    try { const { decodeUploadBase64 } = require('../upload-bytes'); buf = decodeUploadBase64(args.base64).buf; }
    catch (_) { buf = null; }
  }
  if (!buf) return { attempted: false, ok: false, reason: 'no source bytes', replaced: [] };

  try {
    const sliceFn = typeof args.slice === 'function' ? args.slice : slicePdfPages;
    const sliced = await sliceFn(buf, weak);
    if (!sliced || !sliced.ok || !sliced.buf) return { attempted: true, ok: false, reason: (sliced && sliced.reason) || 'slice failed', replaced: [] };
    // The sub-PDF's pages are in ascending order of the actually-in-range pages.
    const subPageToOriginal = Array.isArray(sliced.pages) ? sliced.pages : weak;

    const rr = await args.read(args.engine, { buffer: sliced.buf });
    if (!rr || !rr.ok) return { attempted: true, ok: false, reason: (rr && rr.reason) || 're-read failed', replaced: [] };

    // Map each sub-PDF page result back to its ORIGINAL page number.
    const byPage = {};
    const rrPages = Array.isArray(rr.pages) ? rr.pages : [];
    if (rrPages.length) {
      rrPages.forEach((p, i) => {
        const orig = subPageToOriginal[i];
        if (orig != null && p && typeof p.text === 'string' && p.text.trim()) {
          byPage[orig] = { text: p.text, confidence: p.confidence != null ? p.confidence : null, engine: rr.engine || args.engine || null };
        }
      });
    } else if (subPageToOriginal.length === 1 && typeof rr.text === 'string' && rr.text.trim()) {
      // A single-weak-page re-read whose engine returned only whole-doc text.
      byPage[subPageToOriginal[0]] = { text: rr.text, confidence: null, engine: rr.engine || args.engine || null };
    }

    if (!Object.keys(byPage).length) return { attempted: true, ok: false, reason: 're-read produced no usable page text', replaced: [] };
    const merged = spliceReread(originalPages, byPage);
    return { attempted: true, ok: merged.replaced.length > 0, replaced: merged.replaced, pages: merged.pages, text: merged.text, engine: args.engine || null };
  } catch (e) {
    return { attempted: true, ok: false, reason: (e && e.message) || 're-read error', replaced: [] };
  }
}

module.exports = { rereadWeakPages, spliceReread, _internals: { sortWeak } };
