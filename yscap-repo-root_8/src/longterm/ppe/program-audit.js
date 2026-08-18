'use strict';
/**
 * LT PPE — THE PROGRAM SELF-AUDIT (the offline "our-side" half of the scaled agreement harness; #49).
 *
 * WHAT THIS IS. `program-engine.runProgram` answers ONE scenario. This runs a program descriptor over a
 * whole battery of scenarios and produces a factual DIGEST of what the engine decides across the space:
 * how many scenarios are eligible / ineligible, which LAYER declined them, how often each decline CODE
 * fired, which overlays armed, and what stayed flagged / unverifiable. It is the eligibility analogue of
 * the pricing rung-digest (§2.5), and it is what the parity audit diffs against Lender Price — but on its
 * own it already earns its keep as a self-diagnostic: a decline code that NEVER fires across a broad
 * battery is a red flag (an unreachable rule — an encoding bug, or a battery that never exercises it),
 * exactly the class the honest second layer exists to catch.
 *
 * INPUT is a list of engine-FACTS bags (the vocabulary `runProgram` reads — fico raw, ltv milli, dscr
 * milli, loan_amount, purpose, state, the overlay facts, …). The caller generates them however it likes
 * (`scenario-matrix.buildMatrix` with fact-shaped axes, `lp-agreement-legs.lpScenarioToFacts`, hand-
 * written). Keeping the audit decoupled from scenario GENERATION is deliberate: one digest shape works
 * for every source.
 *
 * HOW TO ACTUALLY RUN IT: `node scripts/lt-ppe-program-audit.js` takes every program in the catalog
 * (both registries), pushes a deterministic full-grid battery through it and prints the digest as a
 * report a non-developer can act on — including the three-way answer for a rule that never fired.
 *
 * PURE: no DB, no network, no clock, no randomness. LT-only; no RTL import.
 */

const { runProgram } = require('./program-engine');
const { buildMatrix } = require('./scenario-matrix');

// Count a key into a plain-object tally.
function bump(tally, key) { tally[key] = (tally[key] || 0) + 1; }

/**
 * Run `descriptor` over `factsList` and summarize. PURE.
 *   opts.perScenarioOpts(facts, index) — optional: returns the per-scenario opts for runProgram
 *     (e.g. monthlyPitia). Omitted → {}.
 *   opts.expectedCodes — optional array of decline codes the program is EXPECTED to be able to emit;
 *     the digest then reports `neverFired` (expected codes that fired in ZERO scenarios) so a dead /
 *     unreachable rule is surfaced, not silently absent.
 * Returns a digest:
 *   { total, eligible, ineligible,
 *     layerHitCounts: { eligibility_matrix, ppp_matrix, overlay },   // # scenarios with ≥1 decline there
 *     declineCodeCounts: { <code>: n },                              // # scenarios where that code fired
 *     overlayArmedCounts: { <overlayName>: n },                      // # scenarios where an overlay armed
 *     stillFlaggedCounts: { <overlayText>: n },
 *     stillUnverifiableCounts: { <overlayText>: n },
 *     neverFired: [ <code>, … ] }                                    // present only when expectedCodes given
 */
function auditProgram(descriptor, factsList, opts = {}) {
  const list = Array.isArray(factsList) ? factsList : [];
  const perOpts = typeof opts.perScenarioOpts === 'function' ? opts.perScenarioOpts : null;

  const digest = {
    total: 0,
    eligible: 0,
    ineligible: 0,
    layerHitCounts: { eligibility_matrix: 0, ppp_matrix: 0, overlay: 0 },
    declineCodeCounts: {},
    overlayArmedCounts: {},
    stillFlaggedCounts: {},
    stillUnverifiableCounts: {},
  };

  for (let i = 0; i < list.length; i += 1) {
    const facts = list[i];
    const result = runProgram(descriptor, facts, perOpts ? perOpts(facts, i) : {});
    digest.total += 1;
    if (result.eligible) digest.eligible += 1; else digest.ineligible += 1;

    // Per SCENARIO (not per reason): a layer / code counts at most once for a scenario, so the counts
    // read as "how many scenarios did this affect" rather than being inflated by multi-decline loans.
    const layersHit = new Set();
    const codesHit = new Set();
    for (const r of result.reasons || []) {
      if (r.layer) layersHit.add(r.layer);
      if (r.code) codesHit.add(r.code);
    }
    for (const l of layersHit) if (Object.prototype.hasOwnProperty.call(digest.layerHitCounts, l)) digest.layerHitCounts[l] += 1;
    for (const c of codesHit) bump(digest.declineCodeCounts, c);

    for (const e of (result.overlay && result.overlay.enforced) || []) bump(digest.overlayArmedCounts, e.overlay);
    for (const f of (result.overlay && result.overlay.stillFlagged) || []) bump(digest.stillFlaggedCounts, f.overlay);
    const rc = result.unverifiableReconciled;
    for (const u of (rc && rc.stillUnverifiable) || []) bump(digest.stillUnverifiableCounts, (u && u.overlay) || String(u));
  }

  if (Array.isArray(opts.expectedCodes)) {
    digest.neverFired = opts.expectedCodes.filter((c) => !digest.declineCodeCounts[c]);
  }
  return digest;
}

/**
 * Convenience: build a scenario matrix from `axes` (via scenario-matrix.buildMatrix) and audit it — and
 * carry the COVERAGE so a `neverFired` claim is not read as truth off a truncated grid.
 *
 * WHY THIS MATTERS (learned by flying it). buildMatrix DETERMINISTICALLY STRIDES the grid down to
 * `maxScenarios` when the full product is larger. A strided grid can skip every cell that would have
 * armed a rule — so a perfectly live rule reports as `neverFired`, a FALSE dead-rule alarm. So this
 * function refuses to let a truncated run claim reliability: it returns `coverage` and, when
 * `expectedCodes` is given, `neverFiredReliable` — TRUE only when the FULL grid was audited. A caller
 * must not treat `neverFired` as real unless `neverFiredReliable === true`.
 *   opts: { base, maxScenarios, label, expectedCodes, perScenarioOpts } (base/maxScenarios/label → buildMatrix).
 */
function auditProgramMatrix(descriptor, axes, opts = {}) {
  const built = buildMatrix(axes, { base: opts.base, maxScenarios: opts.maxScenarios, label: opts.label });
  const digest = auditProgram(descriptor, built.scenarios, { expectedCodes: opts.expectedCodes, perScenarioOpts: opts.perScenarioOpts });
  digest.coverage = { fullSize: built.fullSize, sampled: built.scenarios.length, truncated: built.truncated, stride: built.stride };
  if (Array.isArray(opts.expectedCodes)) {
    // A neverFired verdict is only trustworthy over the COMPLETE grid — a strided sample can miss the
    // very cells that arm a rule (a false dead-rule alarm). Say so, loudly, rather than let it read true.
    digest.neverFiredReliable = !built.truncated;
  }
  return digest;
}

module.exports = { auditProgram, auditProgramMatrix };
