'use strict';
/**
 * LT PPE — the validation scenario MATRIX generator (MEGA plan §10.3). PURE: no DB, no network,
 * no clock, no randomness. It turns a compact AXES spec into the flat scenario facts bags the
 * shadow-reliability harness feeds through BOTH engines (ours via quote.js, Lender Price via the
 * live search) and then hands to parity.compareScenario.
 *
 * A scenario is a flat object of facts: the engine reads scenario.loan_amount / .lock_days /
 * .product directly, and the rule predicates read every other key (fico, ltv, dscr, state, …) out
 * of the same bag. So the matrix is just the cartesian product of the axes, each combination
 * spread over a common base.
 *
 * NO SILENT CAPS (repo rule): the product is bounded by `maxScenarios`; when the full grid would
 * exceed it, buildMatrix DETERMINISTICALLY strides the space to that size and REPORTS the
 * truncation (`truncated`, `fullSize`) rather than quietly dropping the tail. Deterministic, so a
 * shadow run is reproducible — never Math.random.
 *
 * LT-only. No RTL imports.
 */

// Cartesian size of the axes (product of each axis length). Empty axes -> 1 (the base alone).
function fullSizeOf(axes) {
  const keys = Object.keys(axes || {});
  let size = 1;
  for (const k of keys) {
    const vals = axes[k];
    if (!Array.isArray(vals) || vals.length === 0) return 0; // an empty axis produces no scenarios
    size *= vals.length;
  }
  return size;
}

// The i-th combination of the axes, mixed-radix over the axis lengths (deterministic, stable order:
// the LAST axis varies fastest).
function combinationAt(axes, keys, index) {
  const combo = {};
  let rem = index;
  for (let a = keys.length - 1; a >= 0; a -= 1) {
    const vals = axes[keys[a]];
    combo[keys[a]] = vals[rem % vals.length];
    rem = Math.floor(rem / vals.length);
  }
  return combo;
}

/**
 * Build the scenario grid.
 *   axes: { fieldName: [values...] } — each field becomes one dimension of the cartesian product.
 *   opts:
 *     base            — a flat object merged UNDER every scenario (fixed facts, e.g. product).
 *     maxScenarios    — hard ceiling (default 500). Full grid over it -> deterministic stride.
 *     label           — array of axis keys used to build each scenario's `_label` (default all keys).
 *
 * Returns { scenarios:[...], fullSize, truncated, stride }.
 * Every scenario carries a stable `_label` and `_index` (its position in the full grid) so a
 * finding can be traced back to exactly which cell produced it.
 */
function buildMatrix(axes = {}, opts = {}) {
  const base = opts.base || {};
  const max = opts.maxScenarios == null ? 500 : opts.maxScenarios;
  const keys = Object.keys(axes);
  const labelKeys = Array.isArray(opts.label) && opts.label.length ? opts.label : keys;

  const fullSize = fullSizeOf(axes);
  if (fullSize === 0) return { scenarios: [], fullSize: 0, truncated: false, stride: 1 };

  const truncated = fullSize > max && max > 0;
  const stride = truncated ? Math.ceil(fullSize / max) : 1;

  const scenarios = [];
  for (let i = 0; i < fullSize; i += stride) {
    const combo = combinationAt(axes, keys, i);
    const scenario = { ...base, ...combo };
    scenario._index = i;
    scenario._label = describeScenario(combo, labelKeys);
    scenarios.push(scenario);
    if (max > 0 && scenarios.length >= max) break; // ceiling guard (stride can leave a remainder)
  }

  return { scenarios, fullSize, truncated, stride };
}

// Stable, human-readable label for a scenario from a subset of keys: "fico=740 ltv=70 state=CA".
function describeScenario(scenario, keys) {
  const use = Array.isArray(keys) && keys.length
    ? keys
    : Object.keys(scenario || {}).filter((k) => k[0] !== '_');
  return use.map((k) => `${k}=${scenario ? scenario[k] : undefined}`).join(' ');
}

module.exports = { buildMatrix, fullSizeOf, describeScenario, _internals: { combinationAt } };
