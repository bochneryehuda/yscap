'use strict';
/**
 * SOW CHANGE-REQUEST / BUDGET REALLOCATION validator (research doc §13, Workflow A).
 *
 * A borrower (or staff) proposes moving money between Scope-of-Work lines. The rules are
 * NON-NEGOTIABLE and grounded in construction-loan draw administration:
 *
 *   · BEFORE clear-to-close  — the total MAY change; a total change re-opens Products &
 *     Pricing (the loan was sized off the old budget). Not net-zero → reprice, don't block.
 *   · AFTER clear-to-close   — the total must NET TO ZERO (money only MOVES between lines,
 *     it is never created); only UNDRAWN money is movable (a line can never be cut below
 *     what has already been drawn); a real move needs capital-partner approval; both the
 *     old (Version 1) and new (Version 2) budgets stay on record.
 *
 *   · A material change on any line (|Δ| > variance_pct of the line, default 10%) is flagged
 *     for capital-partner / lender review either way (never silently applied).
 *
 * PURE — no I/O — so every rule is unit-testable. Money is integer cents. Nothing is
 * guessed: the validator reports violations/warnings; the route parks or blocks. It never
 * "fixes" a bad proposal.
 */

const N = (x) => Number(x || 0) || 0;

/**
 * @param cells  [{ key, label, budget_cents, drawn_cents, new_cents }]
 *               key = a stable cell identity (sow_line_key[:unit]); budget = current frozen
 *               amount; drawn = already released on that cell; new = proposed amount.
 * @param opts   { phase: 'before_ctc' | 'after_ctc', variancePct: number (default 10) }
 * @returns      { phase, totals, cells, violations, warnings, needs_capital_partner, ok }
 */
function planReallocation(cells, opts = {}) {
  const phase = opts.phase === 'after_ctc' ? 'after_ctc' : 'before_ctc';
  const variancePct = Number.isFinite(Number(opts.variancePct)) ? Number(opts.variancePct) : 10;

  const violations = [];
  const warnings = [];
  let before = 0, after = 0, anyMove = false, anyMaterial = false;

  const outCells = (cells || []).map((c) => {
    const budget = N(c.budget_cents);
    const drawn = N(c.drawn_cents);
    const proposed = N(c.new_cents);
    const delta = proposed - budget;
    const movable = Math.max(0, budget - drawn); // only the undrawn portion can be given up
    before += budget; after += proposed;
    if (delta !== 0) anyMove = true;

    const belowDrawn = proposed < drawn;
    if (proposed < 0) violations.push({ code: 'negative_amount', key: c.key, label: c.label, message: `"${c.label}" cannot be negative` });
    if (belowDrawn) violations.push({ code: 'below_drawn', key: c.key, label: c.label,
      message: `"${c.label}" proposed ${fmt(proposed)} is below the ${fmt(drawn)} already drawn — only undrawn money can be moved` });

    // material-variance flag (per line). A brand-new line (budget 0, new>0) is inherently material.
    let variance = null, material = false;
    if (budget > 0) { variance = Math.round((Math.abs(delta) / budget) * 1000) / 10; material = variance > variancePct; }
    else if (proposed > 0) { material = true; }
    if (material) { anyMaterial = true; warnings.push({ code: 'material_variance', key: c.key, label: c.label,
      message: `"${c.label}" changes by ${fmt(delta)}${budget > 0 ? ` (${variance}% of the line)` : ' (new line)'} — over the ${variancePct}% variance threshold; capital-partner review required` }); }

    return { key: c.key, label: c.label, budget_cents: budget, drawn_cents: drawn, new_cents: proposed,
      delta_cents: delta, movable_cents: movable, below_drawn: belowDrawn, variance_pct: variance, material };
  });

  const delta = after - before;
  const netZero = delta === 0;

  if (phase === 'after_ctc') {
    if (!netZero) violations.push({ code: 'not_net_zero',
      message: `After clear-to-close the budget must net to zero — proposed total ${fmt(after)} differs from current ${fmt(before)} by ${fmt(delta)}. Money can move between lines but the total cannot change.` });
  } else if (!netZero) {
    warnings.push({ code: 'total_changed_reopens_pricing',
      message: `The construction total changes by ${fmt(delta)} (${fmt(before)} → ${fmt(after)}). Because this is before clear-to-close, Products & Pricing will re-open and the loan must be re-registered on the new budget.` });
  }

  // After CTC, ANY real move needs capital-partner approval; a material variance needs it either phase.
  const needs_capital_partner = (phase === 'after_ctc' && anyMove) || anyMaterial;
  const ok = violations.length === 0 && (phase === 'before_ctc' || netZero);

  return {
    phase,
    totals: { before_cents: before, after_cents: after, delta_cents: delta, net_zero: netZero },
    cells: outCells, violations, warnings, needs_capital_partner, ok,
    any_move: anyMove,
  };
}

function fmt(cents) {
  const neg = cents < 0; const v = Math.abs(N(cents)) / 100;
  return (neg ? '-$' : '$') + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { planReallocation };
