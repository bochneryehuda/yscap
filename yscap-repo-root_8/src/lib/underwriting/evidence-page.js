'use strict';
/**
 * R5.3 — locate the SOURCE PAGE of an extracted value.
 *
 * Azure/Google Layout OCR returns text per page (`ocrPages = [{pageNumber,
 * text}]`). Extraction returns field VALUES with no page pointer. This module
 * closes that gap heuristically: it searches the per-page OCR text for a
 * value and returns the first page it appears on — so a finding / fact can
 * record "seen on page 3" without the full polygon evidence ledger (that is
 * R5.13–R5.16).
 *
 * This is a lightweight text alignment, NOT polygon-precise grounding. It only
 * ever ADDS a page_number; a miss returns null (never a wrong page). Pure — no
 * DB, no network — so it unit-tests trivially.
 */

// Normalize a value for substring matching: lowercase, collapse whitespace,
// and (for money/number-ish values) also try a digits-only form so "$1,234.00"
// matches "1234" in the OCR text. Returns an array of candidate needles.
function needlesFor(value) {
  if (value == null) return [];
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  s = s.trim();
  if (!s) return [];
  const out = new Set();
  const norm = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (norm.length >= 3) out.add(norm);
  // Money / number form: strip currency + separators, keep the integer part.
  const digits = s.replace(/[^0-9.]/g, '');
  if (digits && /[0-9]/.test(digits)) {
    const intPart = digits.split('.')[0];
    if (intPart.length >= 3) out.add(intPart);          // e.g. "250000"
  }
  // A last-4 form for identifiers (SSN/account) — only when clearly numeric-ish.
  const bare = s.replace(/[^0-9A-Za-z]/g, '');
  if (bare.length >= 4 && /^[0-9]/.test(bare)) out.add(bare.toLowerCase());
  return Array.from(out);
}

function pageText(page) {
  if (!page) return '';
  return String(page.text || '').toLowerCase().replace(/\s+/g, ' ');
}

// A pure-digit needle ("250000") is compared against a digits-only version of
// the page text so it matches a formatted "$250,000.00" in the source.
function isDigitNeedle(n) { return /^[0-9]+$/.test(n); }

/**
 * @param {*} value      the extracted field value to locate
 * @param {Array<{pageNumber:number,text:string}>} ocrPages
 * @returns {number|null} the 1-indexed page it first appears on, or null
 */
function pageNumberForValue(value, ocrPages) {
  if (!Array.isArray(ocrPages) || !ocrPages.length) return null;
  const needles = needlesFor(value);
  if (!needles.length) return null;
  for (const page of ocrPages) {
    const hay = pageText(page);
    if (!hay) continue;
    const hayDigits = hay.replace(/[^0-9]/g, '');
    for (const n of needles) {
      if (n.length < 3) continue;
      const found = isDigitNeedle(n) ? hayDigits.includes(n) : hay.includes(n);
      if (found) return Number.isFinite(page.pageNumber) ? page.pageNumber : null;
    }
  }
  return null;
}

/**
 * Build a `pageNumberFor(fieldName)` closure bound to an extraction's fields +
 * OCR pages, for twin.recordFactsFromExtraction. Returns () => null when there
 * are no pages, so callers can pass it unconditionally.
 */
function makeFieldPager(fields, ocrPages) {
  if (!Array.isArray(ocrPages) || !ocrPages.length || !fields) return () => null;
  const cache = new Map();
  return (fieldName) => {
    if (cache.has(fieldName)) return cache.get(fieldName);
    const p = pageNumberForValue(fields[fieldName], ocrPages);
    cache.set(fieldName, p);
    return p;
  };
}

module.exports = { pageNumberForValue, makeFieldPager, _internals: { needlesFor } };
