'use strict';
/**
 * LT PPE — the CANARY run (§10.3/§10.5): price one scenario matrix beside Lender Price and package the
 * result for every downstream consumer, in ONE reusable call.
 *
 * The pieces already exist and each owns exactly one job — this module is the wiring that a scheduler
 * (or an admin "run canary now" button) calls, and the wiring the shadow-e2e test proves end to end:
 *
 *     shadow.runShadow    → prices every scenario with both engines, per-scenario agree/findings
 *     finding.recordsFromComparison → turns each scenario's findings into KEYED ledger records
 *     shadow-report.buildReport     → a human, plain-language summary of the run
 *
 * `runCanary` returns everything the rest of the loop needs, and NOTHING it doesn't:
 *   - `records`   → hand to `finding-store.persistRun(scope, records)` to reconcile + persist the ledger
 *   - `runRecord` → push onto the series `scoreboard.assemble(runs, …)` aggregates over time
 *   - `report`    → render for a human (`shadow-report.renderText`)
 *   - `matrix`    → WHERE it disagreed (`parity-matrix`), sliced on the sheet's own band edges
 *
 * It MEASURES one run; it never DECIDES (cutover) and never PERSISTS (finding-store) — so the merge
 * discipline ("never re-open a settled finding") and the promote gate each keep their single definition.
 * Pure orchestration + injected clock (`nowMs`), so it is offline-testable with stub engines.
 * LT-only; no RTL import.
 */

const shadow = require('./shadow');
const finding = require('./finding');
const shadowReport = require('./shadow-report');
const parityMatrix = require('./parity-matrix');

/**
 * Run one canary and package it.
 *   engines: { ours, theirs } — async(scenario) → quote, as shadow.runShadow expects.
 *   opts:
 *     investor, program — the identity the finding keys are scoped to (§10.4 finding_key).
 *     nowMs             — the injected clock; stamps firstSeen/lastSeen AND dates the run record.
 *     dayMs             — the run's day for the scoreboard (defaults to nowMs).
 *     priceToleranceMilli / rateToleranceMilli / concurrency — passed to shadow.runShadow.
 *     bands / dimensions — passed through to the parity matrix (bands default to the program's own
 *                          rule edges; dimensions default to the facts the run actually states).
 * Returns { dayMs, investor, program, summary, results, matrix, agreementRate, records, findingKeys,
 *           runRecord, report }.
 */
async function runCanary(scenarios, engines = {}, opts = {}) {
  const nowMs = typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs) ? opts.nowMs : null;
  const dayMs = typeof opts.dayMs === 'number' && Number.isFinite(opts.dayMs) ? opts.dayMs : nowMs;
  const investor = opts.investor || null;
  const program = opts.program || null;

  const run = await shadow.runShadow(scenarios, engines, {
    priceToleranceMilli: opts.priceToleranceMilli,
    rateToleranceMilli: opts.rateToleranceMilli,
    concurrency: opts.concurrency,
    onResult: opts.onResult,
  });

  // Every scenario's disagreements become keyed ledger records (the same shape finding-store persists).
  const records = [];
  for (const r of run.results || []) {
    if (!r || !Array.isArray(r.findings) || r.findings.length === 0) continue;
    // The FACTS ride alongside the label. `recordsFromComparison` writes `scenarioFacts` only when it
    // is handed an OBJECT, and this call used to pass `r.scenario` — the display label — so the
    // ledger's `scenario_facts` column (db/561) was NULL on every finding the canary ever recorded,
    // and the review queue could not group or slice by state / FICO / LTV. The label stays the
    // scenario's NAME (it is what the finding key is built from and must not move); the facts are
    // carried in the field made for them.
    const recs = finding.recordsFromComparison(
      { findings: r.findings },
      { scenario: r.facts || r.scenario, scenarioLabel: r.scenario, investor, program, nowMs },
    );
    for (const rec of recs) records.push(rec);
  }
  // Unique, stable finding identities for the scoreboard's new-vs-recurring accounting.
  const findingKeys = Array.from(new Set(records.map((rec) => rec.key))).sort();

  const report = shadowReport.buildReport(run, { investor, program });

  // WHERE the run disagreed, not just how often — sliced by the scenarios' own facts, on the sheet's
  // OWN band edges (master plan P9). Best-effort: a measurement of the measurement must never be the
  // thing that loses a canary, so a failure here leaves `matrix` null and the run stands.
  //
  // THIS CATCH IS BELT-AND-BRACES TODAY, and that is written down rather than implied: `parity-matrix`
  // is total by construction — every entry point guards its input shape and `bandsFromProgram` already
  // returns an empty map for any program it cannot read — so mutation-testing shows the catch never
  // fires on any input the tests can build. It is kept because the alternative is a canary that prices
  // a 500-scenario battery against a live upstream and then loses the whole run to a slicing bug.
  let matrix = null;
  try {
    matrix = parityMatrix.buildParityMatrix(run.results, { program: opts.program, bands: opts.bands, dimensions: opts.dimensions });
  } catch (_) { matrix = null; }

  return {
    dayMs,
    investor,
    program,
    summary: run.summary,
    // The per-scenario results, so a caller can slice them a second way without re-pricing anything.
    results: run.results,
    matrix,
    agreementRate: run.summary ? run.summary.agreementRate : null,
    records,
    findingKeys,
    // exactly the shape scoreboard.dailySeries / assemble consumes
    runRecord: { dayMs, agreementRate: run.summary ? run.summary.agreementRate : null, findingKeys, summary: run.summary },
    report,
  };
}

module.exports = { runCanary };
