'use strict';

/**
 * Sanity guard for a HAND-TYPED condition label.
 *
 * Root cause (2026-07-22, the "08759" incident): the staff "add a condition" box
 * accepts ANY free text with no check, so a stray value — a property ZIP
 * ("08759"), a phone number, an SSN, an amount, a one-key blip — silently becomes
 * a real internal condition on the file. A staffer accidentally added the
 * borrower's property ZIP as a condition, and nothing stopped it.
 *
 * A real condition is a short instruction IN WORDS ("Verify owner of record on
 * REO #3"); a bare number or a 1–2 character blip never is. This flags the
 * obvious non-conditions so the server can refuse a silent accident (unless the
 * caller explicitly confirms) and the UI can explain why. It is deliberately
 * CONSERVATIVE — anything containing at least one letter and ≥3 characters passes
 * clean — so a real (if terse) condition is never blocked.
 *
 * Pure + dependency-free. If the client mirrors this for an inline confirm, keep
 * the two in lock-step. Test: scripts/test-condition-label-sanity.js.
 */

// A run of digits with only numeric-style separators — a ZIP (08759 / 08759-1234),
// a phone, an SSN, a loan/account number, an amount. No letters at all.
const NUMERICISH = /^[\d\s().+\-\/#$,.]+$/;
const ZIP = /^\d{5}(-\d{4})?$/;

/**
 * Return a machine reason string when `rawLabel` clearly is NOT a condition, or
 * null when it looks like a real one. Empty/blank returns null (the caller's
 * existing "label required" check owns that case).
 *
 *   'looks_like_zip' — exactly a 5-digit ZIP or ZIP+4 (the 08759 case)
 *   'looks_numeric'  — digits/number-punctuation only, not a ZIP (phone, SSN, amount)
 *   'no_words'       — no letters at all and not purely numeric (stray symbols)
 *   'too_short'      — has a letter but is under 3 characters
 */
function strayConditionReason(rawLabel) {
  const label = String(rawLabel == null ? '' : rawLabel).trim();
  if (!label) return null;
  const letters = (label.match(/[A-Za-z]/g) || []).length;
  if (letters === 0) {
    if (ZIP.test(label)) return 'looks_like_zip';
    if (NUMERICISH.test(label)) return 'looks_numeric';
    return 'no_words';
  }
  if (label.replace(/\s+/g, '').length < 3) return 'too_short';
  return null;
}

/**
 * Plain-language, staff-facing message for a flagged label. Deliberately does NOT
 * mention a "confirm" affordance so it reads correctly on every client — it tells
 * the staffer HOW to make a real condition. A client that offers an inline "add
 * anyway" confirm intercepts before this is ever shown.
 */
function strayConditionMessage(reason, label) {
  const shown = label ? `“${String(label).trim()}”` : 'That';
  switch (reason) {
    case 'looks_like_zip':
      return `${shown} looks like a ZIP code, not a condition. Describe what needs to happen in a few words — for example, “Verify the property ZIP on the title commitment”.`;
    case 'looks_numeric':
      return `${shown} looks like a number, not a condition. Describe what needs to happen in a few words — a condition is an instruction, not a value.`;
    case 'no_words':
      return `${shown} doesn’t contain any words, so it doesn’t look like a condition. Add a short description of what needs to happen.`;
    case 'too_short':
      return `${shown} is too short to be a condition. Add a few words describing what needs to happen.`;
    default:
      return `${shown} doesn’t look like a condition. Add a short description of what needs to happen.`;
  }
}

module.exports = { strayConditionReason, strayConditionMessage };
