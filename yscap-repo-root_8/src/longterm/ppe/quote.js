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
const purpose = require('./purpose');
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

// ---- which scenario facts the PRICING BASIS itself reads --------------------
//
// The rules evaluator derives its own price-bearing facts from the rule set (a
// pricing rule names the facts its predicate reads — rules.factsOf). But not
// every price-bearing fact travels through a rule: the loan-size PRICE CAP is a
// program `priceLimit`, and it reads `loan_amount` STRAIGHT off the scenario. A
// missing `loan_amount` therefore left the ladder UNCAPPED with nothing recorded
// anywhere — `unknownFacts` did not even mention it, because no predicate had
// touched it.
//
// So the basis declares its own scenario dependencies HERE, once, and the basis
// resolution below READS the fact through this table rather than naming it a
// second time — one definition, not a parallel list. `active(priceLimit)` says
// when the knob is actually in play (no cap tiers → the cap reads nothing, so a
// missing loan_amount cannot make the price wrong).
//
// `scripts/test-lt-ppe-missing-fact.js` scans THIS file's source for every
// `scenario.<fact>` read and fails when one is neither declared here nor a
// rung-selection fact — so a knob added later cannot quietly become a silent
// price-bearing hole.
const RUNG_SELECTION_FACTS = ['lock_days', 'product']; // choose WHICH rungs, never their price
const PRICING_BASIS_FACTS = [
  {
    knob: 'capMilli',
    fact: 'loan_amount',
    active: (pl) => Array.isArray(pl.capTiers) && pl.capTiers.length > 0,
    why: 'the loan-size price cap tier is selected by loan amount — without it the ladder prices UNCAPPED',
  },
];

// The declared basis dependencies that are ACTIVE for this program.
function activeBasisFacts(priceLimit) {
  const pl = priceLimit || {};
  return PRICING_BASIS_FACTS.filter((d) => d.active(pl));
}

// The fact name a basis knob reads — the basis resolution below reads the scenario
// THROUGH this, so the declaration the refusal is built on is the same one the
// price is built on. An undeclared knob is a programming error, not a null cap.
function basisFactName(knob) {
  const d = PRICING_BASIS_FACTS.find((x) => x.knob === knob);
  if (!d) throw new Error(`quote:undeclared_pricing_basis_knob:${knob}`);
  return d.fact;
}

// An explicitly INCOMPLETE answer. It is deliberately NOT a decline (eligibility
// semantics are untouched — a missing fact must never invent one) and deliberately
// NOT a price: it carries `priced:false`, `incomplete:true`, and NO `ladder` and no
// `pricingBasis` key at all, so a caller that reads `q.ladder` gets `undefined` and
// fails loudly rather than reading an empty ladder as "no rungs, that's fine". The
// old shape — `eligible:true` with an empty ladder and nothing said — is exactly
// the confidently-wrong answer this replaces.
function incompleteQuote(programRef, decision, reasons) {
  const facts = [...new Set(reasons.flatMap((r) => r.facts || []))].sort();
  return {
    eligible: decision.eligible, // UNCHANGED: refusing to price is not a decline
    priced: false,
    incomplete: true,
    reason: reasons[0].code,
    reasons,
    missingPriceFacts: facts,
    summary: reasons.map((r) => r.detail).join(' '),
    program: programRef,
    declines: decision.declines,
    bounds: decision.bounds,
    trace: decision.trace,
    unknownFacts: decision.unknownFacts,
    indeterminate: decision.indeterminate,
  };
}

