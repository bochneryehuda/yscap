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
// A non-finite value fails CLOSED to "no band" — never the top "1.25" band (defense-in-depth).
ok(dscrBand(NaN) === null && dscrBand(Infinity) === null,
  'NANSAFE a NaN/Infinity DSCR produces no band (null), never a mis-priced top band');

// ---- the token is NOT transmitted by default, and that was MEASURED --------
// §37.9. Apples to apples against the live tenant: the captured frontend request for one scenario
// returns 11 programs / 309 priced options / 8 lenders. Our body for the SAME scenario — read back
// out of that capture, so the deal is identical — returned 10 / 281 / 8. Removing DSCRRATIO and
// changing nothing else returned exactly 11 / 309 / 8. The key appears in NO captured working
// request; it was derived from a threshold table in the vendor's JS bundle, which proves the tokens
// exist and never proved the frontend SENDS them. Asserting a pricing band nobody asked for narrows
// the lender set that matches — a silently worse quote, which is the expensive direction.
const a = sm.buildSearch({ ...S, dscr: 1.25 });
ok(dyn(a, 'DSCRRATIO') === undefined,
  'PAYLOAD-1 dscr 1.25 sends NO DSCRRATIO — measured: sending it costs a whole lender program');
// The tokens themselves are real, so the behaviour stays reachable for a future capture that shows
// the frontend genuinely sending one. The band table below is still fully covered either way.
process.env.LP_SEND_DSCRRATIO = '1';
const aOn = sm.buildSearch({ ...S, dscr: 1.25 });
delete process.env.LP_SEND_DSCRRATIO;
ok(dyn(aOn, 'DSCRRATIO') === '1.25',
  'PAYLOAD-1b …and LP_SEND_DSCRRATIO=1 still sends the captured token, so the table stays testable');
ok(a.criteria.dscr === 1.25, 'PAYLOAD-2 criteria.dscr carries the verbatim numeric value');

// ---- the FOURTH option is the CAPTURED one, not a derived band ------------
// §37.10. BOTH real captured requests — different deals, different states, both HTTP 200 with real
// pricing — send [PPP, "Debt Service Coverage Ratio", "DSCR", **"Prepay Buyout"**], every option
// carrying a real id. We used to append an invented "DSCR >=1.25 - J" with NO id, read out of the
// vendor's JS bundle: that table proves such names exist, it never showed the frontend sending one.
// The fourth option is now carried through from the foundation (a real vendor document) instead.
const withPpp = sm.buildSearch({ ...S, dscr: 1.25, prepayMonths: 60 });
const names = withPpp.criteria.specialMortgageOptions.map((o) => o.name);
ok(JSON.stringify(names) === JSON.stringify(['5 Yr PPP', 'Debt Service Coverage Ratio', 'DSCR', 'Prepay Buyout']),
  'SMO-1 the fourth option is the captured "Prepay Buyout", not a derived band');
ok(withPpp.criteria.specialMortgageOptions.every((o) => o && typeof o.id === 'string' && o.id),
  'SMO-1b every option carries a real id — an id-less element is unlike anything in any capture');
process.env.LP_SEND_DSCR_BAND_SMO = '1';
const bandOn = sm.buildSearch({ ...S, dscr: 1.25, prepayMonths: 60 });
delete process.env.LP_SEND_DSCR_BAND_SMO;
ok(bandOn.criteria.specialMortgageOptions.map((o) => o.name).includes('DSCR >=1.25 - J'),
  'SMO-1c …and LP_SEND_DSCR_BAND_SMO=1 still emits the derived band, so the table stays testable');
// An OMITTED prepay is not "no prepay": it takes the DSCR profile's five-year Standard default, so
// the PPP option is still first and the band still sits after the DSCR pair. (This assertion used to
// read [DSCVR, DSCR, band] — it was written when omission inherited the foundation's prepay, which
// the 2026-08-16 audit reversed: omitting prepay is the ORDINARY quote, and inheriting left it at
// 36 months with no PPP option on a book the owner quotes at five years.)
const noPpp = sm.buildSearch({ ...S, dscr: 0.90 });
ok(JSON.stringify(noPpp.criteria.specialMortgageOptions.map((o) => o.name)) === JSON.stringify(['5 Yr PPP', 'Debt Service Coverage Ratio', 'DSCR', 'Prepay Buyout']),
  'SMO-2 omitted prepay: [5 Yr PPP (profile default), DSCVR, DSCR, Prepay Buyout]');
// A DIFFERENT DSCR band must not change the option list at all now — the band is not in it.
const otherBand = sm.buildSearch({ ...S, dscr: 1.40 });
ok(JSON.stringify(otherBand.criteria.specialMortgageOptions) === JSON.stringify(noPpp.criteria.specialMortgageOptions),
  'SMO-2b the option list no longer varies with the DSCR band');

// ---- bands with no band SMO add nothing beyond the DSCR pair ---------------
// Asserted by NAME rather than by list length. A length check conflates "no band was added" with
// "nothing else was added", so it broke the moment the profile started contributing its own PPP
// option — and would equally have passed if a band went missing while some unrelated option appeared.
const BANDS = ['DSCR <1.15', 'DSCR >=1.00', 'DSCR >=1.25 - J'];
for (const d of [0, 0.5, 0.7]) {
  const m = sm.buildSearch({ ...S, dscr: d });
  const names = m.criteria.specialMortgageOptions.map((o) => o.name);
  ok(!names.some((n) => BANDS.includes(n)),
    `SMO-NONE dscr=${d} adds no pricing-band SMO (${JSON.stringify(names)})`);
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
// An explicit DSCR still overrides a stale foundation token — the anti-leak property is unchanged,
// and it now holds in the stronger direction: the key is absent rather than merely correct.
const over = sm.buildSearch({ ...S, dscr: 0.80 }, { base });
ok(dyn(over, 'DSCRRATIO') === undefined,
  'FAILCLOSED-4 a stale foundation DSCRRATIO is cleared and NOT re-sent, whatever the DSCR');
process.env.LP_SEND_DSCRRATIO = '1';
const overOn = sm.buildSearch({ ...S, dscr: 0.80 }, { base });
delete process.env.LP_SEND_DSCRRATIO;
ok(dyn(overOn, 'DSCRRATIO') === 'DSCR<1',
  'FAILCLOSED-4b …and with the token enabled, an explicit DSCR still overrides the stale one');

// ---- reachable over HTTP + round-trips in effectiveScenario ----------------
const route = require('../src/longterm/routes/dscr-pricer');
const { effectiveOf, unsupportedFields } = route._internals;
ok(unsupportedFields({ dscr: 1.25, purpose: 'Purchase' }).length === 0, 'ROUTE-1 dscr is a supported route field');
const eff = effectiveOf(sm.buildSearch({ ...S, dscr: 1.10 }));
ok(eff.dscr === 1.10 && eff.dscrRatio === undefined,
  'ROUTE-2 effectiveScenario surfaces the entered dscr, and reports NO band token because none is sent');
process.env.LP_SEND_DSCRRATIO = '1';
const effOn = effectiveOf(sm.buildSearch({ ...S, dscr: 1.10 }));
delete process.env.LP_SEND_DSCRRATIO;
ok(effOn.dscrRatio === 'DSCR>=1',
  'ROUTE-2b …and when the token IS sent, effectiveScenario still shows exactly what went upstream');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
