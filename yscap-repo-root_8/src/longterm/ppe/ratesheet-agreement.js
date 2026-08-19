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
 *   disqualifier-reconciler.reconcileDisqualifiers → WHY each side declined, per LAYER (see below)
 *   rung-digest.buildRungDigest                 → WHERE in the price build-up a disagreement sits
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
 * every cap/floor probe is faithful AND — when BOTH sides declined — they declined for the SAME reason.
 *
 * THE BOTH-DECLINE GAP, AND WHY THIS IS THE FIX (2026-08-18). `parity-detectors` ends its eligibility
 * axis with `if (!ours.eligible && !lpEligible) return finalize(differences)` — "both decline — agree
 * on the outcome (reason-set comparison is a later refinement)". So a scenario where WE declined on
 * FICO and Lender Price declined on a state prepayment prohibition scored as a clean agreement, and
 * `summarize()` counted it under `agreedDeclined`. That is not the owner's rule, which names
 * "eligibility AND ineligibility" as things to agree on, and it hides the exact defect it is most
 * likely to be covering: two engines that decline the same loan for different reasons will DISAGREE on
 * the neighbouring scenario where only one of those reasons applies — and that scenario is the
 * dangerous direction (we price a loan LP declines). `disqualifier-reconciler` is the later refinement
 * that sentence promised, and it now decides a both-decline:
 *
 *   its verdict 'agree'        → the outcome AND the per-layer reasons match → a real agreement.
 *   its verdict 'disagree'     → both declined, on DIFFERENT dimensions → NOT an agreement.
 *   ANY unknown reason      → we could not READ one side's reasons (an uncrosswalkable vendor reason,
 *                                a decline whose rule carries no dimension) → the scenario becomes
 *                                INCOMPARABLE with a stated reason. Never an agreement (that is the
 *                                gap), and never a disagreement either — nothing was shown to differ,
 *                                and calling it one sends a reader to fix a sheet that may be right.
 *                                An unknown VETOES a disagreement, because the reconciler reconciles
 *                                what is left after setting it aside — see `declineOutcome`.
 *   the reconciler THREW       → the verdict stands exactly as it was, and `notReconciled` says so.
 *
 * That is a deliberate BEHAVIOUR CHANGE TO A GATE: a scenario that agreed before can now disagree or
 * fall out of `comparable`. It is proven by `scripts/test-lt-ppe-agreement-audit-pure.js`.
 *
 * LT-only. No RTL imports.
 */
const { detectDifferences } = require('./parity-detectors');
const { reconcileLlpas, boundsProbe } = require('./ratesheet-agreement-diff');
const { normalizeLpFull, normalizeLpDisqualified, bestRungs } = require('./lp-normalize-full');
const { describeScenario } = require('./scenario-matrix');
const { reconcileDisqualifiers } = require('./disqualifier-reconciler');
const { buildRungDigest } = require('./rung-digest');

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
// carries only rate+price). The agreement harness needs only per-coupon best for the comparison.
// (This comment used to call `best-execution.js` the live picker for the quote path. It is nothing of
// the sort: nothing under `src/` requires that module — its only consumer anywhere is its own test
// suite — and the quote path never asks it anything. Corrected rather than deleted because the
// CONTRAST it was drawing is still the point: this fold is per-coupon-best for a COMPARISON, which is
// a different job from ranking investors against each other for an execution.)
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
// The two audit modules' contribution to that stored record, and both are capped for the same reason.
// A rung DIGEST is per-coupon × per-dimension — on a 28-coupon ladder that is hundreds of rows for ONE
// scenario, and 50 of them would not belong in a jsonb column. So the summary carries the ONE rung
// where the build-up diverged worst (rate + the five build-up deltas), which is the question the digest
// exists to answer — base, adjustments, margin or the clamp — and the FULL digest stays on the run
// RESULT, which is returned to the caller and is not stored. `WHAT_IS_NOT_STORED` says that in the
// summary itself rather than leaving a reader of an old row to work out what they are missing.
const DECLINE_ROWS_PER_SCENARIO = 8;
// A decline REASON is free text a vendor wrote, so it is the one thing in this record with no natural
// size at all — every other field is a number or a short dimension key. Capped, and the cap SHOWS: a
// truncated reason ends in '…', so a reader is never shown a sentence that looks complete and is not.
const REASON_TEXT_MAX = 120;
const WHAT_IS_NOT_STORED = 'per-coupon rung digests and full per-layer decline reports live on the run '
  + 'result only; this summary carries the worst rung\'s build-up and a capped decline-mismatch sample, '
  + `with each decline reason cut to ${REASON_TEXT_MAX} characters (a cut reason ends in '…').`;

function clipReason(v) {
  if (v == null) return null;
  const s = String(v);
  return s.length <= REASON_TEXT_MAX ? s : `${s.slice(0, REASON_TEXT_MAX - 1)}…`;
}

