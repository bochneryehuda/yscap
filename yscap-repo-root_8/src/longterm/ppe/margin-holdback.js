'use strict';
/**
 * LT PPE — per-investor margin & holdback resolution (Layer 1). PURE: no DB, no
 * network, no config reads. A resolved margin + holdback (defaults), an optional
 * per-scenario rule list, and a flat bag of scenario facts go in; the EFFECTIVE
 * margin + holdback + the applied-rule trace come out.
 *
 * WHY THIS EXISTS (owner-directed 2026-08-16): "the margin holdback should be set
 * up for each and every Investor separately in the setting, pre-filled 0.25 but
 * changeable, reaching every Investor, and it should be able to have different kind
 * of margin and holdback to different scenarios with different rules."
 *
 * TWO KNOBS, RESOLVED INDEPENDENTLY:
 *   • margin   — our markup (the 0.250 pre-fill = 250 milli-points)
 *   • holdback — the buffer/retained spread held back per investor (also 0.250 pre-fill)
 * Both are in MILLI-POINTS (250 = 0.250 point), the one unit the whole PPE speaks
 * (pricing.js, settings.js).
 *
 * THE LAYERING (first hit wins, exactly like settings.resolve):
 *   per-investor override (scope investor:<code>) → company default → product default (250)
 * That layering happens in store.js (the DB bridge, which resolves the DEFAULTS);
 * this module takes those resolved defaults and applies the PER-SCENARIO rules on
 * top. So the DB decides "what is this investor's default margin?", and this pure
 * function decides "does this scenario's rule change it?".
 *
 * PER-SCENARIO RULES: an ordered list; each row { code?, when?, marginMilli?,
 * holdbackMilli?, priority? }. Evaluated in priority order (then input order). The
 * FIRST matching row that NAMES a field wins for that field — margin and holdback
 * resolve independently, so one row may override the margin, a later row the
 * holdback, and a scenario can legitimately carry a different margin and a
 * different holdback. A row's predicate is evaluated by rules.evalPredicate
 * (all/any/none/not + leaf ops), which FAILS SAFE on a missing fact (an unknown
 * fact never fires an override), so a rule can never invent an override off a fact
 * the scenario does not carry.
 *
 * NOTHING HERE TOUCHES THE PRICE. This resolves the two NUMBERS + records how they
 * were reached. Wiring holdback into the final-rate math is a MONEY rule that needs
 * the owner's exact combine-formula (never guessed) — see the PPE plan doc. Margin
 * already flows into pricing.priceRung via its `marginMilli` input; this module is
 * what a caller uses to work out WHICH margin (and holdback) applies to a scenario
 * before calling the pipeline.
 *
 * LT-only. No RTL imports.
 */

const { evalPredicate } = require('./rules');

// Coerce a value to a non-negative integer number of milli-points, or null if it
// is not a usable number. A rule row that carries a garbage marginMilli/holdbackMilli
// is IGNORED for that field (falls through to the default) rather than trusted —
// the same fail-safe discipline as an invalid setting override.
function _milliOrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || v < 0) return null;
  return v;
}

/**
 * Resolve the effective margin + holdback for one scenario.
 *
 * input:
 *   marginMilli   — the resolved DEFAULT margin for this investor (milli-points).   default 250
 *   holdbackMilli — the resolved DEFAULT holdback for this investor (milli-points).  default 250
 *   rules         — the per-scenario override list (settings pricing.margin_holdback_rules). default []
 *   facts         — the flat scenario facts bag the rule predicates read.            default {}
 *
 * Returns:
 *   {
 *     marginMilli, holdbackMilli,                 // the EFFECTIVE numbers
 *     marginSource, holdbackSource,               // 'default' | 'rule'
 *     marginRule, holdbackRule,                   // the rule code that set it, or null
 *     appliedRules[],                             // every rule that contributed { code, sets:[...] }
 *     trace[],                                    // per-rule { code, matched, sets, touchedUnknown? }
 *     unknownFacts[],                             // facts a rule predicate referenced but the scenario lacks
 *   }
 *
 * Never throws on a bad rule ROW (it is skipped); throws only on a structurally
 * invalid predicate (via evalPredicate), which is a programming error, not data.
 */
function resolveMarginHoldback(input) {
  const inp = input || {};
  const defMargin = _milliOrNull(inp.marginMilli);
  const defHoldback = _milliOrNull(inp.holdbackMilli);
  // A null/garbage default degrades to the product default (250) rather than to
  // an unpriceable NaN — the same "never degrade to nothing" rule the store uses.
  let marginMilli = defMargin == null ? 250 : defMargin;
  let holdbackMilli = defHoldback == null ? 250 : defHoldback;
  let marginSource = 'default';
  let holdbackSource = 'default';
  let marginRule = null;
  let holdbackRule = null;

  const facts = inp.facts || {};
  const rawRules = Array.isArray(inp.rules) ? inp.rules : [];
  const unknownAll = new Set();
  const trace = [];
  const appliedRules = [];

  // Stable ordered pass by priority asc, then input order.
  rawRules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r && typeof r === 'object')
    .sort((a, b) => (Number(a.r.priority || 0) - Number(b.r.priority || 0)) || (a.i - b.i))
    .forEach(({ r }) => {
      const ruleUnknown = new Set();
      const { value: matched } = evalPredicate(r.when, facts, ruleUnknown);
      for (const u of ruleUnknown) unknownAll.add(u);
      const code = r.code || null;
      const sets = [];
      if (matched) {
        // FIRST matching row that NAMES a field wins for that field.
        const rm = _milliOrNull(r.marginMilli);
        if (rm != null && marginSource === 'default') {
          marginMilli = rm; marginSource = 'rule'; marginRule = code; sets.push('margin');
        }
        const rh = _milliOrNull(r.holdbackMilli);
        if (rh != null && holdbackSource === 'default') {
          holdbackMilli = rh; holdbackSource = 'rule'; holdbackRule = code; sets.push('holdback');
        }
        if (sets.length) appliedRules.push({ code, sets });
      }
      const entry = { code, matched, sets };
      if (ruleUnknown.size) entry.touchedUnknown = [...ruleUnknown];
      trace.push(entry);
    });

  return {
    marginMilli,
    holdbackMilli,
    marginSource,
    holdbackSource,
    marginRule,
    holdbackRule,
    appliedRules,
    trace,
    unknownFacts: [...unknownAll],
  };
}

module.exports = { resolveMarginHoldback, _milliOrNull };
