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
// …but SIZE ALONE NEVER SEPARATED A PHOTOGRAPH FROM A SIGNATURE (owner-reported 2026-08-02: "for
// the main picture of the house it comes up the appraiser's signature"). A scanned signature on the
// URAR certification page is routinely 400×200 or larger, so it sails past MIN_W/MIN_H — and it sits
// on page 6, BEFORE the subject photo page, so in plain page order it is the FIRST image found and
// became the hero. The fix is to judge what an image IS, from its own pixels: see classifyImage().
// Real photographs are stored first, so the hero is a photograph and never a signature, a logo, a
// location map or a floor-plan sketch.
const MAX_GRAPHICS = 6;      // form artwork/maps/sketches kept (they're useful) but capped + last
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

// ---- is this a PHOTOGRAPH, or part of the form? ----------------------------
// Pure pixel statistics over a strided sample (~20k pixels — enough to be stable, cheap enough to
// run on every candidate before we spend a PNG encode on it). Reads the ORIGINAL buffer, before
// any downscale, so the numbers describe the image the appraiser actually embedded.
const SAMPLE_TARGET = 20000;
function imageStats(px, w, h, ch) {
  const total = w * h;
  if (!total || !px || px.length < total * ch) return null;
  const step = Math.max(1, Math.floor(total / SAMPLE_TARGET));
  let n = 0, nearWhite = 0, mid = 0, colored = 0, chromaSum = 0;
  const buckets = new Uint8Array(32);            // 32-bucket luminance histogram (tonal variety)
  for (let i = 0; i < total; i += step) {
    const o = i * ch;
    let r, g, b;
    if (ch === 1) { r = g = b = px[o]; }
    else {
      r = px[o]; g = px[o + 1]; b = px[o + 2];
      // A fully transparent RGBA pixel is background, not ink — read it as white so a
      // transparent-background logo isn't mistaken for a dark, "photographic" image.
      if (ch === 4 && px[o + 3] === 0) { r = g = b = 255; }
    }
    const lum = (r * 299 + g * 587 + b * 114) / 1000;
    const chroma = Math.max(r, g, b) - Math.min(r, g, b);
    if (lum >= 245) nearWhite++;
    if (lum > 60 && lum < 200) mid++;
    if (chroma > 24) colored++;
    chromaSum += chroma;
    buckets[Math.min(31, Math.floor(lum / 8))] = 1;
    n++;
  }
  if (!n) return null;
  let tones = 0;
  for (let i = 0; i < 32; i++) tones += buckets[i];
  return {
    nearWhiteFrac: nearWhite / n,
    midFrac: mid / n,
    colorFrac: colored / n,
    meanChroma: chromaSum / n,
    tones,                                   // how many of the 32 luminance bands are used at all
    aspect: h > 0 ? w / h : 0,
    sampled: n,
  };
}

/**
 * classifyImage(stats) → { photo:boolean, why:string }
 *
 * "Photograph" here means a picture of the world (the house, the street, a room, a comp) as opposed
 * to something drawn or scanned as part of the report: a signature, a logo, a location map, a floor
 * plan, a form fragment. The tests are deliberately conservative — a misjudged photograph is only
 * demoted to the END of the gallery (never dropped), while a misjudged signature becomes the face
 * of the property report, which is the bug this exists to stop.
 *
 * A page of ink on paper has two signatures of its own, and a photograph has neither:
 *   • it is overwhelmingly WHITE with very little in the midtones (paper + strokes, no shading);
 *   • it carries almost no COLOUR.
 * A house photo has sky, brick, grass, roof — midtones and chroma everywhere, even a grey overcast
 * shot. Both tests must agree before an image is demoted, except for the two shape/flatness cases
 * below which are decisive on their own.
 */
