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
const { normalizeLpFull, normalizeLpDisqualified, bestRungs } = require('./lp-normalize-full');
const { describeScenario } = require('./scenario-matrix');

const ERROR_KIND = 'engine_error';

// LLPA families Lender Price prices that our confirmed Deephaven sheet does NOT encode yet — measured
// live 2026-08-17 (§2.6): loan-amount tiers, interest-only, escrow-waiver, non-warrantable(-condo).
// These are the "next encode target" (task #62) and each needs a per-cell live re-measure sweep first,
// so they can never be GUESSED. This set is used ONLY to LABEL the gate report — a disagreement in one
// of these families is STILL a disagreement that blocks `gateMet` (owner HARD RULE: agree on every LLPA
// to the penny). Its only job is to let a live 200-scenario run separate "the 4 families we already
// know we must measure" from a genuine sheet bug in a cell we DO encode. Adding a family here after it
// is encoded (so it stops disagreeing) is harmless; leaving one out only mislabels it as a `surprise`.
const KNOWN_UNENCODED_FAMILIES = new Set(['loan_amount', 'interest_only', 'escrow_waiver', 'non_warrantable']);

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
// ONE definition, in lp-normalize-full beside the normalizer whose output it folds — the live shadow
// façade folds LP's programs through the very same function, so the audit harness and production can
// never come to disagree about which rung wins at a coupon.
const bestRungsOf = bestRungs;

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
 *              our sheet does not model prepay yet — surfaced separately, not counted as a disagreement),
 *            boundsGate           — which boundsProbe checks COUNT toward agreement, by name
 *              (`samePrice` / `clampFaithful`). Default: both. Everything not gated is still fully
 *              reported and rolled up by summarize(), so a skipped check is STATED, never silent.
 *            skipBounds           — legacy blunt form of `boundsGate: []` (gate no bounds check). Kept
 *              meaning exactly what it always meant so no caller's gate moves; prefer boundsGate. }
 */
// The probe's checks, and the default gate (all of them). Named here so `boundsGate` can be validated
// rather than silently ignoring a typo — a mis-spelled check name would otherwise read as "gated" while
// gating nothing, which is the failure mode this whole change exists to remove.
const BOUNDS_CHECKS = ['samePrice', 'clampFaithful'];

// How much per-scenario EVIDENCE the summary carries. The summary is the ONLY thing that survives a
// run — `agreement-store.recordRun` stores it whole as jsonb and stores nothing else, so anything left
// out here is answerable only by running the whole battery against the paid vendor again. It used to
// carry `disagreeing` (bare scenario LABELS, silently sliced at 50), which means a stored record could
// say "41 disagreed" beside a list that named where NONE of them went wrong.
//
// BOUNDED, AND THE BOUND IS STATED. A run whose every scenario disagrees would otherwise put ~300
// records with every itemized row into one jsonb value; the caps keep it small and
// `disagreementsOmitted` / `dimensionsOmitted` say exactly what was left out, because a truncated list
// with nothing to say about the truncation reads as the whole story (repo rule: no silent caps).
const DISAGREEMENT_SAMPLE = 50;
const DIMENSION_ROWS_PER_SCENARIO = 12;

/**
 * One disagreeing verdict → the compact record of WHERE it disagreed. Pure; never throws on a
 * half-shaped verdict (a reporter must never cost a run its result).
 *
 * `categories` is the GATING coarse axes only — the axes a caller deliberately ignored are reported in
 * `byCategory` and are, by construction, not why this scenario failed. Naming an ignored axis as the
 * cause is how a reader is sent to fix a compensation-layer difference the gate was told not to count.
 */
