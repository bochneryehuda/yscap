'use strict';
/**
 * AMC party mapping + the owner's form defaults — pure, no database.
 *
 * Pins the two things that decide where a real appraisal order goes:
 *   1. THEIR "Loan Officer" is OUR NOTE BUYER (owner-directed 2026-08-07). Our
 *      employee loan officer must never occupy that slot.
 *   2. An unmapped / ambiguous party is REFUSED, never defaulted onto some other
 *      capital partner's routing.
 * Plus the form defaults the owner named by product id.
 */
const assert = require('assert');
const pm = require('../src/amc/party-map');
const formSelect = require('../src/amc/form-select');
const orderBuild = require('../src/amc/order-build');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('PASS ' + label); } else { fail++; console.error('FAIL ' + label); } }

// ---------------------------------------------------------------------------
console.log('\n--- keys are exact, and shared with the rest of the repo ---');
ok(pm.noteBuyerKey('Blue Lake') === 'bluelake', 'note buyer normalizes like normNoteBuyer');
ok(pm.noteBuyerKey('CorrFirst') === 'corrfirst', 'casing folded');
ok(pm.noteBuyerKey('Fidelis Investors LLC') === 'fidelisinvestorsllc', 'the real ClickUp label keeps its own key — it is NOT truncated to "fidelis"');
ok(pm.noteBuyerKey(null) === '', 'a blank buyer has no key');
ok(pm.personKey('Lisa  Katz') === 'lisakatz', 'person key folds spacing');
ok(pm.personKey("Yonah Rapapa'ort") === 'yonahrapapaort', 'person key folds punctuation');

// ---------------------------------------------------------------------------
console.log('\n--- pickBinding: refuse, never guess ---');
const ROWS = [
  { pilot_key: 'bluelake', amc_id: '201564', amc_name: 'Investor Blue Lake', active: true },
  { pilot_key: 'bluelakecapital', amc_id: '201564', amc_name: 'Investor Blue Lake', active: true },
  { pilot_key: 'fidelis', amc_id: '199451', amc_name: 'Investor Fidelis', active: true },
  { pilot_key: 'corrfirst', amc_id: '199439', amc_name: 'Investor CorrFirst', active: true },
  { pilot_key: 'retired', amc_id: '111', amc_name: 'Old', active: false },
];
ok(pm.pickBinding('bluelake', ROWS).amcId === '201564', 'a bound buyer resolves');
ok(pm.pickBinding('bluelakecapital', ROWS).amcId === '201564', 'an ALIAS resolves to the same id — aliases are not ambiguity');
ok(pm.pickBinding('emcap', ROWS).unmapped === true, 'EMCAP has no row on the live tenant → unmapped, NOT defaulted');
ok(pm.pickBinding('emcap', ROWS).reason === 'not_mapped', 'and it says why');
ok(pm.pickBinding('', ROWS).reason === 'no_value', 'a file with no note buyer is refused distinctly');
ok(pm.pickBinding('retired', ROWS).unmapped === true, 'an inactive row does not bind');
ok(pm.pickBinding('bluelake', []).unmapped === true, 'no rows at all → refuse');
// The safety case: two DIFFERENT ids for one key must never silently pick one.
const AMBIG = [
  { pilot_key: 'x', amc_id: '1', amc_name: 'A', active: true },
  { pilot_key: 'x', amc_id: '2', amc_name: 'B', active: true },
];
ok(pm.pickBinding('x', AMBIG).reason === 'ambiguous', 'two different ids for one buyer → ambiguous, never a coin flip');

// A near-miss must NOT match: an over-match here routes an appraisal, and its
// invoice, to the wrong capital partner.
ok(pm.pickBinding('bluelakecapitalpartners', ROWS).unmapped === true,
   'a longer unseen spelling does NOT fuzzy-match Blue Lake');
ok(pm.pickBinding('fidelity', ROWS).unmapped === true, '"Fidelity" never matches "Fidelis"');

// ---------------------------------------------------------------------------
console.log('\n--- the refusal is in plain language and names the value ---');
const msg = pm.explain('note_buyer', 'EMCAP', 'not_mapped');
ok(/EMCAP/.test(msg), 'the message names the buyer');
ok(!/null|undefined|NaN/.test(msg), 'no developer noise in the message');
ok(/note buyer/i.test(pm.explain('note_buyer', 'X', 'no_value')), 'the no-value message explains the routing');

