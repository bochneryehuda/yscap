'use strict';
/**
 * Regression test for the "no form default for NAN" live bug (2026-08-11).
 *
 * The amc_form_map `loan_type` dimension (db/481) carries the RTL STRATEGY
 * (fix_and_flip / bridge / dscr / ground_up), but dealShapeFor was feeding `loanType`
 * from the loan PURPOSE (Purchase/Refinance), so every deal matched NONE of the nine
 * seeded rules and no form ever auto-picked. This pins the strategy derivation and
 * proves a real deal now selects the owner's seeded default — while an unseeded
 * strategy/property still returns nothing (the desk asks a human, never a wrong form).
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const ob = require(path.join(ROOT, 'src/amc/order-build'));
const fs = require(path.join(ROOT, 'src/amc/form-select'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- dealStrategyKey: the deal-type / rehab-tier → seed-token mapping ----
const strat = (program, loanPurpose, rehabType) => ob.dealStrategyKey({ program, loanPurpose, rehabType });

eq(strat('Fix & Flip', 'Purchase'), 'fix_and_flip', 'Fix & Flip → fix_and_flip');
// THE CANONICAL production program value is "Fix & Flip w/ Construction" (the ClickUp-
// synced enum; plain "Fix & Flip" was a drift bug). It contains "construction" — this is
// the case the post-merge audit caught: keying ground-up on /construction/ misclassified
// it as ground_up (unseeded) → no form default, i.e. the live bug WAS NOT fixed.
eq(strat('Fix & Flip w/ Construction', 'Purchase'), 'fix_and_flip', 'CANONICAL fix&flip "Fix & Flip w/ Construction" → fix_and_flip (NOT ground_up)');
eq(strat('Bridge / Stabilized', 'Purchase'), 'bridge', 'Bridge / Stabilized → bridge');
eq(strat('Ground-up Construction', 'Purchase'), 'ground_up', 'Ground-up → ground_up');
eq(strat('Ground-Up Construction', 'Purchase'), 'ground_up', 'canonical "Ground-Up Construction" still → ground_up (contains "ground")');
eq(strat('Fix & Hold (BRRRR)', 'Purchase'), 'fix_and_flip', 'BRRRR (a renovation) → fix_and_flip');
eq(strat('', 'DSCR Rental'), 'dscr', 'DSCR/rental keyword in loan_type → dscr');
eq(strat('', 'Purchase', 'heavy'), 'fix_and_flip', 'a rehab tier alone → fix_and_flip');
eq(strat('', 'Purchase', 'light'), 'fix_and_flip', 'a light rehab tier → fix_and_flip');
// The loan PURPOSE must NEVER be read as a strategy.
eq(strat('', 'Purchase'), null, 'a bare Purchase is not a strategy → null (human picks)');
eq(strat('', 'Refinance'), null, 'a bare Refinance is not a strategy → null');
eq(strat('', 'Refi Cash-Out'), null, 'Refi Cash-Out is not a strategy → null');
// Legacy files that stored the strategy in the loan_type column are still caught.
eq(strat('', 'Ground up'), 'ground_up', 'legacy "Ground up" in loan_type → ground_up');
// Priority: a rental exit beats a bridge word; ground-up beats everything.
eq(strat('Bridge / Stabilized', 'DSCR'), 'dscr', 'dscr wins over bridge');
eq(strat('Fix & Flip', '', 'ground up construction'), 'ground_up', 'ground-up wins over flip');

// ---- chooseForm against the REAL db/481 production seed shape ----
const SEED = [
  { id: 1, loan_type: 'fix_and_flip', property_key: 'sfr', product_code: '56634', product_name: '1004 - SFR - Completed Subject to (w/As Is Value)', priority: 10, active: true },
  { id: 2, loan_type: 'fix_and_flip', property_key: 'condo', product_code: '56651', priority: 10, active: true },
  { id: 3, loan_type: 'fix_and_flip', property_key: 'multi_2_4', product_code: '56650', priority: 10, active: true },
  { id: 4, loan_type: 'bridge', property_key: 'sfr', product_code: '55975', priority: 10, active: true },
  { id: 5, loan_type: 'bridge', property_key: 'condo', product_code: '56320', priority: 10, active: true },
  { id: 6, loan_type: 'bridge', property_key: 'multi_2_4', product_code: '55996', priority: 10, active: true },
  { id: 7, loan_type: 'dscr', property_key: 'sfr', product_code: '55975', priority: 10, active: true },
  { id: 8, loan_type: 'dscr', property_key: 'condo', product_code: '56320', priority: 10, active: true },
  { id: 9, loan_type: 'dscr', property_key: 'multi_2_4', product_code: '55996', priority: 10, active: true },
];
const formFor = (program, loanPurpose, propertyType, rehabType) => {
  const ctx = { program, loanPurpose, rehabType, property: { category: propertyType } };
  const chosen = fs.chooseForm(ob.dealShapeFor(ctx), SEED);
  return chosen ? chosen.productCode : null;
};

eq(formFor('Fix & Flip', 'Purchase', 'SFR'), '56634', 'fix&flip SFR → 56634 (the owner\'s default)');
eq(formFor('Fix & Flip w/ Construction', 'Purchase', 'SFR'), '56634', 'CANONICAL fix&flip program auto-picks 56634 (the live-bug regression — must NOT be blank)');
eq(formFor('Fix & Flip', 'Purchase', 'Condominium'), '56651', 'fix&flip condo → 56651');
eq(formFor('Fix & Flip', 'Purchase', '2-4 Family'), '56650', 'fix&flip 2-4 → 56650');
eq(formFor('Bridge / Stabilized', 'Purchase', 'Single Family Residence'), '55975', 'bridge SFR → 55975');
eq(formFor('Bridge / Stabilized', 'Refinance', 'Condo'), '56320', 'bridge condo refi → 56320');
eq(formFor('', 'DSCR', 'Duplex'), '55996', 'DSCR 2-4 → 55996');
// Deliberately-unseeded cases still get NO auto-pick (the desk asks a human).
eq(formFor('Ground-up Construction', 'Purchase', 'SFR', 'ground_up'), null, 'ground-up is unseeded → no auto-pick');
eq(formFor('Bridge / Stabilized', 'Purchase', 'Land'), null, 'an unseeded property (land) → no auto-pick');
eq(formFor('Fix & Flip', 'Purchase', 'Multi 5+'), null, '5+ units unseeded → no auto-pick');
// And the pre-fix failure mode is gone: a real fix&flip purchase is no longer starved.
ok(formFor('Fix & Flip', 'Purchase', 'SFR') !== null, 'the "no form default" regression is fixed');

console.log(`\n[test-amc-form-default-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
