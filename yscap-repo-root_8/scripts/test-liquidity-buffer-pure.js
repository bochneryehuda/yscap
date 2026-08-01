/* 1% closing-cost liquidity buffer (owner-authorized 2026-07-31).
   Proves, against the REAL engines (src/lib/pricing.js normalize):
   (1) the buffer = 1% of the total loan, added to liquidityRequired ONLY
       (cash-to-close is untouched — it is a cushion we verify, not a cost);
   (2) waived (applications.liquidity_buffer_waived=true) → buffer 0 and the
       liquidity is byte-identical to the pre-buffer formula;
   (3) the waiver is FILE-OWNED — a client override can never set or clear it;
   (4) every other number on the quote is identical waived vs not (sizing, rate,
       caps, closing costs — the buffer touches nothing else);
   (5) the flag surfaces on the quote (closingBuffer / closingBufferWaived). */
'use strict';
const assert = require('assert');
const pricing = require('../src/lib/pricing');

if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.log('SKIP test-liquidity-buffer-pure: engines not loadable', pricing.loadErr && pricing.loadErr());
  process.exit(0);
}

const appBase = {
  purchase_price: 200000, as_is_value: 200000, arv: 300000, rehab_budget: 100000,
  fico: 720, term: 12, program: 'Fix and Flip', loan_type: 'Purchase',
  property_type: 'Single Family', units: 1, property_address: { state: 'TX' },
  requested_exp_flips: 3,
};
const exp = { flips: 3, holds: 0, ground: 0 };
const quoteFor = (app, ov) => pricing.quoteProgram('standard', pricing.buildInputs(app, exp, ov || {}));

const withBuffer = quoteFor({ ...appBase, liquidity_buffer_waived: false });
const waived = quoteFor({ ...appBase, liquidity_buffer_waived: true });

// (1) buffer = 1% of totalLoan, on liquidity only
const total = withBuffer.sizing.totalLoan;
assert.ok(total > 0, 'scenario sizes a loan');
const expectedBuffer = Math.round(total * 0.01 * 100) / 100;
assert.strictEqual(withBuffer.closingBuffer, expectedBuffer, `buffer is 1% of the loan (${expectedBuffer})`);
assert.strictEqual(withBuffer.closingBufferWaived, false, 'not waived by default');
assert.strictEqual(withBuffer.cashToClose, waived.cashToClose, 'cash-to-close is NOT changed by the buffer');
assert.strictEqual(
  Math.round((withBuffer.liquidityRequired - waived.liquidityRequired) * 100) / 100,
  expectedBuffer, 'liquidity difference is exactly the buffer');
assert.strictEqual(withBuffer.liquidity, withBuffer.liquidityRequired, 'alias stays in step');

// (2) waived → 0 buffer, pre-buffer formula
assert.strictEqual(waived.closingBuffer, 0, 'waived → buffer 0');
assert.strictEqual(waived.closingBufferWaived, true, 'waived flag surfaces');
const preBufferFormula = Math.round((waived.cashToClose + waived.reserveRequirement + (waived.sizing.oopRehab || 0)) * 100) / 100;
assert.strictEqual(waived.liquidityRequired, preBufferFormula, 'waived liquidity = the pre-buffer formula exactly');

// (3) file-owned: a client override can never flip the waiver either way
const sneakyOn = quoteFor({ ...appBase, liquidity_buffer_waived: false }, { waiveLiqBuffer: true });
assert.strictEqual(sneakyOn.closingBuffer, expectedBuffer, 'override cannot WAIVE the buffer (file says not waived)');
const sneakyOff = quoteFor({ ...appBase, liquidity_buffer_waived: true }, { waiveLiqBuffer: false });
assert.strictEqual(sneakyOff.closingBuffer, 0, 'override cannot RESTORE the buffer (file says waived)');

// (4) nothing else moved
for (const k of ['totalLoan', 'initialAdvance', 'rehabHoldback', 'financedReserve', 'downPayment', 'monthlyPayment', 'ltcPct', 'acqLtvPct', 'arvPct']) {
  assert.strictEqual(withBuffer.sizing[k], waived.sizing[k], `sizing.${k} identical waived vs not`);
}
assert.strictEqual(withBuffer.noteRate, waived.noteRate, 'note rate identical');
assert.strictEqual(withBuffer.closingCosts.dueAtClosing, waived.closingCosts.dueAtClosing, 'closing costs identical');
assert.strictEqual(withBuffer.reserveRequirement, waived.reserveRequirement, 'reserve requirement identical');

// (5) Gold program carries it too (different reserve basis, same buffer layer)
const gold = pricing.quoteProgram('gold', pricing.buildInputs({ ...appBase, liquidity_buffer_waived: false, fico: 740 }, exp, {}));
if (gold && gold.sizing && gold.sizing.totalLoan > 0) {
  const gBuf = Math.round(gold.sizing.totalLoan * 0.01 * 100) / 100;
  assert.strictEqual(gold.closingBuffer, gBuf, 'Gold: buffer is 1% of the loan');
  assert.strictEqual(
    Math.round((gold.cashToClose + gold.reserveRequirement + (gold.sizing.oopRehab || 0) + gBuf) * 100) / 100,
    gold.liquidityRequired, 'Gold: liquidity = cash + reserve + oop + buffer');
}

console.log('All liquidity-buffer checks passed.');
