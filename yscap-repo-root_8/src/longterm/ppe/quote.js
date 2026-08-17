'use strict';
/**
 * LT PPE — the quote façade (MEGA plan §5 + §9.2). PURE: no DB, no network. It
 * composes the two engine cores — the rules evaluator (rules.js) and the numeric
 * pricing pipeline (pricing.js) — into ONE call that prices a program for a
 * scenario and returns either a structured ineligible result (reasons, never
 * dropped) or an eligible priced LADDER with a full reconstruction record per
 * rung.
 *
 * WHERE THE KNOBS COME FROM (Rule #1): every pricing knob — margin, rounding
 * mode + increment, price floor, loan-size price cap, cumulative-adjustment cap
 * — is resolved from the RESOLVED SETTINGS MAP the caller passes in (the output
 * of settings.resolveAll(...).values). Nothing is hardcoded here; a program's
 * own `priceLimit` may override the floor/cap/rounding for that program, and the
 * settings supply the tenant default. So the same façade prices any tenant's any
 * program with zero code change.
 *
 * THE SHAPE (all pure data):
 *   scenario  — a flat bag of facts: { fico, ltv, cltv, dscr, loan_amount, state,
 *               occupancy, property_type, units, purpose, prepay, lock_days,
 *               term, io, product, ... }. FICO/LTV/DSCR in the same integer units
 *               the rules use (ltv in milli-percent, dscr in milli, etc. — the
 *               façade does not interpret them, the rules do).
 *   program   — { code, name, investorCode?, rules[], baseGrid[], priceLimit? }
 *               baseGrid: [{ rate, lockDays, product?, basePriceMilli }]
 *               priceLimit?: { floorMilli?, capTiers?:[{uptoLoanAmount, capMilli}],
 *                              roundingMode?, roundingIncrementMilli? }
 *   settings  — a resolved { key: value } map (settings.resolveAll(...).values)
 *
 * LT-only. No RTL imports.
 */

const { evaluateRules } = require('./rules');
const pricing = require('./pricing');

// Map a settings `pricing.rounding_mode` enum + increment into the pricing
// pipeline's { mode, incrementMilli }. Single definition so the settings enum
// and the engine can never drift.
function resolveRounding(settings) {
  const s = settings || {};
  const mode = s['pricing.rounding_mode'] || 'nearest_eighth';
  const incr = s['pricing.rounding_increment_milli'];
  switch (mode) {
    case 'none': return { mode: 'none', incrementMilli: 0 };
    case 'nearest_eighth': return { mode: 'nearest', incrementMilli: 125 };
    case 'nearest_increment': return { mode: 'nearest', incrementMilli: incr == null ? 125 : incr };
    case 'up': return { mode: 'up', incrementMilli: incr == null ? 125 : incr };
    case 'down': return { mode: 'down', incrementMilli: incr == null ? 125 : incr };
    case 'half_even': return { mode: 'half_even', incrementMilli: incr == null ? 125 : incr };
    default: throw new Error(`quote:unknown_rounding_mode:${mode}`);
  }
}

// Pick the price cap for a loan amount from a program's ascending tier list.
// A tier {uptoLoanAmount, capMilli} caps loans AT OR BELOW uptoLoanAmount; the
// first tier the amount fits under wins. No tiers / no amount → no cap (null).
function capForLoanAmount(capTiers, loanAmount) {
  if (!Array.isArray(capTiers) || !capTiers.length || loanAmount == null) return null;
  const sorted = capTiers.slice().sort((a, b) => Number(a.uptoLoanAmount) - Number(b.uptoLoanAmount));
  for (const t of sorted) {
    if (loanAmount <= Number(t.uptoLoanAmount)) return t.capMilli;
  }
  return null; // above every tier → uncapped (or the program should decline it via a bound)
}

// Which base-grid rungs apply to this scenario: filter by lock_days and product
// when the scenario names them; otherwise price the whole ladder.
function selectRungs(baseGrid, scenario) {
  const grid = Array.isArray(baseGrid) ? baseGrid : [];
  return grid.filter((r) => {
    if (scenario.lock_days != null && r.lockDays != null && r.lockDays !== scenario.lock_days) return false;
    if (scenario.product != null && r.product != null && r.product !== scenario.product) return false;
    return true;
  });
}

/**
 * Price a program for a scenario. Returns:
 *   ineligible → { eligible:false, program, declines[], bounds, trace, unknownFacts }
 *   eligible   → { eligible:true, program, ladder[<reconstruction record>],
 *                  bounds, trace, unknownFacts, pricingBasis }
 * `severityOf(decline)` (optional) lets a soft finding not decline (settings
 * eligibility.result_mode drives this at the caller).
 */
