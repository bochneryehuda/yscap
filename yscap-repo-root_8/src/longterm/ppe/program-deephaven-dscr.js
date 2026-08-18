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
const { pppDisqualifier, pppResult, pppUnresolved } = require('./deephaven-ppp-matrix');
const { evaluateInformational } = require('./informational');
const { evaluateOverlayDeclines, DEEPHAVEN_OVERLAY_CUTS } = require('./deephaven-overlay-rules');
const { runProgram, assertDescriptor } = require('./program-engine');

const INVESTOR = 'Deephaven';
const PROGRAM_NAME = 'Deephaven DSCR'; // the investor name IS in the program name (owner rule)

// Map engine facts → the PPP layer's input shape. prepay_months > 0 ⇒ a PPP is requested.
// borrower_type DEFAULTS to LLC (owner-directed 2026-08-17): the product's entity default, so a NJ
// loan carries a PPP by default (an LLC is allowed one) and only an Advanced switch to an individual
// triggers the natural-person prohibition. A direct-facts caller that omits it still gets this default.
function pppInputFromFacts(f) {
  const sc = f || {};
  // A GUESS TRAVELS AS A GUESS (defect A8.5). `borrower_type_assumed` is set by the fact converter when
  // nothing was stated; a direct-facts caller that supplies only `borrower_type` is treated as having
  // STATED it, and a caller that supplies neither is assuming by definition.
  const stated = sc.borrower_type_stated || sc.borrower_type || null;
  return {
    state: sc.state,
    borrowerType: stated || 'LLC',
    borrowerTypeAssumed: sc.borrower_type_assumed === true || !stated,
    units: sc.units,
    lien: 'first', // a DSCR loan is a first lien
    loanAmount: sc.loan_amount,
    apr: sc.apr,
    ruralProperty: !!sc.rural_property,
    prepayRequested: Number(sc.prepay_months) > 0,
  };
}

// The Deephaven DSCR PROGRAM DESCRIPTOR — the per-investor slots the generic `program-engine.runProgram`
// pipeline calls. This is the seed entry of the multi-investor program registry (PPE #47): a second
// investor's program is a NEW descriptor (its own layer functions + overlay cut table), never a second
// copy of the three-layer wiring. `runProgram` composes them identically for every investor.
const DESCRIPTOR = assertDescriptor({
  investor: INVESTOR,
  programName: PROGRAM_NAME,
  evaluateEligibility,                                                   // dot 2 — the eligibility matrix
  pppInputFromFacts,                                                     // engine facts → the PPP input shape
  pppResult,                                                            // dot 3 — the PPP result
  pppDisqualifier,                                                      // dot 3 — the PPP disqualifier
  pppUnresolved,                                                        // dot 3 — "we could not tell"
  evaluateOverlay: (facts, o) => evaluateOverlayDeclines(facts, o),      // D36 Advanced-overlay declines
  evaluateInformational,                                               // reserves / notes / delegate exception
  // the overlay facts THIS program's overlay layer handles (enforces or flags) — the `when` keys of its
  // cut table. The program engine uses it to reconcile the matrix's `unverifiable` catalog: an overlay
  // whose fact is covered here is no longer "nobody can check it". Derived from the table, never hand-kept.
  overlayCoverage: [...new Set(DEEPHAVEN_OVERLAY_CUTS.map((g) => g.when))],
  // The overlay CUT TABLE itself, carried on the descriptor so a self-audit can ENUMERATE the decline
  // codes this layer is capable of emitting. Without it the overlay layer is a closed function: its
  // declines can be counted but never checked for completeness, so a dead overlay rule (an encoded cut
  // that can never fire) would be invisible — the exact defect class the program self-audit exists for.
  // It is the SAME table the coverage above is derived from, passed by reference, never a second copy.
  // Read-only: nothing in the pricing pipeline reads it.
  overlayCuts: DEEPHAVEN_OVERLAY_CUTS,
});

/**
 * The combined ELIGIBILITY verdict for Deephaven DSCR: the matrix layer AND the PPP layer, PLUS the
 * INFORMATIONAL layer (reserves / notes / the delegate exception — non-blocking; never changes eligible).
 * Returns { program, investor, eligible, reasons:[{layer, code, dimension, declineReason, citation}],
 *   maxLtvMilli, ppp:{result, terms}, unverifiable, overlay, reserves, informational[], exceptions[] }.
 *   opts.monthlyPitia — the priced product's monthly PITIA, so the reserve DOLLAR is computable.
 * Byte-identical to the previous hand-written composition — it now runs through the shared program engine.
 */
function evaluateProgram(facts, opts = {}) {
  return runProgram(DESCRIPTOR, facts, opts);
}

// The program descriptor — the three dots, named by the investor, in one place.
const PROGRAM = {
  investor: INVESTOR,
  name: PROGRAM_NAME,
  layers: {
    rateSheet: buildDeephavenGrid,          // dot 1 (pricing)
    eligibility: evaluateEligibility,        // dot 2
    ppp: { result: pppResult, disqualifier: pppDisqualifier, unresolved: pppUnresolved }, // dot 3
  },
  descriptor: DESCRIPTOR,
  evaluate: evaluateProgram,
};

module.exports = { PROGRAM, DESCRIPTOR, evaluateProgram, INVESTOR, PROGRAM_NAME, _internals: { pppInputFromFacts } };
