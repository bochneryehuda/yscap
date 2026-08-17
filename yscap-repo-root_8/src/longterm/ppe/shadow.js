'use strict';
/**
 * LT PPE — the shadow-reliability RUNNER (MEGA plan §10). This is the spine that ties the scenario
 * matrix (§10.3) to the parity comparator (§10.1): for every scenario it runs BOTH engines and
 * records the agreement + findings. LENDER PRICE WINS and is what the business sees; our engine runs
 * beside it and every disagreement becomes a finding we fix before an investor is ever trusted on our
 * engine alone (§1.2, §9, §11).
 *
 * IO IS INJECTED, so this module is PURE and offline-testable. The caller supplies:
 *   ours(scenario)   -> a quote.js result (or a normalized ladder), possibly async.
 *   theirs(scenario) -> Lender Price's result for the same scenario, possibly async.
 * The runner never talks to the DB or the network itself — the harness wires the real quote.js and
 * the live LP search into `ours`/`theirs`.
 *
 * FAIL SAFE, NEVER FAIL THE BATCH (repo rule): if either engine throws for one scenario the runner
 * records an `engine_error` finding for THAT scenario and moves on — one LP timeout can never lose
 * the rest of the run. Concurrency is bounded so a live LP search is not hammered.
 *
 * LT-only. No RTL imports.
 */

const parity = require('./parity');
const { describeScenario } = require('./scenario-matrix');

const ERROR_KIND = 'engine_error';

// Run one scenario through both engines and compare. Never throws — an engine failure becomes a
// finding on that scenario.
async function runOne(scenario, ours, theirs, opts) {
  const tag = scenario && scenario._label ? scenario._label : describeScenario(scenario);
  let a; let b;
  try {
    a = await ours(scenario);
  } catch (e) {
    return { agree: false, scenario: tag, facts: factsOf(scenario), error: 'ours', findings: [{ kind: ERROR_KIND, side: 'ours', detail: `our engine threw: ${errText(e)}`, scenario: tag }] };
  }
  try {
    b = await theirs(scenario);
  } catch (e) {
    return { agree: false, scenario: tag, facts: factsOf(scenario), error: 'theirs', findings: [{ kind: ERROR_KIND, side: 'theirs', detail: `Lender Price threw: ${errText(e)}`, scenario: tag }] };
  }
  // Thread our raw declines so a reasoned overlay divergence is typed as OVERLAY, not a defect (D29).
  const ourDeclines = Array.isArray(a && a.declines) ? a.declines : undefined;
  const cmp = parity.compareScenario(a, b, { ...opts, scenario: tag, ourDeclines });
  return { agree: cmp.agree, incomparable: cmp.incomparable || false, overlay: cmp.overlay || false, scenario: tag, facts: factsOf(scenario), findings: cmp.findings };
}

// The scenario's own FACTS, carried beside its label.
//
// `scenario` was reduced to a display STRING here and the object thrown away — one function before
// anybody could use it. Everything downstream inherited that: the findings ledger has a
// `scenario_facts` column (db/561) that the canary path could never fill, and a parity dashboard
// sliced "by state / DSCR band / FICO / LTV" had no facts to slice by. The label is a SENTENCE about
// the scenario; it is not the scenario, and re-parsing it back into facts would be inventing a format.
// This is the repo's recurring "a value computed and then discarded by the summarizer" class.
//
// Carried ADDITIVELY and only when it really is an object, so a caller passing a bare string label as
// its scenario gets `null` rather than a facts bag made of characters.
function factsOf(scenario) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) return null;
  const out = {};
  for (const [k, v] of Object.entries(scenario)) {
    if (k === '_label') continue;             // the label is carried separately, as `scenario`
    if (v === undefined) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

function errText(e) {
  if (!e) return 'unknown error';
  return String(e.message || e).slice(0, 200);
}

/**
 * Run a whole scenario batch.
 *   scenarios: [...] from scenario-matrix.buildMatrix.
 *   engines:   { ours, theirs } — see module header.
 *   opts:      { priceToleranceMilli, rateToleranceMilli, concurrency=1, onResult(result,i) }
 *
 * Returns { results:[{agree, scenario, findings, error?}], summary }. `summary` is
 * parity.summarize plus an `errors` count (scenarios where an engine threw).
 */
async function runShadow(scenarios, engines = {}, opts = {}) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const ours = engines.ours;
  const theirs = engines.theirs;
  if (typeof ours !== 'function' || typeof theirs !== 'function') {
    throw new Error('runShadow requires engines.ours and engines.theirs functions');
  }
  const conc = Math.max(1, Math.min(opts.concurrency || 1, 16));
  const cmpOpts = { priceToleranceMilli: opts.priceToleranceMilli, rateToleranceMilli: opts.rateToleranceMilli };
  const results = new Array(list.length);

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      const r = await runOne(list[i], ours, theirs, cmpOpts);
      results[i] = r;
      if (typeof opts.onResult === 'function') {
        try { opts.onResult(r, i); } catch (_) { /* a reporter must never break the run */ }
      }
    }
  }
  const workers = [];
  for (let w = 0; w < conc; w += 1) workers.push(worker());
  await Promise.all(workers);

  return { results, summary: summarize(results) };
}

// parity.summarize + an errors tally (engine throws counted separately from disagreements).
function summarize(results) {
  const base = parity.summarize(results);
  let errors = 0;
  for (const r of results || []) if (r && r.error) errors += 1;
  base.errors = errors;
  return base;
}

module.exports = { runShadow, runOne, summarize, ERROR_KIND, _internals: { factsOf } };
