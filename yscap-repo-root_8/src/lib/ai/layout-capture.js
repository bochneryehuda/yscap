'use strict';
/**
 * #112 (R5.15) — LAYOUT CAPTURE: preserve the line/word POLYGONS from Azure
 * Document Intelligence and Google Document AI in ONE canonical, engine-agnostic
 * shape, so an evidence span can later be drawn as a highlighted rectangle over the
 * rendered page ("click a fact → see the exact spot", #114).
 *
 * The two engines report geometry differently:
 *   • Azure prebuilt-layout — each line/word carries `polygon` as a FLAT array
 *     [x1,y1,x2,y2,x3,y3,x4,y4] in the page's `unit` (inches for a PDF, pixels for
 *     an image); the page carries width/height in the same unit.
 *   • Google Document AI — each line/token carries
 *     `layout.boundingPoly.normalizedVertices` ([{x,y}] already in 0..1) or
 *     `.vertices` ([{x,y}] in pixels, normalized by the page dimension).
 *
 * This module normalizes BOTH to a canonical page:
 *   { pageNumber, width, height, unit,
 *     lines: [{ text, bbox:{x,y,w,h}, polygon:[[x,y],...], confidence }],
 *     words: [{ text, bbox:{x,y,w,h}, polygon:[[x,y],...], confidence }] }
 * where every x/y/w/h and every polygon point is in NORMALIZED 0..1 page space, so
 * the overlay scales to whatever size the page image is rendered at.
 *
 * PURE: no DB, no clock, no I/O. NEVER THROWS — a missing/garbled polygon degrades
 * to null geometry (the text is still captured), never an exception.
 */

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function pos(v) { const n = num(v); return n != null && n > 0 ? n : null; }
function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }
function str(v) { return typeof v === 'string' ? v : (v == null ? '' : String(v)); }

/**
 * bboxOf(points) → { x, y, w, h } axis-aligned bounding rect of a polygon (array
 * of [x,y] pairs), or null if there are no usable points. Coords pass through as-is
 * (the caller normalizes). PURE.
 */
function bboxOf(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  let seen = 0;
  for (const pt of points) {
    if (!Array.isArray(pt)) continue;
    const x = num(pt[0]); const y = num(pt[1]);
    if (x == null || y == null) continue;
    if (x < minX) minX = x; if (y < minY) minY = y;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    seen++;
  }
  if (!seen) return null;
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

// normalize a list of [x,y] points by page width/height into 0..1 (clamped).
function normPoints(points, width, height) {
  if (!Array.isArray(points) || !width || !height) return null;
  const out = [];
  for (const pt of points) {
    if (!Array.isArray(pt)) continue;
    const x = num(pt[0]); const y = num(pt[1]);
    if (x == null || y == null) continue;
    out.push([clamp01(x / width), clamp01(y / height)]);
  }
  return out.length ? out : null;
}

// Azure: flat [x1,y1,x2,y2,...] → [[x1,y1],[x2,y2],...]. PURE.
function pairFlat(flat) {
  if (!Array.isArray(flat)) return null;
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = num(flat[i]); const y = num(flat[i + 1]);
    if (x == null || y == null) continue;
    out.push([x, y]);
  }
  return out.length ? out : null;
}

// Google normalizedVertices/vertices [{x,y},...] → [[x,y],...]. PURE.
function pairVertices(verts) {
  if (!Array.isArray(verts)) return null;
  const out = [];
  for (const v of verts) {
    if (!v || typeof v !== 'object') continue;
    const x = num(v.x); const y = num(v.y);
    if (x == null || y == null) continue;
    out.push([x, y]);
  }
  return out.length ? out : null;
}

function geom(polygon) {
  const bbox = bboxOf(polygon);
  return { polygon: polygon || null, bbox };
}

/**
 * normalizeAzurePage(page) → canonical page (PURE, NEVER THROWS).
 * Azure lines carry `content` + flat `polygon`; words add `confidence`. Page dims
 * are in `unit`; polygons are normalized by width/height into 0..1.
 */
function normalizeAzurePage(page, index) {
  const p = page && typeof page === 'object' ? page : {};
  const width = pos(p.width); const height = pos(p.height);
  const mapItem = (it) => {
    const o = it && typeof it === 'object' ? it : {};
    const poly = normPoints(pairFlat(o.polygon), width, height);
    return Object.assign({ text: str(o.content), confidence: num(o.confidence) }, geom(poly));
  };
  const lines = (Array.isArray(p.lines) ? p.lines : []).map(mapItem);
  const words = (Array.isArray(p.words) ? p.words : []).map(mapItem);
  return {
    pageNumber: Number.isFinite(p.pageNumber) ? p.pageNumber : (index + 1),
    width, height, unit: typeof p.unit === 'string' ? p.unit : null,
    lines, words,
  };
}

