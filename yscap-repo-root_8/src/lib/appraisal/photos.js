'use strict';
/**
 * Appraisal PHOTO extraction — pull the subject + comparable photos out of the appraisal PDF,
 * entirely in-process (nothing leaves our server). The XML already carries the PDF as base64
 * (X.embeddedPdfBase64), so no upload round-trip is needed.
 *
 * Deps: `unpdf` (a pre-bundled, serverless build of Mozilla's pdf.js — pure JS, NO native
 * build, honours the express+pg-only rule). Images come back as decoded pixels; we encode
 * them to PNG using Node's built-in zlib (zlib.deflateSync + zlib.crc32) — no image library.
 *
 * Advisory / best-effort, exactly like ocr.js: any failure returns a structured result and
 * NEVER throws, so it can never block an import. Auto subject/comp labelling is a heuristic
 * and is surfaced as a suggestion, never asserted.
 */
const crypto = require('crypto');
const zlib = require('zlib');
// Pure-JS CRC-32 (works on every Node ≥14 — zlib.crc32 only exists on Node ≥20.15/22.2, and
// package.json declares node>=18, so a bare zlib.crc32 would throw on an older runtime and
// silently store ZERO photos). Reuse the repo's existing implementation.
const { crc32 } = require('../zip');

// Only keep images big enough to be real photographs (drop logos, form rules, signature marks).
const MIN_W = 200, MIN_H = 150;
// Skip a pathologically large embedded raster BEFORE pdf.js/we fully materialize it — a giant
// source image (decoded to w*h*channels bytes) could OOM the worker, and an OOM is not catchable.
const MAX_SRC_AREA = 40 * 1000 * 1000;  // ~40 megapixels — far above any real appraisal photo
// Cap the number of stored photos per appraisal — an appraisal repeats the same shots across
// the summary + addenda; after de-duplication this is plenty and bounds storage.
const MAX_PHOTOS = 24;
// Downscale to this long-side before encoding: keeps the gallery/hero crisp on screen while
// bounding each PNG (photographic PNG is lossless, so dimensions are the main size lever).
const MAX_SIDE = 560;
// Don't ship an enormous PDF into pdf.js; appraisal PDFs are ~1–8 MB. Above this, skip.
const MAX_PDF_BYTES = 40 * 1024 * 1024;

// Area-average downscale of a raw pixel buffer to a max long side. No-op when already small.
function downscale(px, w, h, ch, maxSide) {
  const scale = Math.max(w, h) / maxSide;
  if (scale <= 1) return { px, w, h };
  const nw = Math.max(1, Math.round(w / scale)), nh = Math.max(1, Math.round(h / scale));
  const out = Buffer.alloc(nw * nh * ch);
  for (let y = 0; y < nh; y++) {
    const sy0 = Math.floor((y * h) / nh), sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * h) / nh));
    for (let x = 0; x < nw; x++) {
      const sx0 = Math.floor((x * w) / nw), sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * w) / nw));
      for (let c = 0; c < ch; c++) {
        let sum = 0, cnt = 0;
        for (let sy = sy0; sy < sy1; sy++) { const row = sy * w; for (let sx = sx0; sx < sx1; sx++) { sum += px[(row + sx) * ch + c]; cnt++; } }
        out[(y * nw + x) * ch + c] = cnt ? (sum / cnt) | 0 : 0;
      }
    }
  }
  return { px: out, w: nw, h: nh };
}

// ---- minimal PNG encoder (RGB / grayscale / RGBA), Node built-ins only ----
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePng(px, width, height, channels) {
  const ch = channels === 1 ? 1 : channels === 4 ? 4 : 3;
  const colorType = ch === 1 ? 0 : ch === 4 ? 6 : 2;
  const stride = width * ch;
  // raw = each scanline prefixed with a filter byte (0 = None)
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
}

// Normalize a pdf.js image's pixel buffer to a Node Buffer of length width*height*channels.
function toPixelBuffer(img) {
  const d = img.data;
  const buf = Buffer.isBuffer(d) ? d : Buffer.from(d.buffer || d, d.byteOffset || 0, d.byteLength || d.length);
  const ch = img.channels || Math.round(buf.length / (img.width * img.height)) || 3;
  return { buf, ch };
}

/**
 * Extract photos from an appraisal PDF (base64). Returns:
 *   { attempted:true, photos:[{ page, seq, width, height, png:Buffer, sha256 }], reason? }
 *   { attempted:false, reason } on no-PDF / oversize / library-missing.
 * Never throws.
 */
async function extractPhotos(pdfBase64, opts = {}) {
  if (!pdfBase64) return { attempted: false, reason: 'no appraisal PDF was available', photos: [] };
  const byteLen = Math.floor((String(pdfBase64).length * 3) / 4);
  if (byteLen > MAX_PDF_BYTES) return { attempted: false, reason: 'the appraisal PDF is too large to read for photos', photos: [] };

  let getDocumentProxy, extractImages;
  try { ({ getDocumentProxy, extractImages } = await import('unpdf')); }
  catch (e) { return { attempted: false, reason: `the PDF reader is unavailable (${e.message})`, photos: [] }; }

  let pdf;
  try {
    const bytes = new Uint8Array(Buffer.from(pdfBase64, 'base64'));
    pdf = await getDocumentProxy(bytes);
  } catch (e) { return { attempted: true, reason: `the PDF could not be opened (${e.message})`, photos: [] }; }

  const maxPhotos = opts.maxPhotos || MAX_PHOTOS;
  const seen = new Set();
  const photos = [];
  const nPages = Math.min(pdf.numPages || 0, 120);
  for (let p = 1; p <= nPages; p++) {
    if (photos.length >= maxPhotos) break;
    let imgs;
    try { imgs = await extractImages(pdf, p); } catch (_) { continue; }
    for (const img of imgs || []) {
      if (photos.length >= maxPhotos) break;
      const w = img.width | 0, h = img.height | 0;
      if (w < MIN_W || h < MIN_H) continue;
      // Skip an absurdly large raster before OUR downscale/PNG allocation. NOTE: extractImages has
      // already decoded the image to img.data by here, so this does not prevent a decode-time OOM
      // inside the PDF library — it only bounds our own re-allocation. The real decode is loosely
      // bounded by MAX_PDF_BYTES + the library's internals (unpdf exposes no pre-decode dimensions).
      if (w * h > MAX_SRC_AREA) continue;
      let px, ch;
      try { ({ buf: px, ch } = toPixelBuffer(img)); } catch (_) { continue; }
      if (!px || px.length < w * h * ch) continue;        // malformed / too-short buffer (all channels)
      const sha = crypto.createHash('sha256').update(px).digest('hex');
      if (seen.has(sha)) continue;                        // the same shot repeated across pages
      seen.add(sha);
      let png, ow = w, oh = h;
      try {
        const ds = downscale(px, w, h, ch, opts.maxSide || MAX_SIDE);
        png = encodePng(ds.px, ds.w, ds.h, ch); ow = ds.w; oh = ds.h;
      } catch (_) { continue; }
      photos.push({ page: p, seq: photos.length, width: ow, height: oh, png, sha256: sha });
    }
  }
  return { attempted: true, photos, reason: photos.length ? null : 'no photographs were found in the PDF' };
}

module.exports = { extractPhotos, encodePng, MIN_W, MIN_H, MAX_PHOTOS };
