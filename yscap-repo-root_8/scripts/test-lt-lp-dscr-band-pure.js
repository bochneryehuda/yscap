#!/usr/bin/env node
'use strict';
/**
 * §32.3 — DSCR THRESHOLD TABLE (pure, offline).
 *
 * The entered DSCR ratio drives, beyond the always-present DSCR pair, a coarse `DSCRRATIO` dynamic
 * token AND (above 0.75) one derived pricing-band special mortgage option. The buckets are the
 * CONFIRMED live §32.3 capture, implemented as a REVIEWED RANGE TABLE — never string-formatted from
 * the number (0.50 → "0.75", 0.80 → "DSCR<1"):
 *
 *   | On-screen | criteria.dscr | DSCRRATIO.value | Derived pricing-band SMO |
 *   | 0.00                          | 0    | NoDSCR  | none            |
 *   | 0.50, 0.70                    | same | 0.75    | none            |
 *   | 0.75, 0.80, 0.90              | same | DSCR<1  | DSCR <1.15      |
 *   | 1.00, 1.05, 1.10, 1.15, 1.20  | same | DSCR>=1 | DSCR >=1.00     |
 *   | 1.25, 1.50, 2.00              | same | 1.25    | DSCR >=1.25 - J |
 *
 * Discontinuities at 0, 0.75, 1.00, 1.25 — boundary just-below/at/just-above tests below.
 *
 * PROVEN TO FAIL: move any band boundary (e.g. `if (dscr < 1.00)` → `<= 1.00`) or drop the
 * setDyn('DSCRRATIO', …) / the derived-SMO push in buildSearch, and the matching assertion goes red.
 * Change any confirmed token string and the exact-token assertions go red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const { dscrBand } = sm._internals;

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const dyn = (m, k) => (m.dynamicPropertiesMap && m.dynamicPropertiesMap[k] && typeof m.dynamicPropertiesMap[k] === 'object'
  ? m.dynamicPropertiesMap[k].value : (m.dynamicPropertiesMap ? m.dynamicPropertiesMap[k] : undefined));
const S = { purpose: 'Purchase', value: 5e5, loan: 4e5 };

console.log('§32.3 DSCR threshold table');

// ---- the confirmed table, every captured on-screen value ------------------
const TABLE = [
  { dscr: 0,    ratio: 'NoDSCR',  smo: null },
  { dscr: 0.50, ratio: '0.75',    smo: null },
  { dscr: 0.70, ratio: '0.75',    smo: null },
  { dscr: 0.75, ratio: 'DSCR<1',  smo: 'DSCR <1.15' },
  { dscr: 0.80, ratio: 'DSCR<1',  smo: 'DSCR <1.15' },
  { dscr: 0.90, ratio: 'DSCR<1',  smo: 'DSCR <1.15' },
  { dscr: 1.00, ratio: 'DSCR>=1', smo: 'DSCR >=1.00' },
  { dscr: 1.05, ratio: 'DSCR>=1', smo: 'DSCR >=1.00' },
  { dscr: 1.10, ratio: 'DSCR>=1', smo: 'DSCR >=1.00' },
  { dscr: 1.15, ratio: 'DSCR>=1', smo: 'DSCR >=1.00' },
  { dscr: 1.20, ratio: 'DSCR>=1', smo: 'DSCR >=1.00' },
  { dscr: 1.25, ratio: '1.25',    smo: 'DSCR >=1.25 - J' },
  { dscr: 1.50, ratio: '1.25',    smo: 'DSCR >=1.25 - J' },
  { dscr: 2.00, ratio: '1.25',    smo: 'DSCR >=1.25 - J' },
];
for (const t of TABLE) {
  const b = dscrBand(t.dscr);
  ok(b && b.ratio === t.ratio && b.smo === t.smo,
    `TABLE dscr=${t.dscr} → DSCRRATIO ${t.ratio}${t.smo ? ' + SMO "' + t.smo + '"' : ' (no band SMO)'}`);
}

// ---- NOT string-formatted from the input (the whole point of a lookup) ----
ok(dscrBand(0.50).ratio === '0.75', 'FORMAT-1 0.50 → "0.75" (bucket ceiling, NOT "0.5")');
ok(dscrBand(0.80).ratio === 'DSCR<1', 'FORMAT-2 0.80 → "DSCR<1" (a token, NOT "0.8")');
ok(dscrBand(0).ratio === 'NoDSCR', 'FORMAT-3 0.00 → "NoDSCR" (NOT "0")');

// ---- boundary just-below / at / just-above each discontinuity -------------
ok(dscrBand(0.749).ratio === '0.75' && dscrBand(0.75).ratio === 'DSCR<1',
  'BOUND-0.75 just-below stays "0.75"; AT 0.75 crosses to "DSCR<1"');
ok(dscrBand(0.999).ratio === 'DSCR<1' && dscrBand(1.00).ratio === 'DSCR>=1',
  'BOUND-1.00 just-below stays "DSCR<1"; AT 1.00 crosses to "DSCR>=1"');
ok(dscrBand(1.249).ratio === 'DSCR>=1' && dscrBand(1.25).ratio === '1.25',
  'BOUND-1.25 just-below stays "DSCR>=1"; AT 1.25 crosses to "1.25"');
// The 0 boundary: exactly 0 is NoDSCR, the smallest positive supplied DSCR is the "0.75" bucket.
ok(dscrBand(0).ratio === 'NoDSCR' && dscrBand(0.01).ratio === '0.75',
  'BOUND-0 exactly 0 → "NoDSCR"; any positive below 0.75 → "0.75"');

// ---- null in → null out (an omitted DSCR writes no band) ------------------
ok(dscrBand(null) === null && dscrBand(undefined) === null,
  'NULL an absent DSCR produces no band (null)');

// ---- the token is transmitted in the built payload ------------------------
const a = sm.buildSearch({ ...S, dscr: 1.25 });
ok(dyn(a, 'DSCRRATIO') === '1.25', 'PAYLOAD-1 dscr 1.25 → dynamicPropertiesMap.DSCRRATIO "1.25"');
ok(a.criteria.dscr === 1.25, 'PAYLOAD-2 criteria.dscr carries the verbatim numeric value');

// ---- the derived band SMO is added AFTER the DSCR pair, in captured order --
// Captured order with a prepay is [PPP, "Debt Service Coverage Ratio", "DSCR", <band>].
const withPpp = sm.buildSearch({ ...S, dscr: 1.25, prepayMonths: 60 });
const names = withPpp.criteria.specialMortgageOptions.map((o) => o.name);
ok(JSON.stringify(names) === JSON.stringify(['5 Yr PPP', 'Debt Service Coverage Ratio', 'DSCR', 'DSCR >=1.25 - J']),
  'SMO-1 order is [PPP, DSCVR, DSCR, band] — band appended last');
// Without a prepay the band still sits after the DSCR pair.
const noPpp = sm.buildSearch({ ...S, dscr: 0.90 });
ok(JSON.stringify(noPpp.criteria.specialMortgageOptions.map((o) => o.name)) === JSON.stringify(['Debt Service Coverage Ratio', 'DSCR', 'DSCR <1.15']),
  'SMO-2 no prepay: [DSCVR, DSCR, band]');

// ---- bands with no band SMO add nothing beyond the DSCR pair ---------------
for (const d of [0, 0.5, 0.7]) {
  const m = sm.buildSearch({ ...S, dscr: d });
  ok(m.criteria.specialMortgageOptions.length === 2,
    `SMO-NONE dscr=${d} adds no band SMO (DSCR pair only)`);
}

// ---- FAIL-CLOSED: an omitted DSCR clears a stale foundation DSCRRATIO ------
const base = JSON.parse(JSON.stringify(sm.BASE));
base.dynamicPropertiesMap = base.dynamicPropertiesMap || {};
base.dynamicPropertiesMap.DSCRRATIO = { fieldId: 'DSCRRATIO', value: 'STALE_FROM_PRIOR_SESSION' };
const cleared = sm.buildSearch({ ...S }, { base }); // omit dscr
ok(dyn(cleared, 'DSCRRATIO') === undefined,
  'FAILCLOSED-1 an omitted DSCR sends NO DSCRRATIO — a live foundation\'s stale token cannot leak');
ok(cleared.criteria.dscr == null,
  'FAILCLOSED-2 an omitted DSCR clears criteria.dscr to null (scenario-owned)');
ok(cleared.criteria.specialMortgageOptions.every((o) => o.name !== 'DSCR <1.15' && o.name !== 'DSCR >=1.00' && o.name !== 'DSCR >=1.25 - J'),
  'FAILCLOSED-3 an omitted DSCR adds no band SMO');
// An explicit DSCR overrides the stale foundation value.
const over = sm.buildSearch({ ...S, dscr: 0.80 }, { base });
ok(dyn(over, 'DSCRRATIO') === 'DSCR<1', 'FAILCLOSED-4 an explicit DSCR overrides the stale foundation token');

// ---- reachable over HTTP + round-trips in effectiveScenario ----------------
const route = require('../src/longterm/routes/dscr-pricer');
const { effectiveOf, unsupportedFields } = route._internals;
ok(unsupportedFields({ dscr: 1.25, purpose: 'Purchase' }).length === 0, 'ROUTE-1 dscr is a supported route field');
const eff = effectiveOf(sm.buildSearch({ ...S, dscr: 1.10 }));
ok(eff.dscr === 1.10 && eff.dscrRatio === 'DSCR>=1',
  'ROUTE-2 effectiveScenario surfaces the entered dscr AND the derived DSCRRATIO band token');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
