/**
 * Unit assertions for the FEMA flood cross-check (src/lib/appraisal/flood). The pure comparison
 * logic runs with no network; the geocode/FEMA calls run against an INJECTED mock fetch (no real
 * network, deterministic). Confirms the never-guess contract: unreachable services → not checked,
 * no invented zone.
 */
const flood = require('../src/lib/appraisal/flood');
let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// ---- isSfha ----
assert(flood.isSfha('AE') === true, 'AE is a special flood hazard area');
assert(flood.isSfha('VE') === true, 'VE is SFHA');
assert(flood.isSfha('X') === false, 'X is not SFHA');
assert(flood.isSfha('') === null, 'blank zone is unknown (null), not false');

// ---- compareZones ----
assert(flood.compareZones('X', 'X').agrees === true, 'X vs X agrees');
{
  const c = flood.compareZones('X', 'AE');
  assert(c.agrees === false && c.severity === 'warning' && c.kind === 'sfha_mismatch', 'appraisal X but FEMA AE → warning sfha_mismatch');
  assert(/insurance/i.test(c.note), 'the mismatch note mentions insurance');
}
{
  const c = flood.compareZones('AE', 'A');
  assert(c.kind === 'zone_diff' && c.severity === 'info', 'AE vs A → same risk, info-level zone_diff');
}
{
  const c = flood.compareZones('', 'AE');
  assert(c.kind === 'fema_only' && c.severity === 'info', 'no appraisal zone + FEMA AE → info fema_only');
}
assert(flood.compareZones('', '').agrees === null, 'nothing on either side → cannot compare');

// ---- geocode + femaZoneAt with an injected mock fetch ----
function mockFetch(map) {
  return async (url) => {
    for (const [needle, payload] of map) {
      if (url.includes(needle)) return { ok: true, json: async () => payload };
    }
    return { ok: false, json: async () => ({}) };
  };
}
(async () => {
  const geoOk = mockFetch([['geocoding.geo.census.gov', { result: { addressMatches: [{ coordinates: { x: -74.2, y: 40.7 }, matchedAddress: '1 MAIN ST' }] } }]]);
  const g = await flood.geocode('1 Main St', geoOk);
  assert(g && g.lat === 40.7 && g.lng === -74.2, 'geocode reads lat/lng from the Census response');

  const g2 = await flood.geocode('1 Main St', mockFetch([['nowhere', {}]]));
  assert(g2 === null, 'geocode returns null when the service does not match (never guesses coords)');

  const femaOk = mockFetch([['hazards.fema.gov', { features: [{ attributes: { FLD_ZONE: 'AE', ZONE_SUBTY: null, SFHA_TF: 'T' } }] }]]);
  const fz = await flood.femaZoneAt(40.7, -74.2, femaOk);
  assert(fz && fz.zone === 'AE' && fz.sfha === true, 'femaZoneAt reads the FLD_ZONE + SFHA flag');

  const femaEmpty = mockFetch([['hazards.fema.gov', { features: [] }]]);
  const fzE = await flood.femaZoneAt(40.7, -74.2, femaEmpty);
  assert(fzE && fzE.unmapped === true && fzE.zone === null, 'a point FEMA does not map returns unmapped, not a guessed zone');

  // Full cross-check: appraisal says X, FEMA says AE → checked + a warning comparison.
  const both = mockFetch([
    ['geocoding.geo.census.gov', { result: { addressMatches: [{ coordinates: { x: -74.2, y: 40.7 }, matchedAddress: '1 MAIN ST' }] } }],
    ['hazards.fema.gov', { features: [{ attributes: { FLD_ZONE: 'AE', SFHA_TF: 'T' } }] }],
  ]);
  const cc = await flood.crossCheckFlood({ address: '1 Main St', appraisalZone: 'X', fetchImpl: both });
  assert(cc.checked === true && cc.femaZone === 'AE' && cc.comparison.severity === 'warning', 'crossCheck flags an X-vs-AE mismatch');

  // Never-guess: geocode fails → not checked, no zone.
  const noGeo = await flood.crossCheckFlood({ address: '1 Main St', appraisalZone: 'X', fetchImpl: mockFetch([['x', {}]]) });
  assert(noGeo.checked === false && noGeo.femaZone === null && /geocode/i.test(noGeo.reason), 'geocode failure → not checked, no invented zone');

  // safeFetchJson never throws even with a throwing fetch.
  const threw = await flood._internals.safeFetchJson('https://x', async () => { throw new Error('boom'); });
  assert(threw === null, 'safeFetchJson swallows a thrown fetch and returns null');

  console.log(`\n${failures ? failures + ' FAILURE(S)' : 'ALL flood assertions passed'}`);
  process.exit(failures ? 1 : 0);
})();