// ---------------------------------------------------------------------------
console.log("\n--- the owner's form defaults (live NAN product ids, 2026-08-07) ---");
// Exactly the rows db/481 seeds.
const RULES = [
  { id: 1, loan_type: 'fix_and_flip', property_key: 'sfr',       product_code: '56634', priority: 10, active: true },
  { id: 2, loan_type: 'fix_and_flip', property_key: 'condo',     product_code: '56651', priority: 10, active: true },
  { id: 3, loan_type: 'fix_and_flip', property_key: 'multi_2_4', product_code: '56650', priority: 10, active: true },
  { id: 4, loan_type: 'bridge',       property_key: 'sfr',       product_code: '55975', priority: 10, active: true },
  { id: 5, loan_type: 'bridge',       property_key: 'condo',     product_code: '56320', priority: 10, active: true },
  { id: 6, loan_type: 'bridge',       property_key: 'multi_2_4', product_code: '55996', priority: 10, active: true },
  { id: 7, loan_type: 'dscr',         property_key: 'sfr',       product_code: '55975', priority: 10, active: true },
  { id: 8, loan_type: 'dscr',         property_key: 'condo',     product_code: '56320', priority: 10, active: true },
  { id: 9, loan_type: 'dscr',         property_key: 'multi_2_4', product_code: '55996', priority: 10, active: true },
];
const pick = (loanType, propertyType) => {
  const deal = orderBuild.dealShapeFor({ loanType, property: { category: propertyType } });
  const got = formSelect.chooseForm(deal, RULES);
  return got && got.productCode;
};

ok(pick('fix_and_flip', 'Single Family') === '56634', 'single-family fix & flip → 56634 (1004 Completed Subject to, w/As Is)');
ok(pick('fix_and_flip', 'Condo') === '56651', 'condo fix & flip → 56651 (1073 Condo Interior Completed Subject to)');
ok(pick('fix_and_flip', 'Multi 2-4') === '56650', '2-4 unit fix & flip → 56650 (1025 Completed Subject to)');
ok(pick('bridge', 'Single Family') === '55975', 'single-family bridge → 55975 (1004 w/ 1007) — no ARV');
ok(pick('bridge', 'Condo') === '56320', 'condo bridge → 56320 (1073 w/ 1007)');
ok(pick('bridge', 'Multi 2-4') === '55996', '2-4 unit bridge → 55996 (1025 plain)');
ok(pick('dscr', 'Single Family') === '55975', 'single-family DSCR takes the same form as a bridge');
ok(pick('dscr', 'Condo') === '56320', 'condo DSCR → 56320');

// The property label varies across doors — the canonical key is what must decide.
ok(pick('fix_and_flip', 'Condominium') === '56651', '"Condominium" resolves to the SAME condo form as "Condo"');
ok(pick('fix_and_flip', 'SFR (1 unit)') === '56634', 'the portal label "SFR (1 unit)" resolves to single family');
ok(pick('fix_and_flip', 'Multi 2–4') === '56650', 'an EN-DASH "Multi 2–4" still resolves');

// Never guess where the owner did not decide.
ok(pick('ground_up', 'Single Family') === null || pick('ground_up', 'Single Family') === undefined,
   'GROUND UP has no default — the owner never named one, so the desk must ask rather than order the wrong report');
ok(pick('fix_and_flip', 'Mixed use') == null, 'an unmapped property class gets no default');
ok(pick(null, 'Single Family') == null, 'no loan type → no default');

// ---------------------------------------------------------------------------
console.log('\n--- the new dimensions are ADDITIVE (old rules still behave) ---');
const LEGACY = [{ id: 1, program: 'gold', product_code: '99999', priority: 50, active: true }];
const legacyDeal = orderBuild.dealShapeFor({ program: 'gold', property: { category: 'Single Family' } });
ok(formSelect.chooseForm(legacyDeal, LEGACY).productCode === '99999',
   'a pre-existing program-only rule still matches — the two new fields are wildcards on it');
// And a legacy rule must not beat a specific new one.
const MIXED = RULES.concat(LEGACY);
ok(formSelect.chooseForm(orderBuild.dealShapeFor({ program: 'gold', loanType: 'fix_and_flip', property: { category: 'Single Family' } }), MIXED).productCode === '56634',
   "the owner's specific default wins over a broad legacy rule");

// ---------------------------------------------------------------------------
console.log('\n--- dealShapeFor exposes both new dimensions ---');
const shape = orderBuild.dealShapeFor({ loanType: 'fix_and_flip', loanPurpose: 'purchase', property: { category: 'Condominium' } });
ok(shape.propertyKey === 'condo', 'propertyKey is canonical, not the raw label');
ok(shape.loanType === 'fix_and_flip', 'loanType survives (loanPurpose would have collapsed it to Purchase)');
ok(shape.loanPurpose === 'Purchase', 'loanPurpose keeps its own CDG meaning, unchanged');
// The same file read the OLD way: loanPurpose alone cannot tell these two apart,
// which is exactly why loanType had to be added.
const asRefi = orderBuild.dealShapeFor({ loanType: 'bridge', loanPurpose: 'refinance', property: { category: 'Condo' } });
ok(asRefi.loanPurpose === 'Refinance' && asRefi.loanType === 'bridge',
   'a refinance keeps BOTH readings — the CDG purpose and the RTL loan type');
ok(orderBuild.dealShapeFor({ loanPurpose: 'fix_and_flip' }).loanType === 'fix_and_flip',
   'a file that only carries loan_type in the legacy slot still exposes it as loanType');

console.log(`\ntest-amc-party-map-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