// Every reason this scenario cannot be priced CONFIDENTLY. Empty for a
// fully-specified scenario the sheet publishes a rung for.
function unpriceableReasons(program, scenario, decision, rungs) {
  const reasons = [];

  // (a) a PRICING rule that did NOT fire and whose predicate cannot be decided
  //     from these facts. Its adjustment might have applied — pricing without it
  //     silently DROPS an LLPA and quotes TOO CHEAP. The facts come from the
  //     rule's own predicate (rules.factsOf), never a hand-typed list.
  //
  //     A fact whose ABSENCE the rule set itself gives a meaning to is not
  //     undecidable and is never counted here — see `rules.declaredAbsentFacts`.
  const indet = (decision.indeterminate || []).filter((r) => r.kind === 'pricing');
  if (indet.length) {
    const facts = [...new Set(indet.flatMap((r) => r.facts))].sort();
    reasons.push({
      code: 'missing_price_bearing_fact',
      facts,
      rules: indet.map((r) => ({ code: r.code, facts: r.facts })),
      detail: `the scenario does not carry ${facts.join(', ')}, so ${indet.length} pricing rule${indet.length === 1 ? '' : 's'} cannot be decided (${indet.map((r) => r.code).join(', ')}); pricing without them would drop or invent an adjustment.`,
    });
  }

  // (b) a pricing-BASIS knob whose scenario fact is missing while the knob is
  //     live for this program (today: the loan-size price cap).
  const basisMissing = activeBasisFacts(program.priceLimit)
    .filter((d) => scenario[d.fact] == null);
  if (basisMissing.length) {
    reasons.push({
      code: 'missing_pricing_basis_fact',
      facts: basisMissing.map((d) => d.fact).sort(),
      knobs: basisMissing.map((d) => d.knob),
      detail: `the scenario does not carry ${basisMissing.map((d) => d.fact).join(', ')}: ${basisMissing.map((d) => d.why).join('; ')}.`,
    });
  }

  // (c) the sheet publishes no rung for what was asked. An empty ladder is not a
  //     price — it must never come back as eligible with nothing said.
  if (!rungs.length) {
    const asked = [];
    if (scenario.lock_days != null) asked.push(`lock_days=${scenario.lock_days}`);
    if (scenario.product != null) asked.push(`product=${scenario.product}`);
    const grid = Array.isArray(program.baseGrid) ? program.baseGrid : [];
    const locks = [...new Set(grid.map((r) => r.lockDays).filter((x) => x != null))].sort((a, b) => a - b);
    const products = [...new Set(grid.map((r) => r.product).filter((x) => x != null && x !== ''))].sort();
    reasons.push({
      code: 'no_matching_rungs',
      facts: [],
      requested: { lock_days: scenario.lock_days == null ? null : scenario.lock_days, product: scenario.product == null ? null : scenario.product },
      available: { lockDays: locks, products },
      detail: `the rate sheet publishes no rung for ${asked.length ? asked.join(' ') : 'this scenario'} (available lock days: ${locks.length ? locks.join(', ') : 'none'}${products.length ? `; products: ${products.join(', ')}` : ''}).`,
    });
  }

  return reasons;
}

/**
 * Price a program for a scenario. Returns:
 *   ineligible → { eligible:false, program, declines[], bounds, trace, unknownFacts }
 *   incomplete → { eligible:<unchanged>, priced:false, incomplete:true, reason,
 *                  reasons[], missingPriceFacts[], summary, program, declines,
 *                  bounds, trace, unknownFacts, indeterminate }   — NO ladder
 *   eligible   → { eligible:true, program, ladder[<reconstruction record>],
 *                  bounds, trace, unknownFacts, pricingBasis }
 * `severityOf(decline)` (optional) lets a soft finding not decline (settings
 * eligibility.result_mode drives this at the caller).
 */
