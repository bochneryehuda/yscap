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
 * …AND THAT SAFE DIRECTION IS ONLY SAFE FOR AN ELIGIBILITY DISQUALIFIER. Never
 * inventing a decline is right; never applying a PRICE adjustment we cannot rule
 * out is NOT — a missing `ltv` silently drops the leverage LLPA and the quote
 * comes back eligible, priced, and TOO CHEAP, with `unknownFacts` decorating a
 * number nobody can trust. So the evaluator ALSO reports, per rule, whether its
 * predicate could be DECIDED from the facts at all:
 *
 *   • `evalPredicate3` is the SAME predicate tree under KLEENE three-valued logic
 *     — a missing leaf is UNKNOWN rather than false, and unknown propagates
 *     (all: false wins over unknown; any: true wins over unknown; not/none flip).
 *   • A rule whose Kleene value is UNKNOWN is INDETERMINATE: had the missing fact
 *     been carried, the rule might have matched (or might not have), so its
 *     contribution is not knowable. Those rules land in `indeterminate[]`, each
 *     naming the facts it is missing — DERIVED from the rule's own predicate
 *     (`factsOf`), never a hand-kept list of "price-bearing" fact names.
 *   • …EXCEPT where the RULE SET ITSELF gives the absence a meaning. A sheet that
 *     prices on a DEFAULT column unless the scenario opts in writes that as a
 *     NEGATED equality (`none:[{fact, eq, <opt-in value>}]`), which the boolean
 *     pass resolves to TRUE when the fact is absent — deliberately, and the sheets
 *     say so in their own words. For such a fact absence IS a value, so the rules
 *     testing it are decided and are never flagged (`declaredAbsentFacts`, read
 *     off the rule set, never configured).
 *   • THE BOOLEAN MATCH SEMANTICS ARE UNTOUCHED. Kleene is computed BESIDE the
 *     existing two-valued pass, never instead of it, because collapsing Kleene to
 *     a boolean would change `not`/`none` over an unknown fact — and eligibility
 *     semantics must stay EXACTLY as they are (a missing fact still never invents
 *     a decline). `evaluateRules` returns the same eligible/declines/bounds/
 *     adjustments/trace it always did for any scenario; `indeterminate` is purely
 *     additive, and is EMPTY for a fully-specified scenario.
 *
 * The PRICING layer (quote.js) is what makes this BITE: it refuses to price when
 * an indeterminate PRICING rule (or a pricing-basis input) is missing its facts.
 * The evaluator only measures; it never declines and never prices.
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

  _assertLeaf(node);
  return _evalLeaf(node, facts, unknown);
}

