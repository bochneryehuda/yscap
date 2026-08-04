'use strict';
/**
 * ONE way to display a note rate, everywhere (owner-directed 2026-08-04).
 *
 * The owner: "when the rate needs to be 10.625 in certain places, it populates at
 * 10.63 instead of 10.625 … The rate should always be the same. We need to add
 * another digit, so we should be able to do 10.625 instead of 10.63 only."
 *
 * The stored rate already carries the precision (product_registrations.note_rate is
 * numeric(7,5), applications.rate_pct is numeric(6,3)); the bug was purely that
 * every surface printed it with toFixed(2), truncating 10.625 to 10.63. This is the
 * single formatter every surface must use so the SAME rate reads identically on the
 * term sheet, the overview, the studio and the DocuSign package.
 *
 * Rule: up to THREE decimals, never fewer than two, one trailing zero trimmed. So
 * 10.625 → "10.625", 10.30 → "10.30", 10.5 → "10.50", 10.63 → "10.63". A whole
 * or 1-decimal rate keeps two decimals (10.00 / 10.50) so it never looks truncated;
 * a rate that genuinely needs the third digit keeps it.
 *
 * Nothing here changes a pricing NUMBER — the engines still produce the rate; this
 * only stops the display from throwing away its third decimal.
 */

// Round a percent NUMBER (e.g. 10.625) to the 2-or-3-decimal display string.
function trim3(pctNumber) {
  const n = Number(pctNumber);
  if (!Number.isFinite(n)) return '';
  let s = n.toFixed(3);                     // "10.625" | "10.300" | "10.500"
  if (s.charAt(s.length - 1) === '0') s = s.slice(0, -1);  // drop ONE trailing zero
  return s;
}

// Note rate held as a FRACTION (0.10625) → "10.625".
function fmtRatePct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '';
  return trim3(n * 100);
}

// Note rate already held as a PERCENT number (10.625) → "10.625".
function fmtRatePctFromPct(pct) {
  return trim3(pct);
}

module.exports = { fmtRatePct, fmtRatePctFromPct, trim3 };
