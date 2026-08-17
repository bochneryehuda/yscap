#!/usr/bin/env node
'use strict';
/**
 * D27 — VACANT-vs-LEASED OCCUPANCY as a first-class DSCR eligibility FACT (pure, offline).
 *
 * WHAT THIS PROVES:
 *   • the fact ROUND-TRIPS through the scenario → facts mapper (buildSearch retains it on the built
 *     payload; the route's effectiveScenario surfaces it to the eligibility overlay);
 *   • an ABSENT occupancy stays UNKNOWN — no silent default: omitting it yields a BYTE-IDENTICAL
 *     payload and effectiveScenario.occupancy === undefined;
 *   • it is only RETAINED WHEN SUPPLIED, and — because no live capture confirms a Lender Price wire
 *     field for vacant-vs-leased — it is NEVER put on the wire (a guessed token is not invented);
 *   • it is a validated route field: vacant|leased pass (case/space tolerant), an unknown value is
 *     REJECTED 422 rather than silently dropped.
 *
 * WHY RETAINED-NOT-TRANSMITTED: the field registry deliberately leaves occupancy tokens OUT until a
 * one-field capture confirms the current-tenant token, because a guessed dynamicPropertiesMap fieldId
 * silently prices a whole lender program away (measured for DSCRRATIO / the mortgage-late buckets).
 * So occupancy rides the CASHOUT_INTERNAL Symbol pattern and buildSearch carries a clearly-commented
 * SEAM for wiring transmission the io/escrowWaive way once a token is captured.
 *
 * PROVEN TO FAIL (mutation controls):
 *   • drop `if (occupancy != null) m[OCCUPANCY_INTERNAL] = occupancy` from buildSearch → RETAIN-* / EFF-1 red.
 *   • make mapOccupancy default an omitted value to 'leased' (return 'leased' on '') → OMIT-*, BYTES,
 *     UNKNOWN-* red (a silent default that changes eligibility is exactly what D27 forbids).
 *   • transmit it (e.g. `setDyn('SomeGuessedField', occupancy)`) → WIRE-1/WIRE-2 red.
 *   • delete the validateInputs occupancy check → VAL-REJECT red.
 *   • drop 'occupancy' from the route SUPPORTED_FIELDS → ROUTE-1 red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const route = require('../src/longterm/routes/dscr-pricer');
const { effectiveOf, unsupportedFields } = route._internals;

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

// A complete, priceable base scenario so these assertions test occupancy rather than re-testing the
// location / amount-triangle / fico refusals. Occupancy is independent of every other field.
const S = { purpose: 'Purchase', value: 5e5, loan: 375000, dscr: 1.25, state: 'NJ', countyFps: '34039', fico: 760 };

console.log('D27 occupancy (vacant vs leased) — first-class, unknown-safe, retained-not-transmitted');

// ---- supplied occupancy → RETAINED on the built payload (Symbol channel) ----
const mV = sm.buildSearch({ ...S, occupancy: 'vacant' });
const mL = sm.buildSearch({ ...S, occupancy: 'leased' });
ok(mV[sm.OCCUPANCY_INTERNAL] === 'vacant', 'RETAIN-1 buildSearch retains occupancy "vacant" internally');
ok(mL[sm.OCCUPANCY_INTERNAL] === 'leased', 'RETAIN-2 buildSearch retains occupancy "leased" internally');

// ---- case/space tolerant, like rentalTerm -----------------------------------
ok(sm.buildSearch({ ...S, occupancy: 'Vacant' })[sm.OCCUPANCY_INTERNAL] === 'vacant', 'CASE-1 "Vacant" normalizes to "vacant"');
ok(sm.buildSearch({ ...S, occupancy: ' LEASED ' })[sm.OCCUPANCY_INTERNAL] === 'leased', 'CASE-2 " LEASED " normalizes to "leased"');

// ---- NOT transmitted: no guessed token reaches the wire ---------------------
const wireV = JSON.stringify(mV);
ok(wireV.includes('vacant') === false, 'WIRE-1 "vacant" NEVER appears in the serialized body (retained, not transmitted)');
const dpV = mV.dynamicPropertiesMap || {};
const invented = Object.keys(dpV).filter((k) => {
  const val = dpV[k] && typeof dpV[k] === 'object' ? dpV[k].value : dpV[k];
  return val === 'vacant' || val === 'leased';
});
ok(invented.length === 0, 'WIRE-2 no dynamicPropertiesMap entry carries a vacant/leased value (no invented occupancy field)');

// ---- omitted occupancy → UNKNOWN: nothing retained, byte-identical payload --
const m0 = sm.buildSearch({ ...S });
ok(m0[sm.OCCUPANCY_INTERNAL] === undefined, 'OMIT-1 no occupancy supplied → nothing retained (unknown, never defaulted)');
// The strongest non-regression + no-silent-default proof: adding occupancy changes ONLY the internal
// Symbol (which JSON.stringify skips), so the wire payload is byte-for-byte the same as with no
// occupancy at all. A default (e.g. omitted → 'leased') would either differ here or leak onto the wire.
ok(JSON.stringify(mV) === JSON.stringify(m0), 'BYTES a supplied occupancy leaves the serialized payload byte-identical to an omitted one');
ok(JSON.stringify(sm.buildSearch({ ...S })) === JSON.stringify(sm.buildSearch({ ...S, occupancy: undefined })),
  'BYTES-2 an undefined occupancy is identical to an absent one');

// ---- effectiveScenario surfaces it to the overlay, undefined when unknown ---
ok(effectiveOf(mV).occupancy === 'vacant', 'EFF-1 effectiveScenario reports the retained occupancy fact');
ok(effectiveOf(m0).occupancy === undefined, 'UNKNOWN-1 effectiveScenario.occupancy is undefined when the scenario did not state it');

// ---- a supported, validated route field -------------------------------------
ok(unsupportedFields({ occupancy: 'vacant', purpose: 'Purchase' }).length === 0, 'ROUTE-1 occupancy is a supported route field (not rejected as unsupported)');
ok(sm.validateScenario({ ...S, occupancy: 'leased' }).ok === true, 'VAL-OK-1 a valid occupancy "leased" passes validation');
ok(sm.validateScenario({ ...S, occupancy: 'Vacant' }).ok === true, 'VAL-OK-2 a case-variant "Vacant" passes validation');
ok(sm.validateScenario({ ...S }).ok === true, 'VAL-OK-3 an omitted occupancy passes validation (unknown is allowed)');
const bad = sm.validateScenario({ ...S, occupancy: 'partially-leased' });
ok(bad.ok === false && bad.status === 422 && bad.error === 'invalid_occupancy' && bad.field === 'occupancy',
  'VAL-REJECT an unrecognized occupancy is rejected 422 invalid_occupancy (never silently dropped)');

// ---- defense-in-depth: a direct buildSearch with a bad value throws ----------
let threw = null;
try { sm.buildSearch({ ...S, occupancy: 'squatted' }); } catch (e) { threw = e; }
ok(threw && threw.lpValidation === true && threw.code === 'unknown_occupancy',
  'THROW mapOccupancy refuses an unrecognized value on a direct buildSearch call (LpValidationError)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
