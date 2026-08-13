'use strict';
/**
 * THE APPLICATION-DETAILS DOOR'S FIELD MAP — request key → `applications` column.
 *
 * It used to live inline in `PATCH /applications/:id/details` and nowhere else,
 * which was fine while the door was the only thing that needed it. The 2026-08-13
 * experience re-allocation carve-out needs the SAME map BEFORE the write, to answer
 * "would this request change anything other than the experience counts?" — and a
 * second, hand-kept copy of forty field names is precisely the drift this repo keeps
 * getting bitten by (a key added to one copy and not the other would silently let an
 * unrelated field ride through a frozen term sheet).
 *
 * So it lives here once. `routes/staff.js` aliases these straight into its existing
 * `NUM` / `STR` / `DATE` locals, so the door's behaviour is byte-identical; nothing
 * about how a value is coerced, bounded or audited moved.
 *
 * WHEN YOU ADD A FIELD TO THE DETAILS DOOR, ADD IT HERE. `scripts/test-experience-
 * realloc-pure.js` reads the door's source and fails if it finds a key the door
 * handles that this map does not know — an unknown key is treated as "changes
 * something else" and refuses, so a miss fails SAFE (the freeze stands) rather than
 * letting a field through, but it also silently disables the carve-out.
 */

/** Money / count columns — coerced with Number() at the door. */
const NUM = {
  units: 'units', purchasePrice: 'purchase_price', asIsValue: 'as_is_value',
  arv: 'arv', rehabBudget: 'rehab_budget', sqftPre: 'sqft_pre', sqftPost: 'sqft_post',
  requestedExpFlips: 'requested_exp_flips', requestedExpHolds: 'requested_exp_holds',
  requestedExpGround: 'requested_exp_ground',
  requestedExpReo: 'requested_exp_reo', requestedIrMonths: 'requested_ir_months',
  requestedIrAmount: 'requested_ir_amount',
  payoffAmount: 'payoff_amount', originalPurchasePrice: 'original_purchase_price',
  // WHAT THE BORROWER WALKS AWAY WITH on a cash-out refinance (db/267's
  // `estimated_cash_out`). The payoff section fills it from the structure and lets a
  // human override it; see src/lib/payoff.js for the one definition of that arithmetic.
  estimatedCashOut: 'estimated_cash_out',
  underlyingContractPrice: 'underlying_contract_price', assignmentFee: 'assignment_fee',
};

/** Free-text / enum columns. */
const STR = {
  propertyType: 'property_type', loanType: 'loan_type', program: 'program', occupancy: 'occupancy',
  rehabType: 'rehab_type', term: 'term', lender: 'lender', channel: 'channel', ppp: 'ppp',
  // WHO we pay off and WHICH loan (db/386) — free text beside the payoff AMOUNT that
  // has lived in NUM since db/032.
  payoffLender: 'payoff_lender', payoffLoanNumber: 'payoff_loan_number',
};

/** Date-only columns. */
const DATE = { acquisitionDate: 'acquisition_date' };

/** Boolean columns the door writes explicitly. */
const BOOL = { isAssignment: 'is_assignment' };

/** jsonb columns the door writes explicitly. */
const JSONB = { propertyAddress: 'property_address' };

/** Every request key the door understands → its column. */
const ALL = { ...NUM, ...STR, ...DATE, ...BOOL, ...JSONB };

/** The KIND of each request key, for callers that must compare a proposed value to
 *  a stored one (see details-freeze.changesOnlyExperience). */
function kindOf(key) {
  if (key in NUM) return 'num';
  if (key in STR) return 'str';
  if (key in DATE) return 'date';
  if (key in BOOL) return 'bool';
  if (key in JSONB) return 'jsonb';
  return null;
}

module.exports = { NUM, STR, DATE, BOOL, JSONB, ALL, kindOf };
