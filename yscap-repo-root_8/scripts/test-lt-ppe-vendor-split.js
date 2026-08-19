#!/usr/bin/env node
'use strict';
/**
 * LT PPE — LENDER PRICE PRICES A LOAN AND REFUSES IT AT THE SAME TIME (§2.113).
 *
 * ⛔ WHAT THE CAPTURED BYTES SAY. §2.112 turned the raw sink on and the first live disqualify trees
 * landed. Replayed offline — free, on the vendor's own payload — for the scenario
 * `fico=660 cltv=75 dscr=1.25`, scoped to Deephaven Mortgage `^dscr`:
 *
 *   PRICED    "DSCR < 1.00  -  30 Yr Fixed"      28 rungs, lpNorm.eligible = true
 *   REFUSED   "DSCR  1.00-1.24   -  30 Yr Fixed"     and   "DSCR  >= 1.25  - 30 Yr Fixed"
 *   ...in 56 rows describing those 2 containers — each refusal repeated exactly 28 times, once per
 *      coupon on the ladder, with the same sentence appearing two and three times inside a single row.
 *
 * TWO FINDINGS, and they are deliberately treated differently because only one of them is settled.
 *
 * ── 1. THE REPETITION IS A PLAIN DEFECT, AND IT CHANGED AN ANSWER ────────────────────────────────
 * Twenty-eight copies of one refusal is not twenty-eight refusals. Every consumer counted them as
 * such: the per-layer agreement / onlyOurs / onlyAuthority tallies, the container-partition count
 * (§2.107 printed the same sentence seven times over and the reason was this), and — the one that
 * actually moves a verdict — §2.108's same-dimension check, which reads a second row on one axis as a
 * SECOND RULE our sheet failed to state. Twenty-seven phantom `loan_amount` rules per scenario.
 * Collapsed on the FULL identity, so a genuinely different second refusal on the same program survives
 * — which is exactly what §2.108 exists to catch.
 *
 * ── 2. WHETHER A PRICE IS AN OFFER IS AN OPEN BUSINESS QUESTION, AND IT IS NOT ANSWERED HERE ─────
 * `ratesheet-agreement.js` computes `lpEligible = lpNorm.eligible && !lpDeclined`, and `lpDeclined` is
 * true when ANY in-scope program refused. On this sheet that is the NORMAL state of every loan, so
 * `lpEligible` is false essentially always, `agreedPriced` has been **0 in every report this harness
 * has ever produced**, and the battery has never once observed Lender Price APPROVING a loan.
 *
 * Two live measurements disagree about whether that is right:
 *   • 2026-08-17 — on four of six ineligible probes "the DSCR-matching container declined while a
 *     mismatched container leaked a price". Conclusion recorded in the code: do NOT read a Deephaven
 *     price as eligibility.
 *   • 2026-08-19 (§2.107) — the container NAME does not describe the loan's band (a DSCR 1.25 loan
 *     priced under `DSCR < 1.00`) and the band is priced by an ADJUSTMENT ROW inside the grid, so the
 *     three-way split is a configuration artifact rather than a pricing partition.
 *
 * Under the first the price is a leak; under the second it is a real offer and our sheet refusing it is
 * a disagreement in the EXPENSIVE direction — a loan the investor would fund that we turn away.
 * Flipping it on a guess would either manufacture a false disagreement on every scenario or keep hiding
 * a real one, and which is true is a question about how the investor's product works. **So the verdict
 * is NOT changed here.** What changes is that the choice stops being silent: every scenario reports
 * what Lender Price actually did, the summary counts the population the question governs, and the run
 * prints it. Section D pins the verdict as UNCHANGED, so a future flip has to be deliberate.
 *
 * PURE: no DB, no network, no credentials. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { normalizeLpDisqualified } = require('../src/longterm/ppe/lp-normalize-full');
const { runOne, summarize } = require('../src/longterm/ppe/ratesheet-agreement');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }
const done = (label) => {
  console.log(`${fails.length ? 'FAIL' : 'PASS'} — ${label}: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(fails.length ? 1 : 0);
};

const LIVE = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lp-vendor-split-live.json'), 'utf8'));
const FILTER = { investor: 'Deephaven Mortgage', programLike: '^dscr' };
// Rebuild the vendor's own shape from the fixture: each distinct refusal, repeated as many times as it
// really arrived. Reading the counts off the fixture rather than hard-coding 28 keeps the test honest
// if the ladder length ever changes.
const repeats = Math.round(LIVE.itemsInDscrScope / Math.max(1, LIVE.distinctInDscrScope));
function vendorTree(rows, times) {
  const items = [];
  for (let i = 0; i < times; i += 1) for (const r of rows) items.push({ program: r.program, reasons: (r.reasons || []).map((x) => ({ ...x })) });
  return { ready: true, lenders: [{ lender: LIVE.investor, investor: LIVE.investor, items }] };
}

// ---- A. THE PER-RUNG REPETITION IS COLLAPSED, AND SAID -------------------------------------------
ok(LIVE.itemsInDscrScope === 56 && LIVE.distinctInDscrScope === 2,
  `A1 the live capture really did carry ${LIVE.itemsInDscrScope} rows for ${LIVE.distinctInDscrScope} containers`);
ok(repeats === 28, `A2 …each repeated once per rung on the 28-coupon ladder — got ${repeats}`);
const norm = normalizeLpDisqualified(vendorTree(LIVE.distinctDeclined, repeats), FILTER);
ok(norm.declined.length === 2, `A3 the normalizer returns the 2 real refusals — got ${norm.declined.length}`);
ok(norm.rowsSeen === 56, `A4 …and says how many rows it saw — got ${norm.rowsSeen}`);
ok(norm.duplicatesCollapsed === 54,
  `A5 …and how many it folded away, so nothing is silently dropped — got ${norm.duplicatesCollapsed}`);
ok(norm.declined.map((d) => d.program).join('|') === LIVE.distinctDeclined.map((d) => d.program).join('|'),
  'A6 …keeping the vendor\'s own order, because a consumer that pairs by index reads it');

// ---- B. A GENUINELY DIFFERENT SECOND REFUSAL ON ONE PROGRAM SURVIVES -----------------------------
// ⛔ THE LOAD-BEARING CASE. §2.108 exists to catch a SECOND rule our sheet failed to state; a dedupe
// keyed on the program alone would eat exactly that and silently undo it. The identity is the program
// AND every reason, so only an exact repeat collapses.
const A = LIVE.distinctDeclined[0];
const second = { program: A.program, reasons: [{ rule: 'Minimum FICO 680', adjType: 'FicoRateAdjustment', group: null }] };
const withSecond = normalizeLpDisqualified(vendorTree([A, second, A, second], 3), FILTER);
ok(withSecond.declined.length === 2,
  `B1 two DIFFERENT refusals on one program both survive — got ${withSecond.declined.length}: ${JSON.stringify(withSecond.declined.map((d) => (d.reasons[0] || {}).rule))}`);
ok(withSecond.duplicatesCollapsed === 10, `B2 …while the 10 exact repeats collapse — got ${withSecond.duplicatesCollapsed}`);

// ---- C. THE SAME SENTENCE REPEATED INSIDE ONE ROW ------------------------------------------------
const dupInside = normalizeLpDisqualified({
  ready: true,
  lenders: [{ lender: LIVE.investor, investor: LIVE.investor, items: [{
    program: 'DSCR TEST', reasons: [
      { rule: 'Minimum DSCR .75%', adjType: 'DscrRateAdjustment', group: null },
      { rule: 'Minimum DSCR .75%', adjType: 'DscrRateAdjustment', group: null },
      { rule: 'Minimum FICO 680', adjType: 'FicoRateAdjustment', group: null },
      { rule: 'Minimum DSCR .75%', adjType: 'DscrRateAdjustment', group: null },
    ] }] }],
}, { investor: LIVE.investor, programLike: '^dscr' });
ok((dupInside.declined[0] || {}).reasons.length === 2,
  `C1 a sentence repeated inside one row is stated once — got ${JSON.stringify((dupInside.declined[0] || {}).reasons)}`);
ok(((dupInside.declined[0] || {}).reasons[0] || {}).rule === 'Minimum DSCR .75%',
  'C2 …with the FIRST sighting keeping its position, so index pairing still reads the vendor\'s order');

// ---- D. WHAT LENDER PRICE DID IS REPORTED — AND THE VERDICT IS UNCHANGED -------------------------
const SC = { _label: 'split', fico: 660, ltv: 75000, dscr: 1250, loan_amount: 375000 };
const OPTS = { filter: FILTER, settings: {}, coarseIgnore: ['final_price', 'llpa_total', 'margin'] };
const lpLeg = async () => ({
  full: { programs: [{
    lender: LIVE.investor, investor: LIVE.investor, program: LIVE.pricedPrograms[0].program,
    options: Array.from({ length: 4 }, (_, i) => ({
      priceBuild: { noteRate: 6.125 + i * 0.125, price: 96.6 + i * 0.5, basePoints: 0.75, adjustmentPoints: 0 }, adjustments: [],
    })),
  }] },
  disqualified: vendorTree(LIVE.distinctDeclined, repeats),
});
const ourDecline = async () => ({ eligible: false, ladder: [], declines: [{ code: 'dhvn_min_dscr', reason: 'Minimum DSCR 0.75', dimension: 'dscr', source: 'base' }] });

(async () => {
  const r = await runOne(SC, ourDecline, lpLeg, OPTS);
  ok(r.lpPriced === true, `D1 the run records that Lender Price PRICED it — got ${r.lpPriced}`);
  ok((r.lpPricedBy || []).join('|') === LIVE.pricedPrograms[0].program,
    `D2 …naming the container that did — got ${JSON.stringify(r.lpPricedBy)}`);
  ok((r.lpRefusedBy || []).length === 2,
    `D3 …and the two that refused — got ${JSON.stringify(r.lpRefusedBy)}`);
  ok(r.lpDeclineDuplicatesCollapsed === 54,
    `D4 …and how many per-rung repeats were folded — got ${r.lpDeclineDuplicatesCollapsed}`);
  // ⛔ THE VERDICT IS DELIBERATELY UNCHANGED. This build reports the choice; it does not make it. A
  // future flip must be a deliberate act with the owner's answer behind it, not a side effect.
  ok(r.lpEligible === false,
    `D5 the verdict is UNCHANGED — a priced loan whose sibling refused is still scored ineligible (§2.113 is REPORTED, not decided) — got ${r.lpEligible}`);

  const sum = summarize([r]);
  const vs = sum.vendorSplit || {};
  ok(vs.lpPricedWhileRefused === 1, `E1 the summary counts the split population — got ${vs.lpPricedWhileRefused}`);
  ok(vs.lpPricedNotCounted === 1,
    `E2 …and how many of those the run scored as a Lender Price decline — the sharp number — got ${vs.lpPricedNotCounted}`);
  ok(vs.declineDuplicatesCollapsed === 54, `E3 …and the folded repeats — got ${vs.declineDuplicatesCollapsed}`);
  ok(sum.agreedPriced === 0,
    `E4 …which is why agreedPriced is 0: no scenario in this shape can ever be a priced agreement — got ${sum.agreedPriced}`);

  // ---- F. THE RUN SAYS SO, AS A QUESTION ---------------------------------------------------------
  const runner = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
  ok(/vendorSplit/.test(runner), 'F1 the paid runner reads summary.vendorSplit');
  ok(/lpPricedWhileRefused/.test(runner) && /OPEN owner question/.test(runner),
    'F2 …and prints it as an OPEN question rather than a settled number');
  ok(/declineDuplicatesCollapsed/.test(runner),
    'F3 …and never stops saying how many repeats it folded away');

  done('vendor split + per-rung repeat guard');
})().catch((e) => {
  console.log('FAIL — vendor split guard: threw', e && e.stack ? e.stack : e);
  process.exit(1);
});
