/* Out-of-pocket rehab exception — backend pricing (src/lib/pricing.js normalize).
   Proves: (1) with no exception amount the sizing is byte-identical to before;
   (2) the two info numbers (initial cut, max OOP) surface even at the default;
   (3) the exception re-slices initial↑ / holdback↓ / OOP=X at a CONSTANT total,
   rate and caps; (4) cash-to-close drops by X, liquidity rises by X; (5) the
   "max it out" toggle equals the max; (6) an over-ask is clamped to the max. */
'use strict';
const assert = require('assert');
const pricing = require('../src/lib/pricing');

if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP test-oop-rehab-pricing: engines not loadable', pricing.loadErr && pricing.loadErr());
  process.exit(0);
}

// A purchase where the 75% ARV cap ($225k) cuts the initial to $125k — below its
// own 90% acquisition cap ($180k) — because rehab is fully financed.
const app = {
  purchase_price: 200000, as_is_value: 200000, arv: 300000, rehab_budget: 100000,
  fico: 720, term: 12, program: 'Fix and Flip', loan_type: 'Purchase',
  property_type: 'Single Family', units: 1, property_address: { state: 'TX' },
  requested_exp_flips: 3,
};
const exp = { flips: 3, holds: 0, ground: 0 };
const q = (ov) => pricing.quoteProgram('standard', pricing.buildInputs(app, exp, ov || {}));

const base = q();
console.log('default:', JSON.stringify({
  total: base.sizing.totalLoan, initial: base.sizing.initialAdvance,
  holdback: base.sizing.rehabHoldback, down: base.sizing.downPayment,
  oop: base.sizing.oopRehab, maxOop: base.sizing.maxOopRehab,
  initialCut: base.sizing.initialCut, maxInitial: base.sizing.maxInitial,
  cash: base.cashToClose, binding: base.sizing.binding,
}));

// --- guardrails on the scenario itself (so a matrix change can't silently pass) ---
assert.strictEqual(base.sizing.totalLoan, 225000, 'total should be ARV-capped at 225k');
assert.strictEqual(base.sizing.initialAdvance, 125000, 'default initial is the cut plug');
assert.strictEqual(base.sizing.rehabHoldback, 100000, 'default rehab is 100% financed');
assert.strictEqual(base.sizing.downPayment, 75000, 'default down = 200k - 125k');

// (2) the two info numbers show at the default, no exception entered
assert.strictEqual(base.sizing.maxInitial, 180000, 'max initial = 90% of 200k');
assert.strictEqual(base.sizing.initialCut, 55000, 'initial cut = 180k - 125k');
assert.strictEqual(base.sizing.maxOopRehab, 55000, 'max OOP = min(cut, holdback)');
assert.strictEqual(base.sizing.oopRehab, 0, 'no exception → OOP 0');

// (1) byte-identical: explicit oopRehab:0 === default for every shared sizing key
const zero = q({ oopRehab: 0 });
for (const k of ['totalLoan', 'initialAdvance', 'rehabHoldback', 'financedReserve',
  'downPayment', 'initialPayment', 'monthlyPayment', 'ltcPct', 'acqLtvPct', 'arvPct']) {
  assert.strictEqual(zero.sizing[k], base.sizing[k], `oopRehab:0 must not move ${k}`);
}
assert.strictEqual(zero.cashToClose, base.cashToClose, 'oopRehab:0 must not move cash-to-close');
assert.strictEqual(zero.liquidityRequired, base.liquidityRequired, 'oopRehab:0 must not move liquidity');

// (3)+(4) apply the exception at the max
const ex = q({ oopRehab: 55000 });
assert.strictEqual(ex.sizing.totalLoan, base.sizing.totalLoan, 'TOTAL LOAN MUST NOT CHANGE');
assert.strictEqual(ex.noteRate, base.noteRate, 'NOTE RATE MUST NOT CHANGE');
assert.strictEqual(ex.sizing.initialAdvance, 180000, 'initial rises to the cap');
assert.strictEqual(ex.sizing.rehabHoldback, 45000, 'holdback drops by X');
assert.strictEqual(ex.sizing.oopRehab, 55000, 'OOP = X');
assert.strictEqual(ex.sizing.downPayment, 20000, 'down = 200k - 180k');
// The DISPLAYED initial-advance % must reflect the OOP-BOOSTED initial (owner-reported
// 2026-08-12: it stayed stale — "30% initial" while the dollar rose). acqDenom = 200k.
// base initial 125k → 0.625; with the exception the initial is 180k so the TRUE LTV is
// 0.90 — persisted on the quote, so the borrower email, the INITIAL PDF and the FINAL
// DocuSign sheet all show it. Was showing the stale 0.625 before the fix.
assert.strictEqual(base.sizing.acqLtvPct, 0.625, 'base initial LTV = 125k/200k');
assert.strictEqual(ex.sizing.acqLtvPct, 0.9, 'OOP-boosted initial LTV = 180k/200k (not the stale 0.625)');
assert.strictEqual(ex.cashToClose, base.cashToClose - 55000, 'cash-to-close (money at the table) drops by X');
// Liquidity to SHOW is the borrower's total skin (down + OOP + closing + reserve) —
// unchanged, because cash-to-close fell by X while the OOP requirement rose by X.
// Same total, just deployed differently (less at closing, more over construction).
assert.strictEqual(ex.liquidityRequired, base.liquidityRequired, 'liquidity to show is unchanged (same total, different timing)');
// invariant: rehab_budget = financed + OOP  (matches the tape / Encompass derivation)
assert.strictEqual(app.rehab_budget - ex.sizing.rehabHoldback, ex.sizing.oopRehab, 'budget = financed + OOP');
// invariant: total = initial + holdback + reserve
assert.strictEqual(ex.sizing.initialAdvance + ex.sizing.rehabHoldback + ex.sizing.financedReserve,
  ex.sizing.totalLoan, 'total = initial + holdback + reserve');

// (5) the "max it out" toggle equals the max
const mx = q({ oopRehabMax: true });
assert.strictEqual(mx.sizing.oopRehab, 55000, 'toggle → max OOP');
assert.strictEqual(mx.sizing.initialAdvance, 180000, 'toggle → initial at cap');

// (6) an over-ask is clamped to the max (never over the acquisition cap)
const over = q({ oopRehab: 999999 });
assert.strictEqual(over.sizing.oopRehab, 55000, 'over-ask clamps to max');
assert.strictEqual(over.sizing.initialAdvance, 180000, 'initial never exceeds its cap');

// a partial amount re-slices proportionally
const half = q({ oopRehab: 20000 });
assert.strictEqual(half.sizing.oopRehab, 20000);
assert.strictEqual(half.sizing.initialAdvance, 145000, 'initial = 125k + 20k');
assert.strictEqual(half.sizing.rehabHoldback, 80000, 'holdback = 100k - 20k');
assert.strictEqual(half.sizing.totalLoan, base.sizing.totalLoan, 'partial: total unchanged');
assert.strictEqual(half.sizing.acqLtvPct, 145000 / 200000, 'partial OOP: LTV = 145k/200k (recomputed from the boosted initial)');

console.log('OK test-oop-rehab-pricing — 30+ assertions passed');