// pull a Google element's polygon (prefer already-normalized vertices).
function googlePoly(el, width, height) {
  const layout = el && el.layout;
  const bp = layout && layout.boundingPoly;
  if (!bp) return null;
  // normalizedVertices are already 0..1 — use directly (clamped).
  const nv = pairVertices(bp.normalizedVertices);
  if (nv) return nv.map(([x, y]) => [clamp01(x), clamp01(y)]);
  // else fall back to pixel vertices normalized by the page dimension.
  return normPoints(pairVertices(bp.vertices), width, height);
}

// resolve a Google element's text via its textAnchor segments into the doc `text`.
function googleText(el, fullText) {
  const layout = el && el.layout;
  const segs = layout && layout.textAnchor && Array.isArray(layout.textAnchor.textSegments) ? layout.textAnchor.textSegments : [];
  let out = '';
  for (const seg of segs) {
    const s = Number(seg && seg.startIndex) || 0;
    const e = Number(seg && seg.endIndex) || 0;
    if (e > s && e <= fullText.length) out += fullText.slice(s, e);
  }
  return out;
}

/**
 * normalizeGooglePage(page, fullText) → canonical page (PURE, NEVER THROWS).
 * Google pages carry `lines[]` + `tokens[]`, each with a `layout.boundingPoly`
 * (normalizedVertices in 0..1, or pixel vertices) and a textAnchor into `fullText`.
 */
function normalizeGooglePage(page, index, fullText) {
  const p = page && typeof page === 'object' ? page : {};
  const dim = p.dimension && typeof p.dimension === 'object' ? p.dimension : {};
  const width = pos(dim.width); const height = pos(dim.height);
  const ft = str(fullText);
  const mapItem = (it) => {
    const poly = googlePoly(it, width, height);
    const conf = num(it && it.layout && it.layout.confidence);
    return Object.assign({ text: googleText(it, ft), confidence: conf }, geom(poly));
  };
  const lines = (Array.isArray(p.lines) ? p.lines : []).map(mapItem);
  const words = (Array.isArray(p.tokens) ? p.tokens : []).map(mapItem);
  return {
    pageNumber: Number.isFinite(p.pageNumber) ? p.pageNumber : (index + 1),
    width, height, unit: typeof dim.unit === 'string' ? dim.unit : null,
    lines, words,
  };
}

/**
 * captureLayout(rawPage, opts) → a canonical page with normalized line/word
 * geometry, or a text-only canonical page when geometry is absent. PURE, NEVER
 * THROWS.
 *   opts: { engine: 'azure' | 'google', index?, fullText? (google) }
 */
function captureLayout(rawPage, opts) {
  // normalize opts ONCE up front so an explicit null/garbage never trips the catch
  // handler (the `opts = {}` default only covers undefined) — keeps NEVER THROWS true.
  const o = opts && typeof opts === 'object' ? opts : {};
  try {
    const engine = String(o.engine || '').toLowerCase();
    const index = Number.isFinite(o.index) ? o.index : 0;
    if (engine === 'google' || engine === 'google-docai') return normalizeGooglePage(rawPage, index, o.fullText);
    if (engine === 'azure' || engine === 'docint') return normalizeAzurePage(rawPage, index);
    // unknown engine → empty canonical page (never throw).
    return { pageNumber: index + 1, width: null, height: null, unit: null, lines: [], words: [] };
  } catch (_e) {
    return { pageNumber: (Number.isFinite(o.index) ? o.index : 0) + 1, width: null, height: null, unit: null, lines: [], words: [] };
  }
}

/**
 * capturePages(rawResult, opts) → [canonical page] for a full OCR result. Azure
 * passes { pages }; Google passes { pages, text }. PURE, NEVER THROWS.
 */
function capturePages(rawResult, opts = {}) {
  try {
    const r = rawResult && typeof rawResult === 'object' ? rawResult : {};
    const pages = Array.isArray(r.pages) ? r.pages : [];
    const engine = String(opts.engine || r.engine || '').toLowerCase();
    const fullText = opts.fullText != null ? opts.fullText : r.text;
    return pages.map((p, i) => captureLayout(p, { engine, index: i, fullText }));
  } catch (_e) { return []; }
}

/**
 * alignerLines(pages) → [{ text, page, polygon, bbox, spanType:'line' }] flattened
 * across canonical pages, in the EXACT shape field-aligner.align() consumes — so an
 * extracted value can now be aligned to the OCR line AND its polygon (the polygon
 * the aligner has been carrying as null until layout capture landed). PURE.
 */
function alignerLines(pages) {
  const out = [];
  const list = Array.isArray(pages) ? pages : [];
  for (const pg of list) {
    const p = pg && typeof pg === 'object' ? pg : {};
    const page = Number.isFinite(p.pageNumber) ? p.pageNumber : null;
    for (const ln of (Array.isArray(p.lines) ? p.lines : [])) {
      if (!ln || !str(ln.text)) continue;
      out.push({ text: ln.text, page, polygon: ln.polygon || null, bbox: ln.bbox || null, spanType: 'line' });
    }
  }
  return out;
}

module.exports = {
  captureLayout, capturePages, normalizeAzurePage, normalizeGooglePage,
  alignerLines, bboxOf, _internals: { pairFlat, pairVertices, normPoints, googlePoly, googleText },
};
