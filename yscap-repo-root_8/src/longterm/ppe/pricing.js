'use strict';
/**
 * LT PPE — the numeric pricing pipeline (MEGA plan §5). PURE: no DB, no network,
 * no config reads — every knob comes in as an argument, so the whole engine is
 * unit-testable offline and a caller (the façade, the parity harness) decides
 * where the numbers come from.
 *
 * THE ONE MENTAL MODEL (§5): almost everything is denominated in PRICE (points),
 * not rate. A rate is CHOSEN (the coupon row); a PRICE is what that rate is
 * worth. `points = 100 − price` (par = 100; one point = 1% of the loan amount).
 * LLPAs move the PRICE. We never invent new rates ("par → base → note rate" is
 * the classic wrong model and is banned).
 *
 * INTEGER BASIS POINTS, NEVER FLOATS (§3). Every price/adjustment is an integer
 * in MILLI-POINTS (thousandths of a point): 102.850 points → 102850; par (100
 * points) → 100000; the 0.250 correspondent margin → 250. This matches
 * settings.js (`price_floor_milli` = 98000, `correspondent_margin_milli` = 250)
 * so the whole system speaks one unit. Summing signed integers stays associative
 * and never drifts — the entire reason floats are refused here.
 *
 * SIGN CONVENTION is the #1 place a reconstruction breaks (§5.2). We use the
 * COST-POSITIVE convention on PRICE throughout:
 *   price = base_price − Σ(signed LLPA) − margin − comp(LPC) + SRP
 * A POSITIVE LLPA is a cost → it LOWERS the price (raises points the borrower
 * pays); a NEGATIVE LLPA is a credit → it RAISES the price. Margin and LPC comp
 * lower the price; SRP (servicing value) raises it. Each adjustment carries its
 * own signed value AND its convention in the trace — we never infer a global
 * sign after the fact.
 *
 * FLOOR/CEILING LAST, ROUND ONCE (§5.2). Adjustments accumulate, then we round
 * ONCE to the declared increment (default 1/8 point = 125 milli), then clamp to
 * [floor, cap] — the clamp is the true last word so a rounded value can never
 * escape its bounds.
 *
 * THE OUTPUT IS THE RECONSTRUCTION RECORD (§5.4) — the crown jewel — not a bare
 * number: base price, the itemized signed adjustment array, margin/SRP/comp as
 * SEPARATE components, the interpolation provenance, and the final price/points.
 * It maps 1:1 onto Lender Price's `priceBuild`, which is exactly what the §10
 * parity harness reconciles against.
 *
 * LT-only. No RTL imports.
 */

const PAR_MILLI = 100000; // 100.000 points, in milli-points
const DEFAULT_ROUNDING_INCREMENT_MILLI = 125; // 1/8 point

// ---- unit helpers -----------------------------------------------------------

// A price/adjustment value must be a finite integer number of milli-points. We
// REFUSE a float outright (the whole discipline is integer bp) rather than
// silently rounding it — a non-integer here means the caller mixed units.
function assertMilli(name, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`pricing:${name}_not_a_number`);
  if (!Number.isInteger(v)) throw new Error(`pricing:${name}_not_an_integer_milli:${v}`);
  return v;
}

// price (milli-points) ↔ points (milli-points, borrower-pays-positive).
// points = par − price. At par price=100000 → 0 points.
function priceToPoints(priceMilli) { return PAR_MILLI - priceMilli; }
function pointsToPrice(pointsMilli) { return PAR_MILLI - pointsMilli; }

// Round to the nearest increment (half-away-from-zero, deterministic — never a
// float-tie surprise), ONCE. increment ≤ 0 disables rounding (used for a raw
// comparison against an upstream engine that rounds itself).
function roundToIncrement(valueMilli, incrementMilli) {
  const inc = Number(incrementMilli) || 0;
  if (inc <= 0) return valueMilli;
  const q = valueMilli / inc;
  const r = q >= 0 ? Math.floor(q + 0.5) : Math.ceil(q - 0.5);
  return r * inc;
}

