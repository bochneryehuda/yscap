'use strict';

/**
 * Borrower-facing text sanitizer.
 *
 * Capital-partner / note-buyer names (BlueLake, Temple View, RCN, Churchill,
 * Fidelis, …) must NEVER appear on a borrower surface (frozen session rule in
 * CLAUDE.md). Borrower copy calls the program the **"Gold Standard program."**
 *
 * Owner-directed (2026-07-12, audit S5-01/S2-01): rather than block a save,
 * automatically REPLACE any partner name in borrower-facing text with the
 * program name. Applied in three layers for defense-in-depth:
 *   1) on WRITE — Condition Studio + per-file condition authoring, so a name
 *      never gets stored in a borrower field in the first place;
 *   2) on OUTPUT — borrower condition/checklist/LLC/document render, so
 *      already-stored data is scrubbed on the way out;
 *   3) at the NOTIFY chokepoint — notify.notifyBorrower, so every borrower
 *      email + in-app alert is scrubbed regardless of who built the text.
 *
 * Staff surfaces are NEVER scrubbed — staff may see the real names.
 */

const PROGRAM = 'Gold Standard program';

// Word-boundary, case-insensitive, tolerant of a space/hyphen inside the
// two-word names. Keep in sync with the CLAUDE.md capital-partner list.
const PARTNER_PATTERNS = [
  /\bblue[\s-]?lake\b/gi,
  /\btemple[\s-]?view\b/gi,
  /\bchurchill\b/gi,
  /\bfidelis\b/gi,
  /\brcn\b/gi,
  /\bcorr[\s-]?first\b/gi,
  /\bkiavi\b/gi,
  /\broc\b/gi,
];

/**
 * Replace any capital-partner name in a string with the program name.
 * Non-strings are returned unchanged. Safe to call on already-clean text.
 * @param {*} value
 * @returns {*}
 */
function scrubText(value) {
  if (typeof value !== 'string' || value === '') return value;
  let out = value;
  for (const re of PARTNER_PATTERNS) out = out.replace(re, PROGRAM);
  // Collapse an accidental "…program program" (e.g. "BlueLake program" would
  // otherwise duplicate the word).
  out = out.replace(/Gold Standard program(\s+program)\b/gi, PROGRAM);
  return out;
}

// Unicode private-use sentinels — these never occur in real copy, so masking a
// protected value can't collide with digits/letters already in the text.
const MARK_OPEN = '';
const MARK_CLOSE = '';

/**
 * Scrub partner names from `text` but PROTECT the given substrings.
 *
 * Some partner names collide with ordinary words that appear in legitimate
 * borrower data — "Churchill" and "Blue Lake" are common street / place names,
 * so a property address like "12 Churchill Lane" must NOT be rewritten. At the
 * notify chokepoint the file's address / borrower name / program arrive as clean
 * `meta` values; we mask those exact strings, run the scrub (so a staff-typed
 * condition label elsewhere in the same body IS replaced), then restore them.
 * Protected values come from trusted DB fields (never a staff-typed label), so
 * they never legitimately need scrubbing.
 * @param {*} text
 * @param {string[]} protect  exact substrings to leave untouched
 */
function scrubTextExcept(text, protect) {
  if (typeof text !== 'string' || text === '') return text;
  const vals = Array.isArray(protect)
    ? [...new Set(protect.filter((p) => typeof p === 'string' && p.length >= 3))].sort((a, b) => b.length - a.length)
    : [];
  if (!vals.length) return scrubText(text);
  const marks = [];
  let s = text;
  for (const p of vals) {
    if (!s.includes(p)) continue;
    s = s.split(p).join(MARK_OPEN + marks.length + MARK_CLOSE);
    marks.push(p);
  }
  s = scrubText(s);
  for (let i = 0; i < marks.length; i++) s = s.split(MARK_OPEN + i + MARK_CLOSE).join(marks[i]);
  return s;
}

/**
 * Return a shallow copy of `obj` with the named string keys scrubbed.
 * Non-string values (and missing keys) are left as-is. Does not mutate input.
 * @param {object|null} obj
 * @param {string[]} keys
 */
function scrubFields(obj, keys) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? obj.slice() : { ...obj };
  for (const k of keys) if (typeof out[k] === 'string') out[k] = scrubText(out[k]);
  return out;
}

/** True if the text contains a capital-partner name (for tests / assertions). */
function hasPartnerName(value) {
  if (typeof value !== 'string' || value === '') return false;
  return PARTNER_PATTERNS.some((re) => { re.lastIndex = 0; return re.test(value); });
}

module.exports = { scrubText, scrubTextExcept, scrubFields, hasPartnerName, PROGRAM, PARTNER_PATTERNS };
