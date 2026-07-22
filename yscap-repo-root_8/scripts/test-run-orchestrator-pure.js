'use strict';
/**
 * R6.14 — pure tests for the whole-loan run orchestrator (assembleRun). Proves
 * the run composes context + program verdict + independent structure ledger +
 * every desk's findings into ONE decision that gates term-sheet/CTC/funding
 * correctly, and produces a reproducible source hash.
 */
const assert = require('assert');
const run = require('../src/lib/underwriting/run');
const wlc = require('../src/lib/underwriting/whole-loan-context');
const pa = require('../src/lib/underwriting/program-adapter');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const app = {
  id: 'app-1', updated_at: '2026-07-20T00:00:00Z', program: 'gold', registered_program: 'gold',
  loan_type: 'purchase', property_type: 'sfr', units: 1, purchase_price: 400000, as_is_value: 400000,
  arv: 600000, rehab_budget: 100000, is_assignment: false, fico: 720,
};
const goodQuote = {
  program: 'gold', status: 'ELIGIBLE', eligible: true, noteRate: 0.1099,
  caps: { maxAcqLtv: 0.9, maxArvLtv: 0.75, maxLtc: 0.9, minFico: 660, maxLoan: 3000000 },
  sizing: { totalLoan: 450000, initialAdvance: 350000, rehabHoldback: 100000, financedReserve: 0 },
  reasons: [],
};
const reg = { id: 'reg-1', program: 'gold', status: 'ELIGIBLE', stale: false, is_manual: false,
  total_loan: 450000, note_rate: 0.1099, created_at: '2026-07-21T00:00:00Z',
  inputs: { purchasePrice: 400000, arv: 600000, rehabBudget: 100000, fico: 720, propertyType: 'sfr', units: 1 },
  quote: goodQuote };

function build(appOverride, regOverride, opts) {
  const a = { ...app, ...(appOverride || {}) };
  const r = regOverride === null ? null : { ...reg, ...(regOverride || {}) };
  const context = wlc.assembleContext({ application: a, registration: r });
  const programDecision = r ? pa.fromRegistration(r, { missingRequired: !context.ready }) : null;
  return run.assembleRun({ context, registration: r, programDecision, ...(opts || {}) });
}

// --- clean eligible file: all gates open, ledger computed, no fatal finding ---
let out = build();
assert.strictEqual(out.status, 'ELIGIBLE');
assert.strictEqual(out.termSheetEligible, true);
assert.strictEqual(out.ctcEligible, true);
assert.strictEqual(out.fundingEligible, true);
const arvRow = out.calculations.find((c) => c.metric === 'arv_ltv');
assert.ok(arvRow && Math.abs(arvRow.result - 0.75) < 0.001, 'arv_ltv = 450k/600k = 0.75');
assert.ok(out.calculations.some((c) => c.binding), 'a binding constraint is identified');
ok('a clean ELIGIBLE file: all gates open + the independent ledger is computed');

// --- MANUAL registration (not approved) → nothing issuable ---
out = build({}, { status: 'MANUAL', quote: { ...goodQuote, status: 'MANUAL', reasons: [{ level: 'MANUAL', msg: 'Needs review.' }] } }, { manualApproved: false });
assert.strictEqual(out.status, 'MANUAL_PENDING');
assert.strictEqual(out.termSheetEligible, false, 'MANUAL_PENDING cannot issue');
assert.strictEqual(out.ctcEligible, false);
assert.strictEqual(out.fundingEligible, false);
ok('a MANUAL-pending run blocks term sheet + CTC + funding');

// --- a structure breach over a non-waivable cap → fatal, blocks CTC + funding ---
out = build({}, { quote: { ...goodQuote, caps: { ...goodQuote.caps, maxArvLtv: 0.6 },
  // force a hard breach: lower the ARV cap below the 0.75 result
} });
const breach = out.findings.find((f) => /arv_ltv_over_cap/.test(f.code));
assert.ok(breach, 'the ARV-LTV breach is a finding');
assert.strictEqual(breach.severity, 'warning', 'an over-cap breach with no waiver policy is manual-review');
assert.strictEqual(out.termSheetEligible, false, 'the breach blocks term-sheet issuance (needs approval)');
ok('a structure cap breach becomes a finding and blocks term-sheet issuance');

