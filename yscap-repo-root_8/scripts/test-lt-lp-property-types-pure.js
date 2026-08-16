#!/usr/bin/env node
'use strict';
/**
 * §33.1 — PROPERTY-TYPE enum coverage (pure, offline).
 *
 * The audit's confirmed one-field property-type capture. Every visible dropdown value must normalize
 * to its EXACT upstream `property.propertyType` token and auto-minimum unit count; a value that fell
 * through to SingleFamily (or was 422'd because its token was missing) is a silent-mispricing / dead
 * contract. This adds the four current-tenant tokens that were missing — CondoGarden, MidRiseCondo,
 * CondoTel, ManufacturedHomeCondominium — plus the on-screen label alias "2 - 4 Unit".
 *
 * NEVER-GUESS notes proven here:
 *   • CondoTel carries the confirmed side effect nonWarrantableProject:true (§33.1/§17.2 — the live UI
 *     auto-checks Non-Warrantable Condo); the other new condo sub-types do NOT.
 *   • attachment is NOT a per-condo-type capture — the new tokens inherit the profile default Detached
 *     and stay overridable via sc.attachment (§34.2 P1).
 *
 * PROVEN TO FAIL: drop CondoTel/CondoGarden/MidRiseCondo/ManufacturedHomeCondominium from
 * PROPERTY_TYPES and the TOKEN/UNIT/CONDOTEL rows go red (an unknown type now 422s); drop the
 * "2 - 4 Unit" alias and LABEL-1/LABEL-2 go red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const registry = require('../src/longterm/lenderprice/field-registry');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const loc = { state: 'NJ', countyFps: '34039' };
const scOf = (extra) => ({ purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, ...extra });

console.log('§33.1 property-type enum coverage');

// The complete §33.1 table: on-screen value -> exact upstream token + auto-minimum units.
const TABLE = [
  ['SingleFamily', 'SingleFamily', 1],
  ['PUD', 'PlannedUnitDevelopment', 1],
  ['UnitDwelling_2_4', 'UnitDwelling_2_4', 2],
  ['Modular', 'Modular', 1],
  ['Townhouse', 'Townhouse', 1],
  ['Condo', 'Condos', 1],
  ['Condos', 'Condos', 1],
  ['DetachedCondominium', 'DetachedCondominium', 1],
  ['HighRiseCondo', 'HighRiseCondo', 1],
  ['SiteCondo', 'SiteCondo', 1],
  ['CondoGarden', 'CondoGarden', 1],
  ['MidRiseCondo', 'MidRiseCondo', 1],
  ['CondoTel', 'CondoTel', 1],
  ['ManufacturedHousingDoubleWide', 'ManufacturedHousingDoubleWide', 1],
  ['ManufacturedHousingSingleWide', 'ManufacturedHousingSingleWide', 1],
  ['Cooperative', 'Cooperative', 1],
  ['MultiFamily', 'MultiFamily', 5],
  ['ManufacturedHousing', 'ManufacturedHousing', 1],
  ['ManufacturedHomeCondominium', 'ManufacturedHomeCondominium', 1],
  ['ManufacturedHousingMultiWide', 'ManufacturedHousingMultiWide', 1],
  ['ManufacturedHomeCondominiumOrPUDOrCooperative', 'ManufacturedHomeCondominiumOrPUDOrCooperative', 1],
];

for (const [input, token, minUnits] of TABLE) {
  const r = registry.resolvePropertyType(input);
  ok(r && r.propertyType === token, `TOKEN ${input} → property.propertyType "${token}"`);
  ok(r && r.units === minUnits, `UNIT  ${input} auto-minimums to ${minUnits} unit(s)`);
  // and it survives the full build onto the model (omitted units → the type's minimum)
  const m = sm.buildSearch(scOf({ propertyType: input }));
  ok(m.property.propertyType === token && m.property.numberOfUnit === minUnits,
    `BUILD ${input} → model property.propertyType/numberOfUnit`);
}

// ---- CondoTel carries the confirmed Non-Warrantable side effect; siblings do not ----
{
  const ct = sm.buildSearch(scOf({ propertyType: 'CondoTel' }));
  ok(ct.criteria.nonWarrantableProject === true, 'CONDOTEL-1 CondoTel sets criteria.nonWarrantableProject=true (auto Non-Warrantable Condo SMO)');
  const cg = sm.buildSearch(scOf({ propertyType: 'CondoGarden' }));
  ok(cg.criteria.nonWarrantableProject === false, 'CONDOTEL-2 CondoGarden does NOT force non-warrantable');
  const mr = sm.buildSearch(scOf({ propertyType: 'MidRiseCondo' }));
  ok(mr.criteria.nonWarrantableProject === false, 'CONDOTEL-3 MidRiseCondo does NOT force non-warrantable');
  // an explicit nonWarrantable override still wins on a non-CondoTel type
  const cgOn = sm.buildSearch(scOf({ propertyType: 'CondoGarden', nonWarrantable: true }));
  ok(cgOn.criteria.nonWarrantableProject === true, 'CONDOTEL-4 explicit nonWarrantable override still applies');
}

// ---- attachment is the profile default Detached, overridable (NOT guessed per condo type) ----
{
  const ct = sm.buildSearch(scOf({ propertyType: 'CondoTel' }));
  ok(ct.property.attachmentType === 'Detached', 'ATTACH-1 CondoTel inherits the confirmed Detached default');
  const ctA = sm.buildSearch(scOf({ propertyType: 'CondoTel', attachment: 'Attached' }));
  ok(ctA.property.attachmentType === 'Attached', 'ATTACH-2 an explicit attachment overrides the default');
}

// ---- the on-screen label "2 - 4 Unit" (and de-spaced) normalizes to UnitDwelling_2_4 ----
for (const label of ['2 - 4 Unit', '2-4 Unit']) {
  const r = registry.resolvePropertyType(label);
  ok(r && r.propertyType === 'UnitDwelling_2_4' && r.units === 2, `LABEL-1 "${label}" → UnitDwelling_2_4 (min 2 units)`);
  // and the units-conflict check (which routes through resolvePropertyType) enforces the 2–4 range
  const threeOk = sm.validateScenario(scOf({ propertyType: label, units: 3, ...loc }));
  ok(threeOk.ok === true, `LABEL-2 "${label}" with 3 units is accepted`);
  const fiveBad = sm.validateScenario(scOf({ propertyType: label, units: 5, ...loc }));
  ok(fiveBad.ok === false && fiveBad.error === 'units_conflict', `LABEL-3 "${label}" with 5 units is rejected (2–4 only)`);
}

// ---- an unknown property type is still REJECTED 422 (never silently single-family) ----
{
  const bad = sm.validateScenario(scOf({ propertyType: 'Castle', ...loc }));
  ok(bad.ok === false && bad.status === 422 && bad.error === 'unknown_property_type',
    'UNKNOWN-1 an unrecognized property type is rejected 422 (no fall-through to SingleFamily)');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
