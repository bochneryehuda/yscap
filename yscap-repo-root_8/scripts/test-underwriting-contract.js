'use strict';
/**
 * Unit tests for the purchase-contract findings engine
 * (src/lib/underwriting/purchase-contract-checks.js). Pure — no DB/network/keys.
 * Includes the audit's entity-suffix false-fatal + assignment-math/cap cases.
 */
const assert = require('assert');
const { computeContractFindings, sellerNames, summarize } = require('../src/lib/underwriting/purchase-contract-checks');

const file = {
  property_address: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' },
  purchase_price: 412000,
  entity_name: 'Maple Grove Holdings LLC',
  is_assignment: false, assignment_fee: null, underlying_contract_price: null,
};
const goodContract = {
  propertyAddress: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' },
  purchasePrice: 412000, sellerNames: ['Jane Seller'], buyerName: 'Maple Grove Holdings LLC',
  isAssignment: false, assignmentFee: null, underlyingPrice: null,
  closingDate: '2026-08-01', earnestMoney: 10000, readable: true, notes: null,
};
const codes = (fs) => fs.map((f) => f.code).sort();
const cf = (contract, f = file) => computeContractFindings({ ...goodContract, ...contract }, f);

// 1. Clean, matching contract → no findings.
assert.deepStrictEqual(codes(cf({})), [], 'a matching contract should raise no findings');
assert.strictEqual(summarize(cf({})).blocksCtc, false);

