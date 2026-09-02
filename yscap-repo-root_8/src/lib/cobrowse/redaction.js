'use strict';
/**
 * CO-BROWSING — the server-side REDACTION GUARD (Phase C, belt to the browser's braces).
 *
 * Masking happens in the GUEST's browser before a byte leaves it (app-v2/src/lib/
 * cobrowse.js: maskAllInputs, the block selector, the no-record routes). That is
 * the real protection, and it is the only one that can be complete — this module
 * cannot see a value that never left the guest. What it CAN do is refuse to relay
 * a batch that carries a SECRET-SHAPED value in plain text, so that a mask a
 * future screen forgets (an SSN printed in a table cell nobody marked
 * data-cobrowse-block) costs one frame of the mirror instead of the number.
 *
 * PURE. No requires, no IO, so the whole rule is unit-testable and the hub can
 * call it on every batch without a dependency it did not have before.
 *
 * WHAT IS A SECRET SHAPE — deliberately NARROW, because the cost of a false
 * positive is a dropped frame the viewer notices as a stall, and a rule that
 * drops ordinary frames trains everybody to accept stalls:
 *   · a Social Security number WITH its dashes / spaces (123-45-6789) — a 9-digit
 *     run without separators is a phone number, a loan number, a ZIP+4 a hundred
 *     times over, so a bare run is NOT matched;
 *   · a card number: 15–16 digits with or without the usual 4-4-4-4 separators
 *     that also passes Luhn — the checksum is what keeps a loan amount or a
 *     document id out of it;
 *   · rrweb's own marker for a masked input is '•' — it is never a secret and is
 *     never matched (pinned by test, or a fixed-length mask would be dropped as
 *     a card number).
 * The full-snapshot event (rrweb type 2) is scanned exactly as the incremental
 * ones are — a snapshot is where a printed SSN would live.
 *
 * NEVER GUESSES BEYOND THAT. A one-time code is six digits, indistinguishable
 * from a ZIP or a loan amount, and is defended by the browser (input[autocomplete
 * ="one-time-code"] is BLOCKED there). This module says so rather than pretend.
 */

const SSN_RE = /\b\d{3}[- ]\d{2}[- ]\d{4}\b/;
// 15–16 digits, optionally grouped 4-4-4-4 / 4-6-5, not part of a longer digit run.
const CARD_RE = /(?<![\d•])(?:\d[ -]?){14,15}\d(?![\d•])/g;

function luhnOk(digits) {
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** True when `text` carries a secret-shaped value in the clear. */
function looksLikeSecret(text) {
  const s = String(text || '');
  if (!s) return false;
  if (SSN_RE.test(s)) return true;
  CARD_RE.lastIndex = 0;
  let m;
  while ((m = CARD_RE.exec(s))) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 15 && digits.length <= 16 && luhnOk(digits)) return true;
  }
  return false;
}

/**
 * Decide whether a guest batch (the raw JSON text the guest sent) may be relayed.
 * Returns { ok:true } or { ok:false, reason }. Only 'rrweb' batches are scanned —
 * a 'route' or 'notice' message carries a path or a keyword, never page text.
 */
function judgeBatch(text, parsed) {
  if (!parsed || parsed.t !== 'rrweb') return { ok: true };
  return looksLikeSecret(text) ? { ok: false, reason: 'secret_shaped_text' } : { ok: true };
}

module.exports = { looksLikeSecret, judgeBatch, _internals: { SSN_RE, CARD_RE, luhnOk } };
