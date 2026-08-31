#!/usr/bin/env node
'use strict';
/**
 * LONG-TERM — ONE ROUNDING RULE, BOTH PROGRAMS (pure, offline).
 *
 * Owner-directed 2026-08-30: *"The DSCR should always be rounded down, and the
 * LTV should always be rounded up, so we should never see better."*
 *
 * WHY THIS SUITE EXISTS SEPARATELY FROM THE TWO CONNECTORS' OWN. Each connector
 * already proves its own figure goes out the right way. What neither can see is
 * the thing that actually matters here: that BOTH read the SAME rule, so one
 * loan is never described differently to the two programs. A private copy of
 * "round the LTV up" in each of them would pass both suites and still drift.
 *
 * PROVEN TO FAIL: flip either entry in DIRECTION and the whole battery goes red
 * across both connectors at once; give a connector its own private rounder and
 * the SOURCE guards go red; drop the float guard and the round-number sweeps go
 * red on both.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const tr = require('../src/longterm/pricing/tier-rounding');
const nex = require('../src/longterm/loannex/scenario');
const lp = require('../src/longterm/lenderprice/search-model');
const lpClient = require('../src/longterm/lenderprice/client');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
// Comments necessarily NAME the rule they are explaining, so every "must not
// appear" check below reads the source with them stripped — a guard that read
// its own explanation would fail on the fix it protects.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

console.log('One rounding rule, both programs');

// ---- A. THE RULE ITSELF ----------------------------------------------------
console.log('\n== A. THE RULE, STATED ONCE ==');
ok(tr.DIRECTION.dscr === 'down' && tr.DIRECTION.ltv === 'up',
  'A1 the owner\'s rule is written once: DSCR down, LTV up');
ok(Object.isFrozen(tr.DIRECTION),
  'A2 …and it cannot be reassigned at runtime by a caller that thinks it knows better');
let threw = null;
try { tr.sendAs('fico', 700, 0); } catch (e) { threw = e; }
ok(threw && /no rule for/.test(threw.message),
  'A3 a figure with no stated direction THROWS — a silent default here would be a number cut the wrong way on a vendor request');
ok(tr.cutDown(NaN, 2) === null && tr.liftUp(Infinity, 2) === null,
  'A4 …and a figure that is not a number answers nothing rather than a fabricated 0');

// ⛔ THE FLOAT GUARD. These two products are the reason it exists, and both are
// real IEEE-754 results rather than invented edge cases.
// ⛔ A REAL LOAN, NOT AN INVENTED EDGE CASE, AND FINDING IT IS THE POINT. The first
// cut of this assertion used `0.7 * 100`, which is EXACTLY 70 in IEEE-754 — so it
// passed with the guard deleted and proved nothing. 178750 on a 325000 property is
// exactly 55%, and `178750 / 325000` is 0.5500000000000001, so unguarded the LTV
// goes to the vendor as 55.01% — a plain 55% loan pushed into a worse tier.
ok((178750 / 325000) * 100 !== 55,
  `A5 (context) a $178,750 loan on a $325,000 property is exactly 55%, and in floating point it is ${(178750 / 325000) * 100}`);
ok(tr.liftUp((178750 / 325000) * 100, 2) === 55,
  'A6 …and it is NOT lifted to 55.01 — without this guard a plain 55% loan prices one tier worse');
ok(tr.cutDown(1.15, 2) === 1.15,
  'A7 …and a typed 1.15 DSCR is NOT cut to 1.14 — the same guard, the other direction');

// ---- B. BOTH CONNECTORS READ IT, AND KEEP NO COPY ---------------------------
console.log('\n== B. ONE DEFINITION — NEITHER CONNECTOR KEEPS ITS OWN ==');
const NEX_SRC = code('src/longterm/loannex/scenario.js');
const LP_SRC = code('src/longterm/lenderprice/search-model.js');
const LPC_SRC = code('src/longterm/lenderprice/client.js');
for (const [label, src] of [['the LoanNEX connector', NEX_SRC], ['the Lender Price model', LP_SRC], ['the Lender Price client', LPC_SRC]]) {
  ok(/require\(['"][^'"]*tier-rounding['"]\)/.test(src), `B1 ${label} reads the shared rule`);
  // ⛔ ASSERT THE POSITIVE, NOT ONLY THE ABSENCE. The first cut of this only BANNED
  // `Math.floor`/`Math.ceil` — so a connector that quietly went back to
  // `Math.round(n * 1e6) / 1e6`, which is exactly the round-to-nearest defect, sailed
  // straight through it (the mutation was run; it did). Requiring the emission to go
  // THROUGH the rule cannot be satisfied by any private rounder at all.
  ok(/tierRounding\.sendAs\(\s*['"]ltv['"]/.test(src),
    `B2 …and its LTV goes out THROUGH that rule, so no private rounder can decide the direction (${label})`);
  ok(!/Math\.(floor|ceil)\s*\(/.test(src),
    `B3 …and it keeps no rounder of its own beside it (${label})`);
}
ok(/tierRounding\.sendAs\(\s*['"]dscr['"]/.test(NEX_SRC),
  'B4 …and the DSCR half goes out through the same rule on the connector that formats one');

// ---- C. THE LOANNEX SIDE, THROUGH THE RULE ---------------------------------
console.log('\n== C. WHAT LOANNEX IS ASKED ==');
ok(nex.dscrString(0.999) === '0.99' && nex.ltvString(0.800002) === '80.01',
  'C1 the owner\'s two cases: a 0.999 DSCR goes as 0.99 and an 80.0002% LTV as 80.01');
ok(nex.dscrString(1.25) === '1.25' && nex.ltvString(0.8) === '80.00',
  'C2 …while a figure already on a tier is UNMOVED in both directions');

// ---- D. THE LENDER PRICE SIDE ----------------------------------------------
console.log('\n== D. WHAT LENDER PRICE IS ASKED ==');
const der = lp._internals.deriveAmounts;
ok(der({ loan: 400001, value: 500000 }).ltv === 0.800002,
  'D1 the live builder keeps 4 decimals of the percent — it never lost 80.0002% in the first place');
ok(der({ loan: 1, value: 3 }).ltv === 0.333334,
  'D2 …and a figure that genuinely falls between two representable LTVs is LIFTED, not rounded to nearest');
ok(der({ loan: 375000, value: 500000 }).ltv === 0.75 && der({ value: 500000, ltv: 75 }).ltv === 0.75,
  'D3 …while a round-number loan is byte-identical to what it has always been, typed or derived');

// THE LIVE ENGINE MOVED, SO THE MOVE IS MEASURED RATHER THAN ASSERTED. The
// direction is the safety property; the SIZE is what makes it safe to ship on a
// screen the company prices on today.
{
  const OLD = (n) => Math.round(n * 1e6) / 1e6; // the rule as it stood
  let moved = 0, down = 0, tot = 0, worst = 0;
  for (let value = 100000; value <= 1200000; value += 10000) {
    for (let loan = Math.round(value * 0.4); loan <= value; loan += 97) {
      tot++;
      const o = OLD(loan / value), n = tr.sendAs('ltv', loan / value, 6);
      if (n !== o) { moved++; worst = Math.max(worst, n - o); if (n < o) down++; }
    }
  }
  ok(down === 0, `D4 across ${tot} derived LTVs not one is sent LOWER than it used to be (${down}) — the direction is the whole safety property`);
  ok(worst <= 0.000001 + 1e-12,
    `D5 …and the largest move is a single 4dp step, 0.0001 of a percentage point (worst ${(worst * 100).toFixed(6)}pp) — it can only cross a tier a loan was already over`);
  let rn = 0, rnMoved = 0;
  for (let pct = 5; pct <= 100; pct += 0.25) {
    for (const v of [200000, 350000, 500000, 725000, 1000000]) {
      rn++; const loan = Math.round(v * pct) / 100;
      if (tr.sendAs('ltv', loan / v, 6) !== OLD(loan / v)) rnMoved++;
    }
  }
  ok(rnMoved === 0, `D6 …and every round-number scenario is UNCHANGED (${rn} tested, ${rnMoved} moved) — a 75% loan is still 75%`);
}

// ⛔ THE DSCR REACHES LENDER PRICE EXACT, AND THAT IS AN ASSERTION RATHER THAN
// AN ASSUMPTION. Nothing rounds it today, so the owner's "never round a DSCR up"
// holds there by construction — but "by construction" is only true until somebody
// adds a rounder, which is exactly what this catches.
{
  const built = lp.buildSearch({ purpose: 'Purchase', value: 500000, loan: 375000, fico: 760, dscr: 1.2499, propertyType: 'SingleFamily', zip: '08201' });
  const sent = built && built.criteria ? built.criteria.dscr : null;
  ok(sent === 1.2499,
    `D7 a 1.2499 DSCR reaches Lender Price EXACTLY (got ${sent}) — nothing rounds it, so it can never be rounded UP into the 1.25 band`);
  const band = lp._internals.dscrBand;
  ok(band(1.2499).ratio === 'DSCR>=1' && band(1.25).ratio === '1.25',
    'D8 …and its band is read off that exact figure, so the tier it prices in is the tier it earned');
}

// ---- E. THE TWO PROGRAMS ARE ASKED THE SAME QUESTION ------------------------
console.log('\n== E. ONE LOAN, ONE QUESTION ==');
{
  // The LTV tiers a DSCR sheet actually steps on. Asserted at 5% because that is
  // the owner's own statement of them ("every 5% is a better tier").
  const TIERS = [55, 60, 65, 70, 75, 80, 85];
  const tierOf = (pct) => { let b = 0; for (const t of TIERS) if (pct > t + 1e-9) b = t; return b; };
  let disagreed = 0, tot = 0, firstAt = null;
  for (let value = 150000; value <= 900000; value += 25000) {
    for (let loan = Math.round(value * 0.5); loan <= Math.round(value * 0.86); loan += 13) {
      tot++;
      const nexPct = Number(nex.ltvString(loan / value));
      const lpPct = der({ loan, value }).ltv * 100;
      if (tierOf(nexPct) !== tierOf(lpPct)) { disagreed++; if (firstAt == null) firstAt = `${loan}/${value}`; }
    }
  }
  ok(disagreed === 0,
    `E1 across ${tot} loans the LTV tier LoanNEX is asked for and the tier Lender Price is asked for are the SAME tier (${disagreed} disagreements${firstAt ? ', first at ' + firstAt : ''})`);
}
{
  // The DSCR half of the same question, against Lender Price's OWN band rule.
  const band = lp._internals.dscrBand;
  const bandOf = (v) => { const b = band(v); return b ? b.ratio : 'none'; };
  let disagreed = 0;
  for (let i = 0; i < 40000; i++) {
    const v = (i * 7919 % 200000) / 100000;
    if (bandOf(v) !== bandOf(Number(nex.dscrString(v)))) disagreed++;
  }
  ok(disagreed === 0,
    `E2 …and so is the DSCR band, judged against Lender Price's own band function (${disagreed} disagreements)`);
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
