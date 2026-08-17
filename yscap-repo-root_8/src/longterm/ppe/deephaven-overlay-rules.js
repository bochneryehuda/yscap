'use strict';
/**
 * LT PPE — DEEPHAVEN DSCR ADVANCED-OVERLAY ENFORCEMENT (owner D36 — the D29 enforcement step).
 *
 * WHAT THIS IS, and why it is a THIRD module and not folded into deephaven-matrix.js. advanced-facts.js
 * carries the overlay facts (short_term_rental, first_time_investor, rural_property, declining_market,
 * foreign_national, first_time_homebuyer, renovation, occupancy — every one `lpVisible:false`, i.e.
 * Lender Price cannot SEE them) and overlay.js stamps a reasoned override of LP. This module is the
 * missing middle: it turns the UNAMBIGUOUS numeric cuts published in the Deephaven DSCR matrix into REAL
 * declines — each stamped via overlay.overlayDecline so the E3 agreement classifier scores it as an
 * intentional OVERLAY (never a parity defect). deephaven-matrix.js stays sourced ONLY from LP-visible
 * facts (its independence is the point); the overlay-only cuts live here so the two concerns do not mix.
 *
 * NOW DATA, NOT CODE. The cuts below are a DECLARATIVE TABLE (`DEEPHAVEN_OVERLAY_CUTS`) interpreted by the
 * investor-agnostic `overlay-cut-engine.evaluateCutTable`. The behavior is BYTE-IDENTICAL to the earlier
 * hand-written branches (proven by the equivalence battery in `test-lt-ppe-overlay-cut-engine.js`); the
 * point of the split is that the SECOND investor's overlay cuts are a new table, never a second copy of
 * the interpreter (PPE #47/#48 — the "universal rule shape"; CLAUDE.md build-rule #4).
 *
 * DISCIPLINE — the owner HARD RULE "never guess a business rule" governs every ENFORCED row:
 *   • A cut is enforced ONLY when the matrix text is UNAMBIGUOUS and we carry the fact it needs. Every
 *     enforced number is transcribed verbatim from the published matrix (advanced-facts.js `effect`,
 *     which is itself verbatim from deephaven-matrix.js `unverifiable[]`).
 *   • An AMBIGUOUS cut is NOT enforced — it is a `flags` row returned in `stillFlagged` with what it
 *     needs. Deliberately left flagged: occupancy vacant (D27 — internally ambiguous "ineligible for R/T
 *     & C/O refi; -5% LTV on refi"), Foreign National "LTV caps 70/60" (which cap applies is not stated),
 *     Rural "DSCR > 1.0x" (strict-vs-inclusive boundary) + "<=10 acres, no ag/farm use" (facts not
 *     carried), First-Time Homebuyer (needs a borrower-count fact), Renovation (needs a seasoning fact).
 *   • A cut NEVER fires on an ABSENT fact (fail-safe — the interpreter guarantees this), matching
 *     deephaven-matrix.js.
 *   • "-5% LTV" is read as -5 PERCENTAGE POINTS, not -5% relative — CONFIRMED within the same matrix by
 *     the Short-Term Rental line "-5% LTV (75% max)", which is an 80% base minus 5 points.
 *
 * SAFETY. Every overlay fact defaults OFF (advanced-facts: booleans false, occupancy 'leased'), so an
 * ordinary Lender Price scenario (no Advanced options set) arms NO group here — program eligibility is
 * byte-identical for it, and the live agreement run (which sends no overlay facts) is unaffected. An
 * overlay decline can only ever make our engine STRICTER than LP, which by construction (overlay.js) can
 * only make the E3 gate HARDER to pass, never falsely pass.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const { evaluateCutTable } = require('./overlay-cut-engine');

const CITE = 'Deephaven Corr Flow DSCR matrix, eff 08/04/26 — Advanced overlays';

// The confirmed numeric cuts (matrix-verbatim), in the engine-fact scales: ltv MILLI-percent (75% →
// 75000), dscr MILLI (1.15 → 1150), fico RAW, loan_amount RAW dollars.
const STR_MIN_DSCR = 1150;            // Short-Term Rental: Min DSCR 1.15
const STR_MIN_FICO = 720;             // Short-Term Rental: Min FICO 720
const STR_MAX_LTV = 75000;            // Short-Term Rental: -5% LTV (75% max)
const FTI_MIN_DSCR = 1000;            // First-Time Investor: Min DSCR 1.00
const FTI_MIN_FICO = 700;             // First-Time Investor: Min FICO 700
const RURAL_MAX_LTV = 65000;          // Rural: Max 65% LTV
const FN_MAX_LOAN = 1500000;          // Foreign National: max loan $1.5M
const FN_MIN_DSCR = 1000;             // Foreign National: DSCR >= 1.00 only
const DECLINING_LTV_CUT_MILLI = 5000; // Declining market: Max LTV -5 points

// The Deephaven DSCR Advanced-overlay CUT TABLE — the seed data the generic interpreter reads. ORDER is
// preserved end-to-end: declines, enforced rows, and stillFlagged entries all come out in group order,
// which is the order the E3 comparator and the program layer have always seen.
const DEEPHAVEN_OVERLAY_CUTS = [
  // ---- Short-Term Rental: Min DSCR 1.15, Min FICO 720, Max LTV 75%, no FTI / 2+unit / rural ----------
  // Every one is unambiguous AND we carry the fact (units, first_time_investor, rural_property).
  {
    when: 'short_term_rental', enforce: true,
    cuts: [
      { code: 'overlay_str_min_dscr', fact: 'dscr', cmp: 'lt', value: STR_MIN_DSCR, reason: 'Short-Term Rental requires DSCR >= 1.15x', label: 'dscr>=1.15' },
      { code: 'overlay_str_min_fico', fact: 'fico', cmp: 'lt', value: STR_MIN_FICO, reason: 'Short-Term Rental requires FICO >= 720', label: 'fico>=720' },
      { code: 'overlay_str_max_ltv', fact: 'ltv', cmp: 'gt', value: STR_MAX_LTV, reason: 'Short-Term Rental caps LTV at 75%', label: 'ltv<=75' },
      { code: 'overlay_str_units', fact: 'units', cmp: 'gte', value: 2, reason: 'Short-Term Rental is not allowed on a 2+ unit property', label: 'units<2' },
      { code: 'overlay_str_no_fti', fact: 'first_time_investor', cmp: 'isTrue', reason: 'Short-Term Rental is not allowed for a first-time investor', label: 'not first-time investor' },
      { code: 'overlay_str_no_rural', fact: 'rural_property', cmp: 'isTrue', reason: 'Short-Term Rental is not allowed on a rural property', label: 'not rural' },
    ],
  },
  // ---- First-Time Investor: Min DSCR 1.00, Min FICO 700 --------------------------------------------
  // "long-term rental only" is the SAME STR<->FTI incompatibility the Short-Term Rental block enforces
  // (a first-time investor on a short-term rental is declined there) — never double-enforced here.
  {
    when: 'first_time_investor', enforce: true,
    cuts: [
      { code: 'overlay_fti_min_dscr', fact: 'dscr', cmp: 'lt', value: FTI_MIN_DSCR, reason: 'First-Time Investor requires DSCR >= 1.00x', label: 'dscr>=1.00' },
      { code: 'overlay_fti_min_fico', fact: 'fico', cmp: 'lt', value: FTI_MIN_FICO, reason: 'First-Time Investor requires FICO >= 700', label: 'fico>=700' },
    ],
  },
  // ---- Rural: Max 65% LTV (the DSCR>1.0 boundary + acreage/ag-use are NOT enforced) ----------------
  {
    when: 'rural_property', enforce: true,
    cuts: [
      { code: 'overlay_rural_max_ltv', fact: 'ltv', cmp: 'gt', value: RURAL_MAX_LTV, reason: 'Rural caps LTV at 65%', label: 'ltv<=65' },
    ],
    flags: [{ overlay: 'Rural: DSCR > 1.0x, <=10 acres, no ag/farm use', needs: 'DSCR strict-vs-inclusive boundary + acreage / land-use facts not carried' }],
  },
  // ---- Declining market: Max LTV -5 points (RELATIVE to the Layer-2 grid cap for this cell) --------
  {
    when: 'declining_market', enforce: true,
    cuts: [
      {
        code: 'overlay_declining_ltv', fact: 'ltv', cmp: 'gtRelative', base: 'gridMaxLtvMilli', delta: DECLINING_LTV_CUT_MILLI,
        reason: (c) => `Declining market reduces max LTV by 5 points (to ${c.eff / 1000}%)`,
        label: (c) => `ltv<=${c.eff / 1000}`,
        unresolvedFlag: { overlay: 'Declining market: Max LTV -5%', needs: 'needs the Layer-2 grid max-LTV cap (gridMaxLtvMilli) for this cell' },
      },
    ],
  },
  // ---- Foreign National: max loan $1.5M, DSCR >= 1.00 (the LTV caps "70/60" are ambiguous) ---------
  {
    when: 'foreign_national', enforce: true,
    cuts: [
      { code: 'overlay_fn_max_loan', fact: 'loan_amount', cmp: 'gt', value: FN_MAX_LOAN, reason: 'Foreign National max loan $1,500,000', label: 'loan<=1.5M' },
      { code: 'overlay_fn_min_dscr', fact: 'dscr', cmp: 'lt', value: FN_MIN_DSCR, reason: 'Foreign National requires DSCR >= 1.00x', label: 'dscr>=1.00' },
    ],
    flags: [{ overlay: 'Foreign National: LTV caps 70/60', needs: 'which cap (70 vs 60) applies is not stated in the matrix' }],
  },
  // ---- Overlays with NO enforced cut (ambiguous rule text / facts not carried) — flagged, never guessed
  { when: 'occupancy', whenEquals: 'vacant', flags: [{ overlay: 'Vacant/Unleased: ineligible for R/T & C/O refi; -5% LTV on refi; 2+unit max 1 vacant', needs: 'D27 — internally ambiguous rule text (owner decision pending)' }] },
  { when: 'first_time_homebuyer', flags: [{ overlay: 'First-Time Homebuyer: ineligible unless 2+ borrowers with one non-FTHB', needs: 'needs a borrower-count / non-FTHB fact' }] },
  { when: 'renovation', flags: [{ overlay: 'Renovation cash-out: appraised value under 6mo ownership at max 75% LTV', needs: 'needs a seasoning (months owned) fact' }] },
];

/**
 * Enforce the unambiguous Deephaven DSCR Advanced-overlay cuts for a scenario's engine facts. PURE.
 *   facts — engine facts (lp-agreement-legs.lpScenarioToFacts vocabulary), incl. the boolean overlay
 *           facts + the `occupancy` enum. A missing numeric fact yields no decline for the cut that
 *           needs it (fail-safe).
 *   opts.gridMaxLtvMilli — the Layer-2 grid's resolved max-LTV cap for this scenario's cell, needed ONLY
 *           for the RELATIVE declining-market cut. Absent/non-numeric → that one cut is not enforced (it
 *           is reported in `stillFlagged`); every other cut is unaffected.
 * Returns { declines:[<overlayDecline>...], enforced:[{overlay, cuts[]}], stillFlagged:[{overlay, needs}] }.
 * Each entry in `declines` is a VALID overlay decline (overlay.isValidOverlayDecline === true), so the
 * E3 classifier scores an our-ineligible / LP-eligible divergence resting on them as OVERLAY, not DEFECT.
 */
function evaluateOverlayDeclines(facts, opts = {}) {
  return evaluateCutTable(facts, DEEPHAVEN_OVERLAY_CUTS, { ...opts, citation: CITE });
}

module.exports = {
  evaluateOverlayDeclines,
  CITE,
  DEEPHAVEN_OVERLAY_CUTS,
  _cuts: { STR_MIN_DSCR, STR_MIN_FICO, STR_MAX_LTV, FTI_MIN_DSCR, FTI_MIN_FICO, RURAL_MAX_LTV, FN_MAX_LOAN, FN_MIN_DSCR, DECLINING_LTV_CUT_MILLI },
};
