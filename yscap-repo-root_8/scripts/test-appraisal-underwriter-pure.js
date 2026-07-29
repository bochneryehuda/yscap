'use strict';
/**
 * R6.8 — pure tests for the appraisal underwriter + program-fit. Proves the
 * appraisal is underwritten AGAINST the registered structure: a value the
 * appraisal does not support is a fatal finding (over-leverage) that blocks CTC;
 * a subject-to condition, a property-type/units mismatch, a missing appraisal,
 * and a flood zone each surface correctly; and the fit verdict is right.
 */
const assert = require('assert');
const uw = require('../src/lib/underwriting/appraisal-underwriter');
const fit = require('../src/lib/underwriting/appraisal-program-fit');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const ctx = { values: { as_is_value: 400000, arv: 600000, rehab_budget: 100000, property_type: 'sfr', units: 1, purchase_price: 400000 } };

// --- appraisal supports the sizing → no value finding, fit supported ---
let appr = { as_is_value: 400000, arv_value: 600000, property_type: 'sfr', units: 1, condition_of_appraisal: 'SubjectToCompletion', contract_price: 400000 };
let r = uw.underwriteAppraisal({ appraisal: appr, context: ctx });
assert.ok(!r.findings.some((f) => /below_sizing/.test(f.code)), 'no shortfall finding when supported');
assert.strictEqual(r.valueSupport.asIs, true);
assert.strictEqual(r.valueSupport.arv, true);
// subject-to-completion IS expected on a rehab deal, but still flagged as contingent
assert.ok(r.findings.some((f) => f.code === 'appraisal_subject_to_conditions' && f.blocks_ctc));
ok('a supporting appraisal: no shortfall finding; a subject-to condition still flags contingent value');

let f = fit.assessFit({ appraisal: appr, context: ctx });
assert.strictEqual(f.supports, true, 'fit supported');
ok('program-fit: a supporting appraisal supports the strategy');

// --- ARV below sizing → fatal, blocks CTC + funding ---
appr = { as_is_value: 400000, arv_value: 560000, property_type: 'sfr', units: 1, condition_of_appraisal: 'AsIs' };
r = uw.underwriteAppraisal({ appraisal: appr, context: ctx });
const arvF = r.findings.find((f) => f.code === 'appraisal_arv_below_sizing');
assert.ok(arvF, 'ARV shortfall finding raised');
assert.strictEqual(arvF.severity, 'fatal');
assert.strictEqual(arvF.blocks_ctc, true);
assert.strictEqual(arvF.blocks_funding, true);
assert.strictEqual(r.valueSupport.arv, false);
ok('an ARV below the sizing value → fatal finding blocking CTC + funding');

// --- as-is below sizing → fatal ---
appr = { as_is_value: 380000, arv_value: 600000, property_type: 'sfr', units: 1, condition_of_appraisal: 'AsIs' };
r = uw.underwriteAppraisal({ appraisal: appr, context: ctx });
assert.ok(r.findings.some((f) => f.code === 'appraisal_as_is_below_sizing' && f.severity === 'fatal'));
ok('an As-Is below the sizing value → fatal finding');

// --- property type + units mismatch ---
appr = { as_is_value: 400000, arv_value: 600000, property_type: 'condo', units: 2, condition_of_appraisal: 'AsIs' };
r = uw.underwriteAppraisal({ appraisal: appr, context: ctx });
assert.ok(r.findings.some((f) => f.code === 'appraisal_property_type_mismatch'));
assert.ok(r.findings.some((f) => f.code === 'appraisal_units_mismatch'));
f = fit.assessFit({ appraisal: appr, context: ctx });
assert.strictEqual(f.supports, false, 'a type/units mismatch fails fit');
ok('property-type + unit-count mismatches are flagged and fail program fit');

// --- no appraisal → cannot support, blocks CTC ---
r = uw.underwriteAppraisal({ appraisal: null, context: ctx });
assert.ok(r.findings.some((f) => f.code === 'appraisal_missing' && f.blocks_ctc));
ok('no appraisal on file → a CTC-blocking finding (never assumed supported)');

// --- special flood zone → info finding ---
appr = { as_is_value: 400000, arv_value: 600000, property_type: 'sfr', units: 1, condition_of_appraisal: 'AsIs', flood_zone: 'AE' };
r = uw.underwriteAppraisal({ appraisal: appr, context: ctx });
assert.ok(r.findings.some((f) => f.code === 'appraisal_special_flood_zone' && f.severity === 'info'));
ok('a special flood zone raises a flood-insurance info finding');

// --- rehab deal with no ARV on the appraisal ---
appr = { as_is_value: 400000, arv_value: null, property_type: 'sfr', units: 1, condition_of_appraisal: 'AsIs' };
r = uw.underwriteAppraisal({ appraisal: appr, context: ctx });
assert.ok(r.findings.some((f) => f.code === 'appraisal_arv_missing' && f.blocks_ctc));
ok('a rehab loan with no ARV on the appraisal is flagged (blocks CTC)');


// --- fix 2026-07-23: no appraisal blocks FUNDING too; collateral fatals block the term sheet ---
r = uw.underwriteAppraisal({ appraisal: null, context: ctx });
{
  const m = r.findings.find((f) => f.code === 'appraisal_missing');
  assert.ok(m && m.blocks_ctc && m.blocks_funding, 'a missing appraisal blocks CTC AND funding');
}
appr = { as_is_value: 100000, arv_value: null, property_type: 'sfr', units: 1, condition_of_appraisal: 'AsIs' };
r = uw.underwriteAppraisal({ appraisal: appr, context: { values: { as_is_value: 500000 } } });
{
  const f = r.findings.find((x) => x.code === 'appraisal_as_is_below_sizing');
  assert.ok(f && f.blocks_term_sheet && f.blocks_ctc && f.blocks_funding, 'a below-sizing fatal blocks all three gates');
}
ok('appraisal_missing blocks funding; collateral fatals carry blocks_term_sheet');

console.log(`\nR6.8 appraisal-underwriter pure — ${passed} checks passed`);
