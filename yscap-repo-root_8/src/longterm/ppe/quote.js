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
 * THE SHEET'S OWN MAX-PRICE RULE IS ANSWERED, NEVER ASSUMED. `price-limit.js` is
 * the ONE door: it runs the sheet's per-scenario ceiling rule (where that sheet
 * has one — the Deephaven DSCR sheet combines a loan-amount tier with a
 * prepay-term ceiling and takes the lower) and it resolves the stored tier list
 * into the number the pricer clamps with, always saying WHICH state it is in.
 * Every result — eligible or not — carries a `priceLimit` block. A ceiling that
 * cannot be read, and a registered rule that cannot be evaluated, DECLINE the
 * quote rather than pricing past a limit we cannot see.
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
const { resolveDoubleCharges } = require('./adjustment-overlap');

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

// THE PRICE LIMIT IS RESOLVED IN ONE PLACE — `price-limit.js`. `capForLoanAmount` is
// re-exported here (it is the RAW tier lookup and several callers already import it
// from this module) but the façade itself never calls it: it goes through
// `resolvePriceCap`, which is the only thing that can tell "no ceiling on this sheet"
// apart from "we could not read this sheet's ceiling".
const priceLimitLib = require('./price-limit');
const { capForLoanAmount, resolvePriceCap, applyScenarioPriceLimit } = priceLimitLib;

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

  // 0) THE SHEET'S OWN MAX-PRICE RULE, resolved FIRST so every branch below reports it.
  //    A sheet whose ceiling depends on a SCENARIO fact (the Deephaven DSCR sheet takes the
  //    LOWER of a loan-amount tier and a prepay-term ceiling) cannot state that ceiling in a
  //    stored tier list, so its own rule is run here — through `price-limit.js`, which is the
  //    single door and holds no copy of any ceiling. This is the ONE chokepoint: every
  //    production caller of `quoteProgram` (the /quote route, the canary, the scheduled
  //    canary, the agreement run, the breakdown) is covered by it and none of them needs to
  //    know the rule exists.
  const limited = applyScenarioPriceLimit(program, scenario, arg.priceLimitOpts);
  const priceLimitProgram = limited.program;
  const capRes = resolvePriceCap(priceLimitProgram.priceLimit, scenario.loan_amount);
  const priceLimit = {
    ...capRes,
    rule: limited.rule,
    ruleSheet: limited.sheet,
    ruleReason: limited.reason,
    ruleDetail: limited.detail,
  };

  // FAIL CLOSED, LOUDLY, in the two states where a ceiling exists and cannot be seen: the
  // sheet's own rule could not be evaluated, or its tiers could not be read. Falling back to
  // whatever tiers happen to be stored is exactly the over-quote this exists to stop — those
  // tiers are the HIGHER ceiling. This is NOT routed through `opts.severityOf`: an unreadable
  // ceiling can never be a soft finding.
  if (!limited.usable || !capRes.readable) {
    const detail = !limited.usable ? limited.detail : capRes.detail;
    return {
      eligible: false,
      program: programRef,
      declines: [{ code: 'price_limit_unreadable', reason: detail, source: 'price_limit', bound: false }],
      bounds: {},
      trace: [],
      unknownFacts: [],
      priceLimit,
    };
  }

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
      problems: [], // nothing was priced, so nothing could be double-charged
      priceLimit,
    };
  }

  // 2) resolve the pricing basis (settings, program overrides win)
  const pl = priceLimitProgram.priceLimit || {};
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
  const floorSource = pl.floorMilli != null ? 'sheet' : (s['pricing.price_floor_milli'] != null ? 'settings' : 'none');
  // ONE source for the ceiling — the resolution taken at the top of this function. Never
  // re-derive it here: a second derivation is how the number we clamp with and the state we
  // report drift apart.
  const capMilli = capRes.capMilli;
  const cumulativeAdjustmentCapMilli = s['pricing.cumulative_adjustment_cap_milli'] == null ? null : s['pricing.cumulative_adjustment_cap_milli'];

  // the scenario-level LLPA stack applies to EVERY rung (the coupon axis is the
  // rung; the FICO×LTV/DSCR grid cells etc. are already resolved into these
  // accumulated adjustments by the rules evaluator).
  //
  // DOUBLE-CHARGE GUARD (adjustment-overlap.js). Pricing rules ACCUMULATE, so two rules covering one
  // loan on one dimension — two overlapping DSCR blocks, or the same row pasted twice — charge the
  // borrower twice, silently. This is the ONE place a fired rule becomes money, so it is the one place
  // that decides: the collision is detected by `rule-coverage.analyzeRuleSet` (never a second
  // definition), the LEAST COSTLY of the colliding adjustments is applied once, the rest are
  // suppressed, and every collision comes back on `problems[]` in plain words naming both rules. It is
  // never silent, and it never refuses to quote — see that module's header for why, and for the open
  // question it records for the sheet's owner.
  const collision = resolveDoubleCharges(decision.matchedPricingRules, decision.adjustments);
  const adjustments = collision.adjustments;

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
    // Never silent: empty on a clean sheet, and on a colliding one it names the two rules, the band
    // they collide across, and which one was applied.
    problems: collision.problems,
    suppressedAdjustments: collision.suppressed,
    priceLimit,
    pricingBasis: {
      marginMilli,
      marginSource,
      holdbackMilli, // carried for the reconstruction record; NOT applied to price (money rule pending owner)
      roundingMode,
      roundingIncrementMilli,
      floorMilli,
      floorSource,
      capMilli,
      capStatus: priceLimit.status,
      capApplied: priceLimit.capApplied,
      capAssumption: priceLimit.assumption,
      capRule: priceLimit.rule,
      cumulativeAdjustmentCapMilli,
      rungCount: ladder.length,
    },
  };
}

module.exports = {
  resolveRounding,
  capForLoanAmount,
  resolvePriceCap,
  applyScenarioPriceLimit,
  priceLimitNotice: priceLimitLib.priceLimitNotice,
  selectRungs,
  quoteProgram,
};
