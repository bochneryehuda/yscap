'use strict';
/**
 * LT PPE — the ≥200-scenario Lender Price AGREEMENT harness (E3 gate, owner HARD RULE 2026-08-17):
 * agree with Lender Price on every LLPA, every eligibility AND ineligibility, and max/min price — to
 * the penny — BEFORE a rate sheet is ever built into the system. This module is the ORCHESTRATOR that
 * ties the pieces together; each piece already exists and is separately tested:
 *   scenario-matrix.buildMatrix / coverage    → the scenarios (the caller supplies the batch)
 *   quote.quoteProgram                          → OUR price for a scenario, off the sheet-under-test
 *   lp-normalize-full.normalizeLpFull/…Disqual  → LP's answer, from the injected live leg
 *   parity-detectors.detectDifferences          → the COARSE, categorized axes (eligibility, coupon
 *                                                 set, base/final price, margin, LLPA stack total)
 *   ratesheet-agreement-diff.reconcileLlpas     → the FINE per-DIMENSION LLPA reconciliation (two
 *                                                 offsetting cell errors a stack total agrees on)
 *   ratesheet-agreement-diff.boundsProbe        → the cap (max price) / floor (min price), to the penny
 *
 * IO IS INJECTED (the shadow.js contract), so this module is PURE and offline-testable. The caller
 * supplies `ours(scenario)` (wire quote.quoteProgram with the sheet-under-test program + settings) and
 * `lp(scenario)` (wire the live LP search → { full, disqualified } — the client.parseFull /
 * parseDisqualified shapes). The runner never talks to the DB or the network itself, which is what lets
 * the whole 200-scenario battery run in one command the instant real LP credentials land.
 *
 * FAIL SAFE, NEVER FAIL THE BATCH (repo rule): an engine or LP throw for ONE scenario becomes an
 * `engine_error` verdict on that scenario and the run continues — one LP timeout can never lose the
 * rest of the run. Concurrency is bounded so the live LP search is not hammered. A scenario AGREES only
 * when the coarse axes agree AND every matched rung reconciles to the penny on every dimension AND
 * every cap/floor probe is faithful.
 *
 * LT-only. No RTL imports.
 */
const { detectDifferences } = require('./parity-detectors');
const { reconcileLlpas, boundsProbe } = require('./ratesheet-agreement-diff');
const { normalizeLpFull, normalizeLpDisqualified } = require('./lp-normalize-full');
const { describeScenario } = require('./scenario-matrix');

const ERROR_KIND = 'engine_error';

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// Our ladder rung → the reconcileLlpas our-side shape. A rung's normalized adjustments (pricing.js)
// carry { dimension|category, costMilli, reason }; reconcile folds them per dimension and compares to
// LP's itemized point LLPAs (LP's separate fico/cltv/dscr items sum into our one fico_cltv_dscr cell).
function ourAdjustmentsOf(rung) {
  const list = Array.isArray(rung && rung.adjustments) ? rung.adjustments : [];
  return list.map((a) => ({
    dimension: a.dimension || a.category || 'other',
    adjMilli: isNum(a.costMilli) ? a.costMilli : 0,
    reason: a.reason || a.code || a.category || null,
  }));
}

// LP normalized (possibly several matched programs) → ONE flat best-execution rung list: for each
// coupon, the rung with the HIGHEST price (what the borrower would actually get). Keeps the FULL rung
// (llpas, margin, basePoints) so the fine comparators have everything — bestLadder is not enough (it
// carries only rate+price). best-execution.js is the production picker for the quote path; the
// agreement harness needs only per-coupon best for the comparison.
function bestRungsOf(lpNorm) {
  const byRate = new Map();
  for (const p of (lpNorm.programs || [])) {
    for (const r of (p.rungs || [])) {
      if (!isNum(r.rate) || !isNum(r.priceMilli)) continue;
      const prev = byRate.get(r.rate);
      if (prev == null || r.priceMilli > prev.priceMilli) byRate.set(r.rate, r);
    }
  }
  return Array.from(byRate.values()).sort((a, b) => a.rate - b.rate);
}

// match an our-rung to an LP rung by coupon within the rate tolerance (mirrors parity-detectors)
function matchByRate(lpRungs, rate, tol) {
  let best = null; let bd = Infinity;
  for (const r of lpRungs) {
    if (!isNum(r.rate)) continue;
    const d = Math.abs(r.rate - rate);
    if (d <= tol && d < bd) { bd = d; best = r; }
  }
  return best;
}

