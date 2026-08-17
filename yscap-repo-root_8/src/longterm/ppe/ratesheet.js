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

// One stored INELIGIBILITY row (an N/A grid box, or an explicit decline predicate) → an eligibility
// rule for rules.js. Same band→predicate construction as adjustmentToRule, but kind 'eligibility' with
// a declineReason. A row with NO predicate (every band open) would decline EVERYTHING, which is never
// what an N/A box means — it is dropped (returns null) rather than silently rejecting the whole sheet.
function ineligibilityToRule(a) {
  if (!a || typeof a !== 'object') throw new Error('ratesheet:bad_ineligibility');
  const leaves = [];
  const pf = bandPredicate('fico', a.fico_min, a.fico_max); if (pf) leaves.push(pf);
  const pl = bandPredicate('ltv', a.ltv_min, a.ltv_max); if (pl) leaves.push(pl);
  const pd = bandPredicate('dscr', a.dscr_min, a.dscr_max); if (pd) leaves.push(pd);
  if (a.predicate) leaves.push(a.predicate);
  if (leaves.length === 0) return null; // a fully-open ineligibility is a bug, not "decline all"
  const when = leaves.length === 1 ? leaves[0] : { all: leaves };
  return {
    code: a.code || null,
    kind: 'eligibility',
    source: 'base',
    when,
    priority: a.priority || 0,
    declineReason: a.declineReason || a.reason || `Not eligible (${a.dimension || 'grid'})`,
  };
}

// A loaded sheet → the `program` object quoteProgram() expects.
//   meta: { code, name, investorCode } — identity carried onto the quote.

// Settings vocabulary -> pricer vocabulary, delegating to quote.resolveRounding so
// there is exactly one mapping table. Returns {mode, incrementMilli}; `mode`
// undefined means "the sheet says nothing, let the settings decide".
// Required lazily: quote.js requires nothing from here, but keeping the require at
// call time makes the direction of the dependency obvious and cycle-proof.
const PRICER_MODES = new Set(['nearest', 'up', 'down', 'half_even', 'none']);
function translateRoundingMode(raw, incrementMilli) {
  const incr = incrementMilli == null ? undefined : incrementMilli;
  if (raw == null || raw === '') return { mode: undefined, incrementMilli: incr };
  if (PRICER_MODES.has(raw)) return { mode: raw, incrementMilli: incr };
  try {
    const { resolveRounding } = require('./quote');
    const r = resolveRounding({ 'pricing.rounding_mode': raw, 'pricing.rounding_increment_milli': incr });
    return { mode: r.mode, incrementMilli: r.incrementMilli };
  } catch (_) {
    // Not a mode either vocabulary knows. Pass it through UNCHANGED so the pricer
    // refuses it by name; silently substituting a default would round every price
    // on this sheet by a rule nobody selected.
    return { mode: raw, incrementMilli: incr };
  }
}

function rateSheetToProgram(sheet, meta = {}) {
  if (!sheet || !Array.isArray(sheet.basePrices)) throw new Error('ratesheet:no_sheet');
  const baseGrid = sheet.basePrices.map((bp) => ({
    rate: bp.note_rate_milli_pct,
    lockDays: bp.lock_days,
    product: bp.product || '',
    basePriceMilli: bp.price_milli,
  }));
  const rules = (sheet.adjustments || []).map(adjustmentToRule)
    .concat((sheet.ineligibilities || []).map(ineligibilityToRule).filter(Boolean));
  const pl = sheet.priceLimit;
  // ROUNDING MODE IS TWO VOCABULARIES, AND THE COLUMN SPEAKS THE OTHER ONE.
  // `lt_ppe_price_limit.rounding_mode` is declared `NOT NULL DEFAULT 'nearest_eighth'`
  // (db/560) with no CHECK — that is the SETTINGS vocabulary. The pricer accepts only
  // `nearest|up|down|half_even|none` (`pricing.roundPrice`), and `quote.js` lets a
  // sheet's own mode WIN over `resolveRounding`, which is the only thing that
  // translates between the two. So a price-limit row created at the schema default
  // produced a program that passed every precondition and then threw
  // `pricing:bad_rounding_mode:nearest_eighth` inside `quoteProgram` — which the
  // shadow facade faithfully records as an `engine_error` finding on EVERY quote.
  // Found by the re-audit; missed by every fixture, which all use `'none'` (the one
  // token both vocabularies share) or no price-limit row at all.
  //
  // Translated HERE because this is the ONE place a stored sheet becomes a program,
  // and the mapping table is `resolveRounding`'s own — imported rather than copied,
  // so the two can never drift. A mode already in the pricer's vocabulary passes
  // through untouched; an unrecognized one is left alone so the pricer still refuses
  // it loudly rather than being silently "corrected" to a rounding nobody chose.
  const rounding = pl ? translateRoundingMode(pl.rounding_mode, pl.rounding_increment_milli) : null;
  const priceLimit = pl ? {
    floorMilli: pl.min_price_milli == null ? null : pl.min_price_milli,
    roundingMode: rounding.mode,
    roundingIncrementMilli: rounding.incrementMilli,
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

module.exports = { bandPredicate, adjustmentToRule, ineligibilityToRule, rateSheetToProgram, translateRoundingMode };
