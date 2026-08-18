'use strict';
/**
 * LT PPE — the SHARED dimension classifier for the scaled per-program agreement harness (#49).
 * PURE: no DB, no network, no randomness. This is the ONE place that answers "which dimension does
 * this rule / adjustment / decline belong to" so the scenario auto-generator, the per-layer
 * disqualifier reconciler, and the rung-digest audit can NEVER disagree about it (one definition,
 * never a second copy — CLAUDE.md build rule #3).
 *
 * Two vocabularies are collapsed onto ONE canonical namespace:
 *   • OUR side — a rule's own structure: a pricing rule's `adjustment.dimension`, a bound's `target`,
 *     an eligibility rule's `dimension` or the fact of its single-leaf predicate. Read from the rule,
 *     NEVER guessed from prose.
 *   • THEIR side (Lender Price) — the vendor's structured `adjType`, mapped through the SAME
 *     `disqualify-crosswalk.ADJTYPE_FACT` table the crosswalk already curates from real captures. An
 *     adjType we do not recognize returns null (surfaced as unknown, never merged into a real
 *     dimension — the curated-not-guessed discipline).
 *
 * `ltv_cap` (the CapAdjustment umbrella) is folded onto `ltv` for reconciliation: a cap on LTV is an
 * LTV constraint, and the two sides must land on the same key to be compared. The umbrella is still
 * recognizable because the crosswalk keeps `ltv_cap` internally; here it is normalized outward.
 *
 * LT-only. No RTL imports.
 */

const { ADJTYPE_FACT } = require('./disqualify-crosswalk');

// The canonical dimension namespace both engines are reconciled in. Anything outside it is kept as
// its own literal key rather than folded into `other`, so two distinct dimensions never silently
// merge (matching the disqualify-crosswalk's "never silently merged" rule).
const CANONICAL = new Set([
  'fico', 'ltv', 'cltv', 'dscr', 'loan_amount', 'state', 'purpose', 'prepay',
  'property_type', 'units', 'occupancy', 'io', 'borrower_type', 'cashout',
]);

// The single leaf fact of a predicate, or null when the predicate is COMPOUND (more than one fact,
// or an unresolvable shape). A compound predicate has no one dimension, so the caller surfaces the
// rule as dimension-unknown rather than guessing which fact "owns" it.
function soleLeafFact(pred) {
  if (!pred || typeof pred !== 'object') return null;
  if (Object.prototype.hasOwnProperty.call(pred, 'fact') && Object.prototype.hasOwnProperty.call(pred, 'op')) {
    return pred.fact || null;
  }
  if (Array.isArray(pred.all) && pred.all.length === 1) return soleLeafFact(pred.all[0]);
  if (Array.isArray(pred.any) && pred.any.length === 1) return soleLeafFact(pred.any[0]);
  if (pred.not != null) return soleLeafFact(pred.not);
  return null;
}

// A canonical dimension is not always spelled the same as the FACT a predicate tests on: the cash-out
// dimension is expressed by the fact `cashout_amount`. This is the ONE place that mapping lives, so a
// guard asking "is this rule's stated dimension actually one the rule tests?" and a reader asking
// "which fact carries this dimension?" can never answer differently. Additive only — a dimension with
// no entry is expressed by its own name, which is the ordinary case.
const FACT_ALIASES = Object.freeze({ cashout: ['cashout_amount'] });

// Every fact name that can express `dimension` (itself first). Never null; unknown input -> [].
function factsForDimension(dimension) {
  if (!dimension) return [];
  return [String(dimension), ...(FACT_ALIASES[dimension] || [])];
}

// dimension of one of OUR rules, read from the rule's OWN structure (never guessed from text).
function dimensionOfRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.kind === 'pricing' && rule.adjustment) {
    return rule.adjustment.dimension || rule.adjustment.category || null;
  }
  if (rule.kind === 'bound') return rule.target || null;
  if (rule.dimension) return rule.dimension;
  return soleLeafFact(rule.when);
}

// dimension of one of OUR priced adjustments (a pricing.js reconstruction-record adjustment entry).
function dimensionOfOurAdjustment(adj) {
  if (!adj || typeof adj !== 'object') return null;
  return adj.dimension || adj.category || null;
}

// dimension of a LENDER PRICE reason (a declined `{rule,adjType}` OR a priced llpa `{reason,adjType,...}`).
// Uses the vendor's own `adjType`; `ltv_cap` normalizes outward to `ltv`. Unknown adjType → null.
function dimensionOfLpReason(reason) {
  const r = reason || {};
  const adjType = r.adjType || null;
  if (adjType && Object.prototype.hasOwnProperty.call(ADJTYPE_FACT, adjType)) {
    const f = ADJTYPE_FACT[adjType];
    return f === 'ltv_cap' ? 'ltv' : f;
  }
  return null;
}

module.exports = {
  CANONICAL,
  FACT_ALIASES,
  factsForDimension,
  soleLeafFact,
  dimensionOfRule,
  dimensionOfOurAdjustment,
  dimensionOfLpReason,
};