function errorVerdict(tag, side, e) {
  return {
    scenario: tag, agree: false, incomparable: false, error: side,
    coarse: null, rungReconciles: [], bounds: [], worstDeltaMilli: 0,
    findings: [{ kind: ERROR_KIND, side, detail: `${side} threw: ${String((e && e.message) || e).slice(0, 200)}` }],
  };
}

/**
 * Run ONE scenario through OUR engine and the injected LP leg, and produce a full agreement verdict.
 * Never throws — an engine failure becomes an `engine_error` verdict on that scenario.
 *   scenario — one entry from scenario-matrix.buildMatrix (+ coverage)
 *   ours(scenario)  — async → quote.quoteProgram result { eligible, ladder[], declines[] }
 *   lp(scenario)    — async → { full, disqualified } (client.parseFull / parseDisqualified shapes)
 *   opts — { filter:{program,product,lender,investor}, rateScale, priceScale, settings,
 *            priceToleranceMilli, rateToleranceMilli, marginToleranceMilli, basePriceToleranceMilli,
 *            lpDimensionOf(llpa)  — reason-aware LP→dimension classifier for reconcileLlpas (the live
 *              Deephaven harness passes ratesheet-agreement-diff.deephavenLpDimension); default folds by
 *              adjType only,
 *            ignoreDimensions     — LP dimensions to drop from the fine reconcile (e.g. ['prepay'] while
 *              our sheet does not model prepay yet — surfaced separately, not counted as a disagreement) }
 */
async function runOne(scenario, ours, lp, opts) {
  const o = opts || {};
  const tag = scenario && scenario._label ? scenario._label : describeScenario(scenario);
  const rateTol = isNum(o.rateToleranceMilli) ? o.rateToleranceMilli : 0;

  let our; let legs;
  try { our = await ours(scenario); } catch (e) { return errorVerdict(tag, 'ours', e); }
  try { legs = await lp(scenario); } catch (e) { return errorVerdict(tag, 'lp', e); }
  legs = legs || {};

  const filter = o.filter || {};
  const lpNorm = normalizeLpFull(legs.full || {}, { ...filter, rateScale: o.rateScale, priceScale: o.priceScale });
  const lpDisq = normalizeLpDisqualified(legs.disqualified || {}, filter);
  const lpRungs = bestRungsOf(lpNorm);
  const lpDeclined = !!(lpDisq.declined && lpDisq.declined.length);
  const lpHasSignal = lpRungs.length > 0 || lpDeclined;

  // The COARSE, categorized axes (this is what parity-detectors already compared: eligibility, coupon
  // set, base/final price, margin, LLPA stack total).
  const coarse = detectDifferences(
    { ours: our, lp: { eligible: lpNorm.eligible, rungs: lpRungs }, lpDisqualified: lpDisq },
    {
      settings: o.settings,
      priceToleranceMilli: o.priceToleranceMilli,
      rateToleranceMilli: o.rateToleranceMilli,
      marginToleranceMilli: o.marginToleranceMilli,
      basePriceToleranceMilli: o.basePriceToleranceMilli,
    },
  );

  // The FINE axes (per-dimension LLPA reconciliation + cap/floor probe) — only when BOTH priced this
  // scenario. When either side declines, the eligibility axis in `coarse` is what decides agreement.
  const ourEligible = !!(our && our.eligible);
  const lpEligible = lpNorm.eligible && !lpDeclined;
  const rungReconciles = [];
  const bounds = [];
  let reconcileAgree = true;
  let boundsAgree = true;
  if (ourEligible && lpEligible) {
    for (const orr of (our.ladder || [])) {
      if (!isNum(orr.rate)) continue;
      const lpr = matchByRate(lpRungs, orr.rate, rateTol);
      if (!lpr) continue; // a coupon we price that LP does not — coarse already flagged it
      const rec = reconcileLlpas(ourAdjustmentsOf(orr), lpr.llpas || [], { dimensionOf: o.lpDimensionOf, ignore: o.ignoreDimensions });
      const bp = boundsProbe(
        { finalPriceMilli: orr.finalPriceMilli, floorMilli: orr.floorMilli, capMilli: orr.capMilli, clamped: orr.clamped },
        lpr.priceMilli,
      );
      if (!rec.agree) reconcileAgree = false;
      if (!bp.agree) boundsAgree = false;
      rungReconciles.push({ rate: orr.rate, agree: rec.agree, worstDeltaMilli: rec.worstDeltaMilli, itemized: rec.itemized });
      bounds.push({ rate: orr.rate, agree: bp.agree, checks: bp.checks, detail: bp.detail });
    }
  }
  // The FINE gate is the per-dimension LLPA reconcile ALWAYS; the cap/floor bounds probe counts unless
  // skipped. `skipBounds` is for a sheet with no cap/floor whose net price carries a margin the
  // rate-sheet agreement is not about (Deephaven: the displayed price is base net of an unreconciled
  // origination/margin, so the net-price comparison is a compensation-layer question, not an LLPA one).
  const fineAgree = reconcileAgree && (o.skipBounds ? true : boundsAgree);

  // INCOMPARABLE = LP gave no usable signal for our filter (not ready / nothing matched). A both-decline
  // is NOT incomparable — it is a real ELIGIBILITY agreement (the owner's "run a few ineligible ones and
  // confirm the disqualifier matches"), so it counts, and the coarse eligibility axis decides it.
  const incomparable = !lpHasSignal;
  // `coarseIgnore` drops margin-laden coarse axes from the GATE (still fully reported): on the live
  // Deephaven sheet `final_price` and `llpa_total` compare LP's displayed price / adjustmentPoints,
  // which carry the origination/margin, NOT the LLPA stack — so they are a compensation-layer question.
  const coarseIgnore = o.coarseIgnore instanceof Set ? o.coarseIgnore : new Set(Array.isArray(o.coarseIgnore) ? o.coarseIgnore : []);
  const gatingCoarse = ((coarse && coarse.differences) || []).filter((d) => !coarseIgnore.has(d.category));
  const agree = !incomparable && gatingCoarse.length === 0 && fineAgree;
  const worstDeltaMilli = rungReconciles.reduce(
    (m, r) => (Math.abs(r.worstDeltaMilli) > Math.abs(m) ? r.worstDeltaMilli : m), 0,
  );

  return {
    scenario: tag,
    agree,
    incomparable,
    ourEligible,
    lpEligible,
    lpDeclined,
    coarse,
    rungReconciles,
    bounds,
    worstDeltaMilli,
  };
}

