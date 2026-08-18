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
const overlayLib = require('./overlay');

/**
 * DID THIS RUN COMPARE ANYTHING AT ALL? — the one definition, because a run that compared NOTHING must
 * never be able to report like a run that did.
 *
 * `parity.summarize` measures the agreement rate over what could be COMPARED, and correctly answers
 * `null` when nothing could (§10.6: an incomparable scenario is never scored as agreement). That is the
 * right MEASUREMENT and it had the wrong ENDING: a null rate travelled onward as an ordinary result,
 * was written into the run series the go-live gate reads, and was answered with a 200 — so an
 * all-incomparable battery (a mis-wired Lender Price leg, a vendor outage, an empty capture) looked
 * exactly like a battery that ran. Measured on the canonical 299-scenario battery with the leg
 * mis-wired: 299 incomparable, `agreementRate` null, `runRecord.agreementRate` null, run persisted,
 * HTTP 200.
 *
 * COMPARED counts scenarios where BOTH engines produced an answer the comparator could read:
 * `comparable` (agreed + disagreed) less `errors` (scenarios where an engine THREW, which
 * `parity.summarize` counts among the disagreements). A run with zero of those has proven nothing —
 * neither agreement nor disagreement — and `proven:false` says so, with the reason stated.
 *
 * This MEASURES; it does not decide what a caller does about it. The battery refuses; the go-live gate
 * (`cutover.eligibleForLive`) independently refuses a null rate and any incomparable count.
 */
function verdictOf(summary) {
  const n = (k) => (summary && Number.isFinite(summary[k]) ? summary[k] : 0);
  const scenarios = n('scenarios');
  const errors = n('errors');
  const incomparable = n('incomparable');
  // Reasoned overrides are the THIRD outcome (§2.72): our engine declining a scenario Lender Price
  // prices, on a fact LP cannot see, with a stated reason. `parity.summarize` keeps them out of
  // `comparable` — so they are already excluded from `compared` here, and they are NAMED in the reason
  // below rather than left to read as "no scenario was priced", which is what an all-override battery
  // would otherwise report about a run in which every scenario priced perfectly well.
  const overlay = n('overlay');
  const compared = Math.max(0, n('comparable') - errors);
  if (compared > 0) return { proven: true, compared, scenarios, incomparable, overlay, errors, reason: null };
  const parts = [];
  if (incomparable > 0) parts.push(`${incomparable} could not be compared (an engine produced no result)`);
  if (overlay > 0) parts.push(`${overlay} were reasoned overlay overrides (deliberately not scored against Lender Price)`);
  if (errors > 0) parts.push(`${errors} failed with an engine error`);
  if (!parts.length) parts.push('no scenario was priced');
  return {
    proven: false,
    compared: 0,
    scenarios,
    incomparable,
    overlay,
    errors,
    reason: `This canary compared NOTHING: of ${scenarios} scenario(s), ${parts.join(' and ')}. `
      + 'An agreement rate cannot be measured over zero comparisons, so this run proves neither agreement nor disagreement.',
  };
}

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
 * Returns { dayMs, investor, program, summary, verdict, results, matrix, agreementRate, records,
 *           findingKeys, runRecord, report }. `verdict` is `verdictOf(summary)` — whether the run
 * compared anything at all, and why not when it did not.
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
  //
  // ⛔ A REASONED OVERRIDE IS NOT ONE OF THEM, and this is the third place §2.72 had to be enforced.
  // `dailySeries` counts a key never seen on an earlier day as a NEW finding that day, and
  // `cutover.consecutiveCleanDays` breaks the streak on any day with one — so the first run that
  // produced an override reset the 14-day clean streak an investor needs to go live, for behaviour
  // working exactly as specified. The override is still RECORDED (`records` carries it, settled, so the
  // review queue shows it); it is simply not counted as work that appeared.
  const findingKeys = Array.from(new Set(
    records.filter((rec) => !overlayLib.isOverlayFinding(rec)).map((rec) => rec.key),
  )).sort();
  // Named separately rather than dropped — a run that overrode forty scenarios and a run that overrode
  // none must not read the same (this repo's no-silent-caps rule).
  const overrideKeys = Array.from(new Set(
    records.filter((rec) => overlayLib.isOverlayFinding(rec)).map((rec) => rec.key),
  )).sort();

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
    // Whether this run compared anything at all, stated beside the rate it measured — a caller that
    // reads only `agreementRate` cannot tell a measured 100% from a measured nothing.
    verdict: verdictOf(run.summary),
    // The per-scenario results, so a caller can slice them a second way without re-pricing anything.
    results: run.results,
    matrix,
    agreementRate: run.summary ? run.summary.agreementRate : null,
    records,
    findingKeys,
    overrideKeys,
    // exactly the shape scoreboard.dailySeries / assemble consumes
    runRecord: { dayMs, agreementRate: run.summary ? run.summary.agreementRate : null, findingKeys, summary: run.summary },
    report,
  };
}

module.exports = { runCanary, verdictOf };
