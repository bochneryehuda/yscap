'use strict';
/**
 * LT PPE — rate-sheet → engine bridge (MEGA plan §3/§5). PURE: maps a LOADED DB rate sheet
 * (store.loadRateSheet: { version, basePrices[], adjustments[], priceLimit }) into the `program`
 * shape the quote façade (quote.js) prices — a base-price grid + a rule set + price limits. No DB,
 * no network; the store does the IO, this does the shape.
 *
 * The stored adjustment ROWS carry half-open [min,max) integer bands (fico/ltv/dscr) + an open-ended
 * `predicate` jsonb; each becomes a PRICING rule whose `when` is the AND of its present bands + the
 * predicate, and whose adjustment is the signed milli-point value (with its unit/sign/dimension kept
 * verbatim). Eligibility/bound rules live in a later rule table; adjustments are pricing-only here.
 *
 * LT-only. No RTL imports.
 */

// A half-open [min,max) band → a rules.js predicate leaf. Either bound may be absent (open-ended).
function bandPredicate(fact, min, max) {
  if (min != null && max != null) return { fact, op: 'between', value: [min, max] }; // [min,max)
  if (min != null) return { fact, op: 'gte', value: min };
  if (max != null) return { fact, op: 'lt', value: max };
  return null;
}

// One stored adjustment row → a pricing rule for rules.js.
function adjustmentToRule(a) {
  if (!a || typeof a !== 'object') throw new Error('ratesheet:bad_adjustment');
  const leaves = [];
  const pf = bandPredicate('fico', a.fico_min, a.fico_max); if (pf) leaves.push(pf);
  const pl = bandPredicate('ltv', a.ltv_min, a.ltv_max); if (pl) leaves.push(pl);
  const pd = bandPredicate('dscr', a.dscr_min, a.dscr_max); if (pd) leaves.push(pd);
  if (a.predicate) leaves.push(a.predicate); // the open-ended long tail (already a predicate tree)
  const when = leaves.length === 0 ? null : (leaves.length === 1 ? leaves[0] : { all: leaves });
  return {
    code: a.code || null,
    kind: 'pricing',
    source: 'base',
    when,
    priority: a.priority || 0,
    adjustment: {
      code: a.code || null,
      category: a.dimension || 'other',
      dimension: a.dimension || null,
      adjMilli: a.adj_milli,
      unit: a.unit || 'points',
      reason: a.reason || a.dimension || 'adjustment',
      cumulative: a.cumulative !== false,
    },
  };
}

// A loaded sheet → the `program` object quoteProgram() expects.
//   meta: { code, name, investorCode } — identity carried onto the quote.
function rateSheetToProgram(sheet, meta = {}) {
  if (!sheet || !Array.isArray(sheet.basePrices)) throw new Error('ratesheet:no_sheet');
  const baseGrid = sheet.basePrices.map((bp) => ({
    rate: bp.note_rate_milli_pct,
    lockDays: bp.lock_days,
    product: bp.product || '',
    basePriceMilli: bp.price_milli,
  }));
  const rules = (sheet.adjustments || []).map(adjustmentToRule);
  const pl = sheet.priceLimit;
  const priceLimit = pl ? {
    floorMilli: pl.min_price_milli == null ? null : pl.min_price_milli,
    roundingMode: pl.rounding_mode || undefined,
    roundingIncrementMilli: pl.rounding_increment_milli == null ? undefined : pl.rounding_increment_milli,
    capTiers: Array.isArray(pl.cap_tiers) ? pl.cap_tiers : [],
  } : undefined;
  return {
    code: meta.code || (sheet.version && sheet.version.id) || null,
    name: meta.name || null,
    investorCode: meta.investorCode || null,
    rules,
    baseGrid,
    priceLimit,
  };
}

module.exports = { bandPredicate, adjustmentToRule, rateSheetToProgram };
