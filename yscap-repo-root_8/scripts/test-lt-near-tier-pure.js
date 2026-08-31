#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — "YOU ARE ALMOST AT A BETTER TIER" (pure, offline).
 *
 * Owner-directed 2026-08-30: *"You can make a nice flag that you're almost at
 * the edge. If you move down your loan amount a little bit, you can be in a
 * better tier, where every 5% is a better tier… Also, on the ratio, if the ratio
 * is almost at a tier, then you make a pop-up that if you enhance it a little
 * bit, you're in a better tier."*
 *
 * WHAT THIS SUITE IS REALLY GUARDING. The flag tells an officer to cut a
 * borrower's loan amount. So the two ways it can be wrong are both expensive and
 * both are pinned here: naming a tier that does not exist (somebody moves a loan
 * for nothing), and naming a loan amount that does not actually reach the tier
 * (they move it, re-price, land in the same band, and stop trusting the flag).
 * Every dollar figure it states is therefore re-run through the REAL rounding
 * rule the connectors send on, not merely computed.
 *
 * PROVEN TO FAIL: let an unreadable cell fall through to a guessed band and
 * CELL-* go red; drop the verification from `loanForTier` and REACH-* go red;
 * widen either window and WINDOW-* go red; let the sheet's band be mixed with
 * CLTV and BASIS-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const nt = require('../src/longterm/pricing/near-tier');
const tr = require('../src/longterm/pricing/tier-rounding');
const lp = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };

console.log('Almost at a better tier');

// The vendor's OWN words, copied verbatim from the live explain capture.
const LIVE_CELL = { label: 'DSCR Ranges (ND Only)', detail: 'LTV : 70.01% - 75.00%, DSCR : >= 1.25' };
const LIVE_CELL_2 = { label: 'FICO/CLTV (ND)', detail: 'FICO : 760 - 779, CLTV : 70.01% - 75.00%' };

// ---- A. THE TIER COMES OFF THE SHEET ----------------------------------------
console.log('\n== A. THE TIER IS THE SHEET\'S OWN, NOT A GUESS ==');
{
  const r = nt.nearTier({ value: 500000, loan: 352550, lines: [LIVE_CELL] }).ltv;
  ok(r && r.source === 'sheet' && r.tier === 70,
    `CELL-1 the investor's own cell "LTV : 70.01% - 75.00%" puts the better tier at 70.00 (got ${r && r.tier} from ${r && r.source})`);
  ok(r && r.cell === 'LTV : 70.01% - 75.00%' && /rate sheet states the band/.test(r.why),
    'CELL-2 …and the answer quotes the cell it read, so the claim can be checked against the quote it came from');
  ok(r && r.maxLoan === 350000 && r.reduceBy === 2550,
    `CELL-3 …and it states the exact loan that reaches it ($${r && r.maxLoan}) and the exact reduction ($${r && r.reduceBy})`);
}
{
  // An unreadable cell must contribute NOTHING — it must never be half-read into
  // a band, and the answer falls back to the standing steps and SAYS so.
  const r = nt.nearTier({ value: 500000, loan: 352550, lines: [{ detail: 'LTV: somewhere around seventy percent' }] }).ltv;
  ok(r && r.source === 'stated' && r.tier === 70,
    'CELL-4 a cell this cannot read contributes nothing and the answer falls back to the standing steps');
  ok(r && /standing 5% steps/.test(r.why),
    'CELL-5 …and it says which it used — "your sheet says so" and "our assumption says so" are different strengths of claim');
}
{
  // TWO cells that DISAGREE are not something to pick a winner from.
  const r = nt.nearTier({
    value: 500000, loan: 352550,
    lines: [{ detail: 'LTV : 70.01% - 75.00%' }, { detail: 'LTV : 65.01% - 80.00%' }],
  }).ltv;
  ok(r && r.source === 'stated',
    'CELL-6 two cells stating DIFFERENT bands for one loan fall back rather than choosing one');
}

