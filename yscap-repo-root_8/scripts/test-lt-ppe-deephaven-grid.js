#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the rate-sheet GRID model (deephaven-grid.js), pure. Proves a human Deephaven-shaped grid
 * (RATE-SHEET-KNOWLEDGE §2) converts to the EXACT stored shape the built pipeline already prices, and
 * that it prices correctly end-to-end through the real `ratesheet.rateSheetToProgram` +
 * `quote.quoteProgram` (no DB). Also pins the three faithful-not-clever rules: N/A ≠ 0, explicit bands,
 * unit conventions (fico raw, ltv/dscr milli, loan-amount raw).
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { gridToRateSheet, rateSheetToGrid } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');

let pass = 0, fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

// A small Deephaven "Corr Flow" DSCR grid, using the shape of the real sheet (§2).
const GRID = {
  investor: 'deephaven', program: 'corr_flow_dscr', lockDays: 45, scale: 1000,
  terms: [{ key: '30yr_fixed', product: 'DH_DSCR_30F' }, { key: 'arm_15', product: 'DH_DSCR_15F_ARM' }],
  base: [
    { coupon: 6.750, prices: { '30yr_fixed': 102.850, arm_15: 101.900 } }, // §2 example: 6.750 → 102.850 (30Y)
    { coupon: 7.000, prices: { '30yr_fixed': 103.775 } },
  ],
  // FICO × CLTV, DSCR ≥ 1.25 band. Rows = FICO bands, cols = CLTV bands. A number is a points
  // adjustment; null = N/A (ineligible); 0 = eligible at par (a real, priced 0).
  ficoCltvByDscr: [
    {
      dscr: { min: 1.25, max: null },
      ficoBands: [{ min: 760, max: 780 }, { min: 780, max: null }],  // 760–779, 780+
      cltvBands: [{ min: 70, max: 75 }, { min: 75, max: 80 }],       // (70,75], (75,80]
      cells: [
        [0.000, null],     // 760–779: 70–75 par(0); 75–80 N/A
        [0.500, 0.375],    // 780+ : 70–75 +0.500; 75–80 +0.375
      ],
    },
  ],
  // Loan-amount tier LLPA — banded on the `loan_amount` fact (RAW dollars, never scaled to milli).
  llpaTables: [
    { dimension: 'loan_amount', fact: 'loan_amount', reason: 'small/large loan',
      bands: [{ min: null, max: 150000, adj: -1.500 }, { min: 1500000, max: null, adj: -1.000 }] },
    { dimension: 'purpose', predicate: { fact: 'purpose', op: 'eq', value: 'cashout' }, adj: -0.250, reason: 'cash-out' },
  ],
  priceLimit: { minPrice: 98.000, roundingMode: 'none' },
};

console.log('LT PPE — Deephaven rate-sheet grid model\n');
const R = gridToRateSheet(GRID);

// ---- no malformed input ---------------------------------------------------
ok(R.problems.length === 0, 'a well-formed grid produces zero problems');

// ---- base-price grid, exact milli -----------------------------------------
const bp = R.basePrices.find((b) => b.note_rate_milli_pct === 6750 && b.product === 'DH_DSCR_30F');
ok(bp && bp.price_milli === 102850 && bp.lock_days === 45, 'coupon 6.750 / 30Y → note 6750, price 102850, lock 45 (exact milli)');
ok(R.basePrices.length === 3, 'three base cells (6.750 has two products, 7.000 has one)');

// ---- FICO × CLTV × DSCR: the unit convention + N/A ≠ 0 ---------------------
const hi = R.adjustments.find((a) => a.dimension === 'fico_cltv_dscr' && a.fico_min === 780 && a.ltv_min === 70000);
ok(hi && hi.fico_min === 780 && hi.fico_max === null, 'FICO band is RAW (780, open top)');
ok(hi && hi.ltv_min === 70000 && hi.ltv_max === 75000, 'CLTV band is MILLI (70%→70000, 75%→75000)');
ok(hi && hi.dscr_min === 1250 && hi.dscr_max === null, 'DSCR band is MILLI (1.25→1250, open top)');
ok(hi && hi.adj_milli === -500 && hi.unit === 'points' && hi.cumulative === true, 'the +0.500 premium cell → -500 milli points (premium improves price)');

const par = R.adjustments.find((a) => a.dimension === 'fico_cltv_dscr' && a.fico_min === 760 && a.ltv_min === 70000);
ok(par && par.adj_milli === 0, 'a 0-value cell IS a priced adjustment (eligible at par) — 0 is not skipped');
const naElig = R.ineligibilities.find((e) => e.fico_min === 760 && e.ltv_min === 75000);
ok(!!naElig && naElig.kind === 'eligibility' && /Not eligible/.test(naElig.declineReason), 'an N/A cell → an INELIGIBILITY (decline), never a priced adjustment');
ok(!R.adjustments.some((a) => a.fico_min === 760 && a.ltv_min === 75000), '…and that N/A box is NOT in the pricing adjustments');

