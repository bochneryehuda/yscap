'use strict';
/**
 * R6.3 — pure tests for the canonical whole-loan context assembler. Guarantees:
 * registration governs the structure; a source disagreement surfaces as a
 * discrepancy (never silently resolved); a missing required fact makes the
 * context NOT_READY (never a fabricated 0); a missing value stays null; the
 * source hash is reproducible and moves only when a governing value moves.
 */
const assert = require('assert');
const wlc = require('../src/lib/underwriting/whole-loan-context');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const baseApp = {
  id: 'app-1', updated_at: '2026-07-20T00:00:00Z',
  program: 'gold', registered_program: 'gold', loan_type: 'purchase',
  property_type: 'sfr', units: 1, purchase_price: 400000, as_is_value: 400000,
  arv: 600000, rehab_budget: 100000, is_assignment: false, fico: 720,
  borrower_name: 'Jane Doe', vesting_entity: 'ABC LLC',
};
const baseReg = {
  id: 'reg-1', program: 'gold', product_label: 'Gold Standard', status: 'ELIGIBLE',
  note_rate: 0.1099, total_loan: 465000, target_ltc: null, is_manual: false,
  stale: false, stale_reason: null, created_at: '2026-07-21T00:00:00Z',
  inputs: { purchasePrice: 400000, arv: 600000, rehabBudget: 100000, fico: 720, propertyType: 'sfr', units: 1 },
  quote: {},
};

// --- happy path: everything present, no conflict ---
let ctx = wlc.assembleContext({ application: baseApp, registration: baseReg });
assert.strictEqual(ctx.ready, true, 'a complete file is ready');
assert.strictEqual(ctx.values.loan_amount, 465000, 'loan amount from the registration');
assert.strictEqual(ctx.fields.loan_amount.governingSource, 'registration');
assert.strictEqual(ctx.values.program, 'gold');
assert.strictEqual(ctx.discrepancies.length, 0, 'no disagreements when sources agree');
assert.strictEqual(ctx.missingRequired.length, 0);
ok('a complete, agreeing file assembles ready with the registration governing');

// --- a value drift (application ARV changed since pricing) → discrepancy ---
ctx = wlc.assembleContext({ application: { ...baseApp, arv: 650000 }, registration: baseReg });
const arvDisc = ctx.discrepancies.find((d) => d.field === 'arv');
assert.ok(arvDisc, 'an ARV drift surfaces as a discrepancy');
assert.strictEqual(arvDisc.governing.source, 'pricing_engine', 'the priced ARV governs');
assert.ok(arvDisc.conflicts.some((c) => c.source === 'application' && c.value === 650000));
ok('a source disagreement surfaces as a discrepancy (never silently resolved)');

// --- a missing REQUIRED fact (no registration → no loan amount) → NOT ready ---
ctx = wlc.assembleContext({ application: baseApp, registration: null });
assert.strictEqual(ctx.ready, false, 'no registration → not ready');
assert.ok(ctx.missingRequired.includes('loan_amount'), 'loan_amount missing');
assert.strictEqual(ctx.values.loan_amount, null, 'a missing loan amount is null, never 0');
ok('a missing required fact makes the context NOT_READY with a null (never a fabricated 0)');

// --- a missing optional numeric value stays null, not 0 ---
ctx = wlc.assembleContext({ application: { ...baseApp, arv: null }, registration: { ...baseReg, inputs: { ...baseReg.inputs, arv: undefined } } });
assert.strictEqual(ctx.values.arv, null, 'a missing ARV is null everywhere');
ok('a missing value is a wrapped null, never coerced to 0/false');

// --- registration manual/stale surfaces on the context ---
ctx = wlc.assembleContext({ application: baseApp, registration: { ...baseReg, is_manual: true, stale: true, stale_reason: 'inputs changed' } });
assert.strictEqual(ctx.registration.isManual, true);
assert.strictEqual(ctx.registration.stale, true);
assert.strictEqual(ctx.registration.staleReason, 'inputs changed');
ok('registration manual/stale state is carried onto the context');

// --- liquidity shortfall math ---
ctx = wlc.assembleContext({ application: baseApp, registration: baseReg, liquidity: { required: 50000, verified: 30000 } });
assert.strictEqual(ctx.liquidity.shortfall, 20000, 'required − verified');
ctx = wlc.assembleContext({ application: baseApp, registration: baseReg, liquidity: { required: 20000, verified: 50000 } });
assert.strictEqual(ctx.liquidity.shortfall, 0, 'a surplus is not a negative shortfall');
ok('liquidity shortfall = max(0, required − verified)');

// --- reproducible hash: same sources → same hash; a changed loan amount moves it ---
const h1 = wlc.assembleContext({ application: baseApp, registration: baseReg }).sourceHash;
const h2 = wlc.assembleContext({ application: baseApp, registration: baseReg }).sourceHash;
assert.strictEqual(h1, h2, 'same sources → identical hash');
const h3 = wlc.assembleContext({ application: baseApp, registration: { ...baseReg, total_loan: 470000 } }).sourceHash;
assert.notStrictEqual(h1, h3, 'a changed governing value moves the hash');
ok('the source hash is reproducible and moves only when a governing value moves');

// --- program drift: application says standard, registration says gold → gold governs + discrepancy ---
ctx = wlc.assembleContext({ application: { ...baseApp, registered_program: 'standard' }, registration: baseReg });
assert.strictEqual(ctx.values.program, 'gold', 'the registered program governs');
assert.ok(ctx.discrepancies.some((d) => d.field === 'program'), 'a program drift is flagged');
ok('a program drift is governed by the registration and flagged as a discrepancy');

console.log(`\nR6.3 whole-loan-context pure — ${passed} checks passed`);