// ---- B. LTV AND CLTV ARE NEVER MIXED ---------------------------------------
console.log('\n== B. LTV IS NOT CLTV ==');
{
  const only = nt.nearTier({ value: 500000, loan: 352550, lines: [LIVE_CELL_2] }).ltv;
  ok(only && only.source === 'sheet' && only.basis === 'CLTV',
    'BASIS-1 with only a CLTV band published, the answer uses it and SAYS it is the combined figure');
  const both = nt.nearTier({ value: 500000, loan: 352550, lines: [LIVE_CELL, LIVE_CELL_2] }).ltv;
  ok(both && both.basis === 'LTV',
    'BASIS-2 …and where the sheet states both, the first lien\'s own band wins — on a loan with subordinate financing they are different numbers');
}

// ---- C. THE LOAN AMOUNT REALLY REACHES THE TIER ----------------------------
console.log('\n== C. THE FIGURE IS PROVEN, NOT JUST COMPUTED ==');
{
  // ⛔ AWKWARD VALUES ARE THE POINT, and the first cut of this sweep used only
  // round ones — on which the naive `value * tier / 100` happens to be right, so
  // deleting the verification entirely left this suite GREEN (the mutation was
  // run; it did). A $100,000.37 property at the 70% tier gets a naive figure of
  // $70,000.26, which is sent as 70.01% and MISSES the tier it was supposed to
  // reach. So the sweep walks values with cents on them and steps that do not
  // divide evenly.
  let checked = 0, missed = 0, over = 0, firstMiss = null;
  const VALUES = [];
  for (let v = 125000; v <= 950000; v += 5000) VALUES.push(v);
  for (let v = 100000.37; v <= 260000; v += 311.13) VALUES.push(Math.round(v * 100) / 100);
  for (const value of VALUES) {
    for (const tier of [55, 60, 65, 70, 75, 80, 85]) {
      const loan = nt._internals.loanForTier(value, tier);
      if (loan == null) { missed++; continue; }
      checked++;
      // Sent the way BOTH programs really send it, it must land at or under the tier.
      const two = tr.sendAs('ltv', (loan / value) * 100, 2);
      const six = tr.sendAs('ltv', loan / value, 6) * 100;
      if (two > tier + 1e-9 || six > tier + 1e-9) { over++; if (!firstMiss) firstMiss = `${loan}/${value}@${tier}`; }
    }
  }
  // …and the sweep is proven to CONTAIN the hard cases, or "0 short" would be a
  // statement about an easy battery rather than about the code.
  {
    const r2v = (n) => Math.round(n * 100) / 100;
    let naiveMisses = 0;
    for (const value of VALUES) for (const tier of [55, 60, 65, 70, 75, 80, 85]) {
      const naive = r2v(value * tier / 100);
      if (tr.sendAs('ltv', (naive / value) * 100, 2) > tier + 1e-9) naiveMisses++;
    }
    ok(naiveMisses > 0,
      `REACH-0 the battery genuinely contains cases the arithmetic alone gets WRONG (${naiveMisses} of them) — without one, "every figure reaches its tier" would be true of a sweep that could not tell`);
  }
  ok(over === 0,
    `REACH-1 across ${checked} (value, tier) pairs every loan amount this states genuinely lands at or under the tier when sent (${over} short${firstMiss ? ', first ' + firstMiss : ''})`);
  ok(missed === 0, `REACH-2 …and it found an answer for every one of them rather than going silent (${missed} unanswered)`);
}
{
  // …and it is the LARGEST such loan — a figure needlessly low would tell a
  // borrower to give up money they did not have to.
  let notTight = 0;
  for (let value = 200000; value <= 800000; value += 25000) {
    for (const tier of [70, 75, 80]) {
      const loan = nt._internals.loanForTier(value, tier);
      const oneCentMore = Math.round((loan + 0.01) * 100) / 100;
      const two = tr.sendAs('ltv', (oneCentMore / value) * 100, 2);
      const six = tr.sendAs('ltv', oneCentMore / value, 6) * 100;
      if (two <= tier + 1e-9 && six <= tier + 1e-9) notTight++;
    }
  }
  ok(notTight === 0,
    `REACH-3 …and it is the LARGEST loan that reaches the tier — one cent more always misses (${notTight} that did not)`);
}

