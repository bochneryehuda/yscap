/**
 * PII guard for chat. SSNs (and card-like numbers) do not belong in a chat
 * transcript that staff, exports, and email payloads all touch — the borrower
 * has a secure document-upload flow and the encrypted SSN field on the 1003.
 *
 * Policy (industry standard for lending chat):
 *   - borrower sends → BLOCK the send with a friendly redirect to the secure
 *     upload, so the number never persists anywhere.
 *   - staff sends → REDACT in place (keep last 4) and flag it, so work isn't
 *     lost but the raw number never reaches storage, SSE, email, or export.
 *
 * Detection runs BEFORE persist/broadcast — the most common leak in chat
 * systems is the raw value landing in a push/email payload even though the
 * stored copy was masked.
 */

// SSN: 3-2-4 with separators, or a bare 9-digit run. Bare runs only count when
// nearby context suggests an SSN (avoids flagging phone numbers/loan numbers).
const SSN_SEP = /\b(\d{3})[-\s](\d{2})[-\s](\d{4})\b/g;
const SSN_BARE = /\b(\d{3})(\d{2})(\d{4})\b/g;
const SSN_CONTEXT = /\b(ssn|social|soc\s*sec|tax\s*id|itin)\b/i;

// Card-like: 13-19 digit runs (with optional spaces/dashes) that pass Luhn.
const CARDISH = /\b(?:\d[ -]?){13,19}\b/g;
function luhn(numStr) {
  const digits = numStr.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0, dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d; dbl = !dbl;
  }
  return sum % 10 === 0;
}

/** Scan text. Returns { found: bool, kinds: ['ssn'|'card'], redacted: text } */
function scan(text) {
  const s = String(text || '');
  const kinds = new Set();
  let out = s;

  out = out.replace(SSN_SEP, (_m, _a, _b, last4) => { kinds.add('ssn'); return `[SSN ending ${last4}]`; });
  if (SSN_CONTEXT.test(s)) {
    out = out.replace(SSN_BARE, (_m, _a, _b, last4) => { kinds.add('ssn'); return `[SSN ending ${last4}]`; });
  }
  out = out.replace(CARDISH, (m) => {
    if (!luhn(m)) return m;
    kinds.add('card');
    return `[card ending ${m.replace(/\D/g, '').slice(-4)}]`;
  });

  return { found: kinds.size > 0, kinds: [...kinds], redacted: out };
}

const BORROWER_BLOCK_MESSAGE =
  'For your security, please don’t share your Social Security or account numbers in chat. ' +
  'Use the secure document upload on your loan file instead — your loan team will see it there.';

module.exports = { scan, BORROWER_BLOCK_MESSAGE };