/**
 * The PROGRAM whose rules a decline's dimension is read from.
 *
 * ONE SOURCE, NOT TWO. The reconciler reads our decline's dimension from the RULE that produced it
 * (`agreement-dimensions.dimensionOfRule`) and never from the reason text, so it needs the sheet-
 * under-test. That sheet is already in the caller's hand exactly once — it is what `buildOursLeg` was
 * given — so `lp-agreement-legs` stamps it on the leg it returns and this reads it from there. Asking
 * the caller to pass the same program a second time in `opts` is how the two come to disagree about
 * which sheet was measured; `opts.program` still wins for a caller that has no leg to stamp (every
 * offline test builds its own `ours`). With NEITHER, nothing is guessed: every decline reports
 * `no_dimension` and the reconciliation is `indeterminate`, which is the honest answer.
 */
function programOf(o, ours) {
  if (o && o.program) return o.program;
  return (typeof ours === 'function' && ours.program) ? ours.program : null;
}

/**
 * The per-layer decline reconciliation, GUARDED. Returns null if it throws — and a null leaves the
 * verdict exactly as the coarse and fine axes left it (`attachDiagnosis` in facade.js is the shape:
 * an audit laid on top of a comparison may never cost that comparison its answer). The one place a
 * SUCCESSFUL reconciliation changes a verdict is the both-decline branch in runOne, and that is the
 * defect this wiring exists to close.
 */
function safeReconcileDeclines(our, lpDisq, program) {
  try {
    return reconcileDisqualifiers(our, lpDisq, program ? { program } : {});
  } catch (_) { return null; }
}

/**
 * What a reconciliation MEANS for a both-decline — the ONE reading, computed once in runOne and put on
 * the verdict so `summarize()` cannot come to a different conclusion about the same report.
 *
 * AN UNKNOWN ON EITHER SIDE VETOES A DISAGREEMENT. The reconciler puts a reason it cannot read into
 * `unknown` and then reconciles what is LEFT, so an unreadable vendor reason leaves OUR decline
 * standing alone on its dimension and the layer reports `only_ours` — which reads as "we decline
 * something Lender Price does not" when the truth may be that they declined for the very same reason
 * in words nothing could parse. With either reason set incompletely known, neither agreement nor
 * disagreement is established.
 */
function declineOutcome(rep) {
  if (!rep) return null;
  const unknowns = (rep.summary && rep.summary.unknown) || 0;
  if (unknowns > 0 || rep.verdict === 'indeterminate') return 'indeterminate';
  return rep.verdict === 'disagree' ? 'disagree' : 'agree';
}

/**
 * The rung digest, GUARDED, and computed strictly AFTER `agree` is decided so it can never move it.
 * Built only for a scenario that is already known to disagree with rungs on both sides — an agreeing
 * scenario has nothing to line up, and building a per-coupon table for every scenario in a 300-run
 * battery is bloat nobody reads.
 */
function safeDigest(our, lpEligible, lpRungs, rateTol) {
  try {
    return buildRungDigest(our, { eligible: lpEligible, rungs: lpRungs }, { rateToleranceMilli: rateTol });
  } catch (_) { return null; }
}

/** The digest's worst rung, flattened to the six numbers the stored summary carries. */
function worstRungOf(digest) {
  const list = (digest && Array.isArray(digest.rungs)) ? digest.rungs : [];
  let w = null;
  for (const r of list) {
    if (!r) continue;
    const d = isNum(r.worstDeltaMilli) ? r.worstDeltaMilli : 0;
    if (!w || Math.abs(d) > Math.abs(isNum(w.worstDeltaMilli) ? w.worstDeltaMilli : 0)) w = r;
  }
  if (!w) return null;
  return {
    rate: w.rate == null ? null : w.rate,
    baseDeltaMilli: w.base ? w.base.deltaMilli : null,
    adjustmentTotalDeltaMilli: w.adjustmentTotal ? w.adjustmentTotal.deltaMilli : null,
    marginDeltaMilli: w.margin ? w.margin.deltaMilli : null,
    finalDeltaMilli: w.final ? w.final.deltaMilli : null,
    clampedOurs: !!(w.clamped && w.clamped.ours),
    clampedTheirs: w.clamped ? w.clamped.theirs : null,
  };
}

