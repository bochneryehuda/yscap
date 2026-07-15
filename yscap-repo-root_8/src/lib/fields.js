'use strict';

/**
 * Server-side field sanitizers (#90/#91/#92) — the belt-and-suspenders partner to
 * the portal's input constraints, so a value that bypasses the UI (a direct API
 * call, an old cached client, a ClickUp inbound) still can't persist garbage.
 */

// FICO is a 3-digit credit score in [300, 850]. Anything outside → null (reject
// rather than store an impossible score). Accepts a number or a string with any
// punctuation.
function sanitizeFico(v) {
  if (v === '' || v == null) return null;
  const n = parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) && n >= 300 && n <= 850 ? n : null;
}

// SSN → the 9 digits, or null if it isn't a full 9-digit SSN. Never store a
// partial/garbage SSN. (The digits are what the encryption layer consumes.)
function sanitizeSsnDigits(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length === 9 ? d : null;
}

// A loan_type is a loan PURPOSE — Purchase or Refinance — never a program.
// "Ground up"/"Ground-Up" is a program that was wrongly offered as a loan type
// (#95); null it out at the write chokepoint so no surface (V1, V2, API, or a
// ClickUp inbound) can persist it and mis-price the file. Any other value passes
// through unchanged (the pricing engine already coerces non-refi → Purchase).
function sanitizeLoanType(v) {
  if (v == null || v === '') return null;
  return /^\s*ground/i.test(String(v)) ? null : v;
}

module.exports = { sanitizeFico, sanitizeSsnDigits, sanitizeLoanType };
