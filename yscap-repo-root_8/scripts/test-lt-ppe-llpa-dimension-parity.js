#!/usr/bin/env node
'use strict';
/**
 * LT PPE — EVERY LLPA FAMILY OUR SHEET PRICES HAS A PAIRED LENDER-PRICE CLASSIFIER BRANCH
 * (the LLPA-side vocabulary-drift guard; CLAUDE.md "one definition, prove they agree" + the E3 gate's
 * owner HARD RULE 2026-08-17: agree with Lender Price on every LLPA to the penny).
 *
 * The agreement gate reconciles our engine's per-rung LLPA adjustments against Lender Price's itemized
 * LLPAs by DIMENSION (`ratesheet-agreement-diff.reconcileLlpas` with `deephavenLpDimension`). A rung
 * AGREES only when every dimension's delta is 0. That reconciliation is keyed on a shared DIMENSION
 * STRING: our adjustment carries `dimension: 'cashout'`, and LP's cash-out LLPA must ALSO classify to
 * `'cashout'`, or the two land in DIFFERENT buckets and each shows as a one-sided mismatch
 * (`llpa_extra_ours` + `llpa_missing_ours`) — a PERMANENT FALSE DISAGREEMENT that blocks the E3 gate on
 * that whole scenario class even when the money is identical to the penny.
 *
 * `reconcileLlpas` already FAILS SAFE against a SILENT DROP (an unknown LP adjType keys `other:<reason>`
 * and surfaces as a disagreement, never merged). What it CANNOT catch is our OWN vocabulary drifting: a
 * new LLPA family added to `deephaven-dscr-sheet.js` under a dimension the classifier has no branch for.
 * This guard closes exactly that: it collects the dimension set our BUILT sheet emits (the fico×CLTV
 * grid + every `llpaTables[]` entry) and proves, for each, that a representative Lender Price LLPA —
 * built from the sheet's OWN reason string plus the confirmed live adjType — classifies back to the
 * SAME dimension. Adding a sheet family without a classifier branch FAILS THE BUILD (the coverage
 * assertion), which is the point: the classifier is taught before the gate can false-block on it.
 *
 * The adjTypes are the confirmed live Deephaven shapes (already used verbatim in
 * test-lt-ppe-ratesheet-agreement-diff.js): FicoRateAdjustment (fico×CLTV cell AND cash-out, split by
 * reason), SimpleRateAdjustment (DSCR band / IO / escrow / non-warrantable, split by reason),
 * StatesRateAdjustment, LoanAmountRateAdjustment, UnitRateAdjustment, *CondoRateAdjustment. A wrong
 * adjType here cannot pass silently — the classifier would return a different dimension and the pairing
 * assertion goes red, so the only green state is the true one.
 *
 * PURE. No DB, no network. LT-only; no RTL import.
 */
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { deephavenLpDimension, reconcileLlpas } = require('../src/longterm/ppe/ratesheet-agreement-diff');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — every LLPA family our sheet prices pairs to a Lender Price classifier branch\n');

// --- the dimension set our BUILT sheet emits as pricing adjustments -------------------------------
// gridToRateSheet tags the fico×CLTV grid cell `fico_cltv_dscr` (deephaven-grid.js), and every
// llpaTables[] entry keeps its own `.dimension`. So this IS the authoritative "what our engine emits".
const grid = buildDeephavenGrid();
const GRID_DIMENSION = 'fico_cltv_dscr'; // the fico×CLTV cell, not an llpaTables row
const sheetDims = new Set([GRID_DIMENSION, ...grid.llpaTables.map((t) => t.dimension)]);

// The confirmed live Deephaven adjType for each dimension our sheet prices. Reason strings are taken
// from the sheet ITSELF below (so a reason-drift that breaks the classifier regex is caught), except
// the fico×CLTV cell, which is the grid (no llpaTables row) — its reason is the documented live shape.
const LP_ADJTYPE_FOR = {
  fico_cltv_dscr: 'FicoRateAdjustment',
  cashout: 'FicoRateAdjustment',        // split from the cell by the /cash out/ reason
  dscr: 'SimpleRateAdjustment',         // split from prepay/IO/escrow/NW by the /dscr ratio/ reason
  state: 'StatesRateAdjustment',
  loan_amount: 'LoanAmountRateAdjustment',
  units: 'UnitRateAdjustment',
  property_type: 'AllCondoRateAdjustment', // classifier matches adjType /condo/
  interest_only: 'SimpleRateAdjustment',
  escrow_waiver: 'SimpleRateAdjustment',
  non_warrantable: 'SimpleRateAdjustment',
};
// The grid has no llpaTables row, so its representative reason is the documented live one.
const GRID_REASON = 'DSCR (All) - 780+ / CLTV >65.01 % <= 70.0 %';

