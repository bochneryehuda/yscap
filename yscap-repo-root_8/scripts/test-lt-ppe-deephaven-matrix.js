#!/usr/bin/env node
'use strict';
/**
 * LT PPE — LAYER 2 eligibility engine (deephaven-matrix.js), validated OFFLINE against the OFFICIAL
 * Deephaven DSCR product matrix. Runs a heavy qualify/disqualify battery (owner 2026-08-17: "run a lot
 * of scenarios to test those rules … qualifying scenarios and disqualifying scenarios"), proves EVERY
 * grid cell reproduces the published cap, and asserts the engine is INDEPENDENT of the LP-derived
 * envelope (it must never import deephaven-dscr-sheet.js — the whole point of the second layer).
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { evaluateEligibility, gridCell, MATRIX } = require('../src/longterm/ppe/deephaven-matrix');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const ltv = (pct) => pct * 1000;
const base = (o) => ({ fico: 760, dscr: 1250, ltv: ltv(70), purpose: 'purchase', loan_amount: 400000, ...o });
const elig = (o) => evaluateEligibility(base(o)).eligible;
const codes = (o) => evaluateEligibility(base(o)).reasons.map((r) => r.code);

console.log('LT PPE — Layer 2 (Deephaven DSCR eligibility matrix)\n');

// ---- the owner's $75k question, both directions ------------------------------------------------
ok(elig({ loan_amount: 75000, dscr: 1250 }), 'OWNER CASE: $75,000 loan at DSCR 1.25 IS eligible (min loan DSCR>=1.00 is $75k — LP is right)');
ok(!elig({ loan_amount: 75000, dscr: 900 }) && codes({ loan_amount: 75000, dscr: 900 }).includes('dhvn_min_loan_lt1'), '$75,000 at DSCR 0.90 is INELIGIBLE (min loan for DSCR<1.00 is $200k) — the gap the flat envelope misses');
ok(!elig({ loan_amount: 199999, dscr: 950 }) && elig({ loan_amount: 200000, dscr: 950, ltv: ltv(70) }), 'DSCR<1.00 min-loan boundary: $199,999 ineligible, $200,000 eligible');
ok(!elig({ loan_amount: 74999, dscr: 1250 }), 'DSCR>=1.00 min-loan boundary: $74,999 ineligible');

// ---- max loan / min dscr -----------------------------------------------------------------------
ok(!elig({ loan_amount: 2500001, dscr: 1250, fico: 780, ltv: ltv(60) }) && codes({ loan_amount: 2500001, dscr: 1250, fico: 780, ltv: ltv(60) }).includes('dhvn_max_loan'), 'loan $2,500,001 → Max Loan $2.5MM');
ok(!elig({ dscr: 740 }) && codes({ dscr: 740 }).includes('dhvn_min_dscr'), 'DSCR 0.74 → Min DSCR 0.75x');
ok(elig({ dscr: 750, ltv: ltv(70), fico: 720 }), 'DSCR exactly 0.75 prices (at a cell that permits DSCR<1.00)');

// ---- EVERY grid cell reproduces the published cap ---------------------------------------------
// For each (tier, fico row, purpose class, dscr band): a priced cell must be eligible AT the cap and
// ineligible ONE point above; an N/A cell must be ineligible at any LTV.
let cellChk = 0; let cellOk = 0; const cellMiss = [];
const FICO_IN_ROW = { 720: 730, 700: 710, 680: 690, 660: 670, 640: 650 }; // a score inside each floor band
const LOAN_IN_TIER = { 1500000: 1000000, 2000000: 1800000, 2500000: 2300000 };
for (const tier of MATRIX.GRID) {
  const loan = LOAN_IN_TIER[tier.maxLoan];
  for (const row of tier.rows) {
    const fico = FICO_IN_ROW[row.fico];
    for (const [col, purpose, dscr] of [['P_RT_ge1', 'purchase', 1250], ['CO_ge1', 'cashout', 1250], ['P_RT_lt1', 'purchase', 900], ['CO_lt1', 'cashout', 900]]) {
      const cap = row[col];
      const sc = { loan_amount: loan, fico, dscr, purpose, cashout_amount: purpose === 'cashout' ? 50000 : 0 };
      cellChk += 1;
      if (cap == null) {
        // N/A cell: ineligible at a modest LTV (grid N/A, not another rule) — use 60% so no other cap bites
        const r = evaluateEligibility({ ...sc, ltv: ltv(60) });
        if (!r.eligible && r.reasons.some((x) => x.code === 'dhvn_grid_na')) cellOk += 1;
        else cellMiss.push(`T${tier.maxLoan / 1e6}M f${fico} ${col}: expected N/A decline, got ${r.eligible ? 'eligible' : r.reasons.map((x) => x.code).join(',')}`);
      } else {
        // DSCR<1.00 min loan is $200k, so lt1 cells must use a loan >= 200k (all LOAN_IN_TIER are)
        const atCap = evaluateEligibility({ ...sc, ltv: ltv(cap) });
        const overCap = evaluateEligibility({ ...sc, ltv: ltv(cap) + 1 });
        if (atCap.eligible && !overCap.eligible && overCap.reasons.some((x) => x.code === 'dhvn_grid_ltv')) cellOk += 1;
        else cellMiss.push(`T${tier.maxLoan / 1e6}M f${fico} ${col} cap${cap}: at=${atCap.eligible} over=${overCap.eligible}[${overCap.reasons.map((x) => x.code).join(',')}]`);
      }
    }
  }
}
ok(cellOk === cellChk, `all ${cellChk} grid cells reproduce the published cap (eligible at cap, declined 1 point above; N/A cells declined)${cellMiss.length ? ' — ' + cellMiss.slice(0, 4).join(' | ') : ''}`);

// ---- per-tier minimum FICO --------------------------------------------------------------------
ok(!elig({ loan_amount: 1000000, fico: 639, dscr: 1250, ltv: ltv(60) }) && codes({ loan_amount: 1000000, fico: 639, dscr: 1250, ltv: ltv(60) }).includes('dhvn_min_fico_tier'), 'tier1 ($1.5M): FICO 639 → below min FICO 640');
ok(!elig({ loan_amount: 1800000, fico: 659, dscr: 1250, ltv: ltv(60) }) && codes({ loan_amount: 1800000, fico: 659, dscr: 1250, ltv: ltv(60) }).includes('dhvn_min_fico_tier'), 'tier2 ($2.0M): FICO 659 → below min FICO 660 (the flat-640 envelope misses this)');
ok(!elig({ loan_amount: 2300000, fico: 659, dscr: 1250, ltv: ltv(60) }), 'tier3 ($2.5M): FICO 659 → below min FICO 660');
ok(elig({ loan_amount: 1800000, fico: 660, dscr: 1250, ltv: ltv(65) }), 'tier2: FICO 660 at 65% LTV prices');

// ---- cash-out amount caps ---------------------------------------------------------------------
ok(!elig({ purpose: 'cashout', ltv: ltv(65), cashout_amount: 1000001, loan_amount: 1200000, fico: 760, dscr: 1250 }) &&
   codes({ purpose: 'cashout', ltv: ltv(65), cashout_amount: 1000001, loan_amount: 1200000, fico: 760, dscr: 1250 }).includes('dhvn_cashout_le65'), 'cash-out $1,000,001 at LTV 65% → Max Cash-Out $1M');
ok(!elig({ purpose: 'cashout', ltv: ltv(70), cashout_amount: 500001, loan_amount: 400000, fico: 760, dscr: 1250 }) &&
   codes({ purpose: 'cashout', ltv: ltv(70), cashout_amount: 500001, loan_amount: 400000, fico: 760, dscr: 1250 }).includes('dhvn_cashout_gt65'), 'cash-out $500,001 at LTV 70% → Max Cash-Out $500k');
ok(elig({ purpose: 'cashout', ltv: ltv(65), cashout_amount: 1000000, loan_amount: 1200000, fico: 760, dscr: 1250 }), 'cash-out exactly $1M at LTV 65% prices');

// ---- small-loan LTV reduction -----------------------------------------------------------------
ok(!elig({ loan_amount: 120000, ltv: ltv(76), fico: 760, dscr: 1250 }) && codes({ loan_amount: 120000, ltv: ltv(76), fico: 760, dscr: 1250 }).includes('dhvn_small_loan_ltv'), 'loan $120k at 76% LTV → small-loan 75% cap');
ok(elig({ loan_amount: 120000, ltv: ltv(75), fico: 760, dscr: 1250 }), 'loan $120k at exactly 75% LTV prices');

// ---- interest-only overlay --------------------------------------------------------------------
ok(!elig({ interest_only: true, dscr: 900, ltv: ltv(70), fico: 760, loan_amount: 400000 }) && codes({ interest_only: true, dscr: 900, ltv: ltv(70), fico: 760, loan_amount: 400000 }).includes('dhvn_io_min_dscr'), 'IO + DSCR 0.90 → IO Min DSCR 1.00x');
ok(elig({ interest_only: true, dscr: 1000, ltv: ltv(75), fico: 720, loan_amount: 400000 }), 'IO + DSCR 1.00 at 75% prices');

// ---- property type ----------------------------------------------------------------------------
ok(!elig({ property_type: 'RowHome' }) && codes({ property_type: 'RowHome' }).includes('dhvn_row_home'), 'Row Home → ineligible');
ok(elig({ property_type: 'SingleFamily' }), 'SingleFamily prices');
ok(!elig({ property_type: 'Condo', ltv: ltv(81), fico: 780, loan_amount: 400000, dscr: 1250 }), 'Condo over 80% LTV → declined (condo max 80%)');

// ---- unverifiable overlays are flagged, never silently applied --------------------------------
const uv = evaluateEligibility(base({})).unverifiable;
ok(Array.isArray(uv) && uv.some((x) => /Philadelphia/.test(x.overlay)) && uv.some((x) => /Foreign National/.test(x.overlay)) && uv.some((x) => /Short-Term/.test(x.overlay)), 'overlays needing facts we do not carry (Philly/FN/STR/declining/geo) are FLAGGED as unverifiable, not guessed');

// ---- fail-safe: a missing fact never fires a decline ------------------------------------------
ok(evaluateEligibility({ purpose: 'purchase' }).reasons.length === 0, 'a scenario with no loan/fico/dscr fires NO decline (fail-safe: never disqualify on absent data)');
ok(gridCell({ purpose: 'purchase' }).status === 'unknown', 'gridCell with no loan/fico/dscr → unknown (not a guess)');

// ---- the embedded tables reproduce the decoded matrix JSON (no drift) -------------------------
const jsonPath = path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'matrices', 'deephaven-dscr-matrix.json');
const J = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
ok(MATRIX.MIN_LOAN_DSCR_GE1 === J.programParameters.minLoanDscrGe1 && MATRIX.MIN_LOAN_DSCR_LT1 === J.programParameters.minLoanDscrLt1 && MATRIX.MAX_LOAN === J.programParameters.maxLoan, 'program parameters match the decoded matrix JSON');
ok(MATRIX.MAX_CASHOUT_LTV_LE65 === J.programParameters.maxCashOut_LTV_le65 && MATRIX.MAX_CASHOUT_LTV_GT65 === J.programParameters.maxCashOut_LTV_gt65, 'cash-out caps match the JSON');
let gridDrift = 0;
J.ltvGrid.tiers.forEach((jt, ti) => {
  const mt = MATRIX.GRID[ti];
  jt.rows.forEach((jr, ri) => {
    if (typeof jr.fico !== 'number') return; // Foreign National row is deferred, not in the engine GRID
    const mr = mt.rows.find((r) => r.fico === jr.fico);
    const map = { P_RT_ge1: 'P_RT_ge1', CO_ge1: 'CO_ge1', P_RT_lt1: 'P_RT_lt1', CO_lt1: 'CO_lt1' };
    for (const k of Object.keys(map)) {
      const jv = jr[k] == null ? null : Math.round(jr[k] * 100);
      if (!mr || mr[k] !== jv) gridDrift += 1;
    }
  });
});
ok(gridDrift === 0, `every grid cell in the engine matches the decoded JSON (${gridDrift} drifts)`);

// ---- structural: the engine is INDEPENDENT of the LP-derived envelope -------------------------
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'deephaven-matrix.js'), 'utf8');
ok(!/require\(['"].*deephaven-dscr-sheet/.test(src), 'deephaven-matrix.js does NOT import the LP-derived deephaven-dscr-sheet (independence guard)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
