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

// Assignment-purchase normalization (#96) — ONE definition used by EVERY create
// path (staff new-file, borrower application draft-submit, borrower direct
// create) so is_assignment / underlying_contract_price / assignment_fee /
// purchase_price can never drift between surfaces. The ticked flag is the truth:
// underlying + fee are hard-nulled unless the file is an assignment, and the
// stored purchase price is the underlying + the (client-derived) fee so
// leverage/pricing size off seller price + fee and the row is self-consistent
// regardless of what a stale or hand-rolled client sends. Returns the exact
// bind values the INSERTs use.
function assignmentFields(b) {
  b = b || {};
  const isAssignment = !!b.isAssignment;
  const underlying = isAssignment ? (b.underlyingContractPrice || null) : null;
  const assignFee = isAssignment ? (b.assignmentFee || null) : null;
  const purchasePrice = isAssignment
    ? (Number(b.underlyingContractPrice || 0) + Number(b.assignmentFee || 0))
    : (b.purchasePrice || null);
  return { isAssignment, underlying, assignFee, purchasePrice };
}

module.exports = { sanitizeFico, sanitizeSsnDigits, sanitizeLoanType, assignmentFields };