// A representative reason per dimension, taken from the sheet's OWN entries where one exists.
function sheetReasonFor(dim) {
  if (dim === GRID_DIMENSION) return GRID_REASON;
  const row = grid.llpaTables.find((t) => t.dimension === dim);
  return row ? row.reason : null;
}

// (1) COVERAGE: every dimension our sheet emits has an LP-pairing fixture. A new family without one
//     fails HERE, before it can false-block the gate.
const uncovered = [...sheetDims].filter((d) => !Object.prototype.hasOwnProperty.call(LP_ADJTYPE_FOR, d));
ok(uncovered.length === 0, 'every LLPA dimension the sheet emits has an LP-pairing fixture'
  + (uncovered.length ? `\n        UNCOVERED: ${uncovered.join(', ')} — the sheet prices these but deephavenLpDimension has no proven branch; teach the classifier or the E3 gate false-blocks that scenario class` : ''));

// (2) PAIRING: each representative LP LLPA classifies BACK to the sheet's own dimension. Reason comes
//     from the sheet, so a reason-drift that breaks the classifier's regex turns this red.
for (const dim of [...sheetDims].sort()) {
  const adjType = LP_ADJTYPE_FOR[dim];
  const reason = sheetReasonFor(dim);
  if (!adjType || reason == null) continue; // covered by (1)
  const got = deephavenLpDimension({ adjType, reason });
  ok(got === dim, `[${dim}] a Lender Price {${adjType}, "${String(reason).slice(0, 48)}…"} classifies to '${dim}'`
    + (got === dim ? '' : `\n        got '${got}' — our '${dim}' adjustment and LP's would land in different buckets (a permanent false disagreement)`));
}

// (3) END TO END: an AGREEING rung across EVERY family reconciles clean — no false disagreement. Ours
//     = one +250 adjustment per dimension; LP = the same +250 under each paired fixture. The reconcile
//     must report agree=true with every dimension 'match'.
const ourAdj = [...sheetDims].sort().map((d) => ({ dimension: d, adjMilli: 250, reason: `ours ${d}` }));
const lpLlpas = [...sheetDims].sort()
  .filter((d) => LP_ADJTYPE_FOR[d] && sheetReasonFor(d) != null)
  .map((d) => ({ adjType: LP_ADJTYPE_FOR[d], reason: sheetReasonFor(d), valueMilli: 250 }));
const rc = reconcileLlpas(ourAdj, lpLlpas, { dimensionOf: deephavenLpDimension });
ok(rc.agree === true && rc.worstDeltaMilli === 0, 'an agreeing rung reconciles across every family (agree=true, worstDelta=0)'
  + (rc.agree ? '' : `\n        mismatches: ${rc.itemized.filter((x) => x.deltaMilli !== 0).map((x) => `${x.dimension}:${x.status}`).join(', ')}`));
ok(rc.itemized.every((x) => x.status === 'match'), 'every reconciled dimension is a match (no llpa_extra_ours / llpa_missing_ours)');

// (4) MUTATION PROOF — the failure mode is real. A sheet family the classifier CANNOT produce (a made-up
//     'foreign_national' LLPA on our side, its LP twin classifying to other:<reason>) reconciles as a
//     PERMANENT FALSE DISAGREEMENT even though the money is identical (+250 == +250).
const driftOurs = [{ dimension: 'foreign_national', adjMilli: 250, reason: 'ours FN' }];
const driftLp = [{ adjType: 'SimpleRateAdjustment', reason: 'Other - Foreign National', valueMilli: 250 }];
const drift = reconcileLlpas(driftOurs, driftLp, { dimensionOf: deephavenLpDimension });
const extra = drift.itemized.find((x) => x.dimension === 'foreign_national');
const missing = drift.itemized.find((x) => String(x.dimension).startsWith('other:'));
ok(drift.agree === false && extra && extra.status === 'llpa_extra_ours' && missing && missing.status === 'llpa_missing_ours',
  'a drifted family (classifier has no branch) is a permanent false disagreement despite equal money — exactly what (1) prevents');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
