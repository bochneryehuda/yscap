#!/usr/bin/env node
'use strict';
/**
 * §32.4 — RESERVES SELECTOR TABLE (pure, offline).
 *
 * GLOBAL_RESERVES dynamic token. The DSCR profile FORCES the default (Reserves_24, env-overridable)
 * when reserves is omitted; a caller MAY choose a specific requirement via `reservesMonths`, mapped
 * to the CONFIRMED live enum — copied EXACTLY, including the genuinely inconsistent singular/plural
 * prefixes:
 *
 *   | Visible selection | GLOBAL_RESERVES value |
 *   | None      | "Reserve_none"  |   (also reachable via 0)
 *   | 3 Months  | "Reserves_3"    |
 *   | 6 Months  | "Reserve_6"     |   ← SINGULAR (the confirmed inconsistency)
 *   | 12 Months | "Reserves_12"   |
 *   | 18 Months | "Reserves_18"   |
 *   | 24 Months | "Reserves_24"   |
 *
 * "None" (Reserve_none) is DISTINCT from blank/inherit (JSON null); we do NOT expose blank — the DSCR
 * profile always emits a reserves value. An unknown value → 422 (never a guessed token).
 *
 * PROVEN TO FAIL: "fix" Reserve_6 → Reserves_6 (or any token) and the exact-token assertion goes red;
 * drop the reservesMonths wiring in buildSearch and PAYLOAD-* goes red; remove the throw and the 422
 * assertion goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const { mapReserves } = sm._internals;

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const dyn = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] && typeof m.dynamicPropertiesMap[k] === 'object'
  ? m.dynamicPropertiesMap[k].value : (m.dynamicPropertiesMap ? m.dynamicPropertiesMap[k] : undefined));
// fico is REQUIRED (§37.11): Lender Price answers HTTP 500 with no explanation when the field is
// null OR absent, measured live both ways. It is on the fixture so these suites test their own
// subject rather than re-testing that refusal.
const S = { purpose: 'Purchase', value: 5e5, loan: 4e5, dscr: 1.25, state: 'NJ', countyFps: '34039', fico: 760 };

console.log('§32.4 reserves selector table');

// ---- the confirmed enum, copied exactly -----------------------------------
const TABLE = [
  { in: 'none', tok: 'Reserve_none' },
  { in: 0,      tok: 'Reserve_none' },
  { in: 3,      tok: 'Reserves_3' },
  { in: 6,      tok: 'Reserve_6' },   // SINGULAR
  { in: 12,     tok: 'Reserves_12' },
  { in: 18,     tok: 'Reserves_18' },
  { in: 24,     tok: 'Reserves_24' },
];
for (const t of TABLE) {
  ok(mapReserves(t.in) === t.tok, `TABLE reservesMonths=${JSON.stringify(t.in)} → "${t.tok}"`);
}

// ---- the singular/plural inconsistency is pinned --------------------------
ok(mapReserves(6) === 'Reserve_6', 'QUIRK-1 6 months → SINGULAR "Reserve_6" (NOT "Reserves_6")');
ok(mapReserves(3) === 'Reserves_3' && mapReserves(12) === 'Reserves_12' && mapReserves(18) === 'Reserves_18' && mapReserves(24) === 'Reserves_24',
  'QUIRK-2 3/12/18/24 months → PLURAL "Reserves_N"');
ok(mapReserves('none') === 'Reserve_none', 'QUIRK-3 None → "Reserve_none" (singular)');

// ---- omitted → null (caller takes the profile default) ---------------------
ok(mapReserves(undefined) === null && mapReserves(null) === null && mapReserves('') === null,
  'OMIT an omitted reserves maps to null (profile default applied by buildSearch)');

// ---- case / whitespace tolerant -------------------------------------------
ok(mapReserves('None') === 'Reserve_none' && mapReserves(' 24 ') === 'Reserves_24' && mapReserves('NONE') === 'Reserve_none',
  'TOLERANT case/whitespace insensitive ("None", " 24 ", "NONE")');

// ---- unknown → throw (never a guessed token) ------------------------------
for (const bad of [9, '5', 36, 'lots', 6.5]) {
  let code = null;
  try { mapReserves(bad); } catch (e) { code = e.code; }
  ok(code === 'unknown_reserves', `UNKNOWN reservesMonths=${JSON.stringify(bad)} → throws unknown_reserves (no guessed token)`);
}

// ---- payload: omitted → forced default; explicit → the exact token --------
ok(dyn(sm.buildSearch(S), 'GLOBAL_RESERVES') === 'Reserves_24',
  'PAYLOAD-1 omitted reserves → GLOBAL_RESERVES "Reserves_24" (DSCR profile default)');
ok(dyn(sm.buildSearch({ ...S, reservesMonths: 6 }), 'GLOBAL_RESERVES') === 'Reserve_6',
  'PAYLOAD-2 reservesMonths=6 → GLOBAL_RESERVES "Reserve_6"');
ok(dyn(sm.buildSearch({ ...S, reservesMonths: 'none' }), 'GLOBAL_RESERVES') === 'Reserve_none',
  'PAYLOAD-3 reservesMonths="none" → GLOBAL_RESERVES "Reserve_none" (explicit None, distinct from blank)');
ok(dyn(sm.buildSearch({ ...S, reservesMonths: 3 }), 'GLOBAL_RESERVES') === 'Reserves_3',
  'PAYLOAD-4 reservesMonths=3 → GLOBAL_RESERVES "Reserves_3"');
// GLOBAL_RESERVES is a real {fieldId,value} object with a non-null value (never blank/null here).
const built = sm.buildSearch({ ...S, reservesMonths: 12 });
ok(built.dynamicPropertiesMap.GLOBAL_RESERVES && built.dynamicPropertiesMap.GLOBAL_RESERVES.fieldId === 'GLOBAL_RESERVES' && built.dynamicPropertiesMap.GLOBAL_RESERVES.value === 'Reserves_12',
  'PAYLOAD-5 the transmitted object is { fieldId:"GLOBAL_RESERVES", value:"Reserves_12" }');

// ---- validate + reachable over HTTP ---------------------------------------
const route = require('../src/longterm/routes/dscr-pricer');
const { unsupportedFields, effectiveOf } = route._internals;
ok(unsupportedFields({ reservesMonths: 12, purpose: 'Purchase' }).length === 0, 'ROUTE-1 reservesMonths is a supported route field');
const bad = sm.validateScenario({ ...S, reservesMonths: 9 });
ok(bad.ok === false && bad.status === 422 && bad.error === 'unknown_reserves' && bad.field === 'reservesMonths',
  'ROUTE-2 an unknown reserves is rejected 422 unknown_reserves before any upstream call');
const good = sm.validateScenario({ ...S, reservesMonths: 18 });
ok(good.ok === true, 'ROUTE-3 a valid reserves passes validateScenario');
ok(effectiveOf(sm.buildSearch({ ...S, reservesMonths: 18 })).reserves === 'Reserves_18',
  'ROUTE-4 effectiveScenario surfaces the transmitted reserves token');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
