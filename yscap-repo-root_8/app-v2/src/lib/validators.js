/**
 * Field formatters & validators shared across the portal (#90/#91/#92).
 * Constrain each input to exactly what it represents, on every surface, so a
 * bad value can't be typed in the first place (belt-and-suspenders with the
 * server-side checks).
 */

// ---- SSN: format digits as XXX-XX-XXXX, hard-capped at 9 digits -------------
export function formatSSN(raw) {
  const d = String(raw ?? '').replace(/\D/g, '').slice(0, 9);
  if (d.length <= 3) return d;
  if (d.length <= 5) return d.slice(0, 3) + '-' + d.slice(3);
  return d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5);
}
export const ssnDigits = (v) => String(v ?? '').replace(/\D/g, '');
export const isCompleteSSN = (v) => ssnDigits(v).length === 9;

// ---- FICO: 3 digits, valid credit-score range 300–850 ----------------------
export const cleanFICO = (raw) => String(raw ?? '').replace(/\D/g, '').slice(0, 3);
export function ficoValid(v) {
  const s = cleanFICO(v);
  if (s === '') return true;               // blank is allowed (optional field)
  const n = Number(s);
  return n >= 300 && n <= 850;
}