function disagreementRecord(r) {
  const rows = [];
  let dimensionsOmitted = 0;
  for (const rec of ((r && r.rungReconciles) || [])) {
    for (const it of ((rec && rec.itemized) || [])) {
      // deltaMilli === 0 is `status:'match'` by reconcileLlpas' own definition, so this is exactly the
      // set of non-matching rows — the same filter the byDimension tally uses, so the sample and the
      // aggregate can never describe different rows.
      if (!it || it.deltaMilli === 0) continue;
      if (rows.length >= DIMENSION_ROWS_PER_SCENARIO) { dimensionsOmitted += 1; continue; }
      rows.push({
        rate: rec.rate != null ? rec.rate : null,
        dimension: it.dimension,
        status: it.status || 'llpa_mismatch',
        deltaMilli: isNum(it.deltaMilli) ? it.deltaMilli : null,
      });
    }
  }
  const gate = Array.isArray(r && r.boundsGate) ? r.boundsGate : BOUNDS_CHECKS;
  const boundsFailed = [];
  for (const b of ((r && r.bounds) || [])) {
    for (const name of gate) {
      if (b && b.checks && b.checks[name] === false && !boundsFailed.includes(name)) boundsFailed.push(name);
    }
  }
  return {
    scenario: r && r.scenario,
    ourEligible: !!(r && r.ourEligible),
    lpEligible: !!(r && r.lpEligible),
    worstDeltaMilli: isNum(r && r.worstDeltaMilli) ? r.worstDeltaMilli : null,
    categories: Array.isArray(r && r.gatingCategories) ? r.gatingCategories.slice() : [],
    dimensions: rows,
    dimensionsOmitted,
    boundsFailed,
  };
}

function resolveBoundsGate(o) {
  if (o.skipBounds) return [];
  const raw = o.boundsGate;
  if (raw == null) return BOUNDS_CHECKS.slice();
  const list = Array.isArray(raw) ? raw : [raw];
  const unknown = list.filter((n) => !BOUNDS_CHECKS.includes(n));
  if (unknown.length) throw new Error(`unknown boundsGate check(s): ${unknown.join(', ')} (known: ${BOUNDS_CHECKS.join(', ')})`);
  return list.slice();
}