function clamp(valueMilli, floorMilli, capMilli) {
  let v = valueMilli;
  if (floorMilli != null) v = Math.max(v, floorMilli);
  if (capMilli != null) v = Math.min(v, capMilli);
  return v;
}

// ---- adjustment normalization ----------------------------------------------

// One adjustment as it enters the stack. `adjMilli` is SIGNED and expressed as a
// PRICE delta in milli-points under the cost-positive convention: a positive
// value is a COST that lowers the price. A sheet that publishes an adjustment as
// a POINTS add-on (borrower-pays) is already in this convention; a sheet that
// publishes it as a PRICE add-on has the opposite sign, so the caller states
// `unit` and we normalize — but we ALWAYS retain the original in the trace.
//
//   { code, category, adjMilli, unit?: 'points'|'price', reason?, sourceValue?,
//     dimension?, cumulative?: true }
//
// unit 'points' (default): adjMilli is already a signed cost in points → a
//   positive value subtracts from price. Stored cost = +adjMilli.
// unit 'price': adjMilli is a signed PRICE delta → a positive value RAISES price
//   (a credit) → cost = −adjMilli.
function normalizeAdjustment(a, index) {
  if (!a || typeof a !== 'object') throw new Error(`pricing:adjustment_${index}_not_an_object`);
  assertMilli(`adjustment_${index}`, a.adjMilli);
  const unit = a.unit || 'points';
  if (unit !== 'points' && unit !== 'price') throw new Error(`pricing:adjustment_${index}_bad_unit:${unit}`);
  // costMilli: the effect on POINTS (cost-positive). Adding costMilli to points
  // is the same as subtracting it from price.
  const costMilli = unit === 'points' ? a.adjMilli : -a.adjMilli;
  return {
    code: a.code || null,
    category: a.category || a.dimension || 'other',
    dimension: a.dimension || null,
    reason: a.reason || a.code || a.category || 'adjustment',
    unit,
    // the value as the sheet published it, verbatim (never inferred) —
    sourceMilli: a.adjMilli,
    // the normalized effect used by the pipeline —
    costMilli,
    cumulative: a.cumulative !== false,
  };
}

// ---- rate-axis interpolation (§5.1) ----------------------------------------

// Between two priced coupon rungs the PRICE is a linear blend by rate distance.
// Grid CELLS are step functions (never interpolated) — only this rate↔price axis
// interpolates. Provenance is recorded so a between-rung quote is reproducible.
//
// low/high: { rate, priceMilli }. targetRate lies within [low.rate, high.rate].
function interpolatePrice(low, high, targetRate) {
  if (!low || !high) throw new Error('pricing:interpolate_missing_rung');
  const lr = Number(low.rate);
  const hr = Number(high.rate);
  const tr = Number(targetRate);
  if (![lr, hr, tr].every(Number.isFinite)) throw new Error('pricing:interpolate_bad_rate');
  if (lr === hr) return { priceMilli: assertMilli('interp', low.priceMilli), weight: 0, low, high };
  // clamp target into the bracket so a caller can't extrapolate off the ladder
  const t = Math.min(Math.max((tr - lr) / (hr - lr), 0), 1);
  const p = Math.round(low.priceMilli + (high.priceMilli - low.priceMilli) * t);
  return { priceMilli: p, weight: t, low, high };
}

// ---- the pipeline -----------------------------------------------------------

/**
 * Price ONE rung and return the full reconstruction record (§5.4).
 *
 * input:
 *   basePriceMilli   — Layer 1: the grid cell for this coupon/lock (par = 100000)
 *   rate             — the chosen coupon (carried through; used only as a label +
 *                      for interpolation distance). Caller's own scale.
 *   adjustments[]    — Layer 2: the itemized signed LLPA stack (see normalizeAdjustment)
 *   marginMilli      — Layer 4: corporate margin (the 0.25 rule = 250; a SETTING,
 *                      never hardcoded here — the caller resolves it)
 *   srpMilli         — Layer 3: optional servicing value (raises price). default 0
 *   compMilli        — Layer 5: LPC comp (lowers price); BPC passes 0. default 0
 *   floorMilli       — price floor (default 98000). null disables
 *   capMilli         — price ceiling for the loan-size tier. null disables
 *   roundingIncrementMilli — default 125 (1/8 pt). 0 disables (raw compare)
 *   interpolation    — optional provenance object from interpolatePrice()
 *   context          — optional passthrough bag echoed into the record (fico, ltv…)
 *
 * The math (cost-positive, on price, in milli-points):
 *   rawPrice = basePrice − Σ costMilli − margin − comp + srp
 *   rounded  = roundOnce(rawPrice)
 *   final    = clamp(rounded, floor, cap)          # floor/ceiling is the LAST word
 *   points   = par − final
 */
