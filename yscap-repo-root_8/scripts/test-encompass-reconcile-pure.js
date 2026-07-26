'use strict';
/**
 * WO-B — pure tests for the Encompass reconcile service (no DB).
 *
 * Exercises the two pure cores the DB-backed computeFindings composes:
 *   - buildOurValues: application row + pricing quote + vesting LLC → our-side map
 *     (quote-only fields on an un-priced file fall through to "not comparable").
 *   - compareAll / summarize: registry compare + persisted-resolution folding,
 *     the term-sheet-gate `clear` flag, block-vs-advisory gating, and the
 *     resolution snapshot that re-opens a finding when a value moves.
 *
 * Pure: no DB, no network, no Encompass calls.
 */
const assert = require('assert');
const map = require('../src/lib/integrations/encompass-field-map');
const recon = require('../src/encompass/reconcile');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// ── Fixtures: a fully-agreeing flip file ────────────────────────────────────
const app = {
  ys_loan_number: 'YSCAP1', property_type: 'SFR', deal_type: 'flip',
  llc_id: 'llc-1', borrower_id: 'b-1',
  loan_amount: 525450, purchase_price: 450500, underlying_contract_price: 425000, assignment_fee: 25500,
  rehab_budget: 120000, as_is_value: 500000, arv: 750000, ltv: 90, rate_pct: 8.0, term: '12 months', maturity_date: '2027-06-22',
  rehab_type: 'Cosmetic', accrual_type: 'non_dutch',
  requested_exp_flips: 10, requested_exp_holds: 0, requested_exp_ground: 0,
};
const quote = {
  origPct: 0.0125,
  assignment: { recognizedPrice: 450500 },
  sizing: { initialAdvance: 405450, rehabHoldback: 120000, financedReserve: 0, costBasis: 570500, ltcPct: 92.1034, arvPct: 70.06, acqLtvPct: 90 },
  guidelines: { caps: { maxAcqLtv: 90, maxArvLtv: 75, maxLtc: 92.5 } },
};
const llcName = 'ABC Holdings LLC';

const loan = {
  baseLoanAmount: '525450.0000', purchasePriceAmount: '450500.0000', propertyAppraisedValueAmount: '750000.0000',
  loanAmortizationTermMonths: 12, requestedInterestRatePercent: '8.0', maturityDate: '2027-06-22', loanNumber: 'YSCAP1',
  property: { propertyType: 'Single Family' },
  customFields: [
    { fieldName: 'CX.MAXTOTALLOAN', value: '525450.0000' },
    { fieldName: 'CX.FINALINITIALLOAN', value: '405450.0000' },
    { fieldName: 'CX.REHABBUDGET', value: '120000.0000' },
    { fieldName: 'CX.FINANCEDREHABBUDGET', value: '120000.0000' },
    { fieldName: 'CX.EFFECTIVEPURCHASE', value: '450500.0000' },
    { fieldName: 'CX.ORIGINALCONTRACTPURCHASEP', value: '425000.0000' },
    { fieldName: 'CX.ASSIGNMENTFEE', value: '25500.0000' },
    { fieldName: 'CX.FINANCEDINTERESTRESERVE', value: '0.0000' },
    { fieldName: 'CX.TOTALCOST', value: '570500.0000' },
    { fieldName: 'CX.ASISVALUE', value: '500000.0000' },
    { fieldName: 'CX.ACTAULARV', value: '70.06' },
    { fieldName: 'CX.ACTAULLTC', value: '92.1034' },
    { fieldName: 'CX.ACTUALINITIALLTV', value: '90.0' },
    { fieldName: 'CX.MAXINITIALLTV', value: '90.0' },
    { fieldName: 'CX.MAXARV', value: '75.0' },
    { fieldName: 'CX.MAXLTC', value: '92.5' },
    { fieldName: 'CX.DEALPROJECTTYPE', value: 'Fix and Flip' },
    { fieldName: 'CX.REHABTYPE', value: 'Light Rehab' },
    { fieldName: 'CX.ACCRUALTYPE', value: 'Drawn' },
    { fieldName: 'CX.TOTALEXPERIENCEDEALS', value: '10' },
    { fieldName: 'CX.LOANTOBEVESTED', value: 'Entity' },
    { fieldName: '388', value: '1.25' }, // origination fee %
  ],
};

// theirs from the real extract pipeline + the vesting name (1859 loanPath is
// wired in WO-C; here we supply it so the name compare is exercised).
const theirs = Object.assign(map.extractFields(loan), { vesting_llc: 'ABC Holdings, LLC' });

