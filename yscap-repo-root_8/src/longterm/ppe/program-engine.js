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
  // THE THIRD PPP ANSWER, WHICH THIS PIPELINE MAY NOT SWALLOW (defect A8.1, 2026-08-18). A state whose
  // prepayment table could not answer is neither eligible-with-a-penalty nor declined; it is a question
  // for a human. It is deliberately NOT pushed into `reasons` — that would decline the loan, which is
  // one of the two answers to the OPEN OWNER QUESTION (LENDER-PRICE-PARITY-STATUS.md §2.54) and not
  // this module's to give. It rides its own array so `eligible` can never be read alone as "quote it":
  // the pair to read is `eligible && decidable`.
  const pppUnres = desc.pppUnresolved(pppInput);
  const unresolved = pppUnres ? [{ layer: 'ppp_matrix', ...pppUnres }] : [];

  // Layer-2 ADVANCED-OVERLAY enforcement (D36): each decline is a stamped OVERLAY (the E3 gate scores it
  // as an intentional override of LP, never a parity defect). The relative declining-market cut reads the
  // grid's OWN resolved max-LTV cap so the two can never disagree.
  const overlay = desc.evaluateOverlay(facts, { gridMaxLtvMilli: elig.maxLtvMilli });
  for (const d of overlay.declines) {
    reasons.push({ layer: 'overlay', code: d.code, dimension: d.fact, declineReason: d.reason, citation: d.citation, overlay: true, fact: d.fact });
  }

  // The informational layer enriches the product; it NEVER changes the eligible verdict.
  const info = desc.evaluateInformational(facts, { monthlyPitia: opts.monthlyPitia });

  // Reconcile the eligibility layer's `unverifiable` catalog against what the OVERLAY layer now handles.
  // The matrix layer honestly lists every overlay IT cannot check; the D36 overlay layer since carries
  // some of those facts. An unverifiable entry whose EVERY `facts` key is in the program's overlay
  // coverage is now handled (enforced or flagged) — only the rest is genuinely still unverifiable. A
  // descriptor without `overlayCoverage`, or an entry with no `facts`, stays unverifiable (fail-safe:
  // this never HIDES an unverifiable overlay, it only recognizes ones a layer demonstrably handles).
  const unverifiableReconciled = reconcileUnverifiable(elig.unverifiable, desc.overlayCoverage);

  return {
    program: desc.programName,
    investor: desc.investor,
    eligible: reasons.length === 0,
    // `decidable` is FALSE when some layer answered "we could not tell". `eligible: true` +
    // `decidable: false` is NOT a permission — it is an unanswered question about state law.
    decidable: unresolved.length === 0,
    reasons,
    unresolved,
    maxLtvMilli: elig.maxLtvMilli,
    cell: elig.cell,
    ppp: {
      result: ppp.result,
      terms: ppp.terms || null,
      matched: ppp.matched,
      // `resolved:false` means the state's table was consulted and did not answer. An older PPP layer
      // that predates the third answer reports `resolved` as undefined; `!== false` reads that as
      // resolved, which is the pre-existing behaviour and never invents a new "unknown".
      resolved: ppp.resolved !== false,
      borrowerType: ppp.borrowerType === undefined ? null : ppp.borrowerType,
      borrowerTypeSource: ppp.borrowerTypeSource || null,
      unresolved: pppUnres || null,
    },
    unverifiable: elig.unverifiable,
    // The reconciled view of `unverifiable`: `handledByOverlay` = overlays the D36 overlay layer now
    // carries the fact for (no longer "nobody can check"); `stillUnverifiable` = the ones whose facts no
    // layer carries yet (geo / delivery). `unverifiable` above is the raw matrix-layer catalog, unchanged.
    unverifiableReconciled,
    // D36 overlay enforcement detail — which overlays fired, which cuts each enforced, which stay flagged.
    overlay: { declines: overlay.declines, enforced: overlay.enforced, stillFlagged: overlay.stillFlagged },
    // informational product attributes (D26/D34) — reserves, notes, and the loud delegate exception.
    reserves: info.reserves,
    informational: info.informational,
    exceptions: info.exceptions,
  };
}

// Partition an eligibility layer's `unverifiable` catalog into { handledByOverlay, stillUnverifiable }
// given the program's overlay coverage (the fact keys its overlay layer carries). An entry is handled
// only when it names AT LEAST ONE fact and EVERY named fact is covered — so it can never HIDE a
// genuinely unverifiable overlay (a missing/empty `facts`, or one fact not covered, keeps it in
// stillUnverifiable). PURE. `unverifiable` entries that are not `{facts}` objects (e.g. plain strings)
// are treated as still-unverifiable, so a foreign descriptor's list passes through untouched.
function reconcileUnverifiable(unverifiable, overlayCoverage) {
  const coverage = new Set(Array.isArray(overlayCoverage) ? overlayCoverage : []);
  const handledByOverlay = [];
  const stillUnverifiable = [];
  for (const u of Array.isArray(unverifiable) ? unverifiable : []) {
    const facts = u && Array.isArray(u.facts) ? u.facts : [];
    const handled = facts.length > 0 && facts.every((k) => coverage.has(k));
    (handled ? handledByOverlay : stillUnverifiable).push(u);
  }
  return { handledByOverlay, stillUnverifiable };
}

// Validate that a descriptor carries every slot the pipeline calls (a missing slot is a build-time error,
// not a silent null-deref at pricing time). Returns the descriptor unchanged, or THROWS naming the gap.
// `pppUnresolved` IS REQUIRED, and that requirement is the forcing function for defect A8.1: a program
// that cannot answer "we could not tell" is refused AT WIRING TIME rather than quietly pricing every
// unanswerable state as allowed. A descriptor missing it throws here, at boot, not at pricing time.
const REQUIRED_SLOTS = ['investor', 'programName', 'evaluateEligibility', 'pppInputFromFacts', 'pppResult', 'pppDisqualifier', 'pppUnresolved', 'evaluateOverlay', 'evaluateInformational'];
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

module.exports = { runProgram, assertDescriptor, reconcileUnverifiable, REQUIRED_SLOTS };
