'use strict';
/**
 * Pure test for the Class product auto-pick (src/class/form-select.chooseProduct).
 *
 * The Class mirror of scripts/test-amc-form-select-pure.js: chooseProduct is the same
 * matcher as chooseForm, returning a Class productId instead of an AppraisalScope form
 * code, so it must behave identically. The one thing this ALSO pins is that the map
 * ships INERT — with no rows it returns null and the order desk asks a human.
 */
const path = require('path');
const { chooseProduct } = require(path.join(__dirname, '..', 'src/class/form-select'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---- INERT until seeded: no rows -> null, staff picks (this is the whole safety story) ----
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'sfr' }, []), null, 'no rules -> null (inert)');
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'sfr' }, null), null, 'null rules -> null');
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'sfr' }, undefined), null, 'undefined rules -> null');

const RULES = [
  { id: 1, loan_type: 'fix_and_flip', property_key: 'sfr',       product_id: '56634', product_name: '1004 SFR', priority: 10, active: true },
  { id: 2, loan_type: 'fix_and_flip', property_key: 'condo',     product_id: '56651', priority: 10, active: true },
  { id: 3, loan_type: 'bridge',       property_key: 'sfr',       product_id: '55975', priority: 10, active: true },
  { id: 4, loan_type: 'dscr',         property_key: 'multi_2_4', product_id: '55996', priority: 10, active: true },
  { id: 5, program: 'gold',           product_id: '99001', priority: 5,  active: true },   // program-only, higher priority
  { id: 6, loan_type: 'bridge', property_key: 'sfr', product_id: '00000', priority: 10, active: false },  // inactive
];

// ---- exact match by strategy + property key ----
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'sfr' }, RULES).productId, '56634', 'fix&flip sfr -> 56634');
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'sfr' }, RULES).ruleId, 1, 'and reports the winning rule id');
eq(chooseProduct({ loanType: 'dscr', propertyKey: 'multi_2_4' }, RULES).productId, '55996', 'dscr 2-4 -> 55996');
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'sfr' }, RULES).productName, '1004 SFR', 'a named rule reports its name');
eq(chooseProduct({ loanType: 'fix_and_flip', propertyKey: 'condo' }, RULES).productName, null, 'a rule with no name reports null');

// ---- normalization: "Multi 2-4" == "multi_2_4" (the same key form both desks use) ----
eq(chooseProduct({ loanType: 'dscr', propertyKey: 'Multi 2-4' }, RULES).productId, '55996', '"Multi 2-4" normalizes to multi_2_4');
eq(chooseProduct({ loanType: 'dscr', propertyKey: 'MULTI 2 4' }, RULES).productId, '55996', 'and spacing/case is ignored too');

// ---- no matching rule -> null (staff picks), never a wrong product ----
eq(chooseProduct({ loanType: 'ground_up', propertyKey: 'sfr' }, RULES), null, 'unseeded strategy -> null');
eq(chooseProduct({ loanType: 'bridge', propertyKey: 'land' }, RULES), null, 'unseeded property -> null');
eq(chooseProduct({ propertyKey: 'sfr' }, RULES), null, 'a deal with no strategy matches no strategy-keyed rule -> null');

// ---- an inactive rule is never picked ----
eq(chooseProduct({ loanType: 'bridge', propertyKey: 'sfr' }, RULES).productId, '55975',
   'the inactive bridge/sfr rule is ignored; the active one wins');

// ---- priority: a lower priority number wins ----
eq(chooseProduct({ program: 'gold', loanType: 'fix_and_flip', propertyKey: 'sfr' }, RULES).productId, '99001',
   'the program rule at priority 5 beats the strategy rule at priority 10');

// ---- specificity tiebreak: at equal priority the MORE specific rule wins ----
const TIE = [
  { id: 10, loan_type: 'bridge', product_id: 'AAA', priority: 10, active: true },                     // 1 dimension
  { id: 11, loan_type: 'bridge', property_key: 'sfr', product_id: 'BBB', priority: 10, active: true }, // 2 dimensions
];
eq(chooseProduct({ loanType: 'bridge', propertyKey: 'sfr' }, TIE).productId, 'BBB',
   'the more specific rule wins at equal priority');

// ---- a product_id of 0 is a real catalog id, NOT "unusable"; a blank one IS unusable ----
eq(chooseProduct({ loanType: 'bridge', propertyKey: 'sfr' },
   [{ id: 20, loan_type: 'bridge', property_key: 'sfr', product_id: 0, priority: 10, active: true }]).productId, '0',
   'product_id 0 is usable (not falsy-dropped)');
eq(chooseProduct({ loanType: 'bridge', propertyKey: 'sfr' },
   [{ id: 21, loan_type: 'bridge', property_key: 'sfr', product_id: '', priority: 10, active: true }]), null,
   'a blank product_id is unusable -> null');
eq(chooseProduct({ loanType: 'bridge', propertyKey: 'sfr' },
   [{ id: 22, loan_type: 'bridge', property_key: 'sfr', product_id: null, priority: 10, active: true }]), null,
   'a null product_id is unusable -> null');

console.log(`\n[test-class-form-select-pure] ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
