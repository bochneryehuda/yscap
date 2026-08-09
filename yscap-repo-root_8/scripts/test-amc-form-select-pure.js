'use strict';
/**
 * Pure test for AMC form selection (src/amc/form-select.js). No DB, no network.
 *
 * Locks in: wildcard rules, normalized matching ("Ground Up" == "ground_up"), the
 * priority → specificity → id ordering, active/no-product-code skipping, and the
 * shape of the chosen form.
 */
const { chooseForm, norm } = require('../src/amc/form-select');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// normalization
ok(norm('Ground Up') === 'groundup' && norm('ground_up') === 'groundup' && norm('ground-up') === 'groundup', 'norm collapses spacing/underscores/hyphens');
ok(norm('Multi 2-4') === 'multi24', 'norm on a property category');

// no rules → null
ok(chooseForm({ program: 'bridge' }, []) === null, 'no rules → null');
ok(chooseForm({ program: 'bridge' }, null) === null, 'null rules → null');

// a pure wildcard rule matches any deal
{
  const rules = [{ id: 1, program: null, property_category: null, loan_purpose: null, product_code: '5', priority: 100, active: true }];
  const r = chooseForm({ program: 'bridge', propertyCategory: 'SFR', loanPurpose: 'Purchase' }, rules);
  ok(r && r.productCode === '5' && r.ruleId === 1, 'wildcard rule matches any deal');
}

// a specific rule matches only its shape; a mismatch → null
{
  const rules = [{ id: 1, program: 'ground_up', property_category: null, loan_purpose: null, product_code: '9', priority: 100, active: true }];
  ok(chooseForm({ program: 'Ground Up' }, rules).productCode === '9', 'specific program rule matches (normalized)');
  ok(chooseForm({ program: 'fix_and_flip' }, rules) === null, 'specific rule + different program → null');
  ok(chooseForm({ program: null }, rules) === null, 'specific rule + missing deal value → no match');
}

// priority: the lower number wins even if both match
{
  const rules = [
    { id: 1, program: null, property_category: null, loan_purpose: null, product_code: 'DEFAULT', priority: 100, active: true },
    { id: 2, program: 'bridge', property_category: null, loan_purpose: null, product_code: 'BRIDGE', priority: 10, active: true },
  ];
  ok(chooseForm({ program: 'bridge' }, rules).productCode === 'BRIDGE', 'lower priority wins');
  ok(chooseForm({ program: 'other' }, rules).productCode === 'DEFAULT', 'falls back to the wildcard default');
}

// specificity tiebreak: same priority → more specific wins
{
  const rules = [
    { id: 1, program: 'bridge', property_category: null, loan_purpose: null, product_code: 'ONE', priority: 50, active: true },
    { id: 2, program: 'bridge', property_category: 'SFR', loan_purpose: null, product_code: 'TWO', priority: 50, active: true },
  ];
  ok(chooseForm({ program: 'bridge', propertyCategory: 'SFR' }, rules).productCode === 'TWO', 'more specific rule wins on a tie');
}

// active=false and missing product_code are skipped
{
  const rules = [
    { id: 1, program: null, property_category: null, loan_purpose: null, product_code: 'OFF', priority: 1, active: false },
    { id: 2, program: null, property_category: null, loan_purpose: null, product_code: null, priority: 2, active: true },
    { id: 3, program: null, property_category: null, loan_purpose: null, product_code: 'ON', priority: 3, active: true },
  ];
  ok(chooseForm({ program: 'x' }, rules).productCode === 'ON', 'inactive + no-product-code rules are skipped');
}

// subproducts + amc identifier come back as strings
{
  const rules = [{ id: 1, program: null, property_category: null, loan_purpose: null, product_code: 6, subproduct_codes: [5, 7], amc_identifier: 426, priority: 1, active: true }];
  const r = chooseForm({}, rules);
  ok(r.productCode === '6' && r.subproductCodes.length === 2 && r.subproductCodes[0] === '5' && r.amcIdentifier === '426', 'form shape is stringified');
}

console.log(`\n[test-amc-form-select-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
