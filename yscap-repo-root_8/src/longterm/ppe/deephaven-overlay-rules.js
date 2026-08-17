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
 * DISCIPLINE — the owner HARD RULE "never guess a business rule" governs every line:
 *   • A cut is enforced ONLY when the matrix text is UNAMBIGUOUS and we carry the fact it needs. Every
 *     enforced number is transcribed verbatim from the published matrix (advanced-facts.js `effect`,
 *     which is itself verbatim from deephaven-matrix.js `unverifiable[]`).
 *   • An AMBIGUOUS cut is NOT enforced — it is returned in `stillFlagged` with what it needs. Deliberately
 *     left flagged: occupancy vacant (D27 — internally ambiguous "ineligible for R/T & C/O refi; -5% LTV
 *     on refi"), Foreign National "LTV caps 70/60" (which cap applies is not stated), Rural "DSCR > 1.0x"
 *     (strict-vs-inclusive boundary) + "<=10 acres, no ag/farm use" (facts not carried), First-Time
 *     Homebuyer (needs a borrower-count / non-FTHB fact), Renovation (needs a seasoning fact).
 *   • A cut NEVER fires on an ABSENT fact (fail-safe — we never disqualify on data we do not have),
 *     matching deephaven-matrix.js.
 *   • "-5% LTV" is read as -5 PERCENTAGE POINTS, not -5% relative — CONFIRMED within the same matrix by
 *     the Short-Term Rental line "-5% LTV (75% max)", which is an 80% base minus 5 points.
 *
 * SAFETY. Every overlay fact defaults OFF (advanced-facts: booleans false, occupancy 'leased'), so an
 * ordinary Lender Price scenario (no Advanced options set) triggers NOTHING here — program eligibility is
 * byte-identical for it, and the live agreement run (which sends no overlay facts) is unaffected. An
 * overlay decline can only ever make our engine STRICTER than LP, which by construction (overlay.js) can
 * only make the E3 gate HARDER to pass, never falsely pass.
 *
 * PURE: no DB, no network, no clock. LT-only. No RTL imports.
 */

const { overlayDecline } = require('./overlay');

const CITE = 'Deephaven Corr Flow DSCR matrix, eff 08/04/26 — Advanced overlays';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

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
  const f = facts || {};
  const declines = [];
  const enforced = [];
  const stillFlagged = [];
  const flag = (overlay, needs) => stillFlagged.push({ overlay, needs });
  const decline = (fact, reason, code) => declines.push(overlayDecline(fact, reason, { code, citation: CITE }));

  const fico = f.fico, ltv = f.ltv, dscr = f.dscr, loan = f.loan_amount, units = f.units;

  // ---- Short-Term Rental: Min DSCR 1.15, Min FICO 720, Max LTV 75%, no FTI / 2+unit / rural ---------
  // Every one of these is unambiguous AND we carry the fact (units, first_time_investor, rural_property).
  if (f.short_term_rental === true) {
    const cuts = [];
    if (isNum(dscr) && dscr < STR_MIN_DSCR) { decline('short_term_rental', 'Short-Term Rental requires DSCR >= 1.15x', 'overlay_str_min_dscr'); cuts.push('dscr>=1.15'); }
    if (isNum(fico) && fico < STR_MIN_FICO) { decline('short_term_rental', 'Short-Term Rental requires FICO >= 720', 'overlay_str_min_fico'); cuts.push('fico>=720'); }
    if (isNum(ltv) && ltv > STR_MAX_LTV) { decline('short_term_rental', 'Short-Term Rental caps LTV at 75%', 'overlay_str_max_ltv'); cuts.push('ltv<=75'); }
    if (isNum(units) && units >= 2) { decline('short_term_rental', 'Short-Term Rental is not allowed on a 2+ unit property', 'overlay_str_units'); cuts.push('units<2'); }
    if (f.first_time_investor === true) { decline('short_term_rental', 'Short-Term Rental is not allowed for a first-time investor', 'overlay_str_no_fti'); cuts.push('not first-time investor'); }
    if (f.rural_property === true) { decline('short_term_rental', 'Short-Term Rental is not allowed on a rural property', 'overlay_str_no_rural'); cuts.push('not rural'); }
    enforced.push({ overlay: 'short_term_rental', cuts });
  }

  // ---- First-Time Investor: Min DSCR 1.00, Min FICO 700 --------------------------------------------
  // "long-term rental only" is the SAME STR<->FTI incompatibility the Short-Term Rental block enforces
  // (a first-time investor on a short-term rental is declined there) — never double-enforced here.
  if (f.first_time_investor === true) {
    const cuts = [];
    if (isNum(dscr) && dscr < FTI_MIN_DSCR) { decline('first_time_investor', 'First-Time Investor requires DSCR >= 1.00x', 'overlay_fti_min_dscr'); cuts.push('dscr>=1.00'); }
    if (isNum(fico) && fico < FTI_MIN_FICO) { decline('first_time_investor', 'First-Time Investor requires FICO >= 700', 'overlay_fti_min_fico'); cuts.push('fico>=700'); }
    enforced.push({ overlay: 'first_time_investor', cuts });
  }

  // ---- Rural: Max 65% LTV (the DSCR>1.0 boundary + acreage/ag-use are NOT enforced) ----------------
  if (f.rural_property === true) {
    const cuts = [];
    if (isNum(ltv) && ltv > RURAL_MAX_LTV) { decline('rural_property', 'Rural caps LTV at 65%', 'overlay_rural_max_ltv'); cuts.push('ltv<=65'); }
    enforced.push({ overlay: 'rural_property', cuts });
    flag('Rural: DSCR > 1.0x, <=10 acres, no ag/farm use', 'DSCR strict-vs-inclusive boundary + acreage / land-use facts not carried');
  }

  // ---- Declining market: Max LTV -5 points (RELATIVE to the Layer-2 grid cap for this cell) --------
  if (f.declining_market === true) {
    const gridMax = opts.gridMaxLtvMilli;
    if (isNum(gridMax) && isNum(ltv)) {
      const eff = gridMax - DECLINING_LTV_CUT_MILLI;
      const cuts = [];
      if (ltv > eff) { decline('declining_market', `Declining market reduces max LTV by 5 points (to ${eff / 1000}%)`, 'overlay_declining_ltv'); cuts.push(`ltv<=${eff / 1000}`); }
      enforced.push({ overlay: 'declining_market', cuts });
    } else {
      flag('Declining market: Max LTV -5%', 'needs the Layer-2 grid max-LTV cap (gridMaxLtvMilli) for this cell');
    }
  }

  // ---- Foreign National: max loan $1.5M, DSCR >= 1.00 (the LTV caps "70/60" are ambiguous) ---------
  if (f.foreign_national === true) {
    const cuts = [];
    if (isNum(loan) && loan > FN_MAX_LOAN) { decline('foreign_national', 'Foreign National max loan $1,500,000', 'overlay_fn_max_loan'); cuts.push('loan<=1.5M'); }
    if (isNum(dscr) && dscr < FN_MIN_DSCR) { decline('foreign_national', 'Foreign National requires DSCR >= 1.00x', 'overlay_fn_min_dscr'); cuts.push('dscr>=1.00'); }
    enforced.push({ overlay: 'foreign_national', cuts });
    flag('Foreign National: LTV caps 70/60', 'which cap (70 vs 60) applies is not stated in the matrix');
  }

  // ---- Overlays with NO enforced cut (ambiguous rule text / facts not carried) — flagged, never guessed
  if (f.occupancy === 'vacant') flag('Vacant/Unleased: ineligible for R/T & C/O refi; -5% LTV on refi; 2+unit max 1 vacant', 'D27 — internally ambiguous rule text (owner decision pending)');
  if (f.first_time_homebuyer === true) flag('First-Time Homebuyer: ineligible unless 2+ borrowers with one non-FTHB', 'needs a borrower-count / non-FTHB fact');
  if (f.renovation === true) flag('Renovation cash-out: appraised value under 6mo ownership at max 75% LTV', 'needs a seasoning (months owned) fact');

  return { declines, enforced, stillFlagged };
}

module.exports = {
  evaluateOverlayDeclines,
  CITE,
  _cuts: { STR_MIN_DSCR, STR_MIN_FICO, STR_MAX_LTV, FTI_MIN_DSCR, FTI_MIN_FICO, RURAL_MAX_LTV, FN_MAX_LOAN, FN_MIN_DSCR, DECLINING_LTV_CUT_MILLI },
};
