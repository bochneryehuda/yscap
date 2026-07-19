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
assert.deepStrictEqual(codes(cf({ buyerName: 'Maple Grove Holdings' })), [], 'suffix-less entity must match');
assert.deepStrictEqual(codes(cf({ buyerName: 'Maple Grove Holdings, L.L.C.' })), [], 'punctuated LLC must match');

// 5. Assignment: fee mismatch vs file (contract internally consistent, within 15% cap).
{
  const asgFile = { ...file, purchase_price: 112000, is_assignment: true, assignment_fee: 10000, underlying_contract_price: 100000 };
  const f = cf({ purchasePrice: 112000, isAssignment: true, assignmentFee: 12000, underlyingPrice: 100000 }, asgFile);
  assert.deepStrictEqual(codes(f), ['assignment_fee_mismatch'], 'only the fee mismatch should fire when math+cap are clean');
}

// 5b. Assignment math doesn't add up → WARNING.
{
  const asgFile = { ...file, purchase_price: 130000, is_assignment: true, assignment_fee: 15000, underlying_contract_price: 100000 };
  const f = cf({ purchasePrice: 130000, isAssignment: true, assignmentFee: 15000, underlyingPrice: 100000 }, asgFile);
  // 130000 != 100000 + 15000 → math inconsistent; fee 15000 == 15% cap → no cap finding
  assert.deepStrictEqual(codes(f), ['assignment_math_inconsistent']);
}

// 5c. Assignment fee over the 15% cap → WARNING.
{
  const asgFile = { ...file, purchase_price: 125000, is_assignment: true, assignment_fee: 25000, underlying_contract_price: 100000 };
  const f = cf({ purchasePrice: 125000, isAssignment: true, assignmentFee: 25000, underlyingPrice: 100000 }, asgFile);
  // math ok (100000+25000=125000); fee 25000 > 15% of 100000 (15000) → over cap
  assert.deepStrictEqual(codes(f), ['assignment_fee_over_cap']);
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