// ---- loan-amount tiers: predicate on loan_amount, RAW threshold -----------
const small = R.adjustments.find((a) => a.dimension === 'loan_amount' && a.predicate && a.predicate.op === 'lt');
ok(small && small.predicate.fact === 'loan_amount' && small.predicate.value === 150000 && small.adj_milli === 1500, 'small-loan tier -1.5 discount → predicate loan_amount<150000 (RAW), +1500 milli points');
const big = R.adjustments.find((a) => a.dimension === 'loan_amount' && a.predicate && a.predicate.op === 'gte');
ok(big && big.predicate.value === 1500000 && big.adj_milli === 1000, 'large-loan tier -1.0 discount → predicate loan_amount>=1500000 (RAW), +1000 milli points');
const co = R.adjustments.find((a) => a.dimension === 'purpose');
ok(co && co.predicate.value === 'cashout' && co.adj_milli === 250, 'a predicate+adj LLPA (cash-out -0.25 discount) → predicate verbatim, +250 milli points');

// ---- prices exactly through the REAL pipeline -----------------------------
// Scenario: 6.750 coupon deal, 30Y, FICO 780, CLTV 72% (ltv 72000), DSCR 1.30 (1300), $400k, 45-day.
// Hits base 102.850 + the 780×(70–75]×DSCR≥1.25 cell (+0.500); loan $400k in no tier; − margin 0.250.
const sheet = { version: { id: 'dh_corr_flow' }, basePrices: R.basePrices, adjustments: R.adjustments, priceLimit: R.priceLimit };
const program = rateSheetToProgram(sheet, { code: 'DH_DSCR', investorCode: 'DHVN' });
const SETTINGS = { 'pricing.correspondent_margin_milli': 250 };
const SCENARIO = { fico: 780, ltv: 72000, dscr: 1300, loan_amount: 400000, lock_days: 45, product: 'DH_DSCR_30F' };
const q = quoteProgram({ scenario: SCENARIO, program, settings: SETTINGS });
ok(q.eligible === true, 'the converted sheet prices (eligible)');
const rung = (q.ladder || []).find((r) => r.basePriceMilli === 102850);
ok(!!rung, 'the 6.750 / 30Y rung is present (102850 base)');
// 102.850 + 0.500 (fico×cltv×dscr) − 0.250 (margin) = 103.100
ok(rung && rung.finalPriceMilli === 103100, 'the rung prices to 103.100 (base 102.850 + 0.500 LLPA − 0.250 margin)');
ok(rung && rung.adjustments.some((a) => a.code === hi.code), 'the +0.500 LLPA is itemized on the rung by its stable code');

// ---- the INVERSE: sheet → grid → sheet' reproduces the same DATA (E3 editor) --
// The editor renders a stored sheet as a grid; saving an untouched grid must reproduce the same rules.
const grid2 = rateSheetToGrid({ basePrices: R.basePrices, adjustments: R.adjustments, ineligibilities: R.ineligibilities, priceLimit: R.priceLimit });
const R2 = gridToRateSheet(grid2);
ok(R2.problems.length === 0, 'the reconstructed grid re-converts with zero problems');
// base prices (data-only projection, order-independent)
const baseKey = (b) => `${b.note_rate_milli_pct}/${b.lock_days}/${b.product}/${b.price_milli}`;
ok(JSON.stringify(R.basePrices.map(baseKey).sort()) === JSON.stringify(R2.basePrices.map(baseKey).sort()), 'base prices round-trip exactly (rate, lock, product, price)');
// adjustments (data-only: bounds + predicate + adj_milli; codes are regenerable labels, not data)
const adjKey = (a) => `${a.dimension}|${a.fico_min}|${a.fico_max}|${a.ltv_min}|${a.ltv_max}|${a.dscr_min}|${a.dscr_max}|${JSON.stringify(a.predicate || null)}|${a.adj_milli}`;
ok(JSON.stringify(R.adjustments.map(adjKey).sort()) === JSON.stringify(R2.adjustments.map(adjKey).sort()), 'every adjustment round-trips exactly (bounds, predicate, signed adj_milli)');
// ineligibilities (the N/A boxes) round-trip in place
const inKey = (e) => `${e.fico_min}|${e.fico_max}|${e.ltv_min}|${e.ltv_max}|${e.dscr_min}|${e.dscr_max}`;
ok(JSON.stringify(R.ineligibilities.map(inKey).sort()) === JSON.stringify(R2.ineligibilities.map(inKey).sort()), 'the N/A (ineligible) boxes round-trip to the same cells');
ok(R2.ineligibilities.length === 1 && R.ineligibilities.length === 1, 'exactly the one N/A box survives the round trip (never lost, never multiplied)');

// ---- FAIL CLOSED: malformed input is a problem, never silently priced -----
const bad = gridToRateSheet({
  lockDays: 45, terms: [{ key: 't', product: 'P' }],
  base: [{ coupon: 6.5, prices: { t: 'oops' } }, { coupon: 'x', prices: {} }],
  ficoCltvByDscr: [{ dscr: { min: 1.25, max: 1.0 }, ficoBands: [{ min: 760, max: 780 }], cltvBands: [{ min: 70, max: 75 }], cells: [[0.1]] }],
  llpaTables: [{ dimension: 'x' }],
});
ok(bad.problems.some((p) => /price is not a number/.test(p.reason)), 'a non-numeric price is a problem, excluded');
ok(bad.problems.some((p) => /coupon is not a number/.test(p.reason)), 'a non-numeric coupon is a problem, excluded');
ok(bad.problems.some((p) => /not < max/.test(p.reason)), 'an inverted DSCR band (min≥max) is a problem, its block excluded');
ok(bad.problems.some((p) => /neither banded .* nor a predicate/.test(p.reason)), 'an llpa table that is neither banded nor predicate+adj is a problem');
ok(bad.adjustments.length === 0, 'nothing malformed leaked into the priced adjustments');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
