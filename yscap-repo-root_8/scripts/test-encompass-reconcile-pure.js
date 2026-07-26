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
  ys_loan_number: 'YSCAP1', property_type: 'SFR', units: 2,
  program: 'Fix & Flip w/ Construction', loan_type: 'Purchase', // deal_type is derived from these
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
  property: { propertyType: 'Single Family', financedNumberOfUnits: 2 },
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
// deal_type is DERIVED from program/loan_type (no deal_type column on applications)
assert.strictEqual(ours.deal_type, 'flip', '"Fix & Flip w/ Construction" → flip');
assert.strictEqual(recon.buildOurValues({ program: 'Bridge' }).deal_type, 'bridge');
assert.strictEqual(recon.buildOurValues({ loan_type: 'Ground up' }).deal_type, 'ground-up');
assert.strictEqual(recon.buildOurValues({ program: 'DSCR' }).deal_type, 'rental');
assert.strictEqual(recon.buildOurValues({ program: 'Something Else' }).deal_type, undefined, 'unrecognized → defer, never guess');
ok('buildOurValues maps columns + quote outputs; deal_type derives from program/loan_type');

// ── A fully-agreeing file PASSES (owner-directed 2026-07-26: everything matches)
let r = recon.compareAll(ours, theirs, {});
assert.strictEqual(r.summary.openBlocking, 0, 'no open blocking findings');
assert.strictEqual(r.summary.incomparable, 0, 'nothing is "no data to compare" on a full file');
assert.strictEqual(r.summary.clear, true, 'the findings tab passes when everything matches');
assert.strictEqual(r.summary.matched, r.summary.compared, 'matched === compared on a fully-agreeing file');
const lnf = r.fields.find((f) => f.key === 'ys_loan_number');
assert.strictEqual(lnf.status, 'match', 'loan number is now MATCHED (not reference-only)');
assert.strictEqual(lnf.gate, map.GATE.BLOCK);
const unf = r.fields.find((f) => f.key === 'units');
assert.ok(unf, 'units is a comparison field now (Encompass field 16)');
assert.strictEqual(unf.status, 'match', 'units 2 vs 2 matches');
assert.ok(!r.fields.find((f) => f.key === 'ref_pitia'), 'PITIA is removed from the comparison');
ok('a fully-agreeing file passes; loan number + units are matched; PITIA is gone');

// ── A money mismatch un-passes the section ──────────────────────────────────
const ours2 = Object.assign({}, ours, { loan_amount: 525000, max_total_loan: 525000 }); // off by $450
r = recon.compareAll(ours2, theirs, {});
assert.ok(r.summary.openBlocking >= 2, 'loan_amount + max_total_loan both open');
assert.ok(r.summary.notPassingKeys.includes('loan_amount'), 'loan_amount is not-passing');
assert.ok(r.summary.openBlockingKeys.includes('loan_amount'), 'openBlockingKeys aliases notPassingKeys');
assert.strictEqual(r.summary.clear, false, 'the term-sheet gate does NOT pass');
ok('a money mismatch (to the penny) un-passes the section');

// ── An advisory mismatch now ALSO un-passes (owner: advisory must match too) ─
const ours3 = Object.assign({}, ours, { accrual_type: 'dutch' }); // ours dutch vs Encompass Drawn→non_dutch
r = recon.compareAll(ours3, theirs, {});
const acc = r.fields.find((f) => f.key === 'accrual_type');
assert.strictEqual(acc.status, 'mismatch');
assert.strictEqual(acc.gate, map.GATE.ADVISORY);
assert.strictEqual(acc.open, true);
assert.ok(r.summary.openAdvisory >= 1, 'still counted as advisory');
assert.ok(r.summary.notPassingKeys.includes('accrual_type'), 'advisory now counts as not-passing');
assert.strictEqual(r.summary.clear, false, 'an advisory disagreement now blocks the term sheet (owner-directed)');
ok('an advisory mismatch now un-passes the section too');

// ── "No data to compare" (incomparable) un-passes — go enter it in Encompass ─
const oursUnpriced = recon.buildOurValues(app, null, llcName); // no quote → quote-only fields absent → incomparable
r = recon.compareAll(oursUnpriced, theirs, {});
const fin = r.fields.find((f) => f.key === 'final_initial_loan');
assert.strictEqual(fin.status, 'incomparable', 'un-priced file has no data on the quote-only fields');
assert.ok(r.summary.incomparable >= 1);
assert.ok(r.summary.notPassingKeys.includes('final_initial_loan'), 'a no-data field now counts as not-passing');
assert.strictEqual(r.summary.clear, false, 'a "no data to compare" field now blocks (owner: put it in Encompass)');
ok('a "no data to compare" field un-passes the section (must be filled in Encompass)');

// ── An accepted-but-differing resolution still does NOT pass (must MATCH) ────
const resolutions = { loan_amount: { resolution: 'accepted', ours_snapshot: '525000', theirs_snapshot: '525450' } };
r = recon.compareAll(ours2, theirs, resolutions);
const la = r.fields.find((f) => f.key === 'loan_amount');
assert.strictEqual(la.open, false, 'the accepted snapshot marks the finding not-open');
assert.strictEqual(la.resolution, 'accepted');
assert.strictEqual(la.status, 'mismatch', 'the values still differ');
assert.ok(r.summary.notPassingKeys.includes('loan_amount'), 'an accepted-but-differing field still does not match → not-passing');
assert.strictEqual(r.summary.clear, false, 'only a real MATCH passes — accepting a difference does not (owner-directed)');
// move our value → the snapshot no longer matches → the finding re-opens
const ours4 = Object.assign({}, ours2, { loan_amount: 524000 });
r = recon.compareAll(ours4, theirs, resolutions);
assert.strictEqual(r.fields.find((f) => f.key === 'loan_amount').open, true, 'a value move re-opens the resolved finding');
ok('an accepted-but-differing resolution never passes; a value move re-opens it');

console.log(`\nWO-B Encompass reconcile pure — ${passed} checks passed`);
