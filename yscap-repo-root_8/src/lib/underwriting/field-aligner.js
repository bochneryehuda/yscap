'use strict';
/**
 * R5.16 — Field-to-span alignment.
 *
 * Extraction returns a VALUE ("$850,000", "ABC Property Holdings LLC") but the
 * evidence ledger needs the exact SOURCE region — which OCR line/cell on which
 * page that value came from, with its polygon. This aligner takes an extracted
 * value + the OCR layout (lines, each with text + page + polygon) and finds the
 * best-matching line, so recordSpan (evidence-ledger.js) can persist an
 * audit-grade span instead of a page-level guess.
 *
 * Deterministic + pure: no AI, no DB. Matching is normalized-substring + token
 * overlap with a money/number-aware normalizer, so "$850,000.00" aligns to a
 * line reading "Purchase Price 850000". Returns null when nothing clears the
 * confidence floor — NEVER a false alignment (a wrong span is worse than none:
 * the fact stays page-level / unable-to-cite rather than pointing at the wrong
 * place).
 */

const MIN_CONFIDENCE = 0.5;

// Normalize for comparison: lowercase, collapse whitespace, strip punctuation
// that doesn't carry meaning. Money/number values keep their digits.
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
}
function stripPunct(s) {
  return norm(s).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
// Digits-only form of a monetary/number value ("$850,000.00" → "85000000"…);
// used to match a number regardless of currency/thousands formatting.
function digits(s) {
  return String(s == null ? '' : s).replace(/[^0-9]/g, '');
}
function tokens(s) {
  return stripPunct(s).split(' ').filter(Boolean);
}

// Jaccard token overlap between two strings.
function tokenOverlap(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// Score how well `value` matches a `line` of OCR text (0..1).
function scoreLine(value, lineText) {
  const nv = stripPunct(value);
  const nl = stripPunct(lineText);
  if (!nv || !nl) return 0;

  // 1) exact normalized substring — strongest signal.
  if (nl.includes(nv)) return 1;

  // 2) money/number: the value's digits appear in the line's digits.
  const dv = digits(value);
  if (dv && dv.length >= 3) {
    const dl = digits(lineText);
    if (dl.includes(dv)) return 0.95;
  }

  // 3) token overlap (names, addresses that wrap or reorder).
  const overlap = tokenOverlap(value, lineText);
  // require a meaningful share of the value's tokens to be present.
  const vTokens = tokens(value);
  const lSet = new Set(tokens(lineText));
  const present = vTokens.filter((t) => lSet.has(t)).length;
  const coverage = vTokens.length ? present / vTokens.length : 0;
  return Math.max(overlap, coverage * 0.9);
}

/**
 * align(value, lines, opts) — lines: [{text, page?, polygon?, id?, spanType?}]
 * Returns the best match { line, page, polygon, spanType, confidence, index } or
 * null if nothing clears the floor.
 */
function align(value, lines, opts = {}) {
  const floor = Number.isFinite(opts.minConfidence) ? opts.minConfidence : MIN_CONFIDENCE;
  if (value == null || String(value).trim() === '' || !Array.isArray(lines) || !lines.length) return null;

  let best = null;
  lines.forEach((ln, i) => {
    const conf = scoreLine(value, ln.text);
    if (!best || conf > best.confidence) {
      best = { line: ln.text, page: ln.page ?? null, polygon: ln.polygon ?? null,
               spanType: ln.spanType || 'line', confidence: conf, index: i, id: ln.id ?? null };
    }
  });
  if (!best || best.confidence < floor) return null;
  return best;
}

// Convenience: align + shape it as a recordSpan payload for evidence-ledger.
function alignToSpan(value, lines, extra = {}) {
  const m = align(value, lines, extra);
  if (!m) return null;
  return {
    quote: m.line,
    normalizedValue: stripPunct(value),
    pageNumber: m.page,
    polygon: m.polygon,
    spanType: m.spanType,
    extractorConfidence: m.confidence,
    ...extra.span,
  };
}

module.exports = { align, alignToSpan, MIN_CONFIDENCE, _internals: { norm, stripPunct, digits, tokens, tokenOverlap, scoreLine } };
