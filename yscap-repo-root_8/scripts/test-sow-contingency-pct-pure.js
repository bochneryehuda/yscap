'use strict';

/**
 * Pure test for rehab-budget.sowContingencyPct + the desk's checkContingency wiring.
 * Proves the SOW contingency % is computed from the saved payload (so the investor
 * overlay's contingency-cap check actually evaluates), and edge cases return null.
 */

const assert = require('assert');
const rb = require('../src/lib/rehab-budget');
const desk = require('../src/lib/underwriting/investor-guidelines/desk');

let n = 0;
function check(name, fn) { fn(); n++; console.log('  ok -', name); }

console.log('sow-contingency-pct pure tests');

// 1 — explicit amounts → pct of the construction subtotal, one decimal.
check('explicit subtotal + contingency → pct', () => {
  assert.strictEqual(rb.sowContingencyPct({ subtotal: 100000, contingency: 7000 }), 7);
  assert.strictEqual(rb.sowContingencyPct({ subtotal: 200000, contingency: 15000 }), 7.5);
  assert.strictEqual(rb.sowContingencyPct({ subtotal: 100000, contingency: 5000 }), 5);
});

// 2 — pct-mode legacy payload (contingency derived from state.cont) → pct.
check('pct-mode legacy payload → pct', () => {
  const p = { subtotal: 100000, state: { cont: { mode: 'pct', value: 10 } } };
  assert.strictEqual(rb.sowContingencyPct(p), 10);
});

// 3 — unknowable / zero / missing → null (check stays advisory, never a false number).
check('no subtotal / zero / missing → null', () => {
  assert.strictEqual(rb.sowContingencyPct(null), null);
  assert.strictEqual(rb.sowContingencyPct({}), null);
  assert.strictEqual(rb.sowContingencyPct({ subtotal: 0, contingency: 100 }), null);
  assert.strictEqual(rb.sowContingencyPct({ contingency: 5000 }), null, 'no subtotal → null');
});

// 4 — the desk's contingency evaluator fires once the signal is present.
//    Blue Lake cond 2193 caps the contingency; an over-cap % must CONFLICT.
check('desk checkContingency evaluates on the bridged signal', () => {
  const evalr = desk.CHECK_EVALUATORS && desk.CHECK_EVALUATORS[2193];
  assert.ok(typeof evalr === 'function', 'cond 2193 evaluator exists');
  // With no signal → advisory (to_verify), not a fabricated conflict.
  const blank = evalr({});
  assert.ok(blank && blank.status === 'to_verify', 'no signal → to_verify');
  // With a bridged pct present → the evaluator produces a real ok/conflict verdict.
  const withSig = evalr({ sow_contingency_pct: 12 });
  assert.ok(withSig && withSig.status && withSig.status !== 'to_verify', 'bridged signal → real verdict');
});

console.log(`\nsow-contingency-pct: ${n} checks passed`);
