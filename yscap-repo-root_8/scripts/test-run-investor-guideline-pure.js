'use strict';
/**
 * Pure test: the investor-guideline review is folded INTO the ONE whole-loan run
 * (owner-directed 2026-07-24) — its findings land in the SAME deduped registry,
 * categorized `investor_guideline`, driven by the canonical context values + the
 * caller's `investorInputs`. Never fabricates; a fatal escalation flips the run's
 * advisory gate (super-admin-overridable HARD WARNING, never a hard block).
 */
const assert = require('assert');
const run = require('../src/lib/underwriting/run');
const wlc = require('../src/lib/underwriting/whole-loan-context');
const pa = require('../src/lib/underwriting/program-adapter');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const baseApp = {
  id: 'app-ig', updated_at: '2026-07-24T00:00:00Z', program: 'gold', registered_program: 'gold',
  loan_type: 'purchase', property_type: 'sfr', units: 1, purchase_price: 400000, as_is_value: 400000,
  arv: 600000, rehab_budget: 100000, is_assignment: false, fico: 720,
};
const quote = { program: 'gold', status: 'ELIGIBLE', eligible: true, noteRate: 0.1099,
  caps: { maxAcqLtv: 0.9, maxArvLtv: 0.75, maxLtc: 0.9, minFico: 660, maxLoan: 3000000 },
  sizing: { totalLoan: 450000, initialAdvance: 350000, rehabHoldback: 100000, financedReserve: 0 }, reasons: [] };
const baseReg = { id: 'reg-ig', program: 'gold', status: 'ELIGIBLE', stale: false, is_manual: false,
  total_loan: 450000, note_rate: 0.1099, created_at: '2026-07-24T00:00:00Z',
  inputs: { purchasePrice: 400000, arv: 600000, rehabBudget: 100000, fico: 720, propertyType: 'sfr', units: 1 }, quote };

function assemble(appOver, opts) {
  const a = { ...baseApp, ...(appOver || {}) };
  const context = wlc.assembleContext({ application: a, registration: baseReg });
  const programDecision = pa.fromRegistration(baseReg, { missingRequired: !context.ready });
  return run.assembleRun({ context, registration: baseReg, programDecision, ...(opts || {}) });
}
const igFindings = (out) => out.findings.filter((f) => f.category === 'investor_guideline');
const codes = (out) => igFindings(out).map((f) => f.code).sort();

// 1 — the note buyer + property_state flow into the canonical context values.
{
  const context = wlc.assembleContext({ application: { ...baseApp, property_state: 'NY', lender: 'Blue Lake' }, registration: baseReg });
  assert.strictEqual(context.values.property_state, 'NY');
  assert.strictEqual(context.values.note_buyer, 'Blue Lake');
  ok('property_state + note_buyer resolve into the canonical whole-loan context values');
}

// 2 — a Blue Lake NY loan folds the escalation findings INTO the one run, categorized.
{
  const out = assemble({ property_state: 'NY', lender: 'Blue Lake', loan_amount: 2000000 });
  const c = codes(out);
  assert.ok(c.includes('isg_bl_ny_loan'), 'NY loan escalation is in the run');
  const ny = igFindings(out).find((f) => f.code === 'isg_bl_ny_loan');
  assert.strictEqual(ny.category, 'investor_guideline');
  assert.ok(Array.isArray(ny.sources) && ny.sources.includes('investor_guideline'), 'sourced from the investor-guideline desk');
  // it lands in the ONE deduped registry too.
  assert.ok(out.decision.registry.some((r) => r.code === 'isg_bl_ny_loan'), 'the ISG finding is in the deduped registry');
  // a fatal escalation flips the advisory gate (overridable HARD WARNING, not a hard block).
  assert.strictEqual(out.ctcEligible, false, 'a fatal ISG escalation flags CTC in the one decision');
  ok('Blue Lake NY loan: the escalation finding is folded into the one run + registry, categorized investor_guideline');
}

// 3 — the SAME file with no note buyer set fires NO buyer-specific ISG finding (never fabricates).
{
  const out = assemble({ property_state: 'NY', loan_amount: 2000000 }); // no lender
  assert.ok(!codes(out).some((x) => x.startsWith('isg_bl_')), 'no Blue-Lake rule without a known note buyer');
  ok('no note buyer → no buyer-specific ISG finding folded in (never fabricated)');
}

// 4 — caller-provided investorInputs (credit FICO) drive an ALL-buyer rule even with no note buyer.
{
  const out = assemble({}, { investorInputs: { fico_credit: 680 } }); // fico_file (context) = 720
  assert.ok(codes(out).includes('isg_fico_mismatch'), 'a FICO mismatch from investorInputs is folded in');
  const m = igFindings(out).find((f) => f.code === 'isg_fico_mismatch');
  assert.strictEqual(m.expected_value, '680');
  assert.strictEqual(m.actual_value, '720');
  ok('caller investorInputs (imported credit FICO) drive an all-buyer ISG rule inside the run');
}

// 5 — a clean file with matching FICO and no note buyer adds NO ISG findings (silent).
{
  const out = assemble({}, { investorInputs: { fico_credit: 720 } });
  assert.strictEqual(igFindings(out).length, 0, 'a clean file surfaces no investor-guideline findings');
  ok('a clean file: the investor-guideline review adds nothing to the run');
}

console.log(`\nrun investor-guideline wiring pure — ${passed} checks passed`);
