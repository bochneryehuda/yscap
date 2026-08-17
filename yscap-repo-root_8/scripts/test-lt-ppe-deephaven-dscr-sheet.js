#!/usr/bin/env node
'use strict';
/**
 * LT PPE — OUR Deephaven DSCR sheet-under-test (deephaven-dscr-sheet.js), validated OFFLINE against the
 * live Lender Price tables it encodes. Proves our engine REPRODUCES Lender Price's OWN itemized LLPA
 * values — every FICO×CLTV cell, the separate additive DSCR band, and the flat state adder — to the
 * penny, and declines exactly the N/A boxes. (Cross-checked separately against all 148 real captured
 * scenarios; this test locks the same result in without the scratchpad data so it runs in CI.)
 *
 * Also proves the ratesheet fix: N/A grid boxes now become real eligibility declines (rateSheetToProgram
 * consumes sheet.ineligibilities), which they silently did not before.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { buildDeephavenGrid, LP_TABLES, UNMEASURED } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — Deephaven DSCR sheet vs live Lender Price tables\n');

const sheet = gridToRateSheet(buildDeephavenGrid());
ok(sheet.problems.length === 0, `grid builds with no problems (${JSON.stringify(sheet.problems.slice(0, 3))})`);
ok(sheet.basePrices.length === 28, '28 base-price coupons');
ok(sheet.ineligibilities.filter((i) => i.dimension === 'fico_cltv_dscr').length === 4, 'four N/A grid boxes (680/80, 660/80, 640/75, 640/80)');

const program = rateSheetToProgram(sheet, { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const S = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none' };
function q(scenario) { return quoteProgram({ scenario, program, settings: S }); }
function stack(scenario) {
  const r = q(scenario);
  if (!r.eligible) return { eligible: false, declines: r.declines };
  const m = {};
  for (const a of r.ladder[0].adjustments) m[a.dimension || a.category] = (m[a.dimension || a.category] || 0) + a.costMilli;
  return { eligible: true, m, ladder: r.ladder };
}

// A whole CLTV per column (the .5-shifted bands put each whole CLTV in the LP band), loan on a $500k value.
const CLTV_LOAN = [250000, 275000, 300000, 325000, 350000, 375000, 400000]; // 50 55 60 65 70 75 80
const FICO_REP = [800, 770, 750, 730, 710, 690, 670, 645]; // one score inside each FICO band

// ---- the ENTIRE FICO×CLTV grid reproduces Lender Price, cell for cell (at DSCR 1.25 + NY) ----------
let cellsChecked = 0; let cellsOk = 0; const cellMiss = [];
LP_TABLES.FICO_CLTV_LP.forEach((row, fi) => {
  row.forEach((lpVal, ci) => {
    const sc = { fico: FICO_REP[fi], loan: CLTV_LOAN[ci], value: 500000, ltv: null, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: CLTV_LOAN[ci] };
    // supply ltv explicitly (milli-percent) so we exercise the exact band, not a derived rounding
    sc.ltv = Math.round((CLTV_LOAN[ci] / 500000) * 100000);
    const s = stack(sc);
    cellsChecked += 1;
    if (lpVal == null) {
      if (!s.eligible) cellsOk += 1; else cellMiss.push(`fico${FICO_REP[fi]}/cltv${ci}: expected N/A decline, got eligible`);
    } else if (s.eligible && (s.m.fico_cltv_dscr || 0) === Math.round(lpVal * 1000)) {
      cellsOk += 1;
    } else {
      cellMiss.push(`fico${FICO_REP[fi]}/cltv${ci}: expected ${Math.round(lpVal * 1000)}, got ${s.eligible ? (s.m.fico_cltv_dscr || 0) : 'ineligible'}`);
    }
  });
});
ok(cellsOk === cellsChecked, `all ${cellsChecked} FICO×CLTV cells reproduce Lender Price (fico_cltv_dscr) or decline the N/A boxes${cellMiss.length ? ' — ' + cellMiss.slice(0, 4).join(' | ') : ''}`);

// ---- the DSCR-band add-on (separate additive) -------------------------------------------------
const anchor = { fico: 760, loan: 350000, value: 500000, ltv: 70000, state: 'CA', purpose: 'purchase', loan_amount: 350000 };
ok((stack({ ...anchor, dscr: 1500 }).m.dscr || 0) === 250, 'DSCR ≥1.25 → +0.25 (250) flat, no state (CA)');
ok(stack({ ...anchor, dscr: 1250 }).m.dscr === 250, 'DSCR exactly 1.25 → +0.25');
ok((stack({ ...anchor, dscr: 1100 }).m.dscr || 0) === 0, 'DSCR 1.00–1.24 → baseline 0 (no DSCR line)');
ok((stack({ ...anchor, dscr: 1000 }).m.dscr || 0) === 0, 'DSCR exactly 1.00 → baseline 0');
// <1.00 CLTV-segmented — check each measured band
for (const seg of LP_TABLES.DSCR_LT100_BY_CLTV) {
  const cltv = seg.cltv.min == null ? 50 : Math.round((seg.cltv.min + seg.cltv.max) / 2);
  const loan = Math.round(500000 * cltv / 100);
  const s = stack({ fico: 760, loan, value: 500000, ltv: cltv * 1000, dscr: 950, state: 'CA', purpose: 'purchase', loan_amount: loan });
  ok(s.eligible && s.m.dscr === Math.round(seg.lp * 1000), `DSCR <1.00 at CLTV ~${cltv} → +${seg.lp} (${Math.round(seg.lp * 1000)})`);
}

// ---- the state adder ---------------------------------------------------------------------------
for (const st of ['NY', 'NJ', 'MA', 'DC']) ok((stack({ ...anchor, dscr: 1250, state: st }).m.state || 0) === 375, `state ${st} → +0.375 (375)`);
for (const st of ['CA', 'FL', 'TX']) ok((stack({ ...anchor, dscr: 1250, state: st }).m.state || 0) === 0, `state ${st} → no adder`);

// ---- §7 add-on LLPAs (cash-out / condo / 2–4 units), CLTV-segmented ----------------------------
// Each aligns index-for-index with the 7 CLTV bands (50/55/60/65/70/75/80). A 0/null band emits NO
// line, so the add-on dimension must be absent (0) there. Anchor is FICO 760 DSCR 1.25 CA (no state).
const ADDON_CLTV = [50, 55, 60, 65, 70, 75, 80];
function addonAt(cltv, extra) {
  const loan = Math.round(500000 * cltv / 100);
  return stack({ fico: 760, loan, value: 500000, ltv: cltv * 1000, dscr: 1250, state: 'CA', purpose: 'purchase', loan_amount: loan, ...extra });
}
let addOk = 0; let addChk = 0; const addMiss = [];
function addCheck(label, cltv, extra, dim, lpVal) {
  addChk += 1;
  const s = addonAt(cltv, extra);
  const got = s.eligible ? (s.m[dim] || 0) : 'ineligible';
  const want = lpVal == null ? 0 : Math.round(lpVal * 1000);
  if (got === want) addOk += 1; else addMiss.push(`${label} cltv${cltv}: want ${want} got ${got}`);
}
ADDON_CLTV.forEach((cltv, i) => {
  addCheck('cashout≥720', cltv, { purpose: 'cashout', fico: 760 }, 'cashout', LP_TABLES.CASHOUT_GE720_BY_CLTV[i]);
  addCheck('cashout<720', cltv, { purpose: 'cashout', fico: 700 }, 'cashout', LP_TABLES.CASHOUT_LT720_BY_CLTV[i]);
  // a WARRANTABLE condo (non_warrantable false) still fires the Condo line under the new gate.
  addCheck('condo', cltv, { property_type: 'Condo', non_warrantable: false }, 'property_type', LP_TABLES.CONDO_BY_CLTV[i]);
  addCheck('units2', cltv, { property_type: 'Unit2_4', units: 2 }, 'units', LP_TABLES.UNITS_BY_CLTV[i]);
  // the FOUR families measured live 2026-08-17 (interest-only, escrow-waiver, non-warrantable).
  addCheck('io', cltv, { interest_only: true }, 'interest_only', LP_TABLES.IO_BY_CLTV[i]);
  addCheck('escrow', cltv, { escrow_waiver: true }, 'escrow_waiver', LP_TABLES.ESCROW_BY_CLTV[i]);
  addCheck('nonwarr', cltv, { property_type: 'Condo', non_warrantable: true }, 'non_warrantable', LP_TABLES.NONWARR_BY_CLTV[i]);
});
ok(addOk === addChk, `all ${addChk} add-on (cash-out/condo/units/io/escrow/non-warrantable) values reproduce Lender Price${addMiss.length ? ' — ' + addMiss.slice(0, 5).join(' | ') : ''}`);
// a non-add-on scenario carries NONE of the add-on dimensions (the predicates never fire)
const plain = addonAt(70, {});
ok(!(plain.m.cashout) && !(plain.m.property_type) && !(plain.m.units) && !(plain.m.interest_only) && !(plain.m.escrow_waiver) && !(plain.m.non_warrantable) && !(plain.m.loan_amount), 'a plain purchase SFR fires no add-on LLPA');
// a NON-warrantable condo emits the Non-Warrantable line INSTEAD of the plain Condo line (measured).
const nwCondo = addonAt(75, { property_type: 'Condo', non_warrantable: true });
ok(nwCondo.eligible && nwCondo.m.non_warrantable === 1000 && !nwCondo.m.property_type, 'a non-warrantable condo fires Non-Warrantable (+1.000 @75) and SUPPRESSES the Condo line');

// ---- loan-amount family (2D: tier × CLTV), measured 2026-08-17 -------------------------------
// a dedicated helper sizes value so the loan lands squarely in a CLTV band AND a loan-amount tier.
function loanAmtAt(loan, cltv) {
  const value = Math.round(loan / (cltv / 100));
  return stack({ fico: 760, loan, value, ltv: cltv * 1000, dscr: 1250, state: 'CA', purpose: 'purchase', loan_amount: loan });
}
let laOk = 0; let laChk = 0; const laMiss = [];
function laCheck(label, loan, cltv, i, table) {
  laChk += 1;
  const exp = table[i]; // number (a real value), 0 (no line), or null (n/e — the matching container declines)
  const s = loanAmtAt(loan, cltv);
  const got = s.eligible ? (s.m.loan_amount || 0) : 'ineligible';
  // a null (n/e) band: our sheet emits no priced line (the inferred LTV cap is a separate open item), so
  // we assert NO loan_amount line there — never a guessed price.
  const want = (exp == null) ? 0 : Math.round(exp * 1000);
  if (got === want) laOk += 1; else laMiss.push(`${label} cltv${cltv}: want ${want} got ${got}`);
}
ADDON_CLTV.forEach((cltv, i) => {
  laCheck('loan>1.5M', 1600000, cltv, i, LP_TABLES.LOANAMT_GT_1_5M_BY_CLTV);
  laCheck('loan>2.0M', 2100000, cltv, i, LP_TABLES.LOANAMT_GT_2_0M_BY_CLTV);
  laCheck('loan<150k', 140000, cltv, i, LP_TABLES.LOANAMT_LT_150K_BY_CLTV);
  laCheck('loan<125k', 120000, cltv, i, LP_TABLES.LOANAMT_LT_125K_BY_CLTV);
});
ok(laOk === laChk, `all ${laChk} loan-amount (>1.5M / >2M / <150k / <125k × CLTV) values reproduce Lender Price${laMiss.length ? ' — ' + laMiss.slice(0, 6).join(' | ') : ''}`);
// tier selection is mutually exclusive: $2.1M fires the >2.0M tier, NOT >1.5M; $120k fires <125k, NOT <150k.
const t21 = loanAmtAt(2100000, 60); const t120 = loanAmtAt(120000, 50);
ok(t21.m.loan_amount === 375 && t120.m.loan_amount === 1750, 'loan-amount tiers are mutually exclusive (most-specific fires: $2.1M→>2M @60=0.375, $120k→<125k @50=1.750)');

// ---- base price ladder (price = 100 − basePoints) ---------------------------------------------
const l = stack({ fico: 780, loan: 350000, value: 500000, ltv: 70000, dscr: 1250, state: 'CA', purpose: 'purchase', loan_amount: 350000 }).ladder;
const r675 = l.find((x) => x.rate === 6750);
const r950 = l.find((x) => x.rate === 9500);
ok(r675 && r675.basePriceMilli === 102600, 'coupon 6.750 → base price 102.600 (100 − −2.600)');
ok(r950 && r950.basePriceMilli === 109927, 'coupon 9.500 → base price 109.927');

// ---- the eligibility envelope (§10 disqualify reasons) -----------------------------------------
ok(sheet.ineligibilities.length === 13, 'ineligibilities = 4 N/A boxes + 9 explicit bound rules (min-loan is now DSCR-split)');
function declines(sc, re) { const s = stack(sc); return !s.eligible && s.declines.some((d) => re.test(d.reason)); }
ok(declines({ fico: 600, loan: 350000, value: 500000, ltv: 70000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 350000 }, /Min FICO 640/), 'FICO 600 declines: Min FICO 640');
ok(declines({ fico: 760, loan: 425000, value: 500000, ltv: 85000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 425000 }, /Max LTV/), 'LTV 85% declines: Max LTV 80%');
ok(declines({ fico: 760, loan: 350000, value: 500000, ltv: 70000, dscr: 600, state: 'NY', purpose: 'purchase', loan_amount: 350000 }, /Minimum DSCR/), 'DSCR 0.60 declines: Min DSCR 0.75');
ok(declines({ fico: 760, loan: 60000, value: 100000, ltv: 60000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 60000 }, /Minimum Loan/), 'loan $60k declines: Min loan $75,000');
ok(declines({ fico: 760, loan: 3500000, value: 5000000, ltv: 70000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 3500000 }, /Maximum Loan/), 'loan $3.5M declines: Max loan $2.5MM');
ok(declines({ fico: 690, loan: 400000, value: 500000, ltv: 80000, dscr: 900, state: 'NY', purpose: 'purchase', loan_amount: 400000 }, /LTV 70%|LTV 75%|Not eligible/), 'DSCR<1.00 + weak FICO + high LTV declines');

// ---- MIN LOAN is DSCR-GATED (R10 divergence A): $75k for DSCR>=1.00, $200k for DSCR<1.00 ---------
// The old flat $75k min priced a sub-$200k loan under 1.00 DSCR that the matrix declines.
ok(declines({ fico: 760, loan: 150000, value: 250000, ltv: 60000, dscr: 900, state: 'NY', purpose: 'purchase', loan_amount: 150000 }, /Minimum Loan Amount \$200,000/),
  'loan $150k @ DSCR 0.90 declines: Min loan $200,000 (DSCR<1.00) — was WRONGLY pricing before');
ok(stack({ fico: 760, loan: 250000, value: 500000, ltv: 50000, dscr: 900, state: 'NY', purpose: 'purchase', loan_amount: 250000 }).eligible,
  'loan $250k @ DSCR 0.90 still prices (above the $200k DSCR<1.00 min)');
ok(stack({ fico: 760, loan: 90000, value: 150000, ltv: 60000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 90000 }).eligible,
  'loan $90k @ DSCR 1.25 still prices ($75k min applies at DSCR>=1.00)');
ok(declines({ fico: 760, loan: 60000, value: 120000, ltv: 50000, dscr: 900, state: 'NY', purpose: 'purchase', loan_amount: 60000 }, /Minimum Loan Amount \$200,000/),
  'loan $60k @ DSCR 0.90 declines on the $200k floor, not the $75k one');

// ---- L1↔L2 AGREEMENT on min-loan (the mirror must not drift) ------------------------------------
// The sheet's min-loan decision must match the independent Layer-2 matrix for every (loan, dscr) cell,
// so the two encodings of the same published rule can never disagree.
{
  const { evaluateEligibility } = require('../src/longterm/ppe/deephaven-matrix');
  let drift = 0;
  for (const dscr of [750, 900, 999, 1000, 1001, 1250, 1500]) {
    for (const loan of [50000, 74999, 75000, 150000, 199999, 200000, 300000]) {
      const facts = { fico: 760, ltv: 60000, dscr, loan_amount: loan, value: loan * 2, purpose: 'purchase', state: 'CA', units: 1 };
      const l1MinLoan = stack(facts).eligible === false && (stack(facts).declines || []).some((d) => /Minimum Loan/.test(d.reason));
      const l2 = evaluateEligibility(facts);
      const l2MinLoan = (l2.reasons || []).some((r) => /min_loan/.test(r.code));
      if (l1MinLoan !== l2MinLoan) drift += 1;
    }
  }
  ok(drift === 0, 'L1 sheet and L2 matrix AGREE on the min-loan decline across every (loan, dscr) cell (no drift)');
}
// eligible controls STILL price (the bounds do not over-reach)
ok(stack({ fico: 780, loan: 350000, value: 500000, ltv: 70000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 350000 }).eligible, 'a clean 780/70/1.25 still prices');
ok(stack({ fico: 640, loan: 250000, value: 500000, ltv: 50000, dscr: 1250, state: 'NY', purpose: 'purchase', loan_amount: 250000 }).eligible, 'FICO 640 at the boundary still prices (min is 640, not >640)');
ok(stack({ fico: 760, loan: 350000, value: 500000, ltv: 70000, dscr: 950, state: 'CA', purpose: 'purchase', loan_amount: 350000 }).eligible, 'DSCR 0.95 at 70% LTV still prices (within the <1.00 caps)');

// ---- what is deliberately NOT in the sheet is recorded (never guessed) --------------------------
ok(Array.isArray(UNMEASURED) && UNMEASURED.length >= 3, 'UNMEASURED lists the axes deliberately not encoded yet (loan-amount n/e cells, the deferred prepay-structure LLPA, SFR non-warrantable, cashout-<720@80)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
