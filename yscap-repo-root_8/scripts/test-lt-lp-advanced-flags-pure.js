#!/usr/bin/env node
'use strict';
/**
 * §31.3/§31.7 — cross-collateral, first-time investor, living-rent-free (pure, offline).
 *
 * Three confirmed-token advanced flags the audit lists as unsupported gaps (no vendor guess):
 *   • cross-collateral → GLOBAL_Cross_Collateralization_Product, STRING "true"/"false" (§31.3 — BOTH
 *     tokens confirmed live);
 *   • first-time investor → FirstTimeInvestor, STRING "true" (§31.7);
 *   • living rent-free → Global_Living_Rent_Free, STRING "true" (§31.7).
 *
 * THE CONFIRMED QUIRK: unlike GLOBAL_MixedUse (a JSON boolean value), these three carry a STRING
 * "true"/"false" — so the token type itself matters and is pinned here. Public inputs are strict JSON
 * booleans (a string "false" → 422, never coerced); omitted → inherit the live default (not written).
 *
 * PROVEN TO FAIL: drop any of the three setDyn lines in field-registry.applyRegistry and the matching
 * ON-* assertion goes red; remove a field from BOOLEAN_FIELDS and its STRICT-* assertion goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const dyn = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] && typeof m.dynamicPropertiesMap[k] === 'object'
  ? m.dynamicPropertiesMap[k].value : (m.dynamicPropertiesMap ? m.dynamicPropertiesMap[k] : undefined));
const loc = { state: 'NJ', countyFps: '34039' };
const S = { purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25 };

console.log('§31.3/§31.7 cross-collateral + first-time investor + living-rent-free');

// ---- ON → the confirmed STRING "true" token (NOT a JSON boolean) ----------
const on = sm.buildSearch({ ...S, crossCollateral: true, firstTimeInvestor: true, livingRentFree: true });
ok(dyn(on, 'GLOBAL_Cross_Collateralization_Product') === 'true', 'ON-1 crossCollateral true → "true"');
ok(dyn(on, 'FirstTimeInvestor') === 'true', 'ON-2 firstTimeInvestor true → "true"');
ok(dyn(on, 'Global_Living_Rent_Free') === 'true', 'ON-3 livingRentFree true → "true"');
// the value must be a STRING, not a JSON boolean (the confirmed vendor quirk vs GLOBAL_MixedUse)
ok(typeof dyn(on, 'GLOBAL_Cross_Collateralization_Product') === 'string', 'QUIRK-1 the flag value is a STRING "true", not a boolean');
const mixed = sm.buildSearch({ ...S, mixedUse: true });
ok(dyn(mixed, 'GLOBAL_MixedUse') === true, 'QUIRK-2 (contrast) GLOBAL_MixedUse stays a JSON boolean true — the two shapes are deliberately different');

// ---- OFF → cross-collateral has a CONFIRMED off token; the other two do NOT ----
const off = sm.buildSearch({ ...S, crossCollateral: false });
ok(dyn(off, 'GLOBAL_Cross_Collateralization_Product') === 'false', 'OFF-1 crossCollateral false → "false" (confirmed off token §31.3)');
// firstTimeInvestor / living-rent-free: only "true" is confirmed, so an explicit false must NOT write
// a guessed off token — it inherits the live default (proven against a base carrying a stale "true").
const baseFti = JSON.parse(JSON.stringify(sm.BASE));
baseFti.dynamicPropertiesMap = baseFti.dynamicPropertiesMap || {};
baseFti.dynamicPropertiesMap.FirstTimeInvestor = { fieldId: 'FirstTimeInvestor', value: 'true' };
baseFti.dynamicPropertiesMap.Global_Living_Rent_Free = { fieldId: 'Global_Living_Rent_Free', value: 'true' };
const fFalse = sm.buildSearch({ ...S, firstTimeInvestor: false, livingRentFree: false }, { base: baseFti });
ok(dyn(fFalse, 'FirstTimeInvestor') === 'true', 'OFF-2 firstTimeInvestor false does NOT write a guessed off token — inherits the base');
ok(dyn(fFalse, 'Global_Living_Rent_Free') === 'true', 'OFF-3 livingRentFree false does NOT write a guessed off token — inherits the base');
// and on a base WITHOUT them, an explicit false simply leaves them unset (never a fabricated "false")
const fFalse2 = sm.buildSearch({ ...S, firstTimeInvestor: false, livingRentFree: false });
ok(dyn(fFalse2, 'FirstTimeInvestor') == null && dyn(fFalse2, 'Global_Living_Rent_Free') == null,
  'OFF-4 firstTimeInvestor/livingRentFree false writes no token at all when the base has none');

// ---- OMITTED → inherit the base default (not overwritten) ------------------
// The base carries these as scaffolding field-objects; omitting must not write our own value over
// whatever the (live) foundation holds. Prove against a mutated base carrying a distinct value.
const base = JSON.parse(JSON.stringify(sm.BASE));
base.dynamicPropertiesMap = base.dynamicPropertiesMap || {};
base.dynamicPropertiesMap.GLOBAL_Cross_Collateralization_Product = { fieldId: 'GLOBAL_Cross_Collateralization_Product', value: 'true' };
const inherited = sm.buildSearch({ ...S }, { base }); // omit crossCollateral
ok(dyn(inherited, 'GLOBAL_Cross_Collateralization_Product') === 'true', 'OMIT-1 an omitted flag INHERITS the foundation value (not overwritten)');
const overridden = sm.buildSearch({ ...S, crossCollateral: false }, { base }); // explicit false wins
ok(dyn(overridden, 'GLOBAL_Cross_Collateralization_Product') === 'false', 'OMIT-2 an explicit value overrides the inherited foundation value');

// ---- strict boolean: a string is rejected 422, never coerced --------------
for (const f of ['crossCollateral', 'firstTimeInvestor', 'livingRentFree']) {
  const r = sm.validateScenario({ ...S, [f]: 'false', ...loc });
  ok(r.ok === false && r.status === 422 && r.error === 'non_boolean_value' && r.field === f,
    `STRICT-${f} a string "false" is rejected 422 (never coerced to true)`);
  const good = sm.validateScenario({ ...S, [f]: true, ...loc });
  ok(good.ok === true, `VALID-${f} a real JSON boolean passes validateScenario`);
}

// ---- reachable over HTTP + round-trips in effectiveScenario ----------------
const route = require('../src/longterm/routes/dscr-pricer');
const { unsupportedFields, effectiveOf } = route._internals;
ok(unsupportedFields({ crossCollateral: true, firstTimeInvestor: true, livingRentFree: true, purpose: 'Purchase' }).length === 0,
  'ROUTE-1 all three are supported route fields (reachable over HTTP)');
const eff = effectiveOf(sm.buildSearch({ ...S, crossCollateral: true, firstTimeInvestor: true, livingRentFree: true }));
ok(eff.crossCollateral === 'true' && eff.firstTimeInvestor === 'true' && eff.livingRentFree === 'true',
  'ROUTE-2 effectiveScenario surfaces all three transmitted flags');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