function quoteProgram(arg, opts) {
  const { scenario, program, settings } = arg || {};
  if (!scenario || typeof scenario !== 'object') throw new Error('quote:no_scenario');
  if (!program || typeof program !== 'object') throw new Error('quote:no_program');
  if (!Array.isArray(program.baseGrid) || !program.baseGrid.length) throw new Error('quote:program_has_no_base_grid');
  const s = settings || {};
  const programRef = { code: program.code || null, name: program.name || null, investorCode: program.investorCode || null };

  // 1) eligibility + bounds + accumulated LLPAs
  const decision = evaluateRules(program.rules || [], scenario, opts);
  if (!decision.eligible) {
    return {
      eligible: false,
      program: programRef,
      declines: decision.declines,
      bounds: decision.bounds,
      trace: decision.trace,
      unknownFacts: decision.unknownFacts,
    };
  }

  // 2) resolve the pricing basis (settings, program overrides win)
  const pl = program.priceLimit || {};
  // MARGIN precedence (Layer 2, additive): a per-investor/per-scenario resolved margin
  // (the shape store.resolveMarginHoldbackForInvestor / margin-holdback.resolveMarginHoldback
  // returns) wins when the caller passes it; otherwise the legacy settings margin. When no
  // marginHoldback is passed this is BYTE-IDENTICAL to before (proven in test-lt-ppe-quote).
  const mh = arg.marginHoldback;
  const mhMargin = mh && typeof mh.marginMilli === 'number' && Number.isInteger(mh.marginMilli) && mh.marginMilli >= 0
    ? mh.marginMilli : null;
  const margin = mhMargin != null ? mhMargin : s['pricing.correspondent_margin_milli'];
  const marginMilli = margin == null ? 0 : margin;
  // HOLDBACK is CARRIED for the reconstruction record only — it is NOT applied to price.
  // How holdback combines into the final borrower rate is a MONEY rule that needs the owner's
  // exact formula (never guessed) — see docs/longterm/PPE-MARGIN-HOLDBACK-PLAN.md §5 Layer 3.
  const holdbackMilli = mh && typeof mh.holdbackMilli === 'number' && Number.isInteger(mh.holdbackMilli) && mh.holdbackMilli >= 0
    ? mh.holdbackMilli : null;
  const marginSource = mhMargin != null ? (mh.marginSource || 'resolved') : 'settings';
  const rounding = resolveRounding(s);
  const roundingMode = pl.roundingMode || rounding.mode;
  const roundingIncrementMilli = pl.roundingIncrementMilli == null ? rounding.incrementMilli : pl.roundingIncrementMilli;
  const floorMilli = pl.floorMilli == null ? (s['pricing.price_floor_milli'] == null ? null : s['pricing.price_floor_milli']) : pl.floorMilli;
  const capMilli = capForLoanAmount(pl.capTiers, scenario.loan_amount);
  const cumulativeAdjustmentCapMilli = s['pricing.cumulative_adjustment_cap_milli'] == null ? null : s['pricing.cumulative_adjustment_cap_milli'];

  // the scenario-level LLPA stack applies to EVERY rung (the coupon axis is the
  // rung; the FICO×LTV/DSCR grid cells etc. are already resolved into these
  // accumulated adjustments by the rules evaluator).
  const adjustments = decision.adjustments;

  const common = {
    adjustments,
    marginMilli,
    roundingMode,
    roundingIncrementMilli,
    floorMilli,
    capMilli,
    cumulativeAdjustmentCapMilli,
  };

  const rungs = selectRungs(program.baseGrid, scenario).map((r) => ({
    rate: r.rate,
    basePriceMilli: r.basePriceMilli,
    context: { lockDays: r.lockDays, product: r.product || null },
  }));

  const ladder = pricing.priceLadder(rungs, common);

  return {
    eligible: true,
    program: programRef,
    ladder,
    bounds: decision.bounds,
    trace: decision.trace,
    unknownFacts: decision.unknownFacts,
    pricingBasis: {
      marginMilli,
      marginSource,
      holdbackMilli, // carried for the reconstruction record; NOT applied to price (money rule pending owner)
      roundingMode,
      roundingIncrementMilli,
      floorMilli,
      capMilli,
      cumulativeAdjustmentCapMilli,
      rungCount: ladder.length,
    },
  };
}

module.exports = {
  resolveRounding,
  capForLoanAmount,
  selectRungs,
  quoteProgram,
};
