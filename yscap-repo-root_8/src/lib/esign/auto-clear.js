'use strict';
/**
 * Conditions that CLEAR THEMSELVES when their DocuSign package is fully signed
 * (owner-directed 2026-08-05). The borrower signs these in DocuSign when we send
 * the package, so nobody works them by hand — the file stamps them "Auto-cleared
 * by DocuSign" so the team knows the condition is taken care of automatically and
 * doesn't chase it.
 *
 * These are the ORIGINATION packages the owner listed: the term sheet, the loan
 * application + business-purpose disclosure, the Heter Iska, and — on a file that
 * vests in an individual's name — the non-owner-occupied certification.
 *
 * The DRAW REQUEST / wire form (draw_cond_signed_request) is deliberately NOT here:
 * it is signed in DocuSign too, but it is a borrower form that must be REVIEWED and
 * accepted before the draw is delivered to the investor (a different requirement,
 * handled by the draw-wire condition), so it must never read as "nothing to do".
 *
 * Kept in lock-step with esign/orchestrate.js PACKAGES by
 * scripts/test-esign-autoclear-codes-pure.js (which derives the same set from the
 * origination packages and fails if the two drift).
 */

const AUTO_CLEAR_CONDITION_CODES = new Set([
  'rtl_cond_signedts',             // Term Sheet
  'rtl_cond_signed_app',           // Loan Application + Business-Purpose Disclosure
  'rtl_cond_iska',                 // Heter Iska
  'cond_noo_affidavit_individual', // Non-Owner-Occupied Certification (individual vesting)
]);

// The e-sign packages whose signed documents clear an origination condition — the
// draw request is EXCLUDED on purpose (its condition needs human review). Used only
// by the drift-guard test, so the constant set above stays the one runtime source.
const ORIGINATION_PACKAGES = ['term_sheet_package', 'heter_iska', 'noo_affidavit'];

function isAutoClearedByEsign(code) {
  return AUTO_CLEAR_CONDITION_CODES.has(String(code || ''));
}

module.exports = { AUTO_CLEAR_CONDITION_CODES, ORIGINATION_PACKAGES, isAutoClearedByEsign };