// --- a missing required fact (no registration) → NOT_READY, nothing issuable ---
out = build({}, null);
assert.strictEqual(out.status, 'NOT_READY');
assert.strictEqual(out.termSheetEligible, false);
assert.strictEqual(out.fundingEligible, false);
ok('no registration → NOT_READY, nothing issuable');

// --- priced-input drift → STALE + a drift finding ---
out = build({}, {}, { staleChanged: [{ key: 'arv', from: 600000, to: 650000 }] });
assert.strictEqual(out.status, 'STALE', 'drift makes the run STALE');
assert.strictEqual(out.termSheetEligible, false);
assert.ok(out.findings.some((f) => f.code === 'registration_input_drift'), 'a drift finding is recorded');
ok('priced-input drift → STALE, not issuable, with a drift finding');

// --- a source discrepancy (context) → DATA_CONFLICT blocks CTC + funding ---
out = build({ arv: 650000 }); // application ARV drifts from the priced 600k → discrepancy
assert.strictEqual(out.status, 'DATA_CONFLICT');
assert.strictEqual(out.ctcEligible, false);
assert.strictEqual(out.fundingEligible, false);
ok('a source disagreement → DATA_CONFLICT, blocks CTC + funding');

// --- an extra desk finding (e.g. appraisal fatal) flows into the one registry ---
out = build({}, {}, { extraFindings: [{ code: 'appraisal_value_low', severity: 'fatal', source: 'appraisal', blocks_ctc: true, title: 'Appraisal value below sizing' }] });
assert.ok(out.findings.some((f) => f.code === 'appraisal_value_low'), 'the appraisal finding is in the one registry');
assert.strictEqual(out.ctcEligible, false, 'a fatal appraisal finding blocks CTC');
assert.strictEqual(out.termSheetEligible, true, 'but the term sheet can still issue (no term-sheet block on it)');
ok('an appraisal/desk finding flows into the ONE registry and gates CTC');

// --- pricedDrift derives stale from a CONTEXT discrepancy on a priced field ---
// (the audit-fixed path: runWholeLoan builds staleChanged from the context's
// source-priority discrepancies, casing-agnostic — not a snake/camel key match).
const runInternals = require('../src/lib/underwriting/run')._internals;
const driftCtx = { discrepancies: [
  { field: 'purchase_price', governing: { source: 'pricing_engine', value: 400000 }, conflicts: [{ source: 'application', value: 450000 }] },
  { field: 'rehab_budget', governing: { source: 'pricing_engine', value: 100000 }, conflicts: [{ source: 'application', value: 130000 }] },
  { field: 'borrower_name', governing: { source: 'application', value: 'Jane' }, conflicts: [{ source: 'appraisal', value: 'Jane Q' }] },
] };
const drift = runInternals.pricedDrift(driftCtx);
assert.strictEqual(drift.length, 2, 'only the two PRICED-field discrepancies are drift (not borrower_name)');
assert.ok(drift.some((d) => d.key === 'purchase_price' && d.from === 400000 && d.to === 450000), 'purchase_price drift captured with from/to');
assert.ok(!drift.some((d) => d.key === 'borrower_name'), 'a non-priced discrepancy is not treated as priced-input drift');
ok('pricedDrift derives stale from priced-field context discrepancies (casing-agnostic, audit fix)');

// --- reproducible source hash ---
const h1 = build().sourceHash;
const h2 = build().sourceHash;
assert.strictEqual(h1, h2, 'same inputs → same run hash');
ok('the run source hash is reproducible');

console.log(`\nR6.14 run-orchestrator pure — ${passed} checks passed`);
