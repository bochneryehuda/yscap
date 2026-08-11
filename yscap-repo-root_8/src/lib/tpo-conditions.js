'use strict';

/**
 * TPO (broker) CONDITION REVEAL — the ONE definition of which staff-audience,
 * order-driven conditions a broker may SEE (read-only), and the broker-safe
 * wording shown for each (owner-directed 2026-08-04; TPO blueprint §3).
 *
 * A broker already sees the borrower-safe conditions (audience borrower/both)
 * through the ordinary checklist path. On top of that they get a small,
 * hand-picked, READ-ONLY view of a few conditions the LENDER drives, so they can
 * track progress — has credit been pulled? did the appraisal come in? This is a
 * TPO-SURFACE reveal ONLY: it never changes a condition's `audience`, so the
 * borrower portal and every staff surface are byte-identical, and a broker can
 * never act on a revealed row (no upload, no answer, no sign-off — the upload
 * door already refuses a staff-audience condition, and these are marked
 * read-only in the response).
 *
 * HARD RULES baked into this allowlist — do NOT add a code that breaks one:
 *   • The FLOOD CERTIFICATE (`rtl_cond_flood`) and FLOOD INSURANCE
 *     (`rtl_cond_flood_insurance`) are NEVER borrower/broker-facing
 *     (owner-directed 2026-07-30 — the flood certificate is an INTERNAL
 *     condition on EVERY file, staff-only). They are deliberately absent here.
 *   • Fraud / background / criminal (`rtl_cond_fraud`), the PILOT review gates
 *     (`appraisal_review_cleared`, `underwriting_review_cleared`), investor
 *     final review / Clear-to-Close / structure (`rtl_f_review`, `rtl_f_ctc`),
 *     and every internal workflow condition stay hidden (TPO §3 OUT list).
 *   • Title / insurance CONTACT (`rtl_p1_titlec` / `rtl_p1_insc`) and the EMD
 *     condition (`cond_emd_corrfirst`) are already `audience='both'` and shown
 *     by the ordinary borrower-safe path — they are deliberately NOT here.
 *
 * Each revealed code carries HAND-AUTHORED broker-safe wording. The internal
 * label / hint / note / rejection reason of a staff condition is NEVER exposed
 * to a broker — only the code's fixed label + note here, plus the raw status.
 */

// code → { label, note } — the broker-safe wording for a revealed staff condition.
const REVEAL = {
  rtl_cond_credit: {
    label: 'Credit report',
    note: 'Your loan team pulls the borrower’s credit for underwriting.',
  },
  rtl_cond_appraisaldocs: {
    label: 'Appraisal',
    note: 'The appraisal is ordered and reviewed by your loan team.',
  },
};

const REVEAL_CODES = Object.keys(REVEAL);

// Codes that must NEVER appear on the broker surface (a HARD-RULE guard the
// tests assert against; several are staff-audience conditions on every file, so
// a broker seeing one would be a leak, not merely a missing feature).
const NEVER_REVEAL = [
  'rtl_cond_flood',            // flood certificate — staff-only on every file (HARD RULE)
  'rtl_cond_flood_insurance',  // flood insurance — internal
  'rtl_cond_fraud',            // fraud / background / criminal
  'appraisal_review_cleared',  // PILOT appraisal review gate
  'underwriting_review_cleared', // PILOT underwriting review gate
  'rtl_f_review',              // investor final review
  'rtl_f_ctc',                 // investor clear-to-close
];

/**
 * Build the broker-safe read-only "lender progress" row for a revealed staff
 * condition, or null if the code is not on the allowlist. `status` is the raw
 * checklist status (outstanding/received/satisfied/…); everything else is fixed,
 * safe wording — no internal label, hint, note, or reason ever passes through.
 */
function revealRow(id, code, status) {
  const meta = REVEAL[code];
  if (!meta) return null;
  return {
    id,
    label: meta.label,
    hint: meta.note,
    status,
    item_kind: 'progress',
    readOnly: true,
    answerable: false,
    is_required: true,
    rejection_reason: null,
  };
}

module.exports = { REVEAL, REVEAL_CODES, NEVER_REVEAL, revealRow };
