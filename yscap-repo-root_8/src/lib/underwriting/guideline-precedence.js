'use strict';
/**
 * R5.35 (core) — deterministic precedence resolver for the Mortgage Knowledge
 * Graph. Given every rule that APPLIES to a file for a given rule_key (base
 * program + investor + state + internal overlay + approved exception), pick the
 * winner by an EXPLICIT precedence order — never model intuition, never "take
 * the more permissive one".
 *
 * Precedence (lower tier number = higher authority), owner-directed:
 *   10 law_compliance      hard stop
 *   20 state               state restriction / overlay
 *   30 investor_hard       investor hard rule
 *   40 investor_exception  an APPROVED investor exception
 *   50 internal_overlay    YS internal overlay
 *   60 program_base        program / base rule
 *   70 guidance            guidance / preference
 *   80 historical          historical similarity (ADVISORY ONLY — never binds)
 *
 * If two applicable rules share the winning tier AND disagree on the outcome,
 * the resolver ABSTAINS (returns {decision:'abstain', reason:'tie'}) so the
 * caller raises a narrow admin question — it never silently picks one.
 *
 * Pure: no DB, no I/O. The DB-backed collector lives in guideline-knowledge.js;
 * this module just decides. Unit-tested in test-guideline-precedence-pure.js.
 */

const TIERS = Object.freeze({
  law_compliance: 10,
  state: 20,
  investor_hard: 30,
  investor_exception: 40,
  internal_overlay: 50,
  program_base: 60,
  guidance: 70,
  historical: 80,
});
// Anything at or below this tier is advisory and can never bind a decision.
const ADVISORY_AT_OR_ABOVE = TIERS.historical;

function tierOf(rule) {
  if (rule && Number.isFinite(rule.precedence_tier)) return rule.precedence_tier;
  const k = rule && rule.source;
  if (k && Number.isFinite(TIERS[k])) return TIERS[k];
  return TIERS.program_base; // safe default: a rule of unknown provenance is a base rule
}

// Two outcomes are "equivalent" if their JSON canonicalizes identically.
function outcomeKey(outcome) {
  if (outcome == null) return 'null';
  if (typeof outcome !== 'object') return JSON.stringify(outcome);
  const keys = Object.keys(outcome).sort();
  return JSON.stringify(keys.map((k) => [k, outcome[k]]));
}

/**
 * resolveRuleKey(rules) — rules: [{source|precedence_tier, outcome, materiality, rule_id, advisory?}]
 * Returns { decision, winner?, tier?, reason, considered }.
 *   decision: 'apply' | 'abstain' | 'none'
 */
function resolveRuleKey(rules) {
  const applicable = (rules || []).filter((r) => r && r.outcome !== undefined && r.outcome !== null);
  if (!applicable.length) return { decision: 'none', reason: 'no applicable rule', considered: 0 };

  // Binding rules only (advisory tier never decides).
  const binding = applicable.filter((r) => tierOf(r) < ADVISORY_AT_OR_ABOVE && !r.advisory);
  if (!binding.length) {
    return { decision: 'none', reason: 'only advisory rules apply', considered: applicable.length };
  }

  const bestTier = Math.min(...binding.map(tierOf));
  const top = binding.filter((r) => tierOf(r) === bestTier);

  // All top-tier rules must agree, else abstain (never pick one silently).
  const distinctOutcomes = new Set(top.map((r) => outcomeKey(r.outcome)));
  if (distinctOutcomes.size > 1) {
    return {
      decision: 'abstain',
      tier: bestTier,
      reason: 'tie: multiple same-priority rules disagree — needs an admin decision',
      considered: applicable.length,
      conflicting: top.map((r) => ({ ruleId: r.rule_id || null, outcome: r.outcome })),
    };
  }
  return {
    decision: 'apply',
    winner: top[0],
    tier: bestTier,
    reason: `applied ${Object.keys(TIERS).find((k) => TIERS[k] === bestTier) || 'tier ' + bestTier}`,
    considered: applicable.length,
  };
}

// Resolve a whole map of {rule_key: [rules]} → {rule_key: resolution}.
function resolveAll(rulesByKey) {
  const out = {};
  for (const [key, rules] of Object.entries(rulesByKey || {})) {
    out[key] = resolveRuleKey(rules);
  }
  return out;
}

module.exports = { TIERS, ADVISORY_AT_OR_ABOVE, tierOf, resolveRuleKey, resolveAll, _internals: { outcomeKey } };
