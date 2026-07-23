'use strict';
/**
 * R6.6 — Independent structure underwriter (deterministic core).
 *
 * The frozen pricing engine SIZES the loan; this INDEPENDENTLY recomputes the
 * leverage ratios + cash-to-close from the registered structure and compares
 * them to the program caps, producing a calculation LEDGER (formula, numerator,
 * denominator, result, cap, pass/fail, binding) + a breach classification.
 *
 * HARD RULE: this changes NO engine number. It VERIFIES the math the engine
 * already did — a mismatch means an input changed after pricing or the quote
 * was built on stale inputs, which is a finding, not a re-price. The engine's
 * caps (from the registered quote) are the inputs here; the ratios are checked,
 * not re-derived from a matrix.
 *
 * A cap breach is classified by SEVERITY so a non-waivable limit is never
 * treated as a mere warning (the audit's requirement):
 *   hard_ineligible     a non-waivable cap exceeded
 *   manual_review       a cap that requires credit/super-admin review
 *   approvable_exception a cap exceeded but eligible for a documented exception
 *   warning             informational, near a limit
 *   pass                within the cap
 *
 * Pure: no DB, no AI. Missing inputs yield a null ratio (never a divide-by-zero
 * or a fabricated 0), surfaced as an incomplete calculation.
 */

const round = (n, dp = 4) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);

// A safe ratio: null when either side is missing or the denominator is 0.
function ratio(numerator, denominator) {
  // Null/blank guards FIRST (fix 2026-07-23): Number(null)===0 is finite, so a
  // missing numerator used to fabricate a PASSING 0.00 ratio on the ledger
  // instead of the contract's null/incomplete.
  if (numerator == null || numerator === '' || denominator == null || denominator === '') return null;
  const n = Number(numerator), d = Number(denominator);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
  return round(n / d);
}
// Null-safe number: null/blank -> null (never a fabricated 0).
function nnum(v) { return (v == null || v === '' || !Number.isFinite(Number(v))) ? null : Number(v); }

/**
 * computeRatios(s) — s: the registered structure (whole dollars):
 *   { totalLoan, initialAdvance, rehabHoldback, recognizedPurchasePrice,
 *     asIsValue, arv, rehabBudget, costBasis }
 * Returns the standard leverage ratios (null when an input is missing).
 *   acquisitionLtv = initialAdvance / recognizedPurchasePrice
 *   asIsLtv        = initialAdvance / asIsValue
 *   ltc            = totalLoan / costBasis   (costBasis = purchase + rehab)
 *   arvLtv         = totalLoan / arv
 */
function computeRatios(s) {
  s = s || {};
  // Fix 2026-07-23: a NULL costBasis (typical DB row) coerced to 0 and BLOCKED
  // the purchase+rehab fallback; a NULL rehabBudget added +0 to the basis.
  const costBasis = nnum(s.costBasis) != null ? nnum(s.costBasis)
    : (nnum(s.recognizedPurchasePrice) != null && nnum(s.rehabBudget) != null
      ? nnum(s.recognizedPurchasePrice) + nnum(s.rehabBudget) : null);
  return {
    acquisitionLtv: ratio(s.initialAdvance, s.recognizedPurchasePrice),
    asIsLtv: ratio(s.initialAdvance, s.asIsValue),
    ltc: ratio(s.totalLoan, costBasis),
    arvLtv: ratio(s.totalLoan, s.arv),
    costBasis,
  };
}

// Classify a cap breach. `overage` is result - cap (positive = over).
function classifyBreach(result, cap, opts = {}) {
  if (result == null || cap == null) return 'incomplete';
  // Tolerance: a rounding wisp over the cap is a pass (0.05% of the cap).
  const tol = Math.abs(cap) * 0.0005;
  if (result <= cap + tol) return 'pass';
  // Over the cap → severity by waivability.
  if (opts.nonWaivable) return 'hard_ineligible';
  if (opts.exceptionAllowed) return 'approvable_exception';
  if (opts.manualReview) return 'manual_review';
  // Default for an over-cap with no waiver policy = manual review (never a
  // silent warning — the audit's rule).
  return 'manual_review';
}

/**
 * ledger(structure, caps) → [{metric, formula, numerator, denominator, result,
 *   cap, passed, severity, binding}]. `caps` from the registered quote:
 *   { maxAcquisitionLtv, maxAsIsLtv?, maxLtc, maxArvLtv, capPolicy?:{acqLtv:{nonWaivable?},…} }
 * The BINDING constraint is the one closest to (or over) its cap.
 */
function ledger(structure, caps) {
  const r = computeRatios(structure);
  const c = caps || {};
  const s = structure || {};
  const policy = c.capPolicy || {};
  const rows = [
    row('acquisition_ltv', 'initialAdvance / recognizedPurchasePrice', s.initialAdvance, s.recognizedPurchasePrice, r.acquisitionLtv, c.maxAcquisitionLtv, policy.acqLtv),
    row('as_is_ltv', 'initialAdvance / asIsValue', s.initialAdvance, s.asIsValue, r.asIsLtv, c.maxAsIsLtv, policy.asIsLtv),
    row('ltc', 'totalLoan / costBasis', s.totalLoan, r.costBasis, r.ltc, c.maxLtc, policy.ltc),
    row('arv_ltv', 'totalLoan / arv', s.totalLoan, s.arv, r.arvLtv, c.maxArvLtv, policy.arvLtv),
  ];
  // Binding = the row with the smallest headroom (cap - result), among those
  // with both a result and a cap; a breach always binds.
  let binding = null, bestHeadroom = Infinity;
  for (const row of rows) {
    if (row.result == null || row.cap == null) continue;
    const headroom = row.cap - row.result;
    if (headroom < bestHeadroom) { bestHeadroom = headroom; binding = row.metric; }
  }
  for (const row of rows) row.binding = (row.metric === binding);
  return rows;
}

function row(metric, formula, numerator, denominator, result, cap, policy) {
  const p = policy || {};
  const severity = classifyBreach(result, cap == null ? null : Number(cap), p);
  return {
    metric, formula,
    numerator: numerator == null ? null : Number(numerator),
    denominator: denominator == null ? null : Number(denominator),
    result, cap: cap == null ? null : Number(cap),
    passed: severity === 'pass',
    severity,
    binding: false,
  };
}

// Compare the independently-computed figures to the registered quote's reported
// figures — a material difference means the quote is stale/miscomputed.
function compareToRegistered(computed, registeredRatios, tolerance = 0.005) {
  const diffs = [];
  for (const key of ['acquisitionLtv', 'asIsLtv', 'ltc', 'arvLtv']) {
    const a = computed && computed[key];
    const b = registeredRatios && registeredRatios[key];
    if (a == null || b == null) continue;
    if (Math.abs(a - b) > tolerance) diffs.push({ metric: key, computed: a, registered: b });
  }
  return diffs;
}

module.exports = { computeRatios, classifyBreach, ledger, compareToRegistered, ratio };
