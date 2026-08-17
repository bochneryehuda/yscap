#!/usr/bin/env node
'use strict';
/**
 * LT PPE — OUR Deephaven DSCR sheet-under-test (deephaven-dscr-sheet.js), validated against the REAL
 * rate sheet (docs/longterm/ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json) and against
 * the live Lender Price prices it must reproduce.
 *
 * ⛔ WHY THIS SUITE WAS REWRITTEN — READ BEFORE ADDING AN ASSERTION.
 * The previous version asserted that our engine reproduced Lender Price's ITEMIZED MAGNITUDES, and it
 * passed 44/44 on a sheet that mispriced every strong-credit loan by twice the cell value. LP DISPLAYS
 * an absolute magnitude and does not carry the direction; the direction lives on the rate sheet. So a
 * suite that compares magnitudes is blind to exactly the defect that mattered.
 *
 * THE RULE HERE: **assert on the PRICE, never on the magnitude.** Every money assertion below either
 * compares a composed PRICE against a live Lender Price measurement, or asserts which WAY the price
 * moves (a credit must IMPROVE it, a charge must WORSEN it). A sign flip anywhere fails this suite.
 *
 * The two price figures, and why we compare on the first:
 *   rawPriceMilli   = base − Σcost − margin − comp + srp — the sheet's true composed price.
 *   finalPriceMilli = the above after the pricer's DISPLAY rounding (nearest 1/8 by default).
 * LP's own quotes are NOT eighth-rounded (105.175 / 105.675 are not multiples of 0.125), so the raw
 * price is the one that ties out to LP. Rounding is an open item recorded in the sheet's UNMEASURED.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { buildDeephavenGrid, SHEET_TABLES, UNMEASURED } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { quoteProgram } = require('../src/longterm/ppe/quote');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — Deephaven DSCR sheet: the PRICE agrees with the rate sheet and with Lender Price\n');

const sheet = gridToRateSheet(buildDeephavenGrid());
ok(sheet.problems.length === 0, `grid builds with no problems (${JSON.stringify(sheet.problems.slice(0, 3))})`);
ok(sheet.basePrices.length === 28, '28 base-price coupons');

const program = rateSheetToProgram(sheet, { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
const S = { 'pricing.correspondent_margin_milli': 0, 'pricing.rounding_mode': 'none' };
const RATE = 7500; // the coupon every live probe was taken at

function quote(sc) { return quoteProgram({ scenario: sc, program, settings: S }); }
// The composed price at 7.500, in points. null when the scenario is ineligible.
function priceAt(sc) {
  const r = quote(sc);
  if (!r.eligible) return null;
  const rung = r.ladder.find((x) => x.rate === RATE);
  return rung ? rung.rawPriceMilli / 1000 : null;
}
function declinesOf(sc) { const r = quote(sc); return r.eligible ? [] : (r.declines || []); }
// The bare base price at 7.500 — the sheet's own ladder, before any adjustment.
const BARE = (() => {
  const row = sheet.basePrices.find((b) => b.note_rate_milli_pct === RATE);
  if (!row) throw new Error('test setup: no base-price row at 7.500');
  return row.price_milli / 1000;
})();

// A scenario on a $500k property at a given whole CLTV. The .5-shifted bands put each whole CLTV
// squarely in the band Lender Price uses.
function sc(over = {}) {
  const cltv = over.cltv == null ? 50 : over.cltv;
  const value = over.value == null ? 500000 : over.value;
  const loan = over.loan == null ? Math.round(value * cltv / 100) : over.loan;
  const base = {
    fico: 760, loan, value, ltv: Math.round((loan / value) * 100000), dscr: 1200,
    state: 'CA', purpose: 'purchase', loan_amount: loan,
  };
  const out = { ...base, ...over };
  delete out.cltv;
  if (over.loan != null || over.value != null) {
    out.ltv = over.ltv != null ? over.ltv : Math.round((out.loan / out.value) * 100000);
    out.loan_amount = over.loan_amount != null ? over.loan_amount : out.loan;
  }
  return out;
}

// ═══ 1. THE LIVE LENDER PRICE ANCHOR — the probe that exposed the defect ═══════════════════════════
// FICO 760 / CLTV 50% / NY / coupon 7.500, only the DSCR moving. These four prices were measured live
// from Lender Price on 2026-08-17 and are the ground truth the whole sheet is built to reproduce.
const LIVE = [
  { dscr: 1300, price: 105.925, note: 'DSCR 1.30 — a 0.25 CREDIT' },
  { dscr: 1200, price: 105.675, note: 'DSCR 1.20 — baseline' },
  { dscr: 1100, price: 105.675, note: 'DSCR 1.10 — baseline (the 1.00–1.14 band, settled live)' },
  { dscr: 950, price: 104.925, note: 'DSCR 0.95 — a 0.75 CHARGE' },
];
for (const c of LIVE) {
  const got = priceAt(sc({ cltv: 50, state: 'NY', dscr: c.dscr }));
  ok(got === c.price, `LIVE LP: ${c.note} → price ${c.price} (got ${got})`);
}
// The itemized total LP reports for that same loan: adjustmentPoints = −0.5, which is exactly
// −(0.875 credit) + (0.375 NY charge). This is the arithmetic that proved the reading.
{
  const rung = quote(sc({ cltv: 50, state: 'NY', dscr: 1200 })).ladder.find((x) => x.rate === RATE);
  ok(rung.adjustmentPointsMilli === -500, `LIVE LP: adjustmentPoints = −0.5 (got ${rung.adjustmentPointsMilli / 1000})`);
}

// ═══ 2. DIRECTION — a credit must IMPROVE the price, a charge must WORSEN it ═══════════════════════
// This is the whole lesson: the old suite compared magnitudes and was blind to every one of these.
const baseline = priceAt(sc({ cltv: 50, dscr: 1200 })); // FICO 760, CLTV 50, CA, DSCR 1.20

// FICO 760 @ 50 CLTV is a CREDIT of +0.875 → it must IMPROVE the price above a bare base.
{
  ok(baseline > BARE, `FICO 760 @ 50 CLTV IMPROVES the price (${BARE} → ${baseline})`);
  ok(baseline - BARE === 0.875, `…by exactly the sheet's +0.875 credit (got ${(baseline - BARE).toFixed(3)})`);
}
// FICO 760 @ 80 CLTV is a CHARGE of −1.125 → it must WORSEN the price.
{
  const hi = priceAt(sc({ cltv: 80, dscr: 1200 }));
  ok(hi < BARE, `FICO 760 @ 80 CLTV WORSENS the price (${BARE} → ${hi})`);
  ok(BARE - hi === 1.125, `…by exactly the sheet's −1.125 charge (got ${(BARE - hi).toFixed(3)})`);
}
// A strong DSCR must IMPROVE the price. (The old suite asserted this as a 0.25 CHARGE.)
ok(priceAt(sc({ cltv: 50, dscr: 1300 })) > baseline, 'a strong DSCR (≥1.25) IMPROVES the price');
ok(priceAt(sc({ cltv: 50, dscr: 1300 })) - baseline === 0.25, '…by exactly +0.25');
ok(priceAt(sc({ cltv: 50, dscr: 950 })) < baseline, 'a weak DSCR (<1.00) WORSENS the price');
// NY must WORSEN the price.
ok(priceAt(sc({ cltv: 50, dscr: 1200, state: 'NY' })) < baseline, 'NY WORSENS the price');
ok(baseline - priceAt(sc({ cltv: 50, dscr: 1200, state: 'NY' })) === 0.375, '…by exactly 0.375');
for (const st of ['NJ', 'MA', 'DC']) {
  ok(priceAt(sc({ cltv: 50, dscr: 1200, state: st })) < baseline, `${st} WORSENS the price`);
}
for (const st of ['CA', 'FL', 'TX']) {
  ok(priceAt(sc({ cltv: 50, dscr: 1200, state: st })) === baseline, `${st} leaves the price unchanged`);
}
// Better credit must never price worse than weaker credit at the same leverage.
{
  let mono = true;
  const FICO_REP = [800, 770, 750, 730, 710, 690, 670, 645];
  for (const cltv of [50, 55, 60, 65, 70]) {
    let prev = Infinity;
    for (const f of FICO_REP) {
      const p = priceAt(sc({ cltv, fico: f, dscr: 1200 }));
      if (p == null) continue;
      if (p > prev + 1e-9) mono = false;
      prev = p;
    }
  }
  ok(mono, 'price is monotonic in FICO: a stronger score never prices worse at the same leverage');
}
// Higher leverage must never price better than lower leverage at the same score.
{
  let mono = true;
  for (const f of [800, 770, 750, 730, 710]) {
    let prev = Infinity;
    for (const cltv of [50, 55, 60, 65, 70, 75, 80]) {
      const p = priceAt(sc({ cltv, fico: f, dscr: 1200 }));
      if (p == null) continue;
      if (p > prev + 1e-9) mono = false;
      prev = p;
    }
  }
  ok(mono, 'price is monotonic in CLTV: more leverage never prices better at the same score');
}

// ═══ 3. EVERY FICO×CLTV CELL MOVES THE PRICE BY THE SHEET'S OWN SIGNED VALUE ═══════════════════════
// Asserted against SHEET_TABLES (the Excel), on the PRICE — so a flipped sign fails here, cell by cell.
{
  const FICO_REP = [800, 770, 750, 730, 710, 690, 670, 645];
  let checked = 0; let good = 0; const miss = [];
  SHEET_TABLES.FICO_CLTV.forEach((row, fi) => {
    row.forEach((cell, ci) => {
      const cltv = [50, 55, 60, 65, 70, 75, 80][ci];
      const p = priceAt(sc({ cltv, fico: FICO_REP[fi], dscr: 1200 }));
      checked += 1;
      if (cell == null) {
        if (p == null) good += 1; else miss.push(`fico${FICO_REP[fi]}/cltv${cltv}: expected an N/A decline, priced ${p}`);
        return;
      }
      const delta = p == null ? null : +(p - BARE).toFixed(6);
      if (delta === cell) good += 1;
      else miss.push(`fico${FICO_REP[fi]}/cltv${cltv}: sheet ${cell}, price moved ${delta}`);
    });
  });
  ok(good === checked, `all ${checked} FICO×CLTV cells move the PRICE by the sheet's own signed value${miss.length ? ' — ' + miss.slice(0, 4).join(' | ') : ''}`);
}

// ═══ 4. THE ADD-ON FAMILIES — each moves the price the way the sheet says ══════════════════════════
{
  const CLTVS = [50, 55, 60, 65, 70, 75, 80];
  // Each family is [label, sheet table, HOLD, TRIGGER]. HOLD is applied to BOTH sides so the only
  // difference between them is the family itself — otherwise the cash-out <720 case (which moves FICO
  // to 700) would fold the FICO cell's own change into the delta and report a false mismatch.
  const FAMILIES = [
    ['cash-out ≥720', SHEET_TABLES.CASHOUT_GE720, { fico: 760 }, { purpose: 'cashout' }],
    ['cash-out <720', SHEET_TABLES.CASHOUT_LT720, { fico: 700 }, { purpose: 'cashout' }],
    ['condo', SHEET_TABLES.CONDO, {}, { property_type: 'Condo', non_warrantable: false }],
    ['2–4 units', SHEET_TABLES.UNITS, {}, { property_type: 'Unit2_4', units: 2 }],
    ['interest only', SHEET_TABLES.IO, {}, { interest_only: true }],
    ['escrow waiver', SHEET_TABLES.ESCROW, {}, { escrow_waiver: true }],
    ['non-warrantable', SHEET_TABLES.NONWARR, {}, { property_type: 'Condo', non_warrantable: true }],
    ['SHORT-TERM RENTAL', SHEET_TABLES.SHORT_TERM_RENTAL, {}, { short_term_rental: true }],
  ];
  let checked = 0; let good = 0; const miss = [];
  let allWorsen = true;
  for (const [label, table, hold, trigger] of FAMILIES) {
    CLTVS.forEach((cltv, i) => {
      const want = table[i];
      const plain = priceAt(sc({ cltv, dscr: 1200, ...hold }));
      const withIt = priceAt(sc({ cltv, dscr: 1200, ...hold, ...trigger }));
      checked += 1;
      // A null band is the sheet's own N/A. Our sheet prices no line there (the LTV cap is a separate
      // open item), so the price must be UNCHANGED — never a guessed charge.
      const expect = want == null ? 0 : want;
      if (plain == null || withIt == null) { miss.push(`${label} cltv${cltv}: ineligible`); return; }
      const delta = +(withIt - plain).toFixed(6);
      if (delta === expect) good += 1;
      else miss.push(`${label} cltv${cltv}: sheet ${want}, price moved ${delta}`);
      if (want && withIt >= plain) allWorsen = false;
    });
  }
  ok(good === checked, `all ${checked} add-on values move the PRICE by the sheet's own signed value${miss.length ? ' — ' + miss.slice(0, 5).join(' | ') : ''}`);
  ok(allWorsen, 'every add-on family (cash-out / condo / units / IO / escrow / non-warrantable / STR) WORSENS the price');
}

// ═══ 5. THE TWO ROWS ADDED FROM THE SHEET ═════════════════════════════════════════════════════════
// Short-Term Rental — −0.5 across CLTV, N/A at 80%.
{
  const plain = priceAt(sc({ cltv: 65, dscr: 1200 }));
  const str = priceAt(sc({ cltv: 65, dscr: 1200, short_term_rental: true }));
  ok(str < plain, 'Short-Term Rental WORSENS the price');
  ok(+(plain - str).toFixed(6) === 0.5, '…by exactly the sheet\'s 0.5 (got ' + (plain - str).toFixed(3) + ')');
  const p80 = priceAt(sc({ cltv: 80, dscr: 1200 }));
  const s80 = priceAt(sc({ cltv: 80, dscr: 1200, short_term_rental: true }));
  ok(p80 === s80, 'Short-Term Rental @ 80% CLTV is the sheet\'s N/A — no priced line, never a guessed charge');
  // and a scenario that is NOT a short-term rental is untouched
  ok(priceAt(sc({ cltv: 65, dscr: 1200, short_term_rental: false })) === plain, 'a non-STR scenario is untouched');
}
// Loan amount < 250,000 — zero in every band EXCEPT 80% CLTV (−0.125).
{
  // $200k loan lands in the 150k–250k tier. Size the value so the CLTV lands where we want it.
  const at = (cltv) => priceAt(sc({ loan: 200000, value: Math.round(200000 / (cltv / 100)), cltv, dscr: 1200 }));
  const ref = (cltv) => priceAt(sc({ loan: 300000, value: Math.round(300000 / (cltv / 100)), cltv, dscr: 1200 }));
  let zeroOk = true;
  for (const cltv of [50, 55, 60, 65, 70, 75]) { if (at(cltv) !== ref(cltv)) zeroOk = false; }
  ok(zeroOk, 'loan < 250,000 costs NOTHING at CLTV 50–75 (the sheet\'s zero bands)');
  ok(+(ref(80) - at(80)).toFixed(6) === 0.125, 'loan < 250,000 @ 80% CLTV WORSENS the price by exactly 0.125');
  // tier boundaries: $150k is in the <250k tier, $149,999 falls to the <150k tier (a far bigger charge)
  const justUnder = priceAt(sc({ loan: 149999, value: Math.round(149999 / 0.8), cltv: 80, dscr: 1200 }));
  const justOver = priceAt(sc({ loan: 150000, value: Math.round(150000 / 0.8), cltv: 80, dscr: 1200 }));
  ok(justOver > justUnder, 'the <250k / <150k tier boundary bites at exactly $150,000');
}

// ═══ 6. THE SHEET IS THE SOURCE OF TRUTH — every encoded value traces to the JSON ══════════════════
// Reads the extraction itself and proves our tables ARE its cells. A hand-edited number fails here.
{
  const jsonPath = path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'matrices', 'deephaven-dscr-ratesheet-corr-t0.json');
  const J = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const na = (v) => (v === 'N/A' ? null : v);
  // FICO×CLTV — the first 8 rows (the 9th is Foreign National, deliberately not encoded).
  const jFico = J.priceAdjustmentsFicoByCltv.rows.slice(0, 8).map((r) => r.byCltv.map(na));
  ok(JSON.stringify(jFico) === JSON.stringify(SHEET_TABLES.FICO_CLTV), 'FICO×CLTV matches the rate-sheet JSON cell for cell');
  ok(J.priceAdjustmentsFicoByCltv.rows[8].label === 'Foreign National', 'the 9th row is Foreign National (deliberately not encoded — see UNMEASURED)');
  // DSCR
  const jDscr = J.priceAdjustmentsDscr.rows;
  ok(jDscr[0].byCltv.every((v) => v === SHEET_TABLES.DSCR_GE125), 'DSCR ≥1.25 matches the JSON (+0.25 flat, a CREDIT)');
  ok(jDscr[1].byCltv.every((v) => v === 0), 'the JSON middle DSCR band is 0 (baseline, no entry)');
  ok(JSON.stringify(jDscr[2].byCltv.slice(0, 6)) === JSON.stringify(SHEET_TABLES.DSCR_LT100_BY_CLTV.map((s) => s.sheet)), 'DSCR <1.00 matches the JSON');
  // the Other block, by the sheet's own labels
  const other = {};
  for (const r of J.priceAdjustmentsOther.rows) other[r.label] = r.byCltv.map(na);
  const PAIRS = [
    ['Short-Term Rental', SHEET_TABLES.SHORT_TERM_RENTAL], ['< 125,000', SHEET_TABLES.LOANAMT_LT_125K],
    ['< 150,000', SHEET_TABLES.LOANAMT_LT_150K], ['< 250,000', SHEET_TABLES.LOANAMT_LT_250K],
    ['> 1,500,000', SHEET_TABLES.LOANAMT_GT_1_5M], ['> 2,000,000', SHEET_TABLES.LOANAMT_GT_2_0M],
    ['Cash-Out | FICO ≥ 720', SHEET_TABLES.CASHOUT_GE720], ['Cash-Out | FICO < 720', SHEET_TABLES.CASHOUT_LT720],
    ['Interest Only', SHEET_TABLES.IO], ['2-4 Units', SHEET_TABLES.UNITS], ['Condo', SHEET_TABLES.CONDO],
    ['Escrow Waiver', SHEET_TABLES.ESCROW], ['Non-Warrantable', SHEET_TABLES.NONWARR],
  ];
  let traced = 0; const untraced = [];
  for (const [label, ours] of PAIRS) {
    if (JSON.stringify(other[label]) === JSON.stringify(ours)) traced += 1; else untraced.push(label);
  }
  ok(traced === PAIRS.length, `all ${PAIRS.length} "Other" rows match the rate-sheet JSON${untraced.length ? ' — off: ' + untraced.join(', ') : ''}`);
  ok(other['State**'].every((v) => v === SHEET_TABLES.STATE), 'the state adder matches the JSON (−0.375 flat)');
  // and the JSON's own declared convention is the one this sheet is built on
  ok(/PREMIUM-POSITIVE/.test(J._signConvention) && /NO negation/i.test(J._signConvention),
    'the JSON declares PREMIUM-POSITIVE with NO negation — the convention this sheet now follows');
}

// ═══ 7. ELIGIBILITY — unchanged by this work, re-proven on the price ═══════════════════════════════
ok(sheet.ineligibilities.filter((i) => i.dimension === 'fico_cltv_dscr').length === 4, 'four N/A grid boxes decline (680/80, 660/80, 640/75, 640/80)');
ok(sheet.ineligibilities.length === 13, 'ineligibilities = 4 N/A boxes + 9 explicit bound rules');
function declines(scn, re) { return declinesOf(scn).some((d) => re.test(d.reason)); }
ok(declines(sc({ cltv: 70, fico: 600, dscr: 1250, state: 'NY' }), /Min FICO 640/), 'FICO 600 declines: Min FICO 640');
ok(declines(sc({ cltv: 85, dscr: 1250, state: 'NY' }), /Max LTV/), 'LTV 85% declines: Max LTV 80%');
ok(declines(sc({ cltv: 70, dscr: 600, state: 'NY' }), /Minimum DSCR/), 'DSCR 0.60 declines: Min DSCR 0.75');
ok(declines(sc({ loan: 60000, value: 100000, cltv: 60, dscr: 1250 }), /Minimum Loan/), 'loan $60k declines: Min loan $75,000');
ok(declines(sc({ loan: 3500000, value: 5000000, cltv: 70, dscr: 1250 }), /Maximum Loan/), 'loan $3.5M declines: Max loan $2.5MM');
ok(declines(sc({ loan: 150000, value: 250000, cltv: 60, dscr: 900 }), /Minimum Loan Amount \$200,000/), 'loan $150k @ DSCR 0.90 declines on the $200k DSCR<1.00 floor');
ok(priceAt(sc({ loan: 250000, value: 500000, cltv: 50, dscr: 900 })) != null, 'loan $250k @ DSCR 0.90 still prices');
ok(priceAt(sc({ loan: 90000, value: 150000, cltv: 60, dscr: 1250 })) != null, 'loan $90k @ DSCR 1.25 still prices');
// L1 ↔ L2 min-loan agreement (the two encodings of one published rule must not drift)
{
  const { evaluateEligibility } = require('../src/longterm/ppe/deephaven-matrix');
  let drift = 0;
  for (const dscr of [750, 900, 999, 1000, 1001, 1250, 1500]) {
    for (const loan of [50000, 74999, 75000, 150000, 199999, 200000, 300000]) {
      const facts = { fico: 760, ltv: 60000, dscr, loan_amount: loan, value: loan * 2, purpose: 'purchase', state: 'CA', units: 1 };
      const l1 = declinesOf(facts).some((d) => /Minimum Loan/.test(d.reason));
      const l2 = (evaluateEligibility(facts).reasons || []).some((r) => /min_loan/.test(r.code));
      if (l1 !== l2) drift += 1;
    }
  }
  ok(drift === 0, 'L1 sheet and L2 matrix AGREE on the min-loan decline across every (loan, dscr) cell');
}

// ═══ 8. WHAT IS DELIBERATELY NOT ENCODED IS RECORDED (never guessed) ══════════════════════════════
ok(Array.isArray(UNMEASURED) && UNMEASURED.length >= 8, `UNMEASURED records every axis left out (${UNMEASURED.length} entries)`);
ok(UNMEASURED.some((u) => /PREPAY/i.test(u)), 'UNMEASURED records the prepay LLPA family as out of scope');
ok(UNMEASURED.some((u) => /MAX-PRICE/i.test(u)), 'UNMEASURED records the max-price caps as out of scope');
ok(UNMEASURED.some((u) => /LOCK-TERM/i.test(u)), 'UNMEASURED records lock/extension pricing as out of scope');
ok(UNMEASURED.some((u) => /BASE LADDER/i.test(u)), 'UNMEASURED records the unexplained 0.25 base-ladder gap vs Lender Price');
ok(UNMEASURED.some((u) => /Foreign National/i.test(u)), 'UNMEASURED records the un-encoded Foreign National row');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