function classifyImage(st) {
  if (!st) return { photo: true, why: 'no readable statistics — kept as a photo' };
  // A long thin strip is a banner, a rule, or a signature line — no camera produces one.
  if (st.aspect >= 4 || (st.aspect > 0 && st.aspect <= 0.25)) return { photo: false, why: 'banner/strip shape' };
  // Almost no tonal variety at all: a solid block, a two-colour graphic. Kept deliberately tight —
  // a real photograph carries sensor grain and shading and spreads across many bands, but a
  // legitimately flat one (a close-up of a wall) must not be demoted, so this only catches artwork.
  if (st.tones <= 4) return { photo: false, why: 'flat artwork — almost no tonal range' };
  // Paper: mostly white, hardly any midtones. This is the signature / sketch / map case.
  if (st.nearWhiteFrac >= 0.72 && st.midFrac <= 0.30) return { photo: false, why: 'ink on white paper' };
  // Greyscale AND mostly white — a scanned signature or a black-and-white form fragment.
  if (st.colorFrac < 0.02 && st.meanChroma < 8 && st.nearWhiteFrac >= 0.55) return { photo: false, why: 'greyscale scan on white' };
  return { photo: true, why: 'photographic' };
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
 *   { attempted:true, photos:[{ page, seq, width, height, png:Buffer, sha256, kind, why }], reason? }
 *   { attempted:false, reason } on no-PDF / oversize / library-missing.
 *
 * ORDER IS THE CONTRACT: real photographs come first, in page order, then the form graphics
 * (`kind:'graphic'`) in page order. The caller stores them in exactly this order, so photo #1 — the
 * hero on the property report — is the first PHOTOGRAPH in the report, which on a URAR is the
 * subject front shot. Before this, order was raw page order and the appraiser's signature on the
 * certification page (page 6) outranked the subject photo page (page 7+).
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
  const maxGraphics = opts.maxGraphics != null ? opts.maxGraphics : MAX_GRAPHICS;
  const seen = new Set();
  // Two buckets with SEPARATE caps, so the form's own artwork can never crowd real photographs out
  // of the stored set (the old single cap was first-come, and the form comes first in the PDF).
  const photos = [], graphics = [];
  const nPages = Math.min(pdf.numPages || 0, 120);
  for (let p = 1; p <= nPages; p++) {
    if (photos.length >= maxPhotos && graphics.length >= maxGraphics) break;
    let imgs;
    try { imgs = await extractImages(pdf, p); } catch (_) { continue; }
    for (const img of imgs || []) {
      if (photos.length >= maxPhotos && graphics.length >= maxGraphics) break;
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
      // Decide WHAT this image is before spending a PNG encode on it, and before it can take a slot
      // a photograph needs. Statistics run on the original pixels (pre-downscale).
      let cls;
      try { cls = classifyImage(imageStats(px, w, h, ch)); }
      catch (_) { cls = { photo: true, why: 'classification failed — kept as a photo' }; }
      const bucket = cls.photo ? photos : graphics;
      if (bucket.length >= (cls.photo ? maxPhotos : maxGraphics)) continue;
      let png, ow = w, oh = h;
      try {
        const ds = downscale(px, w, h, ch, opts.maxSide || MAX_SIDE);
        png = encodePng(ds.px, ds.w, ds.h, ch); ow = ds.w; oh = ds.h;
      } catch (_) { continue; }
      bucket.push({ page: p, width: ow, height: oh, png, sha256: sha,
        kind: cls.photo ? 'photo' : 'graphic', why: cls.why });
    }
  }
  // PHOTOGRAPHS FIRST. Each bucket is already in page order, so the subject front photo — the first
  // photograph in a URAR — becomes seq 0 and therefore the hero. `seq` is assigned here, over the
  // final order, so it stays the single index the caller stores and the gallery renders by.
  const ordered = photos.concat(graphics).map((ph, i) => Object.assign(ph, { seq: i }));
  return {
    attempted: true, photos: ordered,
    photographs: photos.length, graphics: graphics.length,
    reason: ordered.length ? null : 'no photographs were found in the PDF',
  };
}

module.exports = { extractPhotos, encodePng, imageStats, classifyImage, MIN_W, MIN_H, MAX_PHOTOS, MAX_GRAPHICS };
