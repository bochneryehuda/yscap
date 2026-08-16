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
  // CONTRACT CHANGE (post-merge audit of #1220): this used to assert "nothing is reported as
  // derived". That premise stopped being true when the county-name fill was corrected — the caller
  // supplied the state and the FIPS but NOT the name, so the NAME genuinely is derived here, and
  // reporting it is the point (the alternative was leaving the name to be inherited from a stale
  // pricing foundation). What must still hold is that ONLY the name is claimed, and that nothing the
  // caller supplied is overwritten.
  ok(agree.countyEnrichment && agree.countyEnrichment.filled.join() === 'countyName',
    'ASSERT-2 …and exactly one thing is reported as derived: the county NAME they did not supply');
  ok(agree.request.property.address.state === 'NY' && agree.request.property.address.county === '36047',
    'ASSERT-2b …with the caller\'s own state and county FIPS untouched');
  const allSupplied = sm.validateScenario({ purpose: 'Purchase', fico: 760, value: 5e5, loan: 4e5, zip: '11211', state: 'NY', countyFps: '36047', countyName: 'Kings' });
  ok(allSupplied.countyEnrichment === null,
    'ASSERT-2c a caller who supplied EVERY part still has nothing reported as derived');
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

// ---- POST-MERGE AUDIT (#1220): the STALE FOUNDATION ADDRESS ---------------
// Production clones a LIVE /pricing/defaultSearch, so whatever address the previous session left is
// on the base. Every address part used to be written ONLY when the caller supplied it and NONE was
// in the scenario-owned clearing registry, so the leftovers rode onto the wire: a Brooklyn deal
// priced with a California city, and — worse — a payload whose county FIPS said Kings while its
// county NAME said Los Angeles.
{
  const stale = () => {
    const b = JSON.parse(JSON.stringify(sm.BASE));
    b.property = b.property || {}; b.property.address = b.property.address || {};
    Object.assign(b.property.address, { zip: '90210', state: 'CA', city: 'Beverly Hills', county: '06037', censustract: '06037', countyName: 'Los Angeles' });
    return b;
  };
  const addrOf = (sc) => sm.buildSearch(sc, { base: stale() }).property.address;

  const full = addrOf({ purpose: 'Purchase', loan: 4e5, ltv: 75, zip: '11211', state: 'NY', countyFps: '36047', countyName: 'Kings' });
  ok(full.zip === '11211' && full.state === 'NY' && full.county === '36047' && full.countyName === 'Kings',
    'STALE-1 the caller\'s own location is what reaches the wire');
  ok(full.city === undefined, 'STALE-2 the prior session\'s CITY is gone (it was pricing Brooklyn as Beverly Hills)');

  const noName = addrOf({ purpose: 'Purchase', loan: 4e5, ltv: 75, zip: '11211', state: 'NY', countyFps: '36047' });
  ok(noName.countyName !== 'Los Angeles',
    'STALE-3 a caller supplying a FIPS and no name never inherits the base\'s county NAME (the FIPS/name contradiction)');

  const noZip = addrOf({ purpose: 'Purchase', loan: 4e5, ltv: 75, state: 'NY', countyFps: '36047' });
  ok(noZip.zip === undefined, 'STALE-4 a scenario with no ZIP does not inherit a CA ZIP alongside state NY');

  // every address part is registered, so a part added later cannot quietly reopen this
  const paths = sm._internals.SCENARIO_OWNED.map((e) => e.path);
  for (const part of ['zip', 'state', 'city', 'county', 'censustract', 'countyName']) {
    ok(paths.includes(`property.address.${part}`), `STALE-REG property.address.${part} is in the clearing registry`);
  }
}

// ---- POST-MERGE AUDIT (#1220): the county NAME is filled when it APPLIES ----
// The old rule withheld our county name whenever the caller supplied ANY countyFps. Its stated
// reason ("their explicit county keeps its own name") does not hold when they supplied a FIPS and
// NO name — there is no name to keep — so the name was left to be inherited, and one response
// asserted countyEnrichment.countyName = "Bronx" while the built request said a New Jersey county.
{
  const r = zc.enrichLocation({ zip: '11211', countyFps: '36047' }); // the ZIP's OWN county
  ok(r.ok === true && r.location.countyName === 'Kings',
    'NAMEFILL-1 a caller supplying the ZIP\'s own FIPS and no name DOES get the county name');
  const keep = zc.enrichLocation({ zip: '11211', countyFps: '36047', countyName: 'Their Name' });
  ok(keep.location.countyName === undefined, 'NAMEFILL-2 …and a caller\'s OWN name is still never relabelled');

  // on a SPLIT ZIP where the caller overrode the county, we still fill nothing: their FIPS names a
  // county this table holds no name for, and the dominant county\'s name would be the wrong label.
  let splitZip = null;
  for (let n = 1000; n < 99999 && !splitZip; n++) {
    const z = String(n).padStart(5, '0'); const h = zc.lookupZip(z); if (h && h.split) splitZip = z;
  }
  if (splitZip) {
    const other = zc.enrichLocation({ zip: splitZip, countyFps: '99999' });
    ok(other.ok === true && other.location.countyName === undefined,
      'NAMEFILL-3 an overridden county on a split ZIP is never given the dominant county\'s name');
  }

  // end to end: the response and the built request agree about the county
  const v = sm.validateScenario({ purpose: 'Purchase', fico: 760, loan: 4e5, ltv: 75, zip: '11211', countyFps: '36047' });
  ok(v.ok === true && v.request.property.address.countyName === 'Kings',
    'NAMEFILL-4 the BUILT REQUEST carries the right county name (one answer, one county)');
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
