'use strict';
/**
 * R6.10 + R6.11 — pure tests for system reconciliation + the Encompass field
 * registry. Proves ClickUp/Encompass are reconciled AGAINST the authoritative
 * structure (a mismatch is a warning finding, never a value PILOT adopts), that
 * a matching mirror produces no finding, and that the read-only Encompass
 * registry extracts field IDs correctly and stays read-only.
 */
const assert = require('assert');
const recon = require('../src/lib/underwriting/system-reconciliation');
const encMap = require('../src/lib/integrations/encompass-field-map');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const context = { values: { loan_amount: 465000, program: 'gold', property_type: 'sfr', units: 1, purchase_price: 400000, as_is_value: 400000, arv: 600000, rehab_budget: 100000, note_rate: 0.1099 } };

// --- ClickUp matches → no findings ---
let r = recon.reconcileClickup(context, { loan_amount: 465000, program: 'Gold', property_type: 'SFR', units: 1, purchase_price: 400000, arv: 600000 });
assert.strictEqual(r.findings.length, 0, 'a matching ClickUp mirror has no findings');
assert.ok(r.compared >= 4, 'several fields were compared');
ok('a ClickUp mirror that matches the structure produces no findings (case-insensitive)');

// --- ClickUp loan amount + program differ → mismatch findings (warnings) ---
r = recon.reconcileClickup(context, { loan_amount: 450000, program: 'standard', arv: 600000 });
assert.ok(r.findings.some((f) => f.code === 'clickup_loan_amount_mismatch' && f.severity === 'warning'));
assert.ok(r.findings.some((f) => f.code === 'clickup_program_mismatch'));
assert.ok(r.findings.every((f) => !f.blocks_ctc && !f.blocks_funding), 'a workflow mismatch never blocks CTC/funding by itself');
const lm = r.findings.find((f) => f.code === 'clickup_loan_amount_mismatch');
assert.strictEqual(lm.expected_value, 465000, 'the registered value is the expected');
assert.strictEqual(lm.actual_value, 450000, 'ClickUp is the actual');
ok('a ClickUp loan-amount/program disagreement → warning findings that never block CTC/funding');

// --- a field absent on one side is not a finding ---
r = recon.reconcileClickup(context, { loan_amount: 465000 }); // only one field mirrored
assert.strictEqual(r.findings.length, 0, 'the one matching field agrees; the rest are absent → skipped');
ok('a field absent on either side is skipped (not a spurious finding)');

// --- Encompass registry: read-only + correct field extraction ---
const encLoan = { fields: { '1109': { value: '450000' }, '3': { value: '0.1099' }, '136': { value: 400000 }, '1041': { value: 'SFR' } } };
const extracted = encMap.extractFields(encLoan);
assert.strictEqual(extracted.loan_amount, 450000, 'field 1109 → loan_amount (numeric)');
assert.strictEqual(extracted.note_rate, 0.1099, 'field 3 → note_rate');
assert.strictEqual(extracted.property_type, 'SFR');
ok('the Encompass registry extracts canonical field IDs into portal keys');

// --- Encompass reconciliation: loan amount differs → mismatch ---
r = recon.reconcileEncompass(context, extracted);
assert.ok(r.findings.some((f) => f.code === 'encompass_loan_amount_mismatch'), 'Encompass loan amount differs from the registered structure');
ok('Encompass reconciliation flags an LOS loan-amount disagreement');

// --- registry is read-only: every entry is pull, authoritative pilot, non-blocking ---
assert.ok(encMap.REGISTRY.every((e) => e.direction === 'pull'), 'every field is pull-only (read-only)');
assert.ok(encMap.REGISTRY.every((e) => e.authoritative === 'pilot'), 'PILOT stays authoritative');
assert.ok(encMap.REGISTRY.every((e) => !e.blocksCtc && !e.blocksFunding), 'an Encompass mismatch never blocks CTC/funding');
assert.ok(encMap.BY_KEY.loan_amount.encompassFieldId === '1109', 'the canonical loan-amount id is 1109');
ok('the Encompass field registry is read-only, PILOT-authoritative, and non-blocking by policy');

console.log(`\nR6.10 + R6.11 system-reconciliation pure — ${passed} checks passed`);
