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
 * holdbackMilli?, marginDeltaMilli?, holdbackDeltaMilli?, priority? }. Evaluated in
 * priority order (then input order). Two mechanisms, deliberately separate:
 *   • SET (marginMilli / holdbackMilli): the FIRST matching row that NAMES a field
 *     wins for that field — margin and holdback resolve independently.
 *   • ADD (marginDeltaMilli / holdbackDeltaMilli): EVERY matching row's delta SUMS on
 *     top of the resolved base (a signed integer; the final value is clamped ≥ 0).
 * The two never merge: the base and the extra stay separately visible in the result
 * (marginBaseMilli/holdbackBaseMilli + marginDeltaMilli/holdbackDeltaMilli), because
 * the owner's softer-PPP overlay is explicitly "two separate holdbacks — 0.25 base
 * and 0.375 extra" (2026-08-17), NOT a single merged 0.625. A row's predicate is
 * evaluated by rules.evalPredicate (all/any/none/not + leaf ops), which FAILS SAFE
 * on a missing fact (an unknown fact never fires an override), so a rule can never
 * invent an override — or a delta — off a fact the scenario does not carry.
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

// A DELTA may be negative (a credit) as well as positive (an extra holdback), so it accepts any finite
// integer; a garbage delta is IGNORED for that field (same fail-safe as a garbage set). The final value
// is clamped ≥ 0 by the caller, so a delta can never drive a holdback below zero.
function _deltaOrNull(v) {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null;
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
  // Accumulated additive deltas (summed across EVERY matching row) + which rules contributed them.
  let marginDelta = 0;
  let holdbackDelta = 0;
  const marginDeltaRules = [];
  const holdbackDeltaRules = [];

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
        // FIRST matching row that NAMES a field wins for that field (SET).
        const rm = _milliOrNull(r.marginMilli);
        if (rm != null && marginSource === 'default') {
          marginMilli = rm; marginSource = 'rule'; marginRule = code; sets.push('margin');
        }
        const rh = _milliOrNull(r.holdbackMilli);
        if (rh != null && holdbackSource === 'default') {
          holdbackMilli = rh; holdbackSource = 'rule'; holdbackRule = code; sets.push('holdback');
        }
        // ADD: every matching row's delta SUMS on top (a separate, tracked component).
        const dm = _deltaOrNull(r.marginDeltaMilli);
        if (dm != null && dm !== 0) { marginDelta += dm; marginDeltaRules.push({ code, deltaMilli: dm }); sets.push('margin_delta'); }
        const dh = _deltaOrNull(r.holdbackDeltaMilli);
        if (dh != null && dh !== 0) { holdbackDelta += dh; holdbackDeltaRules.push({ code, deltaMilli: dh }); sets.push('holdback_delta'); }
        if (sets.length) appliedRules.push({ code, sets });
      }
      const entry = { code, matched, sets };
      if (ruleUnknown.size) entry.touchedUnknown = [...ruleUnknown];
      trace.push(entry);
    });

  // The base (default-or-set) stays separately visible; the deltas add on top, clamped ≥ 0. The two
  // never merge — a caller that wants to show "0.25 + 0.375" reads base + delta, not just the sum.
  const marginBaseMilli = marginMilli;
  const holdbackBaseMilli = holdbackMilli;
  marginMilli = Math.max(0, marginBaseMilli + marginDelta);
  holdbackMilli = Math.max(0, holdbackBaseMilli + holdbackDelta);

  return {
    marginMilli,
    holdbackMilli,
    // the base (before deltas) + the summed extra, kept separate on purpose.
    marginBaseMilli,
    holdbackBaseMilli,
    marginDeltaMilli: marginDelta,
    holdbackDeltaMilli: holdbackDelta,
    marginDeltaRules,
    holdbackDeltaRules,
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