function quoteProgram(arg, opts) {
  const { program, settings } = arg || {};
  // ⛔ THE PURPOSE IS CANONICALIZED AT THE DOOR (§2.84). Our sheet's cash-out LLPAs compile to
  // `{fact:'purpose', op:'eq', value:'cashout'}` — an EXACT lowercase match — so every other spelling
  // of the same word used to price as a purchase, silently, half a point in the borrower's favour.
  // 'CashoutRefinance' — Lender Price's OWN token, which is what comes back to us — was one of them.
  // Normalizing here covers every caller (the /quote route, /breakdown, the canary, the agreement run)
  // without any of them having to know, and an unrecognized purpose becomes `null`, which the
  // unknown-fact guard below already refuses to price rather than guessing at.
  const scenario = purpose.withCanonicalPurpose((arg || {}).scenario);
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
  const capRes = resolvePriceCap(priceLimitProgram.priceLimit, scenario[basisFactName('capMilli')]);
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

  // 1b) CAN this scenario be priced CONFIDENTLY at all? A missing PRICE-BEARING
  //     fact must never produce a cheap price, and an empty ladder must never
  //     come back as an eligible answer with nothing said. Both refuse here, with
  //     the reason, BEFORE any number is computed.
  const selected = selectRungs(program.baseGrid, scenario);
  // Judged against the priceLimit that will ACTUALLY price this scenario: a sheet's own
  // per-scenario max-price rule can publish cap tiers the stored program does not carry, and a
  // refusal read off the stored copy would miss exactly those.
  const unpriceable = unpriceableReasons(
    { ...program, priceLimit: priceLimitProgram.priceLimit }, scenario, decision, selected);
  if (unpriceable.length) return incompleteQuote(programRef, decision, unpriceable);

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
  // HOLDBACK — APPLIED to the price since 2026-08-18, on the owner's written direction ("instead of
  // offering the investor's raw pricing, like a 102, we're only gonna offer him a 101.75"). It is a
  // reduction in the price we OFFER, never a fee the borrower pays and never a reason a loan becomes
  // ineligible — eligibility is decided before any of this runs and is untouched by it. `null` means
  // no holdback is configured, and `priceRung` treats that as zero, so a program without one prices
  // exactly as it always did.
  const holdbackMilli = mh && typeof mh.holdbackMilli === 'number' && Number.isInteger(mh.holdbackMilli) && mh.holdbackMilli >= 0
    ? mh.holdbackMilli : null;
  // ⛔ THE HOLDBACK MUST NOT BE TAKEN OFF TWICE — and the only thing that can tell is the frame the
  // base ladder is in, which is why `priceFrame` now travels with the prices instead of living in a
  // paragraph.
  //
  // The owner's rule is "LP = the investor's sheet MINUS our 0.25 holdback", and the Deephaven base
  // ladder is deliberately on the LP-MEASURED side of that subtraction (it is the frame the composed
  // price is compared in). So on that sheet the holdback is ALREADY INSIDE the base. Subtracting it
  // again — which `priceRung` has done since 2026-08-18, correctly, on the owner's written direction —
  // puts every quote 0.25 BELOW what Lender Price shows. Reproduced at coupon 7.500: 105.175 becomes
  // 104.925. Each half is right on its own; together they are wrong, which is why neither half's own
  // tests could catch it.
  //
  // IT REFUSES RATHER THAN QUOTING. A price that is knowably 0.25 out is worse than no price: the
  // number would be acted on, and a quote that silently disagrees with the vendor by a quarter point
  // is exactly the class this engine exists to prevent. Refusing to price is NOT a decline — the
  // scenario stays as eligible as it was (see `incompleteQuote`) — and it names the two halves so
  // whoever hits it knows which one to move.
  //
  // The way out is the owner's to choose and is NOT guessed here: either the ladder moves onto the
  // sheet's own pre-holdback numbers (and the subtraction then produces the right answer), or this
  // program's holdback stays unset because its base already carries it. Recorded as an open question
  // in §2.69.
  //
  // INERT TODAY. No holdback is configured for this program, so `holdbackMilli` is null and this
  // cannot fire — which is also why the defect is latent rather than live.
  if (holdbackMilli != null && holdbackMilli > 0 && program && program.priceFrame === 'lp_post_holdback') {
    return incompleteQuote(programRef, decision, [{
      code: 'holdback_double_counted',
      detail: `this sheet's base prices are already net of the margin holdback (priceFrame lp_post_holdback), and a holdback of ${holdbackMilli / 1000} would be subtracted from them a second time — the quote would be ${holdbackMilli / 1000} below what Lender Price shows. Either move the base ladder onto the investor's own pre-holdback numbers, or leave this program's holdback unset because its base already carries it.`,
      holdbackMilli,
      priceFrame: program.priceFrame,
    }]);
  }

  const marginSource = mhMargin != null ? (mh.marginSource || 'resolved') : 'settings';
  const rounding = resolveRounding(s);
  const roundingMode = pl.roundingMode || rounding.mode;
  const roundingIncrementMilli = pl.roundingIncrementMilli == null ? rounding.incrementMilli : pl.roundingIncrementMilli;
  const floorMilli = pl.floorMilli == null ? (s['pricing.price_floor_milli'] == null ? null : s['pricing.price_floor_milli']) : pl.floorMilli;
  const floorSource = pl.floorMilli != null ? 'sheet' : (s['pricing.price_floor_milli'] != null ? 'settings' : 'none');
  // ONE source for the ceiling — the resolution taken at the top of this function, which itself
  // reads its scenario fact THROUGH the declared basis table (so the refusal above and the number
  // we clamp with can never name different facts). Never re-derive the ceiling here: a second
  // derivation is how the number we clamp with and the state we report drift apart.
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
    holdbackMilli: holdbackMilli == null ? 0 : holdbackMilli,
    roundingMode,
    roundingIncrementMilli,
    floorMilli,
    capMilli,
    cumulativeAdjustmentCapMilli,
  };

  const rungs = selected.map((r) => ({
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
      holdbackMilli, // APPLIED to the price (owner-directed 2026-08-18) and reported here as its own component
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
  RUNG_SELECTION_FACTS,
  PRICING_BASIS_FACTS,
  activeBasisFacts,
  unpriceableReasons,
};
