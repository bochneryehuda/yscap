'use strict';
/**
 * LT PPE — THE GENERIC PROGRAM ENGINE (the scalable "connect the three dots"; PPE #47).
 *
 * WHAT THIS IS. Every investor program the owner requires wires the SAME three eligibility layers plus the
 * overlay layer into one verdict: the eligibility matrix (dot 2), the PPP state matrix (dot 3), and the
 * D36 Advanced-overlay declines, with the informational layer enriching but never gating. That composition
 * was hand-written inside `program-deephaven-dscr.evaluateProgram` — correct, but it meant the SECOND
 * investor's program would be a second copy of the same wiring. This module is the composition, once: it
 * takes a PROGRAM DESCRIPTOR (the per-investor function/table slots) and runs it. A new investor's program
 * is then a DESCRIPTOR (data + its own layer functions), never a re-implementation of the pipeline.
 *
 * A DESCRIPTOR carries exactly the slots the pipeline needs:
 *   { investor, programName,
 *     evaluateEligibility(facts) -> { reasons[], maxLtvMilli, cell, unverifiable },
 *     pppInputFromFacts(facts)  -> <ppp input>,
 *     pppResult(pppInput)       -> { result, terms?, matched? },
 *     pppDisqualifier(pppInput) -> null | { code, dimension, declineReason, citation },
 *     evaluateOverlay(facts, { gridMaxLtvMilli }) -> { declines[], enforced[], stillFlagged[] },
 *     evaluateInformational(facts, { monthlyPitia }) -> { reserves, informational, exceptions } }
 *
 * The RESULT shape is exactly what `evaluateProgram` has always returned (a program is `eligible` iff no
 * layer raised a reason; each reason is labelled with the layer it came from). The overlay's relative
 * declining-market cut reads the grid's OWN resolved max-LTV cap (`elig.maxLtvMilli`), so the two can
 * never disagree — that wiring lives here, once, for every program.
 *
 * PURE: no DB, no network, no clock. It only calls the descriptor's own (pure) slots. LT-only; no RTL.
 */

/**
 * Run a program descriptor against a scenario's engine facts. PURE.
 *   opts.monthlyPitia — the priced product's monthly PITIA, so the informational reserve dollar computes.
 * Returns the combined eligibility verdict + which layer each decline came from (see the module header).
 */
function runProgram(desc, facts, opts = {}) {
  const elig = desc.evaluateEligibility(facts);
  const reasons = elig.reasons.map((r) => ({ layer: 'eligibility_matrix', ...r }));

  const pppInput = desc.pppInputFromFacts(facts);
  const ppp = desc.pppResult(pppInput);
  const pppDq = desc.pppDisqualifier(pppInput);
  if (pppDq) reasons.push({ layer: 'ppp_matrix', ...pppDq });

  // Layer-2 ADVANCED-OVERLAY enforcement (D36): each decline is a stamped OVERLAY (the E3 gate scores it
  // as an intentional override of LP, never a parity defect). The relative declining-market cut reads the
  // grid's OWN resolved max-LTV cap so the two can never disagree.
  const overlay = desc.evaluateOverlay(facts, { gridMaxLtvMilli: elig.maxLtvMilli });
  for (const d of overlay.declines) {
    reasons.push({ layer: 'overlay', code: d.code, dimension: d.fact, declineReason: d.reason, citation: d.citation, overlay: true, fact: d.fact });
  }

  // The informational layer enriches the product; it NEVER changes the eligible verdict.
  const info = desc.evaluateInformational(facts, { monthlyPitia: opts.monthlyPitia });

  return {
    program: desc.programName,
    investor: desc.investor,
    eligible: reasons.length === 0,
    reasons,
    maxLtvMilli: elig.maxLtvMilli,
    cell: elig.cell,
    ppp: { result: ppp.result, terms: ppp.terms || null, matched: ppp.matched },
    unverifiable: elig.unverifiable,
    // D36 overlay enforcement detail — which overlays fired, which cuts each enforced, which stay flagged.
    overlay: { declines: overlay.declines, enforced: overlay.enforced, stillFlagged: overlay.stillFlagged },
    // informational product attributes (D26/D34) — reserves, notes, and the loud delegate exception.
    reserves: info.reserves,
    informational: info.informational,
    exceptions: info.exceptions,
  };
}

// Validate that a descriptor carries every slot the pipeline calls (a missing slot is a build-time error,
// not a silent null-deref at pricing time). Returns the descriptor unchanged, or THROWS naming the gap.
const REQUIRED_SLOTS = ['investor', 'programName', 'evaluateEligibility', 'pppInputFromFacts', 'pppResult', 'pppDisqualifier', 'evaluateOverlay', 'evaluateInformational'];
function assertDescriptor(desc) {
  if (!desc || typeof desc !== 'object') throw new Error('program-engine:descriptor_not_an_object');
  for (const slot of REQUIRED_SLOTS) {
    const v = desc[slot];
    const wantFn = slot !== 'investor' && slot !== 'programName';
    if (wantFn ? typeof v !== 'function' : typeof v !== 'string' || !v) {
      throw new Error(`program-engine:descriptor_missing_slot:${slot}`);
    }
  }
  return desc;
}

module.exports = { runProgram, assertDescriptor, REQUIRED_SLOTS };