// The two leaf guards, factored so the boolean pass and the Kleene pass can never
// disagree about what a well-formed leaf is.
function _assertLeaf(node) {
  if (!('fact' in node) || !('op' in node)) throw new Error(`rules:bad_leaf:${JSON.stringify(node)}`);
  if (!LEAF_OPS.has(node.op)) throw new Error(`rules:bad_op:${node.op}`);
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

// ---- determinacy: which facts a predicate NAMES, and can it be decided? ------

// THE FACTS A PREDICATE READS, derived from the predicate tree itself. This is the
// ONLY definition of "which facts does this rule depend on" — a hand-kept list of
// price-bearing fact names would go stale the first time a rate sheet grows a
// dimension, and nothing would say so.
//
// The traversal MIRRORS `_evalNode`'s shape dispatch exactly (all → any → none →
// not → leaf, first match wins) so the facts reported are the facts evaluated.
function factsOf(pred, into) {
  const out = into || new Set();
  if (pred == null || typeof pred !== 'object') return out;
  for (const key of ['all', 'any', 'none']) {
    if (Array.isArray(pred[key])) { pred[key].forEach((n) => factsOf(n, out)); return out; }
  }
  if (pred.not != null) return factsOf(pred.not, out);
  if ('fact' in pred) out.add(pred.fact);
  return out;
}

// KLEENE three-valued evaluation of the SAME predicate tree: 'true' | 'false' |
// 'unknown'. A leaf over a fact the scenario does not carry is UNKNOWN (rather
// than the boolean pass's false), and unknown propagates through the connectives:
//   all  → false if any child is false, else unknown if any is unknown, else true
//   any  → true  if any child is true,  else unknown if any is unknown, else false
//   none → NOT(any)      not → NOT(child)      (unknown negates to unknown)
// `exists` is TOTAL — it answers a question about presence, so it is never unknown.
//
// 'unknown' means: this rule's outcome CANNOT be decided from these facts. That is
// strictly stronger than "a leaf was missing" — `{all:[purpose=cashout, ltv>=80]}`
// on a PURCHASE is determinately FALSE even with no ltv, so it is not flagged. It
// is also independent of leaf ORDER, which the boolean pass's short-circuit is not.
function evalPredicate3(pred, facts) {
  const v = _evalNode3(pred, facts || {});
  return v === true ? 'true' : (v === false ? 'false' : 'unknown');
}

const _U = null; // unknown
function _not3(v) { return v === _U ? _U : !v; }
function _and3(vals) {
  let unknown = false;
  for (const v of vals) { if (v === false) return false; if (v === _U) unknown = true; }
  return unknown ? _U : true;
}
function _or3(vals) {
  let unknown = false;
  for (const v of vals) { if (v === true) return true; if (v === _U) unknown = true; }
  return unknown ? _U : false;
}

function _evalNode3(node, facts) {
  if (node == null) return true; // an absent predicate matches everything (a base row)
  if (typeof node !== 'object') throw new Error('rules:predicate_not_an_object');

  if (Array.isArray(node.all)) return _and3(node.all.map((n) => _evalNode3(n, facts)));
  if (Array.isArray(node.any)) return _or3(node.any.map((n) => _evalNode3(n, facts)));
  if (Array.isArray(node.none)) return _not3(_or3(node.none.map((n) => _evalNode3(n, facts))));
  if (node.not != null) return _not3(_evalNode3(node.not, facts));

  _assertLeaf(node);
  if (node.op === 'exists') return _evalLeaf(node, facts, new Set()); // total: presence is always knowable
  if (!Object.prototype.hasOwnProperty.call(facts, node.fact) || facts[node.fact] == null) return _U;
  // Known value → the operator semantics are the SAME ones the boolean pass uses
  // (one definition of `between`/`in`/… , never a second copy of the switch).
  return _evalLeaf(node, facts, new Set());
}

// A FACT WHOSE ABSENCE THE RULE SET ITSELF GIVES A MEANING TO.
//
// A rate sheet routinely prices on a DEFAULT column unless the scenario opts in,
// and the way this engine expresses that is a NEGATED equality:
// `none:[{fact:'prepay_pricing_model', op:'eq', value:'fixed5_promo'}]` — which the
// boolean pass resolves to TRUE when the fact is absent, on purpose. The Deephaven
// prepay sheet says so in its own words: "an ABSENT model reads as STANDARD, which
// is the sheet's own shape … whereas a bare `neq` would fail-safe to NOT firing and
// silently drop the LLPA."
//
// So for such a fact, ABSENCE IS A VALUE the sheet declared, not an unknown, and
// the rules that test it are decided after all: the default row fires and the
// opt-in row does not. Refusing to price there would override a sheet author's
// stated design and refuse the sheet's own default case.
//
// THE DECLARATION IS READ OFF THE RULE SET, never configured and never hand-typed:
// a fact is "declared absent" when some rule in this very set tests it under an ODD
// number of negations (`none` / `not`) with an equality/membership operator. Only
// `eq`/`in` count — an opt-in is a NAMED value; a negated ordering comparison
// (`not: ltv >= 75000`) says nothing about what a missing leverage means.
function negatedEqFacts(pred, into, negated) {
  const out = into || new Set();
  const neg = !!negated;
  if (pred == null || typeof pred !== 'object') return out;
  if (Array.isArray(pred.all)) { pred.all.forEach((n) => negatedEqFacts(n, out, neg)); return out; }
  if (Array.isArray(pred.any)) { pred.any.forEach((n) => negatedEqFacts(n, out, neg)); return out; }
  if (Array.isArray(pred.none)) { pred.none.forEach((n) => negatedEqFacts(n, out, !neg)); return out; }
  if (pred.not != null) return negatedEqFacts(pred.not, out, !neg);
  if (neg && 'fact' in pred && (pred.op === 'eq' || pred.op === 'in')) out.add(pred.fact);
  return out;
}

// Every fact this rule set declares a meaning for by absence (the union over its
// rules). Pure; safe on a malformed rule list.
function declaredAbsentFacts(rules) {
  const out = new Set();
  for (const r of (Array.isArray(rules) ? rules : [])) {
    if (!r || r.when == null) continue;
    negatedEqFacts(r.when, out, false);
  }
  return out;
}

// The facts a predicate NAMES that this scenario does not carry, sorted for a
// stable trace/report.
function missingFactsOf(pred, facts) {
  const f = facts || {};
  return [...factsOf(pred)]
    .filter((k) => !Object.prototype.hasOwnProperty.call(f, k) || f[k] == null)
    .sort();
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
//     adjustments[], trace[], unknownFacts[], indeterminate[] }
// `indeterminate` is [] for a fully-specified scenario; every other field is
// exactly what it has always been, for every scenario.
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
  const indeterminate = []; // rules whose predicate cannot be decided from these facts
  // the facts whose ABSENCE this rule set itself gives a meaning to (a default
  // column expressed as a negated equality) — those are decided, not unknown
  const declaredAbsent = declaredAbsentFacts(list);
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

      // DETERMINACY. Only worth asking when a leaf actually READ a missing fact:
      // the boolean pass short-circuits a subtree ONLY once the visited prefix is
      // decisive, and a prefix that is decisive with no unknown visited is decisive
      // under Kleene too (with the same value) — so `state3 === 'unknown'` implies
      // some missing leaf was visited, i.e. ruleUnknown is non-empty. Guarding on
      // it keeps a fully-specified scenario on exactly the work it did before, and
      // keeps its trace byte-identical (no rule can gain `indeterminate`).
      if (ruleUnknown.size && evalPredicate3(r.when, f) === 'unknown') {
        // …unless EVERY fact it is missing is one whose absence the rule set
        // declares a meaning for. Then the rule IS decided — by the sheet.
        const missing = missingFactsOf(r.when, f).filter((k) => !declaredAbsent.has(k));
        if (missing.length) {
          indeterminate.push({
            code: r.code || null, kind: r.kind, source: entry.source, matched, facts: missing,
          });
          entry.indeterminate = missing;
        }
      }
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
    indeterminate,
  };
}

module.exports = {
  LEAF_OPS,
  evalPredicate,
  evalPredicate3,
  declaredAbsentFacts,
  factsOf,
  missingFactsOf,
  evaluateRules,
};