// ---- D. IT ONLY SPEAKS WHEN THERE IS SOMETHING TO SAY -----------------------
console.log('\n== D. WHEN IT STAYS QUIET ==');
ok(nt.nearTier({ value: 500000, loan: 385000, lines: [] }).ltv === null,
  'WINDOW-1 a loan a full 2 points over its tier raises nothing — a flag that fires on everything is one people learn to close');
ok(nt.nearTier({ value: 500000, loan: 375000, lines: [] }).ltv === null,
  'WINDOW-2 …and a loan already ON the tier has nothing better to reach');
ok(nt.nearTier({ value: 500000, loan: 350000, dscr: 1.10, lines: [LIVE_CELL] }).dscr === null,
  'WINDOW-3 …and a ratio well under the next tier is not nagged about it');
ok(nt.nearTier({ loan: 350000, lines: [LIVE_CELL] }).ltv === null,
  'QUIET-1 with no property value there is no LTV to judge and nothing is claimed');
ok(nt.nearTier({ value: 500000, loan: 350000, lines: [LIVE_CELL] }).dscr === null,
  'QUIET-2 …and with no ratio supplied, the ratio half says nothing rather than assuming one');
{
  const bad = nt.nearTier(null);
  ok(bad && bad.ltv === null && bad.dscr === null, 'QUIET-3 …and garbage in answers nothing rather than throwing — a hint may never take a board down');
}

// ---- E. THE RATIO HALF ------------------------------------------------------
console.log('\n== E. THE RATIO ==');
{
  const r = nt.nearTier({ value: 500000, loan: 350000, dscr: 1.22, lines: [LIVE_CELL] }).dscr;
  ok(r && r.source === 'sheet' && r.tier === 1.25 && Math.abs(r.gap - 0.03) < 1e-9,
    `RATIO-1 the sheet's own ">= 1.25" is the tier, and the gap is stated exactly (got ${r && r.tier}, gap ${r && r.gap})`);
  const s = nt.nearTier({ value: 500000, loan: 350000, dscr: 0.97, lines: [] }).dscr;
  ok(s && s.source === 'stated' && s.tier === 1,
    'RATIO-2 …and with no band published it uses the standing tiers, saying so');
}
{
  // ⛔ THE STANDING TIERS ARE LENDER PRICE'S OWN EDGES, read from that program's
  // band function rather than retyped here — a fallback that named a ratio tier
  // the program does not price on would send somebody chasing nothing.
  const band = lp._internals.dscrBand;
  const edgeMoves = nt.STATED_DSCR_TIERS.filter((t) => {
    const below = band(t - 0.0001), at = band(t);
    return !below || !at || below.ratio === at.ratio;
  });
  ok(edgeMoves.length === 0,
    `RATIO-3 …and every standing tier is a REAL edge in Lender Price's own band rule (${edgeMoves.length} that are not)`);
}

// ---- F. IT NAMES NO VENDOR --------------------------------------------------
console.log('\n== F. ONE SYSTEM ==');
{
  const r = nt.nearTier({ value: 500000, loan: 352550, dscr: 1.22, lines: [LIVE_CELL, LIVE_CELL_2] });
  const text = JSON.stringify(r);
  const named = ['loannex', 'loan nex', 'lender price', 'lenderprice'].filter((w) => text.toLowerCase().includes(w));
  ok(named.length === 0,
    `F1 the flag names no software anywhere in its answer (${named.join(', ') || 'none'}) — on a board carrying both programs those words are wrong on half the rows`);
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
