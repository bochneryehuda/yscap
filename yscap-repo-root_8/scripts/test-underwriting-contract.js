'use strict';
/**
 * Unit tests for the purchase-contract findings engine
 * (src/lib/underwriting/purchase-contract-checks.js). Pure — no DB/network/keys.
 */
const assert = require('assert');
const { computeContractFindings, sellerNames, summarize } = require('../src/lib/underwriting/purchase-contract-checks');

const file = {
  property_address: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' },
  purchase_price: 412000,
  entity_name: 'Maple Grove Holdings LLC',
  is_assignment: false,
  assignment_fee: null,
  underlying_contract_price: null,
};
const goodContract = {
  propertyAddress: { line1: '76 Thompson St', city: 'Austin', state: 'TX', zip: '78701' },
  purchasePrice: 412000,
  sellerNames: ['Jane Seller'],
  buyerName: 'Maple Grove Holdings LLC',
  isAssignment: false, assignmentFee: null, underlyingPrice: null,
  closingDate: '2026-08-01', earnestMoney: 10000, readable: true, notes: null,
};
const codes = (fs) => fs.map((f) => f.code).sort();

// 1. Clean, matching contract → no findings.
{
  const f = computeContractFindings(goodContract, file);
  assert.deepStrictEqual(codes(f), [], 'a matching contract should raise no findings');
  assert.strictEqual(summarize(f).blocksCtc, false);
}

// 2. Property address mismatch → FATAL.
{
  const f = computeContractFindings({ ...goodContract, propertyAddress: { line1: '9 Oak Ave', city: 'Dallas', state: 'TX', zip: '75201' } }, file);
  assert.deepStrictEqual(codes(f), ['contract_address_mismatch']);
  assert.strictEqual(summarize(f).blocksCtc, true);
}

// 3. Purchase price mismatch → FATAL.
{
  const f = computeContractFindings({ ...goodContract, purchasePrice: 430000 }, file);
  assert.deepStrictEqual(codes(f), ['contract_price_mismatch']);
  assert.strictEqual(summarize(f).blocksCtc, true);
}
// 3b. A $1 rounding difference is tolerated (no finding).
{
  const f = computeContractFindings({ ...goodContract, purchasePrice: 412001 }, file);
  assert.deepStrictEqual(codes(f), []);
}

// 4. Buyer entity mismatch → FATAL; a containment variant ("… Holdings" vs "… Holdings LLC") matches.
{
  const f = computeContractFindings({ ...goodContract, buyerName: 'Blue Sky Capital LLC' }, file);
  assert.deepStrictEqual(codes(f), ['contract_buyer_mismatch']);
  const ok = computeContractFindings({ ...goodContract, buyerName: 'Maple Grove Holdings' }, file);
  assert.deepStrictEqual(codes(ok), [], 'a trailing-suffix variant of the entity should still match');
}

// 5. Assignment deal: fee + underlying-price mismatches both fire FATAL.
{
  const asgFile = { ...file, is_assignment: true, assignment_fee: 15000, underlying_contract_price: 100000 };
  const asgContract = { ...goodContract, isAssignment: true, assignmentFee: 20000, underlyingPrice: 90000 };
  const f = computeContractFindings(asgContract, asgFile);
  assert.deepStrictEqual(codes(f), ['assignment_fee_mismatch', 'underlying_price_mismatch']);
  assert.strictEqual(summarize(f).fatal, 2);
}

// 6. Contract looks like an assignment but the file isn't marked → WARNING.
{
  const f = computeContractFindings({ ...goodContract, isAssignment: true, assignmentFee: 20000, underlyingPrice: 392000 }, file);
  assert.deepStrictEqual(codes(f), ['assignment_unexpected']);
  assert.strictEqual(f[0].severity, 'warning');
}

// 7. No seller readable → WARNING (needed for cross-document match).
{
  const f = computeContractFindings({ ...goodContract, sellerNames: [] }, file);
  assert.deepStrictEqual(codes(f), ['contract_seller_unreadable']);
}

// 8. Unreadable contract → single verify finding, no false mismatches.
{
  const f = computeContractFindings({ ...goodContract, readable: false, purchasePrice: 999999, buyerName: 'Wrong LLC' }, file);
  assert.deepStrictEqual(codes(f), ['contract_unreadable']);
}

// 9. sellerNames() surfaces the parties for the cross-document pass.
{
  assert.deepStrictEqual(sellerNames({ sellerNames: ['Jane Seller', ' '] }), ['Jane Seller']);
}

console.log('✓ test-underwriting-contract: all purchase-contract findings cases pass');