function priceRung(input) {
  if (!input || typeof input !== 'object') throw new Error('pricing:no_input');
  const basePriceMilli = assertMilli('base_price', input.basePriceMilli);
  const marginMilli = assertMilli('margin', input.marginMilli || 0);
  const srpMilli = assertMilli('srp', input.srpMilli || 0);
  const compMilli = assertMilli('comp', input.compMilli || 0);
  const roundingIncrementMilli = input.roundingIncrementMilli == null
    ? DEFAULT_ROUNDING_INCREMENT_MILLI
    : assertMilli('rounding_increment', input.roundingIncrementMilli);
  const floorMilli = input.floorMilli == null ? null : assertMilli('floor', input.floorMilli);
  const capMilli = input.capMilli == null ? null : assertMilli('cap', input.capMilli);

  const rawAdjustments = Array.isArray(input.adjustments) ? input.adjustments : [];
  const adjustments = rawAdjustments.map(normalizeAdjustment);
  const adjustmentCostMilli = adjustments.reduce((s, a) => s + a.costMilli, 0);

  // On PRICE (cost-positive): a cost lowers the price.
  const rawPriceMilli = basePriceMilli - adjustmentCostMilli - marginMilli - compMilli + srpMilli;
  const roundedPriceMilli = roundToIncrement(rawPriceMilli, roundingIncrementMilli);
  const finalPriceMilli = clamp(roundedPriceMilli, floorMilli, capMilli);
  const clamped = finalPriceMilli !== roundedPriceMilli;

  return {
    // pinned inputs (reproducibility) —
    rate: input.rate == null ? null : input.rate,
    context: input.context || null,
    interpolation: input.interpolation || null,
    // Layer 1 —
    basePriceMilli,
    basePointsMilli: priceToPoints(basePriceMilli),
    // Layer 2 — itemized, verbatim + normalized —
    adjustments,
    adjustmentCostMilli,
    adjustmentPointsMilli: adjustmentCostMilli, // (points are cost-positive too)
    // Layers 3–5 — separate components, never folded silently —
    srpMilli,
    marginMilli,
    compMilli,
    // the result —
    rawPriceMilli,
    roundedPriceMilli,
    roundingIncrementMilli,
    finalPriceMilli,
    finalPointsMilli: priceToPoints(finalPriceMilli),
    floorMilli,
    capMilli,
    clamped,
  };
}

/**
 * Price a whole coupon LADDER: one reconstruction record per rung, so the
 * LO/borrower can pay points for a lower rate or take a credit for a higher one.
 * `common` supplies the shared knobs (margin, srp, comp, floor, cap, rounding);
 * each rung supplies its own basePriceMilli, rate, and adjustments[].
 */
function priceLadder(rungs, common) {
  if (!Array.isArray(rungs)) throw new Error('pricing:ladder_not_an_array');
  const c = common || {};
  return rungs.map((r) => priceRung({
    ...c,
    basePriceMilli: r.basePriceMilli,
    rate: r.rate,
    adjustments: r.adjustments || c.adjustments || [],
    context: r.context || c.context || null,
    interpolation: r.interpolation || null,
  }));
}

module.exports = {
  PAR_MILLI,
  DEFAULT_ROUNDING_INCREMENT_MILLI,
  priceToPoints,
  pointsToPrice,
  roundToIncrement,
  clamp,
  normalizeAdjustment,
  interpolatePrice,
  priceRung,
  priceLadder,
};