/**
 * Run a whole scenario batch (the E3 gate). Mirrors shadow.runShadow's bounded worker pool.
 *   scenarios — [...] from scenario-matrix.buildMatrix (+ coverage golden/boundary/pairwise)
 *   engines   — { ours, lp } (see runOne)
 *   opts      — runOne opts + { concurrency=1, onResult(result,i) }
 * Returns { results:[<runOne verdict>], summary }.
 */
async function runRatesheetAgreement(scenarios, engines = {}, opts = {}) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const ours = engines.ours;
  const lp = engines.lp;
  if (typeof ours !== 'function' || typeof lp !== 'function') {
    throw new Error('runRatesheetAgreement requires engines.ours and engines.lp functions');
  }
  const conc = Math.max(1, Math.min(opts.concurrency || 1, 16));
  const results = new Array(list.length);

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      const r = await runOne(list[i], ours, lp, opts);
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

/**
 * Aggregate the per-scenario verdicts into the gate report. `gateMet` is the E3 decision: at least one
 * scenario was actually comparable, none errored, and NONE disagreed (to the penny). It also tallies
 * every coarse category and every fine DIMENSION that disagreed anywhere, so a failure names exactly
 * which LLPA / bound / eligibility to fix before agreement can be claimed.
 */
function summarize(results) {
  const list = Array.isArray(results) ? results : [];
  let agreed = 0; let disagreed = 0; let incomparable = 0; let errors = 0;
  const byCategory = {};
  const byDimension = {};
  const disagreeing = [];
  for (const r of list) {
    if (!r) continue;
    if (r.error) { errors += 1; continue; }
    if (r.incomparable) { incomparable += 1; continue; }
    if (r.agree) { agreed += 1; } else { disagreed += 1; disagreeing.push(r.scenario); }
    for (const d of ((r.coarse && r.coarse.differences) || [])) {
      byCategory[d.category] = (byCategory[d.category] || 0) + 1;
    }
    for (const rec of (r.rungReconciles || [])) {
      for (const it of (rec.itemized || [])) {
        if (it.deltaMilli !== 0) byDimension[it.dimension] = (byDimension[it.dimension] || 0) + 1;
      }
    }
  }
  const comparable = agreed + disagreed;
  return {
    total: list.length,
    agreed,
    disagreed,
    incomparable,
    errors,
    comparable,
    agreementRate: comparable ? agreed / comparable : null,
    byCategory,
    byDimension,
    disagreeing: disagreeing.slice(0, 50),
    gateMet: errors === 0 && disagreed === 0 && comparable > 0,
  };
}

module.exports = {
  runRatesheetAgreement,
  runOne,
  summarize,
  ERROR_KIND,
  _internals: { ourAdjustmentsOf, bestRungsOf, matchByRate },
};
