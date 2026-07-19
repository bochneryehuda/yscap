'use strict';

/**
 * Underwriting FICO-match check for an imported credit report.
 *
 * "Does the file match?" — the loan's economics were built on a FICO the borrower
 * gave / the file was priced on. Once the bureau's VERIFIED score comes back, the
 * two must agree at the pricing-relevant granularity (the standard bracket). A
 * bracket-level disagreement is a FATAL underwriting finding: the file was sized on
 * a FICO the bureau did not confirm, so a human must reconcile (re-register on the
 * verified score) before clear-to-close. A same-bracket drift (e.g. 718 → 700) is
 * NOT a finding — the price is unchanged.
 *
 * Pure — plain numbers in, a finding object (or null) out. No DB, no I/O. This is
 * the single source of truth for the finding, consumed by import.js (persist +
 * condition wiring) and testable in isolation.
 */
const scoring = require('./scoring');

/**
 * @param {object} o
 *   verified    {number|null}  representative VERIFIED score (highest borrower middle)
 *   claimed     {number|null}  the FICO the file was priced/registered/built on
 *                              (representative of the borrowers' claimed scores)
 *   perBorrower {Array<{name,claimed,verified}>}  optional per-borrower detail
 * @returns {null | { type, severity, verified, claimed, verifiedBracket,
 *                     claimedBracket, perBorrower[], message }}
 */
function ficoMatchFinding(o = {}) {
  const verified = num(o.verified);
  const claimed = num(o.claimed);
  // Nothing to reconcile against: a brand-new file with no claimed/priced FICO, or
  // a no-score verified result (that is its OWN review path, not a mismatch).
  if (verified == null || claimed == null) return null;

  const verifiedBracket = scoring.bracketOf(verified);
  const claimedBracket = scoring.bracketOf(claimed);
  if (verifiedBracket && claimedBracket && verifiedBracket === claimedBracket) return null; // matches for pricing

  const perBorrower = (Array.isArray(o.perBorrower) ? o.perBorrower : [])
    .map((b) => ({ name: b.name || null, claimed: num(b.claimed), verified: num(b.verified) }))
    .filter((b) => b.claimed != null && b.verified != null && scoring.bracketOf(b.claimed) !== scoring.bracketOf(b.verified))
    .map((b) => ({ ...b, claimedBracket: scoring.bracketOf(b.claimed), verifiedBracket: scoring.bracketOf(b.verified) }));

  return {
    type: 'fico_mismatch',
    severity: 'fatal',
    verified, claimed, verifiedBracket, claimedBracket,
    perBorrower,
    message:
      `Verified FICO ${verified}${verifiedBracket ? ` (${verifiedBracket})` : ''} does NOT match the FICO the file was built on `
      + `(${claimed}${claimedBracket ? ` — ${claimedBracket}` : ''}). Underwriting must reconcile: re-register the product on the `
      + `verified score before clear-to-close.`,
  };
}

function num(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
}

module.exports = { ficoMatchFinding };
