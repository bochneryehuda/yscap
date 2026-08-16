#!/usr/bin/env node
'use strict';
/**
 * §31.3/§31.7 true-only flags + §36.11 requested/derived echo (pure, offline).
 *
 * WHY THIS FILE EXISTS: the batch pre-merge audit found both of those commits shipped with NO test.
 * It proved the gap by sabotaging them and watching every suite stay green — `'Yes'` changed to
 * `'true'` (the exact distinction the flag exists to preserve), the late flag's `'true'` changed to
 * `'yes'`, an invented `'No'` off-token written on explicit false, `derivedOf` returning null, and
 * `requestedOf` returning `{}`. All five survived. This file kills all five.
 *
 * Also pins the LTV FLOOR that closed the audit's one real defect: `ltv: 0` satisfied "two of the
 * three amounts are known" while deriving nothing, so a NULL purchase price reached the vendor —
 * precisely what the amount-triangle rule exists to prevent.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const loc = { zip: '11211', state: 'NY', countyFps: '36047' };
const S = { purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, dscr: 1.25 };
const dyn = (m, k) => (m.dynamicPropertiesMap[k] ? m.dynamicPropertiesMap[k].value : undefined);

console.log('§31.3/§31.7 true-only flags + §36.11 echo + the LTV floor');

// ---- §31.3 asset depletion: the token is "Yes", NOT "true" -------------------
{
  const m = sm.buildSearch({ ...S, dscrAssetDepletion: true });
  ok(dyn(m, 'Global_DSCR_Asset_Depletion') === 'Yes',
    'AD-1 asset depletion transmits the confirmed "Yes" (NOT the "true" its sibling flags use)');
  ok(dyn(m, 'Global_DSCR_Asset_Depletion') !== 'true', 'AD-2 …and specifically not "true"');
}
// ---- §31.7 the late-window parent flag: the token IS "true" ------------------
{
  const m = sm.buildSearch({ ...S, lateInLast12Months: true });
  ok(dyn(m, 'Lateinlast12months') === 'true', 'LATE-1 the late parent flag transmits "true"');
  ok(dyn(m, 'Lateinlast12months') !== 'yes' && dyn(m, 'Lateinlast12months') !== 'Yes',
    'LATE-2 …and specifically not a "yes" copied from the asset-depletion field');
}
// ---- true-only: an explicit FALSE must never invent an off-token -------------
for (const [field, key] of [['dscrAssetDepletion', 'Global_DSCR_Asset_Depletion'], ['lateInLast12Months', 'Lateinlast12months']]) {
  const m = sm.buildSearch({ ...S, [field]: false });
  const v = dyn(m, key);
  ok(v === undefined || v === null,
    `OFF-${field} an explicit false writes NO off-token (inherits, exactly like omission) — got ${JSON.stringify(v)}`);
  // the specific invented values the audit sabotaged with
  ok(v !== 'No' && v !== 'false', `OFF2-${field} …and never an invented "No"/"false"`);
  // omission behaves identically to explicit false (that IS the true-only contract)
  const omitted = sm.buildSearch({ ...S });
  ok(JSON.stringify(dyn(omitted, key)) === JSON.stringify(v), `OFF3-${field} omission and explicit false are identical`);
}
// ---- both are strict booleans + reachable over HTTP --------------------------
for (const field of ['dscrAssetDepletion', 'lateInLast12Months']) {
  const r = sm.validateScenario({ ...S, ...loc, [field]: 'true' });
  ok(r.ok === false && r.error === 'non_boolean_value', `BOOL-${field} a string "true" is rejected 422`);
}
{
  const { unsupportedFields } = require('../src/longterm/routes/dscr-pricer')._internals;
  ok(typeof unsupportedFields === 'function', 'ROUTE-0 unsupportedFields is reachable for this guard');
  ok(unsupportedFields({ purpose: 'Purchase', dscrAssetDepletion: true, lateInLast12Months: true }).length === 0,
    'ROUTE-1 both flags are supported route fields (reachable over HTTP)');
}
// ---- §36.11 both flags are ECHOED so a caller can confirm they applied -------
{
  const { effectiveOf } = require('../src/longterm/routes/dscr-pricer')._internals;
  ok(typeof effectiveOf === 'function', 'ECHO-0 effectiveOf is reachable for this guard');
  const e = effectiveOf(sm.buildSearch({ ...S, dscrAssetDepletion: true, lateInLast12Months: true }));
  ok(e.dscrAssetDepletion === 'Yes', 'ECHO-AD effectiveScenario echoes the asset-depletion token');
  ok(e.lateInLast12Months === 'true', 'ECHO-LATE effectiveScenario echoes the late parent flag');
  // and an omitted flag is not fabricated into the echo
  const e2 = effectiveOf(sm.buildSearch({ ...S }));
  ok(e2.dscrAssetDepletion === undefined || e2.dscrAssetDepletion === null, 'ECHO-OMIT an omitted flag echoes empty, never invented');
}

// ---- §36.11 the requested / derived echo actually carries content ------------
{
  const t = sm._internals.deriveAmounts({ loan: 400000, ltv: 75 });
  ok(t && t.value === 533333.33, 'DERIVED-1 the derived echo carries the worked-out property value');
  ok(Array.isArray(t.derived) && t.derived.includes('value'), 'DERIVED-2 …and names WHICH figure was derived');
  ok(t.supplied && t.supplied.loan === true && t.supplied.value === false,
    'DERIVED-3 …and distinguishes supplied from derived (the whole point of the echo)');
  ok(t.known === 3, 'DERIVED-4 …and reports all three known after derivation');
}

// ---- THE AUDIT'S REAL DEFECT: a zero/vanishing LTV is not a usable figure ----
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 400000, ltv: 0, ...loc });
  ok(r.ok === false && r.status === 422 && r.error === 'ltv_out_of_range',
    'LTV0-1 ltv:0 with a loan is REJECTED (it used to pass as "two known" and send a null purchase price)');
  const r2 = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, ltv: 0, ...loc });
  ok(r2.ok === false && r2.error === 'ltv_out_of_range', 'LTV0-2 ltv:0 with a value is rejected (never a $0 loan quote)');
  const tiny = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 4e5, ltv: 0.000001, ...loc });
  ok(tiny.ok === false && tiny.error === 'ltv_out_of_range',
    'LTV0-3 a vanishing LTV is rejected (it derived a $400bn property value)');
  // and a zero can no longer prop up the "two figures known" count
  ok(sm._internals.deriveAmounts({ loan: 4e5, ltv: 0 }).known === 1,
    'LTV0-4 a zero LTV does not count toward the amount triangle');
  ok(sm._internals.deriveAmounts({ value: 0, loan: 4e5 }).known === 1, 'LTV0-5 …nor does a zero value');
  // a real LTV still works
  ok(sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 400000, ltv: 75, ...loc }).ok === true,
    'LTV0-6 a real LTV still prices normally');
}
// ---- deriveAmounts never throws (the module header promises it) --------------
for (const junk of [null, undefined, {}, { value: 'abc' }, { ltv: NaN }, { loan: Infinity }]) {
  let threw = false;
  try { sm._internals.deriveAmounts(junk); } catch (_) { threw = true; }
  ok(!threw, `SAFE deriveAmounts(${JSON.stringify(junk)}) does not throw`);
}
// ---- a SUPPLIED ltv is rounded like a derived one ---------------------------
{
  const t = sm._internals.deriveAmounts({ loan: 1e5, ltv: 33.333333 });
  ok(t.ltv === 0.333333, `ROUND-1 a supplied LTV is rounded to 6dp like a derived one (got ${t.ltv})`);
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
