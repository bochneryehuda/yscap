/* Manual "months of liquidity" = RESERVE months (owner-directed 2026-08-11:
   "how many months of reserves you need to show for the manual program … visible
   in the ending balance of the last statement").

   Proves, against the REAL engines (src/lib/pricing.js normalize):
   (1) a MANUAL quote's reserveRequirement = fullPayment × the stated assetMonths
       (linear in the months), and liquidityRequired reflects it — driven by the
       stated months, NOT the Standard 2/4-by-loan-size rule;
   (2) changing assetMonths on a manual quote moves ONLY the reserve/liquidity
       fields — sizing, rate, cash-to-close and caps are byte-identical;
   (3) Gold/Standard/Silver are BYTE-IDENTICAL with vs without inputs.assetMonths
       set (normalize double-guards on program === 'manual', so a non-manual
       program can never read it) — the frozen-engine equivalence guarantee;
   (4) a manual quote with NO assetMonths falls back to reserveMonths(totalLoan)
       (2/4), so a manual file that somehow lacks the stated months is safe. */
'use strict';
const assert = require('assert');
const pricing = require('../src/lib/pricing');

if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP test-manual-reserve-months-pure: engines not loadable', pricing.loadErr && pricing.loadErr());
  process.exit(0);
}

let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; };
const eq = (a, b, m) => { assert.strictEqual(a, b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); passed++; };
const round2 = (n) => Math.round(Number(n) * 100) / 100;

const appBase = {
  purchase_price: 200000, as_is_value: 200000, arv: 300000, rehab_budget: 100000,
  fico: 720, term: 12, program: 'Fix and Flip', loan_type: 'Purchase',
  property_type: 'Single Family', units: 1, property_address: { state: 'TX' },
  requested_exp_flips: 3,
};
const exp = { flips: 3, holds: 0, ground: 0 };

// Build a manual input the way the register route does: forcePrice so a scenario
// that would be ineligible against the Standard caps still sizes/registers as
// MANUAL, plus the server-side assetMonths (the stated months of liquidity).
function manualInputs(assetMonths) {
  const inp = pricing.buildInputs(appBase, exp, {});
  inp.forcePrice = true;
  if (assetMonths != null) inp.assetMonths = assetMonths;
  return inp;
}
const quoteManual = (assetMonths) => pricing.quoteProgram('manual', manualInputs(assetMonths));

// ── (1) manual reserve = fullPayment × assetMonths ──────────────────────────
const m2 = quoteManual(2);
const m6 = quoteManual(6);
ok(m2.sizing && m2.sizing.totalLoan > 0, 'manual scenario sizes a loan');
eq(m2.reserveMonths, 2, 'manual assetMonths=2 → reserveMonths 2');
eq(m6.reserveMonths, 6, 'manual assetMonths=6 → reserveMonths 6');
ok(/manual program/i.test(m6.reserveBasis), 'reserveBasis names the manual program');
const per = m2.reserveRequirement / 2;   // reserve per month
ok(per > 0, 'a month of reserve is a positive dollar amount');
eq(round2(m6.reserveRequirement), round2(per * 6), 'reserveRequirement scales linearly with the stated months');
ok(m6.liquidityRequired > m2.liquidityRequired, 'more reserve months → more required liquidity');
eq(round2(m6.liquidityRequired - m2.liquidityRequired),
   round2(m6.reserveRequirement - m2.reserveRequirement),
   'the liquidity increase is exactly the reserve increase (nothing else moved)');

// ── (2) only reserve/liquidity move; sizing/rate/caps/cash-to-close identical ─
for (const k of ['totalLoan', 'initialAdvance', 'rehabHoldback', 'financedReserve', 'downPayment', 'monthlyPayment', 'ltcPct', 'acqLtvPct', 'arvPct']) {
  eq(m6.sizing[k], m2.sizing[k], `sizing.${k} identical across assetMonths`);
}
eq(m6.noteRate, m2.noteRate, 'note rate identical across assetMonths');
eq(m6.cashToClose, m2.cashToClose, 'cash-to-close identical across assetMonths');

// ── (3) non-manual is BYTE-IDENTICAL with vs without assetMonths ────────────
for (const prog of ['standard', 'gold', 'silver']) {
  const plain = pricing.buildInputs(appBase, exp, {});
  const withAM = pricing.buildInputs(appBase, exp, {});
  withAM.assetMonths = 6;    // a non-manual program must IGNORE this entirely
  const a = pricing.quoteProgram(prog, plain);
  const b = pricing.quoteProgram(prog, withAM);
  for (const k of ['reserveRequirement', 'reserveMonths', 'reserveBasis', 'liquidityRequired', 'liquidity', 'cashToClose', 'noteRate', 'status']) {
    eq(b[k], a[k], `${prog}.${k} unaffected by assetMonths`);
  }
  if (a.sizing && b.sizing) {
    for (const k of ['totalLoan', 'initialAdvance', 'rehabHoldback', 'financedReserve', 'downPayment', 'monthlyPayment', 'ltcPct', 'acqLtvPct', 'arvPct']) {
      eq(b.sizing[k], a.sizing[k], `${prog}.sizing.${k} unaffected by assetMonths`);
    }
  } else {
    eq(!!a.sizing, !!b.sizing, `${prog} sizing presence unaffected by assetMonths`);
  }
}

// ── (4) manual with NO assetMonths DEFAULTS to 3 (owner-directed 2026-08-11) ──
// "on the manual program, the default should be three months' reserves, but that
// manual box should override" — the manual program NEVER uses the Standard 2/4
// rule; with no stated box value it uses the manual default of THREE months.
const mNone = quoteManual(null);
eq(mNone.reserveMonths, 3, 'manual with no assetMonths defaults to 3 months (never the 2/4 rule)');
const m3 = quoteManual(3);
eq(mNone.reserveRequirement, m3.reserveRequirement, 'the no-box default equals an explicit 3 months exactly');
// The box overrides the default: 6 was asked above and honored; a value of 0/blank
// is treated as "no box" and uses the default 3, not a $0 reserve.
eq(quoteManual(0).reserveMonths, 3, 'a blank/zero box uses the default 3, never a zero reserve');
eq(m6.reserveMonths, 6, 'a stated box value (6) overrides the default of 3');

console.log(`test-manual-reserve-months-pure: OK (${passed} assertions)`);