// ── buildOurValues ──────────────────────────────────────────────────────────
const ours = recon.buildOurValues(app, quote, llcName);
assert.strictEqual(ours.loan_amount, 525450);
assert.strictEqual(ours.max_total_loan, 525450, 'max_total_loan mirrors our total');
assert.strictEqual(ours.final_initial_loan, 405450, 'from quote.sizing.initialAdvance');
assert.strictEqual(ours.effective_purchase, 450500, 'from quote.assignment.recognizedPrice');
assert.strictEqual(ours.contract_price, 425000, 'underlying contract price on an assignment');
assert.strictEqual(ours.origination_pct, 1.25, 'origPct fraction → percent');
assert.strictEqual(ours.term_months, 12, 'text term → int');
assert.strictEqual(ours.total_experience_deals, 10);
assert.strictEqual(ours.loan_to_be_vested, 'Entity', 'llc_id present → entity');
assert.strictEqual(ours.vesting_llc, 'ABC Holdings LLC');
assert.strictEqual(ours.actual_ltc, 92.1034);
assert.strictEqual(ours.max_ltc, 92.5);
assert.strictEqual(ours.exit_plan, undefined, 'no exit_plan column');
ok('buildOurValues maps columns + quote outputs (deferring what it lacks)');

// ── A fully-agreeing file is CLEAR ──────────────────────────────────────────
let r = recon.compareAll(ours, theirs, {});
assert.strictEqual(r.summary.openBlocking, 0, 'no open blocking findings');
assert.strictEqual(r.summary.clear, true, 'the findings tab is clear');
assert.ok(r.summary.matched >= 18, `most fields matched (${r.summary.matched})`);
assert.ok(r.fields.find((f) => f.key === 'ys_loan_number').status === 'reference', 'loan number is reference');
ok('a file that agrees with Encompass is clear (no blocking findings)');

// ── A money mismatch opens a BLOCKING finding ───────────────────────────────
const ours2 = Object.assign({}, ours, { loan_amount: 525000, max_total_loan: 525000 }); // off by $450
r = recon.compareAll(ours2, theirs, {});
assert.ok(r.summary.openBlocking >= 2, 'loan_amount + max_total_loan both open');
assert.ok(r.summary.openBlockingKeys.includes('loan_amount'), 'loan_amount is a blocker');
assert.strictEqual(r.summary.clear, false, 'the term-sheet gate is NOT clear');
ok('a money mismatch (to the penny) opens a blocking finding and un-clears the gate');

// ── An advisory mismatch surfaces but never blocks ──────────────────────────
const ours3 = Object.assign({}, ours, { accrual_type: 'dutch' }); // ours dutch vs Encompass Drawn→non_dutch
r = recon.compareAll(ours3, theirs, {});
const acc = r.fields.find((f) => f.key === 'accrual_type');
assert.strictEqual(acc.status, 'mismatch');
assert.strictEqual(acc.gate, map.GATE.ADVISORY);
assert.strictEqual(acc.open, true);
assert.ok(r.summary.openAdvisory >= 1, 'counted as advisory');
assert.strictEqual(r.summary.clear, true, 'an advisory disagreement never blocks the term sheet');
ok('an advisory mismatch (accrual) surfaces but never blocks the gate');

// ── A resolution snapshot clears the finding — and re-opens if a value moves ─
const resolutions = { loan_amount: { resolution: 'accepted', ours_snapshot: '525000', theirs_snapshot: '525450' } };
r = recon.compareAll(ours2, theirs, resolutions);
const la = r.fields.find((f) => f.key === 'loan_amount');
assert.strictEqual(la.open, false, 'the accepted snapshot resolves the finding');
assert.strictEqual(la.resolution, 'accepted');
assert.ok(!r.summary.openBlockingKeys.includes('loan_amount'), 'a resolved finding is not a blocker');
// move our value → the snapshot no longer matches → the finding re-opens
const ours4 = Object.assign({}, ours2, { loan_amount: 524000 });
r = recon.compareAll(ours4, theirs, resolutions);
assert.strictEqual(r.fields.find((f) => f.key === 'loan_amount').open, true, 'a value move re-opens the resolved finding');
ok('a resolution snapshot clears a finding and auto-re-opens when a value moves');

// ── Missing our-side value → incomparable (deferred), never a false mismatch ─
const oursUnpriced = recon.buildOurValues(app, null, llcName); // no quote → quote-only fields absent
r = recon.compareAll(oursUnpriced, theirs, {});
const fin = r.fields.find((f) => f.key === 'final_initial_loan');
assert.strictEqual(fin.status, 'incomparable', 'un-priced file defers the quote-only fields');
assert.ok(!r.summary.openBlockingKeys.includes('final_initial_loan'), 'a deferred field never blocks');
assert.strictEqual(r.summary.clear, true, 'an un-priced file still clears on the basics (owner: compare basics, defer the rest)');
ok('an un-priced file defers quote-only fields (incomparable), never a false block');

console.log(`\nWO-B Encompass reconcile pure — ${passed} checks passed`);
