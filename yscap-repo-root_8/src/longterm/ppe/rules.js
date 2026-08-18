'use strict';
/**
 * LT PPE — the rules-engine evaluator (MEGA plan §6). PURE: no DB, no network,
 * no config — a rule set and a flat bag of scenario facts go in, a decision +
 * full trace come out. Offline-testable, cache-friendly, trivially explainable.
 *
 * ONE REPRESENTATION FOR ALL RULE KINDS: an ordered decision table (the DMN
 * model), NOT a bespoke DSL and NOT RETE/Drools — mortgage pricing is bounded,
 * stateless, single-pass. Three rule SHAPES that compose and fail differently
 * (§6.1), kept separate on purpose:
 *
 *   • eligibility → the rule's predicate describes a DISQUALIFYING condition; a
 *     match produces a structured decline (rule ref + reason). We collect ALL
 *     declines (the `show_with_reasons` default — "Max LTV 80% exceeded
 *     (requested 85%)" beats a bare "ineligible"), and the scenario is eligible
 *     iff none fired.
 *   • bound → a min/max constraint on a target fact ({target:'ltv', op:'max',
 *     value:60}). We collect every matched bound and take the MOST RESTRICTIVE
 *     per target (max → the smallest, min → the largest). Because tightening is
 *     min/max, a house OVERLAY can only ever restrict, never loosen (§3) — the
 *     evaluator gets that guarantee for free. A requested fact that violates the
 *     tightened bound becomes a decline.
 *   • pricing (LLPA) → a signed adjustment; these never decline, they ACCUMULATE
 *     into the array the pricing pipeline (pricing.js) then stacks onto the base
 *     price.
 *
 * HALF-OPEN [min,max) RANGES EVERYWHERE (§3) — the single most effective defense
 * against the "740 FICO falls in two bands" boundary bug. The `between` operator
 * matches `min <= x < max`, never `<=` on both ends.
 *
 * FAIL-SAFE ON A MISSING FACT: a predicate leaf over a fact the scenario does not
 * carry evaluates to FALSE (so an eligibility disqualifier does not wrongly fire,
 * and a price adjustment does not wrongly apply) and the fact is recorded in the
 * trace's `unknownFacts` — nothing is silent. In shadow mode Lender Price is
 * authoritative anyway (§1.2), so the safe direction is never to invent a
 * decline or a cost from an unknown.
 *
 * LT-only. No RTL imports.
 */

// ---- predicate evaluation ---------------------------------------------------

const LEAF_OPS = new Set(['eq', 'neq', 'in', 'nin', 'lt', 'lte', 'gt', 'gte', 'between', 'exists']);

// Evaluate a predicate TREE against the facts. Returns { value: boolean,
// unknown: Set<fact> } — three-valued at the leaves (a missing fact is unknown),
// collapsed to false at the boolean layer, with the unknown facts surfaced.
//
// Tree shapes: { all:[...] } | { any:[...] } | { none:[...] } | { not: <pred> }
// Leaf:        { fact, op, value }
function evalPredicate(pred, facts, unknown) {
  const seen = unknown || new Set();
  const v = _evalNode(pred, facts, seen);
  return { value: v === true, unknown: seen };
}

function _evalNode(node, facts, unknown) {
  if (node == null) return true; // an absent predicate matches everything (a base row)
  if (typeof node !== 'object') throw new Error('rules:predicate_not_an_object');

  if (Array.isArray(node.all)) return node.all.every((n) => _evalNode(n, facts, unknown));
  if (Array.isArray(node.any)) return node.any.some((n) => _evalNode(n, facts, unknown));
  if (Array.isArray(node.none)) return node.none.every((n) => _evalNode(n, facts, unknown) === false);
  if (node.not != null) return _evalNode(node.not, facts, unknown) === false;

  // a leaf
  if (!('fact' in node) || !('op' in node)) throw new Error(`rules:bad_leaf:${JSON.stringify(node)}`);
  if (!LEAF_OPS.has(node.op)) throw new Error(`rules:bad_op:${node.op}`);
  return _evalLeaf(node, facts, unknown);
}

function _evalLeaf(leaf, facts, unknown) {
  const has = Object.prototype.hasOwnProperty.call(facts, leaf.fact);
  const x = has ? facts[leaf.fact] : undefined;

  if (leaf.op === 'exists') return has && x != null;
  if (!has || x == null) { unknown.add(leaf.fact); return false; } // fail-safe on unknown

  switch (leaf.op) {
    case 'eq': return x === leaf.value;
    case 'neq': return x !== leaf.value;
    case 'in': return Array.isArray(leaf.value) && leaf.value.includes(x);
    case 'nin': return Array.isArray(leaf.value) && !leaf.value.includes(x);
    case 'lt': return x < leaf.value;
    case 'lte': return x <= leaf.value;
    case 'gt': return x > leaf.value;
    case 'gte': return x >= leaf.value;
    case 'between': { // HALF-OPEN [min, max)
      const [min, max] = Array.isArray(leaf.value) ? leaf.value : [];
      return x >= min && x < max;
    }
    default: return false;
  }
}

