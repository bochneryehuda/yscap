'use strict';
/**
 * R5.8 — Page-quality classifier (deterministic core, ADVISORY).
 *
 * When a combined PDF packet is uploaded, each page is rendered + OCR'd. This
 * module classifies EACH page's readability so the splitter and a human reviewer
 * know which pages are blank separators, sideways/upside-down scans, too low-res
 * to trust, unreadable, or password-locked. It NEVER modifies a page or a
 * document — it produces a verdict + advisory issues for the packet review UI.
 *
 * The verdict feeds document_pages.blank_score / quality_score / rotation and
 * the splitter's boundary logic (a blank page is a common document separator).
 *
 * Pure: no DB, no AI, no image libs. It consumes already-extracted page features
 * (text, OCR status, rotation, dimensions) — the render/OCR step supplies those.
 */

// A page with fewer than this many non-whitespace characters AND no meaningful
// image coverage is treated as blank/separator.
const BLANK_TEXT_CHARS = 12;
// Minimum effective resolution (DPI) to trust a scan for extraction.
const MIN_DPI = 150;
// A very low DPI is effectively unreadable for OCR.
const UNUSABLE_DPI = 72;

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// Effective DPI from pixel dimensions + the page's physical size (when known).
// Returns null when we can't tell (e.g. a vector/text page with no raster).
function estimateDpi(page) {
  const w = num(page.width), h = num(page.height);
  const unit = String(page.unit || '').toLowerCase();
  const pxW = num(page.pixel_width) != null ? num(page.pixel_width) : (unit === 'pixel' ? w : null);
  const pxH = num(page.pixel_height) != null ? num(page.pixel_height) : (unit === 'pixel' ? h : null);
  // Physical size in inches (letter default if the page carries point/inch dims).
  let inchesW = null, inchesH = null;
  if (unit === 'inch') { inchesW = w; inchesH = h; }
  else if (unit === 'point') { inchesW = w != null ? w / 72 : null; inchesH = h != null ? h / 72 : null; }
  else if (page.physical_inches_w != null) { inchesW = num(page.physical_inches_w); inchesH = num(page.physical_inches_h); }
  if (pxW == null || inchesW == null || inchesW <= 0) return null;
  const dpiW = pxW / inchesW;
  const dpiH = (pxH != null && inchesH) ? pxH / inchesH : dpiW;
  return Math.round(Math.min(dpiW, dpiH));
}

// Normalize a rotation value to one of 0/90/180/270 (or null if unknown).
function normRotation(r) {
  const n = num(r);
  if (n == null) return null;
  const m = ((Math.round(n / 90) * 90) % 360 + 360) % 360;
  return m;
}

/**
 * assessPage(page) → { verdict, issues:[{code,severity,detail}], blankScore, qualityScore, rotation, dpi }
 *   page: {
 *     text | textLength,          // extracted text (or its length)
 *     ocr_status,                 // 'ok' | 'unreadable' | 'skipped' | 'pending'
 *     rotation,                   // detected degrees (0/90/180/270)
 *     width,height,unit,          // page dims (inch/point/pixel)
 *     pixel_width,pixel_height,   // raster dims when rendered
 *     imageCoverage,              // 0..1 fraction of the page that is imagery
 *     passwordProtected,          // could not open (encrypted)
 *     decoded,                    // false when the page bytes could not be parsed
 *   }
 * Verdicts (worst wins): password_protected > unreadable > blank > upside_down >
 *   rotated > low_res > ok.
 */
function assessPage(page) {
  const p = page || {};
  const issues = [];
  const textLen = p.textLength != null ? num(p.textLength) : (typeof p.text === 'string' ? p.text.replace(/\s+/g, '').length : null);
  const imageCoverage = num(p.imageCoverage);
  const rotation = normRotation(p.rotation);
  const dpi = estimateDpi(p);

  // blankScore: high when there's ~no text and ~no imagery.
  let blankScore = 0;
  if (textLen != null) {
    const textEmpty = textLen < BLANK_TEXT_CHARS;
    const noImagery = imageCoverage == null || imageCoverage < 0.02;
    blankScore = textEmpty ? (noImagery ? 1 : 0.4) : clamp01((BLANK_TEXT_CHARS - textLen) / BLANK_TEXT_CHARS);
    blankScore = clamp01(blankScore);
  }

  // qualityScore: starts at 1, docked for low resolution + rotation.
  let qualityScore = 1;
  if (dpi != null) {
    if (dpi < UNUSABLE_DPI) qualityScore = 0.1;
    else if (dpi < MIN_DPI) qualityScore = 0.5;
  }
  if (rotation === 90 || rotation === 270) qualityScore = Math.min(qualityScore, 0.6);
  else if (rotation === 180) qualityScore = Math.min(qualityScore, 0.7);
  qualityScore = clamp01(qualityScore);

  // --- verdict, worst-first ---
  let verdict = 'ok';
  const push = (code, severity, detail) => issues.push({ code, severity, detail });

  if (p.passwordProtected) {
    verdict = 'password_protected';
    push('page_password_protected', 'warning', 'The page is encrypted/locked — request an unlocked copy.');
  } else if (String(p.ocr_status || '').toLowerCase() === 'unreadable' || p.decoded === false || (dpi != null && dpi < UNUSABLE_DPI)) {
    verdict = 'unreadable';
    push('page_unreadable', 'warning', dpi != null && dpi < UNUSABLE_DPI ? `Effective resolution ~${dpi} DPI is too low to read reliably.` : 'The page could not be read (OCR failed / bytes unparseable).');
  } else if (blankScore >= 0.9) {
    verdict = 'blank';
    push('page_blank', 'info', 'The page appears blank (likely a separator between documents).');
  } else if (rotation === 180) {
    verdict = 'upside_down';
    push('page_upside_down', 'info', 'The page is upside-down (180°) — it should be auto-rotated before review.');
  } else if (rotation === 90 || rotation === 270) {
    verdict = 'rotated';
    push('page_rotated', 'info', `The page is sideways (${rotation}°) — it should be auto-rotated before review.`);
  } else if (dpi != null && dpi < MIN_DPI) {
    verdict = 'low_res';
    push('page_low_res', 'info', `Effective resolution ~${dpi} DPI is below the ${MIN_DPI} DPI we prefer for extraction.`);
  }

  return { verdict, issues, blankScore: +blankScore.toFixed(3), qualityScore: +qualityScore.toFixed(3), rotation, dpi };
}

/**
 * assessPacket(pages) → { pages:[{pageNumber, ...assessPage}], summary }.
 * Runs the classifier over every page + rolls up counts for the review UI.
 * `pages` is an array in packet order (1-indexed by position unless page_number
 * is supplied).
 */
function assessPacket(pages) {
  const out = (pages || []).map((pg, i) => Object.assign(
    { pageNumber: pg && pg.page_number != null ? num(pg.page_number) : i + 1 },
    assessPage(pg)));
  const count = (v) => out.filter((p) => p.verdict === v).length;
  return {
    pages: out,
    summary: {
      total: out.length,
      ok: count('ok'),
      blank: count('blank'),
      rotated: count('rotated') + count('upside_down'),
      lowRes: count('low_res'),
      unreadable: count('unreadable'),
      passwordProtected: count('password_protected'),
      needsAttention: out.filter((p) => p.verdict !== 'ok' && p.verdict !== 'blank').length,
    },
  };
}

module.exports = { assessPage, assessPacket, MIN_DPI, UNUSABLE_DPI, BLANK_TEXT_CHARS, _internals: { estimateDpi, normRotation } };
