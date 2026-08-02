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
  rehab_type: 'Cosmetic', accrual_type: 'non_dutch', lender: 'Fidelis',
  requested_exp_flips: 10, requested_exp_holds: 0, requested_exp_ground: 0,
};
// NOTE (owner-reported 2026-07-26): the frozen engines emit every leverage ratio as
// a FRACTION (ltcPct = totalLoan / ltcBasis; caps are multipliers), which is what
// pricing.js stores on the quote. This fixture used to (wrongly) supply percents,
// which is exactly why the live "0.67425 vs 67.425" mismatch was never caught.
// It now mirrors the REAL engine output; buildOurValues converts to Encompass's
// percent vocabulary at the comparison boundary.
const quote = {
  origPct: 0.0125,
  assignment: { recognizedPrice: 450500 },
  sizing: { initialAdvance: 405450, rehabHoldback: 120000, financedReserve: 0, costBasis: 570500, ltcPct: 0.921034, arvPct: 0.7006, acqLtvPct: 0.90 },
  guidelines: { caps: { maxAcqLtv: 0.90, maxArvLtv: 0.75, maxLtc: 0.925 } },
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
    { fieldName: 'CX.EXITPLAN', value: 'Sale' },
    { fieldName: 'CX.CAPITALPROVIDER', value: 'Fidelis Investors' },  // our 'Fidelis' must match this   // exit plan is a real match now (flip → Sale)
    { fieldName: 'CX.REHABTYPE', value: 'Cosmetic Rehab' },  // our 'Cosmetic' is its OWN bucket now
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
// Engine FRACTIONS are converted to Encompass's PERCENT vocabulary (the 0.67425
// vs 67.425 root cause). The frozen engine math is untouched — only the value we
// hand to the comparison is translated.
assert.strictEqual(ours.actual_ltc, 92.1034, 'engine fraction 0.921034 → 92.1034%');
assert.strictEqual(ours.actual_arv_ltv, 70.06, 'engine fraction 0.7006 → 70.06%');
assert.strictEqual(ours.max_ltc, 92.5, 'cap fraction 0.925 → 92.5%');
assert.strictEqual(ours.max_arv_ltv, 75, 'cap fraction 0.75 → 75%');
assert.strictEqual(ours.actual_initial_ltv, 90, 'applications.ltv is already a percent — left as-is');
// applications.ltv is NEVER re-scaled: a genuinely small LTV stays small (re-scaling
// would read 1% as 100%), and the "use Encompass value" pull-in round-trips.
assert.strictEqual(recon.buildOurValues({ ltv: 1.0 }, null).actual_initial_ltv, 1, 'a 1% stored LTV is not inflated to 100');
assert.strictEqual(recon.buildOurValues({ ltv: 90 }, null).actual_initial_ltv, 90);
// Exit plan on a BRIDGE / GROUND-UP deal is NOT APPLICABLE — it must never hold the
// term sheet (there is nothing for staff to enter anywhere).
{
  const bridge = recon.buildOurValues({ program: 'Bridge' }, null);
  const r = recon.compareAll(bridge, { exit_plan: 'Sale' }, {});
  assert.ok(!r.summary.notPassingKeys.includes('exit_plan'), 'a bridge file is NOT blocked by exit plan');
  const flip = recon.buildOurValues({ program: 'Fix & Flip' }, null);
  const r2 = recon.compareAll(flip, { exit_plan: 'Refinance: Rental' }, {});
  assert.ok(r2.summary.notPassingKeys.includes('exit_plan'), 'a flip whose Encompass exit disagrees still flags');
}
assert.strictEqual(recon.buildOurValues({ program: 'Fix & Flip' }, null).exit_plan, 'sell', 'flip → sell');
assert.strictEqual(recon.buildOurValues({ program: 'DSCR' }, null).exit_plan, 'hold', 'rental → hold');
assert.strictEqual(recon.buildOurValues({ program: 'Bridge' }, null).exit_plan, undefined, 'bridge exit is not guessed');
assert.strictEqual(ours.exit_plan, 'sell', 'a flip file exits by sale');
assert.strictEqual(ours.capital_provider, 'Fidelis', 'note buyer feeds the capital-provider compare');
// Effective purchase falls back to the purchase price when there is no assignment
// haircut, so a straight purchase MATCHES instead of reading "no data to compare".
assert.strictEqual(recon.buildOurValues({ purchase_price: 300000 }, null).effective_purchase, 300000,
  'no assignment → effective purchase = purchase price');
assert.strictEqual(ours.effective_purchase, 450500, 'the capped recognized price still wins when it exists');
// A square-footage addition is an EXPANSION in Encompass regardless of our bucket.
// Uses the SAME signal the pricing layer uses: sqft_post > sqft_pre, or a rehab
// type that names an addition (never an invented boolean column).
assert.strictEqual(recon.buildOurValues({ rehab_type: 'Cosmetic', sqft_pre: 1200, sqft_post: 1800 }, null).rehab_type, 'expansion',
  'square footage grew → Expansion');
assert.strictEqual(recon.buildOurValues({ rehab_type: 'Adding SF' }, null).rehab_type, 'expansion',
  'a rehab type naming an addition → Expansion');
assert.strictEqual(recon.buildOurValues({ rehab_type: 'Cosmetic', sqft_pre: 1200, sqft_post: 1200 }, null).rehab_type, 'Cosmetic',
  'same square footage is NOT an expansion');
assert.strictEqual(recon.buildOurValues({ rehab_type: 'Cosmetic' }, null).rehab_type, 'Cosmetic');
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

// ── Super-admin FIELD EXCEPTIONS (owner-directed 2026-08-02) ────────────────
// A not-matching / "no data to compare" field can be escalated to a super admin, who
// GRANTS an exception so it PASSES the gate. This mirrors how computeFindings composes
// it: compareAll → applyFieldExceptions(resolutions) → summarize.
const applyFieldExceptions = recon._internals.applyFieldExceptions;
{
  // A $450 loan-amount mismatch blocks; a granted exception (snapshot holds) clears it.
  const resEx = { loan_amount: { resolution: 'excepted', ours_snapshot: '525000', theirs_snapshot: '525450', resolved_by: 'super-1', note: 'known LOS rounding, verified' } };
  const cmp = recon.compareAll(ours2, theirs, resEx);
  applyFieldExceptions(cmp.fields, resEx);
  const summary = recon.summarize(cmp.fields);
  const la = cmp.fields.find((f) => f.key === 'loan_amount');
  assert.strictEqual(la.excepted, true, 'the granted field is marked excepted');
  assert.strictEqual(la.exceptedBy, 'super-1', 'it carries who granted it (for the panel)');
  assert.ok(!summary.notPassingKeys.includes('loan_amount'), 'an excepted field is NOT in notPassingKeys — the gate stops blocking it');
  assert.strictEqual(summary.excepted, 1, 'excepted is counted');
  assert.ok(summary.exceptedKeys.includes('loan_amount'), 'excepted keys are listed for the panel');
  // clear passes ONLY because max_total_loan (the other $450 mismatch) is also excepted:
  const resBoth = Object.assign({}, resEx, { max_total_loan: { resolution: 'excepted', ours_snapshot: '525000', theirs_snapshot: '525450', resolved_by: 'super-1' } });
  const cmp2 = recon.compareAll(ours2, theirs, resBoth);
  applyFieldExceptions(cmp2.fields, resBoth);
  assert.strictEqual(recon.summarize(cmp2.fields).clear, true, 'with every not-passing field excepted, the term-sheet gate PASSES');
}
{
  // AUTO-VOID: the exception snapshot no longer holds after the value moves → re-blocks.
  const resEx = { loan_amount: { resolution: 'excepted', ours_snapshot: '525000', theirs_snapshot: '525450', resolved_by: 'super-1' } };
  const oursMoved = Object.assign({}, ours, { loan_amount: 524000, max_total_loan: 524000 }); // now $1450 off — snapshot stale
  const cmp = recon.compareAll(oursMoved, theirs, resEx);
  applyFieldExceptions(cmp.fields, resEx);
  const la = cmp.fields.find((f) => f.key === 'loan_amount');
  assert.ok(!la.excepted, 'the exception AUTO-VOIDS once the value changes — it can never hide a NEW disagreement');
  assert.ok(recon.summarize(cmp.fields).notPassingKeys.includes('loan_amount'), 'the field blocks again after the data moved');
}
{
  // A REQUESTED (not yet granted) exception still blocks — only a grant passes the gate.
  const resReq = { loan_amount: { resolution: 'exception_requested', ours_snapshot: '525000', theirs_snapshot: '525450', requested_by: 'lo-1', note: 'please except' } };
  const cmp = recon.compareAll(ours2, theirs, resReq);
  applyFieldExceptions(cmp.fields, resReq);
  const la = cmp.fields.find((f) => f.key === 'loan_amount');
  assert.strictEqual(la.exceptionRequested, true, 'a pending request is surfaced for the super admin');
  assert.ok(!la.excepted, 'a request is NOT a grant');
  assert.ok(recon.summarize(cmp.fields).notPassingKeys.includes('loan_amount'), 'a pending request still blocks until granted');
}
ok('field exceptions: a granted exception passes the gate; auto-voids on a data change; a pending request still blocks');

console.log(`\nWO-B Encompass reconcile pure — ${passed} checks passed`);
