'use strict';
/**
 * LT PPE — THE PROGRAM: "Deephaven DSCR", the investor-named product that CONNECTS THE THREE DOTS the
 * owner requires for every program (2026-08-17): the investor name lives in the program name, and the
 * three layers are wired together so one scenario resolves against all three.
 *
 *   DOT 1 — RATE SHEET (pricing): base ladder + LLPAs (deephaven-dscr-sheet.buildDeephavenGrid).
 *   DOT 2 — ELIGIBILITY MATRIX: the published product matrix (deephaven-matrix.evaluateEligibility).
 *   DOT 3 — PPP STATE MATRIX: which states/borrower-types may carry a prepayment penalty
 *           (deephaven-ppp-matrix.pppDisqualifier) — a PPP requested where prohibited is a disqualifier.
 *
 * evaluateProgram(facts) runs dots 2 + 3 and returns the COMBINED eligibility verdict + which layer each
 * decline came from. Pricing (dot 1) is referenced by the program but priced by the existing rate-sheet
 * pipeline; this module composes the two ELIGIBILITY layers so "is this loan eligible for Deephaven
 * DSCR?" has one answer that spans the matrix AND the PPP rules.
 *
 * The facts are the engine's (lp-agreement-legs.lpScenarioToFacts) PLUS the PPP-only facts the pricer
 * does not yet carry: `borrower_type` (LLC/Individual/…), `prepay_months` (>0 = a PPP is requested),
 * `apr` (IL natural-person rule), `rural_property` (LA). A PPP fact that is absent fails OPEN — the PPP
 * layer never invents a prohibition on data it does not have.
 *
 * LT-only. Pure: no DB, no network, no clock. No RTL imports.
 */
const { buildDeephavenGrid } = require('./deephaven-dscr-sheet');
const { evaluateEligibility } = require('./deephaven-matrix');
const { pppDisqualifier, pppResult } = require('./deephaven-ppp-matrix');
const { evaluateInformational } = require('./informational');
const { evaluateOverlayDeclines } = require('./deephaven-overlay-rules');

const INVESTOR = 'Deephaven';
const PROGRAM_NAME = 'Deephaven DSCR'; // the investor name IS in the program name (owner rule)

// Map engine facts → the PPP layer's input shape. prepay_months > 0 ⇒ a PPP is requested.
// borrower_type DEFAULTS to LLC (owner-directed 2026-08-17): the product's entity default, so a NJ
// loan carries a PPP by default (an LLC is allowed one) and only an Advanced switch to an individual
// triggers the natural-person prohibition. A direct-facts caller that omits it still gets this default.
function pppInputFromFacts(f) {
  const sc = f || {};
  return {
    state: sc.state,
    borrowerType: sc.borrower_type || 'LLC',
    units: sc.units,
    lien: 'first', // a DSCR loan is a first lien
    loanAmount: sc.loan_amount,
    apr: sc.apr,
    ruralProperty: !!sc.rural_property,
    prepayRequested: Number(sc.prepay_months) > 0,
  };
}

/**
 * The combined ELIGIBILITY verdict for Deephaven DSCR: the matrix layer AND the PPP layer, PLUS the
 * INFORMATIONAL layer (reserves / notes / the delegate exception — non-blocking; never changes eligible).
 * Returns { program, investor, eligible, reasons:[{layer, code, dimension, declineReason, citation}],
 *   maxLtvMilli, ppp:{result, terms}, unverifiable, reserves, informational[], exceptions[] }.
 *   opts.monthlyPitia — the priced product's monthly PITIA, so the reserve DOLLAR is computable.
 */
function evaluateProgram(facts, opts = {}) {
  const elig = evaluateEligibility(facts);
  const reasons = elig.reasons.map((r) => ({ layer: 'eligibility_matrix', ...r }));

  const pppInput = pppInputFromFacts(facts);
  const ppp = pppResult(pppInput);
  const pppDq = pppDisqualifier(pppInput);
  if (pppDq) reasons.push({ layer: 'ppp_matrix', ...pppDq });

  // Layer-2 ADVANCED-OVERLAY enforcement (D36): the Advanced-only facts Lender Price cannot SEE
  // (short-term rental, first-time investor, rural, declining market, foreign national). Each decline is
  // stamped as a reasoned OVERLAY (deephaven-overlay-rules → overlay.overlayDecline), so the E3 gate
  // scores it as an intentional override of LP, never a parity defect. Every overlay fact defaults OFF,
  // so an ordinary scenario (no Advanced options) triggers nothing here — byte-identical to before. The
  // relative declining-market cut reads the grid's OWN resolved max-LTV cap so the two can never disagree.
  const overlay = evaluateOverlayDeclines(facts, { gridMaxLtvMilli: elig.maxLtvMilli });
  for (const d of overlay.declines) {
    reasons.push({ layer: 'overlay', code: d.code, dimension: d.fact, declineReason: d.reason, citation: d.citation, overlay: true, fact: d.fact });
  }

  // The informational layer enriches the product; it NEVER changes the eligible verdict.
  const info = evaluateInformational(facts, { monthlyPitia: opts.monthlyPitia });

  return {
    program: PROGRAM_NAME,
    investor: INVESTOR,
    eligible: reasons.length === 0,
    reasons,
    maxLtvMilli: elig.maxLtvMilli,
    cell: elig.cell,
    ppp: { result: ppp.result, terms: ppp.terms || null, matched: ppp.matched },
    unverifiable: elig.unverifiable,
    // D36 overlay enforcement: which Advanced overlays fired, which cuts each enforced, and which remain
    // flagged (ambiguous rule text / facts not carried). `declines` are valid overlay declines (the E3
    // classifier scores them OVERLAY). Empty for an ordinary scenario with no Advanced facts set.
    overlay: { declines: overlay.declines, enforced: overlay.enforced, stillFlagged: overlay.stillFlagged },
    // informational product attributes (D26/D34) — reserves, notes, and the loud delegate exception.
    reserves: info.reserves,
    informational: info.informational,
    exceptions: info.exceptions,
  };
}

// The program descriptor — the three dots, named by the investor, in one place.
const PROGRAM = {
  investor: INVESTOR,
  name: PROGRAM_NAME,
  layers: {
    rateSheet: buildDeephavenGrid,          // dot 1 (pricing)
    eligibility: evaluateEligibility,        // dot 2
    ppp: { result: pppResult, disqualifier: pppDisqualifier }, // dot 3
  },
  evaluate: evaluateProgram,
};

module.exports = { PROGRAM, evaluateProgram, INVESTOR, PROGRAM_NAME, _internals: { pppInputFromFacts } };
