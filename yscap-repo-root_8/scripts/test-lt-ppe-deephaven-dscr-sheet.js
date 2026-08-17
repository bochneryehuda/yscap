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
ok(sheet.ineligibilities.length === 4, 'four N/A ineligibility boxes (680/80, 660/80, 640/75, 640/80)');

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

// ---- base price ladder (price = 100 − basePoints) ---------------------------------------------
const l = stack({ fico: 780, loan: 350000, value: 500000, ltv: 70000, dscr: 1250, state: 'CA', purpose: 'purchase', loan_amount: 350000 }).ladder;
const r675 = l.find((x) => x.rate === 6750);
const r950 = l.find((x) => x.rate === 9500);
ok(r675 && r675.basePriceMilli === 102600, 'coupon 6.750 → base price 102.600 (100 − −2.600)');
ok(r950 && r950.basePriceMilli === 109927, 'coupon 9.500 → base price 109.927');

// ---- what is deliberately NOT in the sheet is recorded (never guessed) --------------------------
ok(Array.isArray(UNMEASURED) && UNMEASURED.length >= 4, 'UNMEASURED lists the axes deliberately not encoded yet (cash-out/condo/loan-amount/prepay/IO/units/bounds)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