// ---- rule-set evaluation ----------------------------------------------------

// A rule (any shape):
//   { code, kind: 'eligibility'|'bound'|'pricing', source?: 'base'|'overlay',
//     when?: <predicate>, priority?, description?,
//     // eligibility:
//     declineReason?,
//     // bound:
//     target?, op?: 'max'|'min', value?,
//     // pricing:
//     adjustment?: { code, category, adjMilli, unit?, reason?, dimension?, cumulative? } }
//
// Evaluation is a single ordered pass (by `priority` asc, then input order).
// Returns:
//   { eligible, declines[], bounds{target:{op,value,ruleRef,requested,satisfied}},
//     adjustments[], trace[], unknownFacts[] }
function evaluateRules(rules, facts, opts) {
  const list = Array.isArray(rules) ? rules.slice() : [];
  const f = facts || {};
  const unknownAll = new Set();
  const trace = [];
  const declines = [];
  const adjustments = [];
  // The PRICING rules that fired, in lock-step with `adjustments` (same pass, same order). The
  // evaluator stays the FAITHFUL RECORD of what fired — it never collapses anything — but "which rule
  // produced this adjustment" is the one thing the adjustment objects cannot say (two rules can carry
  // the same code, which is exactly the duplicated-row defect), and the pricing façade needs the rule
  // itself to ask rule-coverage whether two of them cover one loan. Additive: nothing existing moves.
  const matchedPricingRules = [];
  const rawBounds = []; // every matched bound, before tightening

  // stable ordered pass
  list
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (Number(a.r.priority || 0) - Number(b.r.priority || 0)) || (a.i - b.i))
    .forEach(({ r }) => {
      if (!r || !r.kind) throw new Error('rules:rule_missing_kind');
      const ruleUnknown = new Set();
      const { value: matched } = evalPredicate(r.when, f, ruleUnknown);
      for (const u of ruleUnknown) unknownAll.add(u);
      const entry = { code: r.code || null, kind: r.kind, source: r.source || 'base', matched, contribution: null };

      if (matched) {
        if (r.kind === 'eligibility') {
          const d = { code: r.code || null, reason: r.declineReason || 'ineligible', source: entry.source };
          declines.push(d);
          entry.contribution = { decline: d };
        } else if (r.kind === 'bound') {
          if (!r.target || (r.op !== 'max' && r.op !== 'min')) throw new Error(`rules:bad_bound:${r.code}`);
          const b = { code: r.code || null, target: r.target, op: r.op, value: r.value, source: entry.source };
          rawBounds.push(b);
          entry.contribution = { bound: b };
        } else if (r.kind === 'pricing') {
          if (!r.adjustment) throw new Error(`rules:pricing_rule_missing_adjustment:${r.code}`);
          const a = { ...r.adjustment, code: r.adjustment.code || r.code || null, source: entry.source };
          adjustments.push(a);
          matchedPricingRules.push(r);
          entry.contribution = { adjustment: a };
        } else {
          throw new Error(`rules:unknown_kind:${r.kind}`);
        }
      }
      // carry any unknown facts this rule touched into the trace entry
      if (ruleUnknown.size) entry.touchedUnknown = [...ruleUnknown];
      trace.push(entry);
    });

  // tighten bounds — most restrictive per (target, op)
  const bounds = {};
  for (const b of rawBounds) {
    const key = `${b.target}:${b.op}`;
    const cur = bounds[key];
    if (!cur) {
      bounds[key] = { target: b.target, op: b.op, value: b.value, ruleRef: b.code, source: b.source };
    } else {
      const tighter = b.op === 'max' ? b.value < cur.value : b.value > cur.value;
      if (tighter) { cur.value = b.value; cur.ruleRef = b.code; cur.source = b.source; }
    }
  }

  // a requested fact that violates a tightened bound is itself a decline
  for (const key of Object.keys(bounds)) {
    const bnd = bounds[key];
    const requested = Object.prototype.hasOwnProperty.call(f, bnd.target) ? f[bnd.target] : undefined;
    bnd.requested = requested == null ? null : requested;
    if (requested == null) { bnd.satisfied = null; continue; } // can't judge without the value
    const violated = bnd.op === 'max' ? requested > bnd.value : requested < bnd.value;
    bnd.satisfied = !violated;
    if (violated) {
      declines.push({
        code: bnd.ruleRef,
        reason: `${bnd.target} ${bnd.op === 'max' ? 'max' : 'min'} ${bnd.value} ${bnd.op === 'max' ? 'exceeded' : 'not met'} (requested ${requested})`,
        source: bnd.source,
        bound: true,
      });
    }
  }

  const hardFail = (opts && opts.severityOf)
    ? declines.some((d) => opts.severityOf(d) === 'hard')
    : declines.length > 0;

  return {
    eligible: !hardFail,
    declines,
    bounds,
    adjustments,
    matchedPricingRules,
    trace,
    unknownFacts: [...unknownAll],
  };
}

module.exports = {
  LEAF_OPS,
  evalPredicate,
  evaluateRules,
};
