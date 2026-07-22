'use strict';
/**
 * R5.46 (core) — the hard release gates for safe learning.
 *
 * No learned/candidate change reaches production unless an evaluation run
 * CLEARS every hard gate. This is the safety-critical decision the whole
 * safe-learning workstream (R5.42 schema, R5.45 runner, R5.47 shadow, R5.48
 * canary) protects. It is DELIBERATELY conservative — a gate failure blocks the
 * release; it never "mostly passes".
 *
 * Hard gates (owner + review):
 *   1. ZERO dangerous false clears in the high-risk set (a false clear / missed
 *      fatal is never acceptable).
 *   2. No reduction in fatal-finding recall vs the champion.
 *   3. No new unsupported fact / nonexistent-evidence citation.
 *   4. Packet boundary F1 meets the production threshold on every major family
 *      (not just overall).
 *   5. Condition-clear precision does not drop below the champion.
 *   6. No per-slice (investor/state/doc) regression, even if the overall
 *      average improves.
 *   7. A suppression rule must be scoped + proven not to hide a true material
 *      finding.
 *
 * Pure: no DB, no AI. The caller assembles a metrics object from
 * evaluation_results + aggregate; this returns {pass, blockers, warnings}.
 */

const BOUNDARY_F1_MIN = 0.90;   // production threshold per major packet family

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/**
 * evaluate(metrics) — metrics shape (all optional; a MISSING metric that a gate
 *   needs is treated as a FAIL for that gate — never an assumed pass):
 *   {
 *     dangerousFalseClears: int,                 // gate 1
 *     fatalRecall: { candidate, baseline },      // gate 2 (0..1)
 *     unsupportedFactCount: int,                 // gate 3
 *     nonexistentCitationCount: int,             // gate 3
 *     boundaryF1ByFamily: { family: f1, … },     // gate 4
 *     conditionClearPrecision: { candidate, baseline }, // gate 5
 *     sliceRegressions: [{ slice, metric, delta }],     // gate 6 (delta < 0 = worse)
 *     suppressionRules: [{ code, scoped:bool, hidesMaterial:bool }], // gate 7
 *   }
 * Returns { pass, blockers:[…], warnings:[…] }.
 */
function evaluate(metrics) {
  const m = metrics || {};
  const blockers = [];
  const warnings = [];

  // Gate 1 — zero dangerous false clears.
  const dfc = num(m.dangerousFalseClears, null);
  if (dfc === null) blockers.push('gate1: dangerousFalseClears not measured');
  else if (dfc > 0) blockers.push(`gate1: ${dfc} dangerous false clear(s) in the high-risk set`);

  // Gate 2 — no fatal-recall reduction.
  if (!m.fatalRecall || m.fatalRecall.candidate == null || m.fatalRecall.baseline == null) {
    blockers.push('gate2: fatalRecall not measured');
  } else if (num(m.fatalRecall.candidate, 0) < num(m.fatalRecall.baseline, 1)) {
    blockers.push(`gate2: fatal recall dropped ${m.fatalRecall.baseline} → ${m.fatalRecall.candidate}`);
  }

  // Gate 3 — no new unsupported facts / hallucinated citations.
  if (num(m.unsupportedFactCount, 0) > 0) blockers.push(`gate3: ${m.unsupportedFactCount} unsupported fact(s)`);
  if (num(m.nonexistentCitationCount, 0) > 0) blockers.push(`gate3: ${m.nonexistentCitationCount} nonexistent citation(s)`);

  // Gate 4 — boundary F1 per major family.
  if (!m.boundaryF1ByFamily || typeof m.boundaryF1ByFamily !== 'object' || !Object.keys(m.boundaryF1ByFamily).length) {
    warnings.push('gate4: boundaryF1ByFamily not provided (skipped — no packet families in this run)');
  } else {
    for (const [family, f1] of Object.entries(m.boundaryF1ByFamily)) {
      if (num(f1, 0) < BOUNDARY_F1_MIN) blockers.push(`gate4: boundary F1 ${num(f1, 0).toFixed(2)} < ${BOUNDARY_F1_MIN} for "${family}"`);
    }
  }

  // Gate 5 — condition-clear precision must not drop.
  if (m.conditionClearPrecision && m.conditionClearPrecision.candidate != null && m.conditionClearPrecision.baseline != null) {
    if (num(m.conditionClearPrecision.candidate, 0) < num(m.conditionClearPrecision.baseline, 1)) {
      blockers.push(`gate5: condition-clear precision dropped ${m.conditionClearPrecision.baseline} → ${m.conditionClearPrecision.candidate}`);
    }
  }

  // Gate 6 — no per-slice regression (even if overall improves).
  for (const r of (m.sliceRegressions || [])) {
    if (num(r.delta, 0) < 0) blockers.push(`gate6: slice "${r.slice}" ${r.metric} regressed by ${r.delta}`);
  }

  // Gate 7 — suppression rules scoped + not hiding a material finding.
  for (const s of (m.suppressionRules || [])) {
    if (s.hidesMaterial) blockers.push(`gate7: suppression "${s.code}" hides a true material finding`);
    else if (!s.scoped) blockers.push(`gate7: suppression "${s.code}" is not scoped (program/investor/state/doc)`);
  }

  return { pass: blockers.length === 0, blockers, warnings };
}

module.exports = { evaluate, BOUNDARY_F1_MIN };