/** The reconciliation's one-sided rows, capped, with what was left out counted. */
function declineMismatchRows(rep) {
  const rows = [];
  let omitted = 0;
  const layers = (rep && rep.layers) || {};
  for (const layer of ['layer2', 'layer3']) {
    const l = layers[layer];
    if (!l) continue;
    const push = (side, row) => {
      if (!row) return;
      if (rows.length >= DECLINE_ROWS_PER_SCENARIO) { omitted += 1; return; }
      rows.push({ layer, side, dimension: row.dimension || null, reason: clipReason(row.reason) });
    };
    for (const row of (l.onlyOurs || [])) push('ours', row);
    for (const row of (l.onlyAuthority || [])) push('authority', row);
  }
  return { rows, omitted };
}

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
  const decline = declineMismatchRows(r && r.declineReconcile);
  return {
    scenario: r && r.scenario,
    ourEligible: !!(r && r.ourEligible),
    lpEligible: !!(r && r.lpEligible),
    worstDeltaMilli: isNum(r && r.worstDeltaMilli) ? r.worstDeltaMilli : null,
    categories: Array.isArray(r && r.gatingCategories) ? r.gatingCategories.slice() : [],
    dimensions: rows,
    dimensionsOmitted,
    boundsFailed,
    // WHERE in the price build-up the worst rung diverged — base, the adjustment stack, the margin,
    // or the final price after the clamp. `dimensions` above already names WHICH LLPA cells moved;
    // this is the half that says a gap sits somewhere other than an LLPA at all (a base-grid or margin
    // difference itemizes as nothing, and a reader with only the cell list would hunt for a cell).
    worstRung: worstRungOf(r && r.digest),
    // WHY each side declined, when they declined differently. Null verdict → no rows, which is right:
    // a priced disagreement has no declines to reconcile.
    declineVerdict: (r && (r.declineOutcome || (r.declineReconcile && r.declineReconcile.verdict))) || null,
    declineMismatch: decline.rows,
    declineRowsOmitted: decline.omitted,
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

  // THE OBSERVER HOOK — both legs, raw, exactly once per scenario, for a caller that wants to answer a
  // SECOND question off a battery that has already been paid for.
  //
  // WHY IT EXISTS: the disqualifier review (§2.58) needs precisely these two things — our quote and
  // Lender Price's own refusal list — and the agreement run already fetches both. Without the hook the
  // only way to fill the review queue is a SECOND battery against a paid vendor, asking the same
  // questions twice for one sheet.
  //
  // IT IS STRICTLY OBSERVATIONAL, and the wrapping is the whole contract: a hook that throws, hangs on
  // its own error, or returns something is ignored, and the verdict below is computed exactly as it
  // would be with no hook at all. A reporter must never be able to change a measurement — that is the
  // same rule `onResult` already follows one level up.
  if (typeof o.onScenario === 'function') {
    try { o.onScenario({ scenario, ours: our, legs, tag }); } catch (_) { /* never changes a verdict */ }
  }

  const filter = o.filter || {};
  const lpNorm = normalizeLpFull(legs.full || {}, { ...filter, rateScale: o.rateScale, priceScale: o.priceScale });
  const lpDisq = normalizeLpDisqualified(legs.disqualified || {}, filter);
  const lpRungs = bestRungsOf(lpNorm);
  const lpDeclined = !!(lpDisq.declined && lpDisq.declined.length);
  const lpHasSignal = lpRungs.length > 0 || lpDeclined;
  // ⛔ DID WE ACTUALLY SEE LENDER PRICE'S DECLINES? (§2.91) The disqualify tree is computed
  // asynchronously and is the ONLY place LP states a refusal. `buildLpLeg` yields `{ready:false}` both
  // when the poll timed out AND when `--no-disqualify` never asked — and for this purpose those are
  // the same fact: LP's verdict was not observed. Without it, `lpEligible` collapses to "a ladder came
  // back", which is a materially weaker claim than "Lender Price approved this loan".
  const lpDisqReady = !!(legs.disqualified && legs.disqualified.ready);

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
  // ⛔ THE VERDICT IS UNCHANGED, AND THE CHOICE INSIDE IT IS NOW SAID OUT LOUD (§2.113). This one
  // expression decides that a loan Lender Price returned a PRICE for is nonetheless "not eligible",
  // because a program in the same scope refused it. On the Deephaven DSCR sheet that is the NORMAL
  // state of every loan — §2.107 measured the vendor splitting one sheet across three band containers
  // where exactly one prices and the other two refuse — so `lpEligible` is false on essentially every
  // scenario, `agreedPriced` has been 0 in every report this harness has ever produced, and the
  // battery has never once observed Lender Price APPROVING a loan.
  //
  // WHETHER THAT IS RIGHT IS A BUSINESS QUESTION AND IT IS OPEN. Two live measurements disagree:
  //   • 2026-08-17 — on four of six ineligible probes "the DSCR-matching container declined while a
  //     mismatched container leaked a price", concluding: do NOT read a Deephaven price as eligibility.
  //   • 2026-08-19 (§2.107) — the container NAME does not describe the loan's band (a DSCR 1.25 loan
  //     priced under `DSCR < 1.00`), and the band is priced by an ADJUSTMENT ROW inside the grid, so
  //     the three-way split is a configuration artifact rather than a pricing partition.
  // Under the first reading the price is a leak; under the second it is a real offer and our sheet
  // refusing it is a disagreement in the expensive direction — a loan the investor would fund that we
  // turn away. Flipping this on a guess would either manufacture a false disagreement on every
  // scenario or keep hiding a real one, so it is NOT flipped here: it is REPORTED (`lpPriced`,
  // `lpPricedBy`, `lpRefusedBy`, and `lpPricedWhileRefused` in the summary) and put to the owner.
  const lpPriced = lpRungs.length > 0;
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
  // confirm the disqualifier matches"), so it counts, and the coarse eligibility axis decides its
  // OUTCOME; whether the two declined for the SAME REASON is decided a few lines below.
  let incomparable = !lpHasSignal;
  let incomparableReason = incomparable ? 'lp_no_signal' : null;
  // ⛔ WITHOUT THE DECLINE FEED, "WE DECLINED AND THEY PRICED" IS NOT A FINDING (§2.91).
  //
  // MEASURED, and it produced a confidently wrong answer. Lender Price splits one Deephaven sheet
  // across several DSCR-band programs, and the repo's own live capture of 2026-08-17 recorded that on
  // four of six ineligible probes **the DSCR-matching container declined while a mismatched container
  // leaked a price** — its own words: *"Do not treat 'an eligible Deephaven price came back' as 'the
  // loan is eligible for its DSCR band'."* The 2026-08-18 run was made with the decline feed OFF, and
  // those same four probes came back as `disqualification_extra` — reported as loans we wrongly refuse.
  // They were the vendor's leak, and the run could not tell.
  //
  // So when OUR side declines and LP merely showed a ladder, with no decline feed to confirm what LP
  // actually decided, the honest verdict is INCOMPARABLE — not a disagreement. It is not evidence our
  // sheet is wrong, and (per §2.90) it now stops such a run from proving a sheet, which is correct:
  // a run that never looked at LP's refusals cannot prove agreement about refusals.
  //
  // The other direction needs no arm: with the feed off, `lpDeclined` is always false, so
  // "LP declined and we priced" cannot arise at all.
  if (!incomparable && !lpDisqReady && !ourEligible && lpNorm.eligible) {
    incomparable = true;
    incomparableReason = 'lp_decline_unobserved';
  }
  // `coarseIgnore` drops margin-laden coarse axes from the GATE (still fully reported): on the live
  // Deephaven sheet `final_price` and `llpa_total` compare LP's displayed price / adjustmentPoints,
  // which carry the origination/margin, NOT the LLPA stack — so they are a compensation-layer question.
  const coarseIgnore = o.coarseIgnore instanceof Set ? o.coarseIgnore : new Set(Array.isArray(o.coarseIgnore) ? o.coarseIgnore : []);
  // ⛔ A SCENARIO BOTH SIDES DECLINED HAS NO PRICE TO COMPARE, so no coarse axis may gate its verdict.
  // Our engine returns NO rungs precisely BECAUSE it declined, while Lender Price returns its ladder
  // even for a program it refuses — so every difference there reads "Lender Price offers coupon X that
  // we do not price", which is trivially true of EVERY declined loan and is evidence about nothing.
  // MEASURED live 2026-08-18: 168 of 168 coarse differences in an 8-scenario run were exactly that, on
  // six scenarios both engines refused, and they held `agree` false before the decline reconciliation
  // below could ever be consulted. The verdict on a both-decline is the DECLINE reconciliation's — see
  // the block below, which is the only thing that may decide it.
  const bothDeclined = !incomparable && !ourEligible && !lpEligible;
  const gatingCoarse = bothDeclined
    ? []
    : ((coarse && coarse.differences) || []).filter((d) => !coarseIgnore.has(d.category));
  let agree = !incomparable && gatingCoarse.length === 0 && fineAgree;
  const worstDeltaMilli = rungReconciles.reduce(
    (m, r) => (Math.abs(r.worstDeltaMilli) > Math.abs(m) ? r.worstDeltaMilli : m), 0,
  );

  // === WHY, per LAYER — the disqualifier reconciliation ==========================================
  // Run whenever a side declined at all, because that is when there are declines to itemize; a
  // one-sided decline (`disqualification_missing` / `_extra`) already disagrees on the coarse axis and
  // this only says WHICH reason on WHICH layer, as evidence. The ONE place it moves a verdict is the
  // both-decline, where nothing compared the reasons before.
  const declineReconcile = (!incomparable && (!ourEligible || !lpEligible))
    ? safeReconcileDeclines(our, lpDisq, programOf(o, ours))
    : null;
  const outcome = declineOutcome(declineReconcile);
  if (bothDeclined && outcome) {
    if (outcome === 'indeterminate') {
      // ⛔ NAME THE CAUSE. "The reasons could not be read" and "both engines named a reason and the two
      // vocabularies file it differently" are different pieces of news, and merging them sends a reader
      // hunting a parsing bug that is not there. `relatedOnly` says the second one happened.
      const unpaired = !!(declineReconcile && declineReconcile.relatedOnly);
      // Counting this as agreement is the gap being closed; counting it as a disagreement would send
      // somebody to fix a sheet nothing has been shown to be wrong with — the same collapse
      // `agreement-store` refuses between "never measured" and "measured and failed".
      // `incomparableByReason` in the summary names it, so it is stated and never silent.
      agree = false;
      incomparable = true;
      incomparableReason = unpaired ? 'decline_reasons_unpaired' : 'decline_reasons_unreadable';
    } else {
      // ⛔ THE VERDICT IS THIS RECONCILIATION'S, IN BOTH DIRECTIONS. It used to be able only to push
      // `agree` further false: the coarse axes had already set it false (see the both-decline note
      // above), and `outcome === 'agree'` did nothing — so a scenario where BOTH engines declined for
      // the SAME stated reason could never be recorded as an agreement, and `agreedDeclined` could
      // never leave zero while Lender Price returned a ladder. The summary said so out loud and
      // nobody could reconcile it: `bothDeclined: 8` beside `agreedDeclined: 0` in the same object.
      //
      // REDUNDANT TODAY, AND SAID SO RATHER THAN IMPLIED: with the coarse axes suppressed above,
      // `agree` already starts TRUE on every both-decline (no gating difference, and `fineAgree` is
      // vacuously true because a decline produces no rungs to reconcile), so `agree = agree &&
      // outcome !== 'disagree'` would behave identically — the mutation proving exactly that stayed
      // GREEN. It is written as an ASSIGNMENT because the verdict's source should be unambiguous
      // and because it keeps holding if `fineAgree` ever stops being vacuous here.
      agree = (outcome === 'agree');
    }
  }

  // === WHERE in the build-up — the rung digest ====================================================
  // AFTER `agree` is final, so it can never move it, and only for a scenario that already disagrees
  // with rungs on BOTH sides. An agreeing scenario has nothing to line up and does not need a table.
  const digest = (!agree && !incomparable && ourEligible && lpEligible)
    ? safeDigest(our, lpEligible, lpRungs, rateTol)
    : null;

  return {
    scenario: tag,
    agree,
    incomparable,
    // WHY it was incomparable — `lp_no_signal` (Lender Price answered nothing for our filter) or
    // `decline_reasons_unreadable` (both declined and the reasons could not be compared). Two very
    // different pieces of news that used to be one number.
    incomparableReason,
    ourEligible,
    lpEligible,
    lpDeclined,
    // WHAT LENDER PRICE ACTUALLY DID, beside the verdict we drew from it. `lpPriced` is the fact the
    // verdict above sets aside; the two program lists say which containers took which side, so a reader
    // can see a scenario priced by one and refused by two without reopening the payload.
    lpPriced,
    lpPricedBy: (lpNorm.programs || []).filter((p) => (p.rungs || []).length).map((p) => p.program || null),
    lpRefusedBy: Array.from(new Set(((lpDisq.declined) || []).map((d) => d.program || null))),
    // The vendor repeats each refusal once per rung; §2.113 collapses them. Carried so a run can never
    // quietly stop reporting how much it folded away.
    lpDeclineDuplicatesCollapsed: isNum(lpDisq.duplicatesCollapsed) ? lpDisq.duplicatesCollapsed : null,
    // ⛔ WHETHER LENDER PRICE'S REFUSALS WERE OBSERVED AT ALL (§2.93). Carried per scenario because
    // the gate below is a claim about the whole battery, and a claim nobody can trace to the runs
    // that support it is the shape this file keeps having to unpick.
    lpDisqReady,
    bothDeclined,
    coarse,
    rungReconciles,
    bounds,
    // The two audit outputs. Both are null when there was nothing to say; `declineReconcile` is also
    // null when the reconciler THREW, which is what leaves the verdict untouched. `declineOutcome` is
    // the ONE reading of that report (see the function), carried so summarize() cannot re-derive a
    // different one from the same rows.
    declineReconcile,
    declineOutcome: outcome,
    digest,
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
 *   opts      — runOne opts + { concurrency=1, onResult(result,i), onScenario({scenario,ours,legs,tag}) }
 *               `onScenario` is called once per scenario with BOTH RAW LEGS, for a caller answering a
 *               second question off a battery already paid for (see runOne). Observational only.
 * Returns { results:[<runOne verdict>], summary }.
 */

/**
 * ⛔ TWO SCENARIOS THAT ASK LENDER PRICE THE SAME QUESTION MUST NOT BE ASKED TWICE (§2.95).
 *
 * MEASURED on the canonical battery: **32 of 305 scenarios build a byte-identical request.** The
 * FICO×CLTV sweep and the DSCR×CLTV sweep overlap at FICO 760, and `ppp 5yr` is byte-identical to
 * `state CA` because 60 months IS the profile default. The two groups ask different QUESTIONS of the
 * same request — so the vendor's answer is identical and the second call learns nothing. At the owner's
 * six scheduled runs a day that is ~190 paid vendor calls daily, spent on answers we already hold.
 *
 * ⛔ THE SCENARIOS ARE NOT DROPPED, AND THAT IS THE POINT. Each is attributed to its own group in the
 * report, and collapsing them would change what each group claims to cover — the coverage a reader
 * trusts. So both scenarios are still compared, still scored, still counted; only the paid CALL is
 * shared. What is saved is money, not measurement.
 *
 * THE KEY IS THE CALLER'S, NOT OURS. This module is deliberately engine-agnostic — `lp` is an injected
 * leg and this file does not know how it builds a request. So the caller supplies `dedupeKey(scenario)`
 * (the runner derives it from the request `buildSearch` would actually send). **Omitted means no
 * deduplication and byte-identical behaviour to before**, which is what makes this safe to ship.
 *
 * THE PROMISE IS CACHED, NOT THE VALUE, so N concurrent workers hitting the same key share ONE upstream
 * call rather than racing to start N. A rejected promise is cached too, deliberately: an identical
 * request that failed will fail identically, and re-asking it 32 times is exactly the waste this
 * closes. `runOne` turns that rejection into the same `errorVerdict` it always would.
 */
function memoizeLeg(lp, keyOf) {
  const cache = new Map();
  let served = 0;
  const leg = (sc) => {
    let k = null;
    try { k = keyOf(sc); } catch (_) { k = null; }
    // An unkeyable scenario is always asked. Guessing a key would silently merge two DIFFERENT
    // questions, which is a wrong answer rather than a slow one.
    if (k == null || k === '') return lp(sc);
    if (cache.has(k)) { served += 1; return cache.get(k); }
    const p = Promise.resolve().then(() => lp(sc));
    cache.set(k, p);
    return p;
  };
  return { leg, stats: () => ({ deduped: served, distinctRequests: cache.size }) };
}

async function runRatesheetAgreement(scenarios, engines = {}, opts = {}) {
  const list = Array.isArray(scenarios) ? scenarios : [];
  const ours = engines.ours;
  const lp = engines.lp;
  if (typeof ours !== 'function' || typeof lp !== 'function') {
    throw new Error('runRatesheetAgreement requires engines.ours and engines.lp functions');
  }
  const conc = Math.max(1, Math.min(opts.concurrency || 1, 16));
  const results = new Array(list.length);
  // Opt-in, and off by default: with no `dedupeKey` the leg is used exactly as passed.
  const memo = typeof opts.dedupeKey === 'function' ? memoizeLeg(lp, opts.dedupeKey) : null;
  const lpLeg = memo ? memo.leg : lp;

  let next = 0;
  async function worker() {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      const r = await runOne(list[i], ours, lpLeg, opts);
      results[i] = r;
      if (typeof opts.onResult === 'function') {
        try { opts.onResult(r, i); } catch (_) { /* a reporter must never break the run */ }
      }
    }
  }
  const workers = [];
  for (let w = 0; w < conc; w += 1) workers.push(worker());
  await Promise.all(workers);

  // NEVER SILENT. A saving nobody is told about reads as a battery that shrank, so the counts ride on
  // the summary: how many calls were shared, and how many distinct requests the battery really asks.
  const summary = summarize(results);
  if (memo) Object.assign(summary, memo.stats());
  return { results, summary };
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
  // ⛔ HOW MANY SCENARIOS ACTUALLY SAW LENDER PRICE'S REFUSALS (§2.93). Counted over every result,
  // including the errored ones, so the denominator is the battery rather than the survivors.
  let declineFeedReady = 0;
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
  // THE INELIGIBILITY AXIS, ROLLED UP. The owner's rule names ineligibility beside price, and until the
  // reconciler was wired the only thing recorded about a both-decline was that it happened. These are
  // the numbers that say whether the `agreedDeclined` headline is evidence or a coincidence.
  const declines = {
    reconciled: 0,            // scenarios where a reconciliation actually ran (either side declined)
    bothDeclined: 0,          // ... of which both sides declined — the ones whose verdict it decides
    // Coarse differences seen on a both-decline and deliberately NOT gated: our engine priced nothing
    // because it declined, so "LP offers a coupon we do not price" is an artefact of the refusal.
    coarseNotEvidence: 0,
    reasonsAgree: 0,          // ... and the per-layer reasons matched (a REAL eligibility agreement)
    reasonsDisagree: 0,       // ... and they did not (declined the same loan for different reasons)
    reasonsIndeterminate: 0,  // ... and one side's reasons could not be read → incomparable, see below
    notReconciled: 0,         // ... and the reconciler threw, so the verdict stands unchanged
    byLayer: {
      layer2: { agreements: 0, onlyOurs: 0, onlyAuthority: 0 },
      layer3: { agreements: 0, onlyOurs: 0, onlyAuthority: 0 },
    },
  };
  const incomparableByReason = {};
  // WHICH POPULATION THE DESCRIPTIVE NUMBERS CAME FROM (§2.110). `byCategory`, `bounds`, `byDimension`
  // and `worstDeltaMilli` are measurements, not scores, and they now cover EVERY scenario the battery
  // ran — comparable or not. That is only honest if the report also says how much of each number came
  // from scenarios that could not be scored, so a reader can weigh it. Counted in the same loops as the
  // tallies themselves, so the two can never drift apart.
  // ⛔ THE POPULATION THE OPEN §2.113 QUESTION GOVERNS. A scenario where Lender Price returned a price
  // under one in-scope program AND refused under another is the case the verdict rule silently decides;
  // counting them is what turns "an open question" into a number somebody can weigh. `lpPricedNotCounted`
  // is the sharp one: LP priced it and the run scored LP as ineligible anyway.
  const vendorSplit = {
    lpPricedWhileRefused: 0,   // priced by one in-scope program, refused by another
    lpPricedNotCounted: 0,     // ... and scored as NOT eligible because of it
    declineDuplicatesCollapsed: 0, // per-rung repeats folded away by the normalizer (§2.113)
  };
  const measurement = {
    scenarios: 0,       // scenarios whose measurements were tallied (errors excluded — they measured nothing)
    comparable: 0,      // ... of which could be scored
    incomparable: 0,    // ... of which could not, and would previously have been dropped whole
    fromIncomparable: { coarseDifferences: 0, rungRows: 0, boundsProbed: 0 },
  };
  for (const r of list) {
    if (!r) continue;
    if (r.lpDisqReady) declineFeedReady += 1;
    if (r.error) { errors += 1; continue; }
    // TALLIED BEFORE THE INCOMPARABLE BRANCH, on purpose: a both-decline whose reasons could not be
    // read is now INCOMPARABLE, and that is exactly the state these counters exist to make visible.
    if (r.bothDeclined) {
      declines.bothDeclined += 1;
      const outcome = r.declineOutcome || null;
      if (!outcome) declines.notReconciled += 1;
      else if (outcome === 'agree') declines.reasonsAgree += 1;
      else if (outcome === 'disagree') declines.reasonsDisagree += 1;
      else declines.reasonsIndeterminate += 1;
    }
    if (r.declineReconcile) {
      declines.reconciled += 1;
      for (const layer of ['layer2', 'layer3']) {
        const l = (r.declineReconcile.layers || {})[layer];
        if (!l) continue;
        declines.byLayer[layer].agreements += (l.agreements || []).length;
        declines.byLayer[layer].onlyOurs += (l.onlyOurs || []).length;
        declines.byLayer[layer].onlyAuthority += (l.onlyAuthority || []).length;
      }
    }
    // SCORING is comparable-only, and stays that way. MEASUREMENT is not — see below.
    if (r.incomparable) {
      incomparable += 1;
      const why = r.incomparableReason || 'unstated';
      incomparableByReason[why] = (incomparableByReason[why] || 0) + 1;
    } else {
      // WHAT KIND of agreement it was. A both-decline is a REAL agreement (the owner asked for
      // ineligible scenarios explicitly — "confirm the disqualifier matches"), but it is weaker
      // evidence about the SHEET than a priced scenario whose every LLPA reconciled, and a headline
      // built mostly of declines would read far stronger than it is. Reported separately so the
      // composition of the number is visible instead of having to be assumed.
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
    }
    // ---- EVERYTHING BELOW IS MEASUREMENT, AND IT RUNS FOR EVERY SCENARIO (§2.110) -----------------
    // This used to sit behind `continue` on the incomparable branch, so a scenario whose decline
    // reasons could not be paired contributed NOTHING to `byCategory`, `bounds`, `byDimension` or
    // `worstDeltaMilli` — while the report presented those numbers as what the battery measured. On the
    // live 2026-08-19 run that silently dropped 6 of 8 scenarios and 168 of 224 coarse differences: a
    // reader chasing "which scenarios are not pricing correctly" saw 56 and had no way to learn the
    // other 168 existed. Incomparable means UNSCORABLE, not unmeasured — the vendor was paid for these
    // payloads either way. None of these tallies feeds `gateMet` (errors / disagreed / comparable /
    // declineFeedComplete), so widening the population cannot move the gate; it only stops the report
    // describing a battery it did not look at. `measurement` below names the population out loud.
    measurement.scenarios += 1;
    if (r.incomparable) measurement.incomparable += 1; else measurement.comparable += 1;
    if (isNum(r.lpDeclineDuplicatesCollapsed)) vendorSplit.declineDuplicatesCollapsed += r.lpDeclineDuplicatesCollapsed;
    if (r.lpPriced && (r.lpRefusedBy || []).length) {
      vendorSplit.lpPricedWhileRefused += 1;
      if (!r.lpEligible) vendorSplit.lpPricedNotCounted += 1;
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
      if (r.incomparable) measurement.fromIncomparable.boundsProbed += 1;
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
      if (r.incomparable) measurement.fromIncomparable.coarseDifferences += 1;
      // `byCategory` tallies EVERY coarse difference — and since §2.110 that phrase is finally true:
      // it used to mean "every difference on a scenario we could score", which on the live run was 56
      // of 224. On a both-decline NONE of them gated: our engine priced nothing because it declined, so
      // "LP offers a coupon we do not price" is an artefact of the refusal. `coarseNotEvidence` is
      // counted HERE, in the same loop and under the same skips as the tally itself, so the two numbers
      // reconcile EXACTLY over whatever population the loop sees — a counter drawn from a different
      // population re-creates the puzzle it exists to remove.
      if (r.bothDeclined) declines.coarseNotEvidence += 1;
    }
    for (const rec of (r.rungReconciles || [])) {
      for (const it of (rec.itemized || [])) {
        if (it.deltaMilli === 0) continue;
        byDimension[it.dimension] = (byDimension[it.dimension] || 0) + 1;
        if (r.incomparable) measurement.fromIncomparable.rungRows += 1;
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
  // COMPLETE means every scenario in the battery saw the feed — not "most", and not "at least one".
  // An empty battery is NOT complete: nothing was observed, so nothing can be claimed.
  const declineFeedComplete = list.length > 0 && declineFeedReady === list.length;
  return {
    total: list.length,
    agreed,
    // agreed = agreedPriced + agreedDeclined. A priced agreement means BOTH sides quoted and every
    // itemized LLPA reconciled; a declined agreement means both refused the loan.
    agreedPriced,
    // A declined agreement now means both sides refused the loan AND the per-layer reasons reconciled.
    // Before the reconciler was wired it meant only that both refused, which is a far weaker claim.
    agreedDeclined,
    disagreed,
    incomparable,
    incomparableByReason,
    declines,
    errors,
    comparable,
    agreementRate: comparable ? agreed / comparable : null,
    byCategory,
    measurement,
    vendorSplit,
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
    // What this record does NOT hold, stated in the record. `agreement-store.recordRun` stores this
    // summary whole and stores nothing else, so a reader months later has no way to know that a fuller
    // per-coupon digest ever existed unless the row says so. A cap nobody is told about reads as the
    // whole story — the same rule `disagreementsOmitted` and `dimensionsOmitted` already follow.
    notStored: WHAT_IS_NOT_STORED,
    // ⛔ HOW MUCH OF THE BATTERY COULD SEE A REFUSAL AT ALL (§2.93). `list.length`, not `comparable`:
    // the question is what the RUN was able to observe, and a scenario that errored or went
    // incomparable still had (or lacked) the feed.
    declineFeedReady,
    declineFeedComplete,
    // ⛔ THE GATE NOW REQUIRES THAT THE REFUSALS WERE OBSERVED (§2.93).
    //
    // `--no-disqualify` is a legitimate and useful way to measure PRICE parity, and it stays. What it
    // cannot do is support a verdict about ELIGIBILITY, because the disqualify tree is the only place
    // Lender Price states a refusal. §2.91 already stops the harmless direction — we decline, they
    // seem to price — from being scored as a finding. THIS closes the expensive direction, which
    // nothing could catch: **Lender Price declines and we price**. With the feed off `lpDeclined` is
    // false on every scenario, so that case is not merely unproven, it is UNDETECTABLE — and it is the
    // one where we quote a loan the investor will not buy.
    //
    // So a run that never looked at the refusals cannot pass. The runner's own mis-invocation guard
    // already refuses an unscoped built-in run on exactly this reasoning: a gate that answers
    // confidently when it was asked the wrong question is worse than a gate that refuses.
    gateMet: errors === 0 && disagreed === 0 && comparable > 0 && declineFeedComplete,
  };
}

module.exports = {
  runRatesheetAgreement,
  memoizeLeg,
  runOne,
  summarize,
  ERROR_KIND,
  KNOWN_UNENCODED_FAMILIES,
  DISAGREEMENT_SAMPLE,
  DIMENSION_ROWS_PER_SCENARIO,
  DECLINE_ROWS_PER_SCENARIO,
  REASON_TEXT_MAX,
  WHAT_IS_NOT_STORED,
  _internals: {
    ourAdjustmentsOf, bestRungsOf, matchByRate, disagreementRecord,
    programOf, safeReconcileDeclines, declineOutcome, safeDigest, worstRungOf, declineMismatchRows,
  },
};
