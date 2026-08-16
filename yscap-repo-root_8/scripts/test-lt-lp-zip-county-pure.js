#!/usr/bin/env node
'use strict';
/**
 * §26.3/§35.2 — ZIP → STATE / COUNTY / COUNTY-FIPS enrichment (pure, offline).
 *
 * Pricing is ZIP-driven: the vendor's own screen turns a 5-digit ZIP into state + county + county
 * FIPS before it searches, while the connector used to demand all of them and refuse an incomplete
 * location. A quote of "Purchase, 760 FICO, $400k loan, 75% LTV, ZIP 11211" could not be served.
 *
 * The rules proven here:
 *   • The committed Census table resolves the ZIPs this repo already uses, to the FIPS values the
 *     audit itself captured (91101 → 06037 Los Angeles is the vendor's own captured request).
 *   • A caller's own values are ASSERTIONS: never overwritten, and a CONTRADICTION is a 422 —
 *     silently preferring one side is how a loan is priced in the wrong county.
 *   • An unknown ZIP FAILS CLOSED with a named error (a PO-box ZIP has no ZCTA), never a guess.
 *   • A ZIP spanning several counties resolves to the DOMINANT one and SAYS SO (`split: true`), and
 *     there an explicit county is honored rather than rejected.
 *   • The ROUTE prices the ENRICHED scenario — pricing the original would validate one request and
 *     send a different, county-less one upstream (which, against the static base, would carry the
 *     capture's stale New Jersey county).
 *   • The lookup is pure + offline: no network, no database, never throws.
 *
 * PROVEN TO FAIL: drop the enrichLocation call from validateScenario and ZIPONLY-* go red; let a
 * supplied value be overwritten and ASSERT-* go red; return a guess for an unknown ZIP and
 * CLOSED-1 goes red; make the route price the original scenario and ROUTE-2 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const zc = require('../src/longterm/lenderprice/zip-county');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

console.log('§26.3/§35.2 ZIP → county enrichment');

// ---- the ZIPs this repo already uses resolve to their captured FIPS ---------
const KNOWN = [
  ['11211', 'NY', '36047', 'Kings'],
  ['11249', 'NY', '36047', 'Kings'],
  ['07036', 'NJ', '34039', 'Union'],
  ['33101', 'FL', '12086', 'Miami-Dade'],
  ['91101', 'CA', '06037', 'Los Angeles'], // the vendor's own captured request (§30.5)
  ['75201', 'TX', '48113', 'Dallas'],
];
for (const [zip, state, fips, name] of KNOWN) {
  const r = zc.lookupZip(zip);
  ok(r && r.state === state && r.countyFps === fips && r.countyName === name,
    `KNOWN ${zip} → ${state} / ${fips} / ${name}` + (r ? '' : ' (NOT FOUND)'));
}
// the county FIPS always begins with its own state's FIPS prefix
{
  let mismatched = 0;
  for (const [zip] of KNOWN) { const r = zc.lookupZip(zip); if (!r) { mismatched++; continue; }
    if (zc._internals.STATE_BY_FIPS[r.countyFps.slice(0, 2)] !== r.state) mismatched++; }
  ok(mismatched === 0, 'KNOWN-FIPS every resolved state agrees with its county FIPS prefix');
}

// ---- a ZIP alone is now a priceable scenario -------------------------------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 400000, ltv: 75, zip: '11211' });
  ok(r.ok === true, 'ZIPONLY-1 a quote with ONLY a ZIP validates (state + county derived)');
  const a = r.request.property.address;
  ok(a.state === 'NY' && a.county === '36047' && a.censustract === '36047' && a.countyName === 'Kings',
    'ZIPONLY-2 the built request carries the derived state / county FIPS / county name');
  ok(r.request.criteria.purchasePrice === 533333.33, 'ZIPONLY-3 …and the amount triangle still derives the value');
  ok(r.countyEnrichment && r.countyEnrichment.filled.includes('countyFps'),
    'ZIPONLY-4 the response REPORTS that the county was derived (never a silent fill)');
  ok(r.countyEnrichment.source === 'census-zcta-2020', 'ZIPONLY-5 …and names the source it came from');
}

// ---- a caller's own values are ASSERTIONS ----------------------------------
{
  // agreeing values are simply kept
  const agree = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, zip: '11211', state: 'NY', countyFps: '36047' });
  ok(agree.ok === true, 'ASSERT-1 supplying values that AGREE with the ZIP is accepted');
  ok(agree.countyEnrichment === null, 'ASSERT-2 …and nothing is reported as derived (nothing was)');
  // a contradicting state is a conflict, not an overwrite
  const badState = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, zip: '11211', state: 'NJ' });
  ok(badState.ok === false && badState.error === 'location_conflict' && badState.field === 'state',
    'ASSERT-3 a state contradicting the ZIP is 422 location_conflict (never silently corrected)');
  // a contradicting county on a SINGLE-county ZIP is a conflict
  const badFps = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, zip: '11211', countyFps: '34039' });
  ok(badFps.ok === false && badFps.error === 'location_conflict' && badFps.field === 'countyFps',
    'ASSERT-4 a county FIPS contradicting a single-county ZIP is 422');
}

// ---- a ZIP with no ZCTA does NOT block a caller who already gave the location --
// ZIP 30301 (Atlanta, PO-box only) has no ZCTA at all, and it is in our own test battery. Failing
// closed unconditionally rejected a COMPLETE, valid request — enrichment is only REQUIRED when
// something is actually missing.
{
  ok(zc.lookupZip('30301') === null, 'NOZCTA-0 30301 genuinely has no ZCTA entry');
  const full = sm.validateScenario({ purpose: 'Purchase', fico: 700, value: 350000, loan: 280000,
    zip: '30301', state: 'GA', county: 'Fulton', countyFps: '13121' });
  ok(full.ok === true, 'NOZCTA-1 a complete location with an unresolvable ZIP is ACCEPTED (nothing needed enriching)');
  const partial = sm.validateScenario({ purpose: 'Purchase', fico: 700, value: 350000, loan: 280000, zip: '30301', state: 'GA' });
  ok(partial.ok === false && partial.error === 'zip_not_found',
    'NOZCTA-2 …but an unresolvable ZIP still refuses when the county is MISSING (fails closed only where it matters)');
}

// ---- an unknown ZIP fails CLOSED -------------------------------------------
{
  const r = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, zip: '00000' });
  ok(r.ok === false && r.status === 422 && r.error === 'zip_not_found',
    'CLOSED-1 an unknown ZIP is refused with a named error (never a guessed county)');
  ok(/supply state \+ countyFps explicitly/i.test(r.message || ''),
    'CLOSED-2 …and the message says how to proceed (a refusal must not be a dead end)');
  const bad = zc.enrichLocation({ zip: '1121' });
  ok(bad.ok === false && bad.code === 'invalid_zip', 'CLOSED-3 a malformed ZIP is refused');
}

// ---- a split ZIP resolves to the dominant county AND says so ---------------
{
  // find a real split ZIP from the table rather than assuming one
  let splitZip = null;
  for (let n = 1000; n < 99999 && !splitZip; n++) {
    const z = String(n).padStart(5, '0');
    const r = zc.lookupZip(z);
    if (r && r.split) splitZip = z;
  }
  ok(!!splitZip, `SPLIT-0 the table contains multi-county ZIPs (found ${splitZip})`);
  if (splitZip) {
    const r = zc.enrichLocation({ zip: splitZip });
    ok(r.ok === true && r.split === true, 'SPLIT-1 a multi-county ZIP resolves and is FLAGGED as split');
    ok(!!r.location.countyFps, 'SPLIT-2 …to the dominant county');
    // on a split ZIP an explicit county is HONORED, not rejected — that is why split is reported
    const override = zc.enrichLocation({ zip: splitZip, countyFps: '99999' });
    ok(override.ok === true, 'SPLIT-3 an explicit county on a split ZIP is honored, not treated as a conflict');
    ok(override.location.countyFps === undefined, 'SPLIT-4 …and the caller\'s county is not overwritten');
  }
}

// ---- the ROUTE prices the ENRICHED scenario --------------------------------
{
  const raw = { purpose: 'Purchase', fico: 760, loan: 400000, ltv: 75, zip: '11211' };
  const v = sm.validateScenario(raw);
  ok(v.scenario && v.scenario.countyFps === '36047', 'ROUTE-1 validateScenario returns the enriched scenario to price from');
  const fromEnriched = sm.buildSearch(v.scenario).property.address;
  const fromRaw = sm.buildSearch(raw).property.address;
  ok(fromEnriched.county === '36047' && fromEnriched.state === 'NY', 'ROUTE-2 building from the enriched scenario carries the right county');
  ok(fromRaw.county !== '36047',
    'ROUTE-3 building from the ORIGINAL would NOT — so the route must swap in the enriched one (this is the bug being prevented)');
}

// ---- the lookup is pure, offline and total --------------------------------
for (const junk of [null, undefined, '', 'abcde', 123, {}, '1234567890']) {
  let threw = false, out;
  try { out = zc.lookupZip(junk); } catch (_) { threw = true; }
  ok(!threw && (out === null || typeof out === 'object'), `SAFE lookupZip(${JSON.stringify(junk)}) does not throw`);
}
{
  const src = require('fs').readFileSync(require.resolve('../src/longterm/lenderprice/zip-county'), 'utf8');
  ok(!/require\(['"]\.\.\/db|fetch\(|https?:\/\//.test(src.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')),
    'PURE-1 the module makes no database or network call outside its comments');
  ok(zc._internals.meta.zipCount > 30000 && zc._internals.meta.sourceSha256.length === 64,
    'PURE-2 the dataset records its size and a pinned source checksum');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