// 2. Property address mismatch → FATAL.
assert.deepStrictEqual(codes(cf({ propertyAddress: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' } })), ['contract_address_mismatch']);

// 3. Purchase price mismatch → FATAL; $1 rounding tolerated.
assert.deepStrictEqual(codes(cf({ purchasePrice: 430000 })), ['contract_price_mismatch']);
assert.deepStrictEqual(codes(cf({ purchasePrice: 412001 })), []);

// 4. Buyer entity — audit fix: "L.L.C." vs "LLC" and "Maple Grove Holdings" must MATCH.
assert.deepStrictEqual(codes(cf({ buyerName: 'Blue Sky Capital LLC' })), ['contract_buyer_mismatch']);
// On an ASSIGNMENT the purchase contract names the WHOLESALER as buyer, not our vesting entity —
// that is the whole point of an assignment, so it must NOT fire a fatal entity mismatch (owner-
// reported 2026-07-27). The assignment/chain checks own whether the assignee reaches the entity.
assert.ok(!codes(cf({ buyerName: 'Blue Sky Capital LLC' }, { ...file, is_assignment: true })).includes('contract_buyer_mismatch'),
  'on an assignment the wholesaler contract buyer is expected — no contract_buyer_mismatch fatal');
assert.deepStrictEqual(codes(cf({ buyerName: 'Maple Grove Holdings' })), [], 'suffix-less entity must match');
assert.deepStrictEqual(codes(cf({ buyerName: 'Maple Grove Holdings, L.L.C.' })), [], 'punctuated LLC must match');
// Buyer is the BORROWER PERSONALLY → no fatal (the seller-chain raises the assign-to-LLC condition).
{
  const withBorrower = { ...file, borrower_name: 'John Q Borrower' };
  assert.deepStrictEqual(codes(cf({ buyerName: 'John Q Borrower' }, withBorrower)), [], 'personal-name buyer defers to the chain (no fatal)');
  // …but an ENTITY that merely contains the borrower's name is NOT "the borrower personally" → fatal (audit fix #2).
  assert.deepStrictEqual(codes(cf({ buyerName: 'John Borrower Properties LLC' }, withBorrower)), ['contract_buyer_mismatch'], 'a stranger entity containing the borrower name still fatals');
  // A one-token borrower name must not over-match a stranger (audit fix #3).
  assert.deepStrictEqual(codes(cf({ buyerName: 'John Smith' }, { ...file, borrower_name: 'John' })), ['contract_buyer_mismatch'], 'a one-token borrower name does not defer a stranger');
}

// 5. Assignment: fee mismatch vs file (contract internally consistent, within 15% cap).
{
  const asgFile = { ...file, purchase_price: 112000, is_assignment: true, assignment_fee: 10000, underlying_contract_price: 100000 };
  const f = cf({ purchasePrice: 112000, isAssignment: true, assignmentFee: 12000, underlyingPrice: 100000 }, asgFile);
  // Contract fee 12k vs file fee 10k → fee mismatch. AND the file's own numbers don't add up
  // (100k seller + 10k fee = 110k, but the file total is 112k) → the price jump doesn't equal the
  // recorded fee → assignment_price_unreconciled (new §4c). The §2 price check does NOT fire — the
  // contract price 112k equals the file total, so no false "purchase price mismatch".
  assert.deepStrictEqual(codes(f), ['assignment_fee_mismatch', 'assignment_price_unreconciled'],
    'the fee mismatch AND the file-reconciliation warning fire; no false price mismatch');
}

// 5b. Assignment math doesn't add up → WARNING (contract-internal AND file reconciliation).
{
  const asgFile = { ...file, purchase_price: 130000, is_assignment: true, assignment_fee: 15000, underlying_contract_price: 100000 };
  const f = cf({ purchasePrice: 130000, isAssignment: true, assignmentFee: 15000, underlyingPrice: 100000 }, asgFile);
  // Contract: 130000 != 100000 + 15000 → math inconsistent; fee 15000 == 15% cap → no cap finding.
  // File: 100k + 15k = 115k != 130k → assignment_price_unreconciled. §2 does not fire (130k == file total).
  assert.deepStrictEqual(codes(f), ['assignment_math_inconsistent', 'assignment_price_unreconciled']);
}

// 5c. Assignment fee over the 15% cap → WARNING.
{
  const asgFile = { ...file, purchase_price: 125000, is_assignment: true, assignment_fee: 25000, underlying_contract_price: 100000 };
  const f = cf({ purchasePrice: 125000, isAssignment: true, assignmentFee: 25000, underlyingPrice: 100000 }, asgFile);
  // math ok (100000+25000=125000); fee 25000 > 15% of 100000 (15000) → over cap
  assert.deepStrictEqual(codes(f), ['assignment_fee_over_cap']);
}

// 5d. THE OWNER'S CASE (2026-07-24): the contract on file is the seller's underlying PSA, so it
// states the SELLER's price (438k), while the file total is the fee-inclusive price (474k). This
// used to fire a FALSE contract_price_mismatch fatal. With the assignment-aware §2, a contract
// price that equals the seller's underlying price on file is a MATCH → NO findings.
{
  const asgFile = { ...file, purchase_price: 474000, is_assignment: true, assignment_fee: 36000, underlying_contract_price: 438000 };
  const f = cf({ purchasePrice: 438000, isAssignment: false, assignmentFee: null, underlyingPrice: null,
    buyerName: 'Maple Grove Holdings LLC', propertyAddress: file.property_address, sellerNames: ['Jane Seller'] }, asgFile);
  assert.deepStrictEqual(codes(f), [], "the seller's underlying price on the contract is NOT a mismatch on an assignment");
}

// 5e. Same file, but the contract states the fee-inclusive TOTAL (474k) → also a MATCH, no findings.
{
  const asgFile = { ...file, purchase_price: 474000, is_assignment: true, assignment_fee: 36000, underlying_contract_price: 438000 };
  const f = cf({ purchasePrice: 474000, isAssignment: true, assignmentFee: 36000, underlyingPrice: 438000,
    buyerName: 'Maple Grove Holdings LLC', propertyAddress: file.property_address, sellerNames: ['Jane Seller'] }, asgFile);
  assert.deepStrictEqual(codes(f), [], 'the fee-inclusive total on the contract also matches on an assignment');
}

// 5f. A genuinely WRONG contract price (matches neither the seller price nor the total) still fatals.
{
  const asgFile = { ...file, purchase_price: 474000, is_assignment: true, assignment_fee: 36000, underlying_contract_price: 438000 };
  const f = cf({ purchasePrice: 500000, isAssignment: false, assignmentFee: null, underlyingPrice: null,
    buyerName: 'Maple Grove Holdings LLC', propertyAddress: file.property_address, sellerNames: ['Jane Seller'] }, asgFile);
  assert.deepStrictEqual(codes(f), ['contract_price_mismatch'], 'a price matching NEITHER acceptable value still fires');
}

// 5g. The positive reconciliation: the file's fee doesn't explain the price jump (438k + 30k != 474k)
// → assignment_price_unreconciled, even with a clean seller PSA on file.
{
  const asgFile = { ...file, purchase_price: 474000, is_assignment: true, assignment_fee: 30000, underlying_contract_price: 438000 };
  const f = cf({ purchasePrice: 438000, isAssignment: false, assignmentFee: null, underlyingPrice: null,
    buyerName: 'Maple Grove Holdings LLC', propertyAddress: file.property_address, sellerNames: ['Jane Seller'] }, asgFile);
  assert.deepStrictEqual(codes(f), ['assignment_price_unreconciled'], 'the price increase must equal the assignment fee');
}

// 5h. THE 2026-07-27 RESIDUAL: an assignment file whose seller/underlying price is NOT yet captured
// (underlying_contract_price null). The contract shows the seller's original price, which won't
// match the fee-inclusive total on file — but on an assignment that is EXPECTED, not a mismatch.
// This must NOT fire the fatal contract_price_mismatch (the false "the contract doesn't match" the
// owner reported); the missing seller price is surfaced elsewhere as a non-fatal advisory.
{
  const asgFile = { ...file, purchase_price: 474000, is_assignment: true, assignment_fee: null, underlying_contract_price: null };
  const f = cf({ purchasePrice: 438000, isAssignment: false, assignmentFee: null, underlyingPrice: null,
    buyerName: 'Maple Grove Holdings LLC', propertyAddress: file.property_address, sellerNames: ['Jane Seller'] }, asgFile);
  assert.ok(!codes(f).includes('contract_price_mismatch'),
    'an assignment with the seller price not yet captured never fires the FATAL price mismatch');
  assert.strictEqual(summarize(f).blocksCtc, false, 'and it never blocks CTC');
}

// 6. Contract looks like an assignment but the file isn't marked → WARNING (+cap on its own numbers).
{
  const f = cf({ isAssignment: true, assignmentFee: 20000, underlyingPrice: 392000, purchasePrice: 412000 });
  assert.deepStrictEqual(codes(f), ['assignment_unexpected'], 'fee 20k <= 15% of 392k and math adds up, so only the unexpected-assignment warning');
}

// 7. No seller readable → WARNING (needed for cross-document match).
assert.deepStrictEqual(codes(cf({ sellerNames: [] })), ['contract_seller_unreadable']);

// 8. Unreadable contract → single verify finding, no false mismatches.
assert.deepStrictEqual(codes(cf({ readable: false, purchasePrice: 999999, buyerName: 'Wrong LLC' })), ['contract_unreadable']);

// 9. sellerNames() surfaces parties for the cross-document pass.
assert.deepStrictEqual(sellerNames({ sellerNames: ['Jane Seller', ' '] }), ['Jane Seller']);

console.log('✓ test-underwriting-contract: all purchase-contract findings cases pass');
