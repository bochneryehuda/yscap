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
 *   2) on OUTPUT — borrower condition/checklist render, so already-stored data
 *      is scrubbed on the way out;
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
  // Collapse an accidental "…program program" (e.g. "BlueLake program" -> the
  // replacement would otherwise duplicate the word).
  out = out.replace(/Gold Standard program(\s+program)\b/gi, PROGRAM);
  return out;
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

module.exports = { scrubText, scrubFields, hasPartnerName, PROGRAM, PARTNER_PATTERNS };
