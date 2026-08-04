// ONE way to display a note rate in the portal (owner-directed 2026-08-04).
// Up to 3 decimals, never fewer than 2, one trailing zero trimmed — so 10.625%
// prints as 10.625 (not 10.63) and 10.30% stays 10.30. Mirrors the server helper
// src/lib/rate-format.js and the studio's fmtRate3 so every surface shows the SAME
// rate. Changes no pricing number — the stored rate already carries the precision.
function trim3(pctNumber) {
  const n = Number(pctNumber);
  if (!Number.isFinite(n)) return '';
  let s = n.toFixed(3);
  if (s.charAt(s.length - 1) === '0') s = s.slice(0, -1);
  return s;
}
// Note rate held as a FRACTION (0.10625) -> "10.625".
export function fmtRatePct(fraction) {
  const n = Number(fraction);
  if (!Number.isFinite(n)) return '';
  return trim3(n * 100);
}
// Note rate already a PERCENT number (10.625) -> "10.625".
export function fmtRatePctFromPct(pct) {
  return trim3(pct);
}