async function runOne(scenario, ours, lp, opts) {
  const o = opts || {};
  const tag = scenario && scenario._label ? scenario._label : describeScenario(scenario);
  const rateTol = isNum(o.rateToleranceMilli) ? o.rateToleranceMilli : 0;
  // Resolved BEFORE either engine leg runs: a bad gate spec is a caller bug and must surface as a
  // throw, not as an `engine_error` verdict blamed on the pricing engine.
  const boundsGate = resolveBoundsGate(o);

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
      // GATE PER CHECK, not per probe. `boundsGate` names which of the probe's checks count toward
      // agreement; the rest are still fully reported. This exists because the two checks answer
      // independent questions (see boundsProbe): `samePrice` is FRAME-DEPENDENT and on the live
      // Deephaven sheet is the known origination/margin gap (task #78), while `clampFaithful` is
      // frame-free and is the only thing that ever verified our cap/floor arithmetic at all.
      for (const name of boundsGate) if (bp.checks[name] === false) boundsAgree = false;
      rungReconciles.push({ rate: orr.rate, agree: rec.agree, worstDeltaMilli: rec.worstDeltaMilli, itemized: rec.itemized });
      bounds.push({
        rate: orr.rate,
        agree: bp.agree,
        gatedAgree: boundsGate.every((name) => bp.checks[name] !== false),
        checks: bp.checks,
        capStated: bp.capStated,
        floorStated: bp.floorStated,
        clamped: bp.clamped,
        boundBy: bp.boundBy,
        detail: bp.detail,
      });
    }
  }
  // The FINE gate is the per-dimension LLPA reconcile ALWAYS, plus whichever bounds checks `boundsGate`
  // names. `skipBounds:true` is the blunt legacy form (gate NO bounds check) and is kept meaning exactly
  // what it always meant, so no caller's gate moves under it; prefer `boundsGate` — switching one flag
  // off used to take the frame-free cap/floor check down with the frame-dependent price comparison, and
  // that is how the cap/floor axis came to be neither gated NOR reported on every live run.
  const fineAgree = reconcileAgree && boundsAgree;

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
    // Which bounds checks GATED this verdict. Carried on the result (not only in the caller's opts) so
    // summarize() can report the ungated ones as ungated rather than as passing.
    boundsGate,
    // Which coarse axes actually COUNTED against this verdict — the same reasoning one line up. The
    // ignored ones stay in `coarse` and in the byCategory tally; without this, summarize() cannot tell
    // a cause from an axis the caller deliberately excluded, and `coarseIgnore` lives only in opts.
    gatingCategories: gatingCoarse.map((d) => d.category),
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
  // The agreement's own composition + magnitude, so the headline can be read for what it is.
  let agreedPriced = 0; let agreedDeclined = 0; let worstDeltaMilli = 0;
  const byCategory = {};
  const byDimension = {};        // dimension -> count of disagreeing rows (back-compat: a NUMBER)
  const byDimensionStatus = {};  // dimension -> { llpa_mismatch, llpa_missing_ours, llpa_extra_ours }
  const byStatus = {};           // status -> total across every dimension
  const disagreeing = [];
  const disagreements = [];
  let disagreementsOmitted = 0;
  // THE CAP/FLOOR AXIS, ROLLED UP — the owner's HARD RULE names max price and min price among the things
  // that must agree, and until now the probe's answer was computed per rung and then dropped on the
  // floor here. Counting it is what turns "we skipped that" into something a reader can see.
  const bounds = {
    rungsProbed: 0,
    capStated: 0,      // rungs where our engine stated a ceiling at all
    floorStated: 0,
    clamped: 0,        // rungs where a limit actually BOUND — an unexercised limit is not a tested one
    boundByCap: 0,
    boundByFloor: 0,
    failures: {},      // check name -> rungs where it failed (gated or not)
    gated: null,       // which checks counted toward agreement (null until a result says)
    ungated: [],
  };
  for (const r of list) {
    if (!r) continue;
    if (r.error) { errors += 1; continue; }
    if (r.incomparable) { incomparable += 1; continue; }
    // WHAT KIND of agreement it was. A both-decline is a REAL agreement (the owner asked for ineligible
    // scenarios explicitly — "confirm the disqualifier matches"), but it is weaker evidence about the
    // SHEET than a priced scenario whose every LLPA reconciled, and a headline built mostly of declines
    // would read far stronger than it is. Reported separately so the composition of the number is
    // visible instead of having to be assumed.
    const priced = !!(r.ourEligible && r.lpEligible);
    if (r.agree) {
      agreed += 1;
      if (priced) agreedPriced += 1; else agreedDeclined += 1;
    } else {
      disagreed += 1;
      if (disagreements.length < DISAGREEMENT_SAMPLE) {
        disagreeing.push(r.scenario);
        disagreements.push(disagreementRecord(r));
      } else disagreementsOmitted += 1;
    }
    // The largest per-dimension LLPA delta anywhere — computed per scenario and, until now, dropped.
    // "We disagree on 41 scenarios" reads very differently at 1 milli than at 5,000.
    if (isNum(r.worstDeltaMilli) && Math.abs(r.worstDeltaMilli) > Math.abs(worstDeltaMilli)) worstDeltaMilli = r.worstDeltaMilli;
    if (Array.isArray(r.boundsGate)) {
      bounds.gated = r.boundsGate.slice();
      bounds.ungated = BOUNDS_CHECKS.filter((n) => !r.boundsGate.includes(n));
    }
    for (const b of (r.bounds || [])) {
      bounds.rungsProbed += 1;
      if (b.capStated) bounds.capStated += 1;
      if (b.floorStated) bounds.floorStated += 1;
      if (b.clamped) bounds.clamped += 1;
      if (b.boundBy === 'cap') bounds.boundByCap += 1;
      if (b.boundBy === 'floor') bounds.boundByFloor += 1;
      for (const name of Object.keys(b.checks || {})) {
        if (b.checks[name] === false) bounds.failures[name] = (bounds.failures[name] || 0) + 1;
      }
    }
    for (const d of ((r.coarse && r.coarse.differences) || [])) {
      byCategory[d.category] = (byCategory[d.category] || 0) + 1;
    }
    for (const rec of (r.rungReconciles || [])) {
      for (const it of (rec.itemized || [])) {
        if (it.deltaMilli === 0) continue;
        byDimension[it.dimension] = (byDimension[it.dimension] || 0) + 1;
        // reconcileLlpas stamps every non-match row with a status: llpa_missing_ours (LP prices a
        // dimension we carry NO adjustment for — the four unencoded families), llpa_mismatch (a cell we
        // DO encode but the number is off — a real sheet bug), or llpa_extra_ours (we price something LP
        // does not). Tally per dimension AND overall so the gate report is actionable.
        const st = it.status || 'llpa_mismatch';
        const bucket = byDimensionStatus[it.dimension] || (byDimensionStatus[it.dimension] = {});
        bucket[st] = (bucket[st] || 0) + 1;
        byStatus[st] = (byStatus[st] || 0) + 1;
      }
    }
  }
  // Split the disagreeing DIMENSIONS into the two piles a human actually needs kept apart. A dimension is
  // `pendingEncode` only when EVERY disagreeing row in it is `llpa_missing_ours` AND it is a documented
  // known-unencoded family — i.e. LP prices a whole family our sheet does not carry yet (task #62), not a
  // cell we got wrong. Anything else is a `surprise` that must be resolved before agreement can be
  // claimed: a real cell mismatch, an extra LLPA of ours, a missing family we did NOT expect, or a known
  // family that ALSO shows a mismatch (so it is no longer purely "unencoded"). `gateMet` is unchanged —
  // BOTH piles still block the gate; this only labels them.
  const pendingEncodeFamilies = [];
  const surprises = [];
  for (const dim of Object.keys(byDimensionStatus).sort()) {
    const statuses = Object.keys(byDimensionStatus[dim]);
    const purelyMissing = statuses.length === 1 && statuses[0] === 'llpa_missing_ours';
    if (purelyMissing && KNOWN_UNENCODED_FAMILIES.has(dim)) pendingEncodeFamilies.push(dim);
    else surprises.push(dim);
  }
  const comparable = agreed + disagreed;
  return {
    total: list.length,
    agreed,
    // agreed = agreedPriced + agreedDeclined. A priced agreement means BOTH sides quoted and every
    // itemized LLPA reconciled; a declined agreement means both refused the loan.
    agreedPriced,
    agreedDeclined,
    disagreed,
    incomparable,
    errors,
    comparable,
    agreementRate: comparable ? agreed / comparable : null,
    byCategory,
    byDimension,
    byDimensionStatus,
    byStatus,
    // `bounds.clamped === 0` is the honest headline for the cap/floor axis: every limit our engine
    // stated was stated and never reached, so this run did not TEST one. A limit that never binds
    // cannot be confirmed by a run, only refuted by one.
    bounds,
    pendingEncodeFamilies,
    surprises,
    worstDeltaMilli,
    // The bare labels, unchanged in shape and meaning, because stored summaries already carry this key
    // and a reader of an old row must not have to guess which shape it holds. `disagreements` is the
    // same sample WITH the evidence; both share one cap, and `disagreementsOmitted` states what neither
    // of them names.
    disagreeing,
    disagreements,
    disagreementsOmitted,
    gateMet: errors === 0 && disagreed === 0 && comparable > 0,
  };
}

module.exports = {
  runRatesheetAgreement,
  runOne,
  summarize,
  ERROR_KIND,
  KNOWN_UNENCODED_FAMILIES,
  DISAGREEMENT_SAMPLE,
  DIMENSION_ROWS_PER_SCENARIO,
  _internals: { ourAdjustmentsOf, bestRungsOf, matchByRate, disagreementRecord },
};
