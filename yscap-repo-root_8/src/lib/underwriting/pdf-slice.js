'use strict';
/**
 * R5.1 / R5.10 — Physical PDF page slicing for the packet splitter.
 *
 * The packet splitter turns one uploaded combined PDF into several logical
 * child documents. For a child to be safely underwritten it must contain ONLY
 * its own pages — otherwise a "bank statement" split out of a 40-page package
 * is still classified / extracted / fact-tied-out against the whole package.
 *
 * `slicePdfPages(buf, pages)` builds a NEW PDF containing exactly the requested
 * 1-indexed pages, in ascending order, deduped. It uses `pdf-lib` — a pure-JS
 * PDF toolkit with NO native dependencies (fits this repo's express+pg only
 * constraint; Render's `npm install` pulls it). The import is lazy so a missing
 * install NEVER crashes the route — the caller falls back to a page-range
 * record instead.
 *
 * NO-THROW CONTRACT: every function returns a result object; it never rejects.
 * On any failure the caller keeps the source bytes and marks the child
 * `page_bounded=false` so it is not auto-analyzed as a whole document.
 */

const MAX_SLICE_BYTES = 60 * 1024 * 1024; // don't try to slice absurdly large packages in-process

// Sniff for a PDF header. The splitter only ever targets PDFs; an image "page"
// has no sub-pages to bound, so slicing simply doesn't apply.
function looksLikePdf(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return false;
  // %PDF- may appear after a small BOM/whitespace preamble in the wild.
  const head = buf.slice(0, 1024).toString('latin1');
  return head.includes('%PDF-');
}

function normalizePages(pages) {
  if (!Array.isArray(pages)) return [];
  const set = new Set();
  for (const p of pages) {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1) set.add(n);
  }
  return Array.from(set).sort((a, b) => a - b);
}

/**
 * @param {Buffer} buf              source PDF bytes
 * @param {number[]} pages          1-indexed page numbers to keep
 * @returns {Promise<{ok:boolean, buf?:Buffer, pages?:number[], reason?:string, sourcePageCount?:number}>}
 */
async function slicePdfPages(buf, pages) {
  const want = normalizePages(pages);
  if (!want.length) return { ok: false, reason: 'no valid pages requested' };
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, reason: 'no source bytes' };
  if (buf.length > MAX_SLICE_BYTES) return { ok: false, reason: 'source too large to slice in-process' };
  if (!looksLikePdf(buf)) return { ok: false, reason: 'source is not a PDF (nothing to page-bound)' };

  let PDFDocument;
  try { ({ PDFDocument } = await import('pdf-lib')); }
  catch (e) { return { ok: false, reason: `pdf slicer unavailable (${e.message})` }; }

  let src;
  try {
    // ignoreEncryption lets us still copy pages out of a permission-flagged (not
    // password-locked) PDF; a truly encrypted doc throws and we fall back.
    src = await PDFDocument.load(new Uint8Array(buf), { ignoreEncryption: true });
  } catch (e) { return { ok: false, reason: `could not open source PDF (${e.message})` }; }

  const total = src.getPageCount();
  const inRange = want.filter((p) => p <= total);
  if (!inRange.length) return { ok: false, reason: `requested pages out of range (source has ${total})`, sourcePageCount: total };

  let out;
  try {
    out = await PDFDocument.create();
    // pdf-lib copyPages is 0-indexed.
    const copied = await out.copyPages(src, inRange.map((p) => p - 1));
    for (const pg of copied) out.addPage(pg);
    const bytes = await out.save();
    return { ok: true, buf: Buffer.from(bytes), pages: inRange, sourcePageCount: total };
  } catch (e) { return { ok: false, reason: `slice build failed (${e.message})`, sourcePageCount: total }; }
}

module.exports = { slicePdfPages, _internals: { looksLikePdf, normalizePages } };
