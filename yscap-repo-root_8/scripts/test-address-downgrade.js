'use strict';
/**
 * A GEOCODER MAY NEVER REWRITE AN ADDRESS IT DID NOT RESOLVE.
 *
 *   node scripts/test-address-downgrade.js                                  (pure)
 *   DATABASE_URL=postgres://… node scripts/test-address-downgrade.js        (+ the cache repair)
 *
 * Owner-reported 2026-07-28 — ClickUp's own activity log on YSCAP258134762
 * (Christopher Rodriguez & Patrick Kamara):
 *   "You changed Subject Property Address from
 *      1727 2nd St, Piscataway, NJ 08854, USA
 *    to 2nd St, Piscataway, NJ 07063"
 * "You" is OUR API token — the portal wrote that. The real property is
 * 1727 S 2nd St, Piscataway, NJ 08854; 07063 is a Plainfield ZIP on a different
 * stretch of road. Correcting the file never stuck, because the corrupted value
 * was ALSO written back onto the record and cached permanently.
 *
 * ROOT CAUSE: `orchestrator.withCoords` adopted the geocoder's `formatted` string
 * unconditionally. Nominatim answers a house number it cannot place with the ROAD
 * it sits on — no `house_number`, and the road's OWN postcode. Verified live:
 *   GET /search?q=1727 2nd St, Piscataway, NJ 08854, USA
 *   → addresstype:"road", display_name:"2nd Street, Piscataway Township, …, 07063"
 * The OSM_ROAD fixture below is that exact response.
 *
 * Proves:
 *   1. The provider text from the owner's real case is REFUSED, and every
 *      legitimate restyling a geocoder does is still allowed.
 *   2. A road-level OSM match yields coordinates but NO text (nothing downstream,
 *      and no permanently-cached row, can adopt it); a house-level match still does.
 *   3. Google's route/ZIP-centroid matches are rejected outright — they also back
 *      `samePlace`, where a road place_id would merge two different houses.
 *   4. End-to-end: withCoords keeps OUR address and takes only the coordinates —
 *      reproducing the owner's exact string and asserting it can no longer be
 *      produced.
 *   5. DB: the poisoned cache row is repaired, and the repair is idempotent.
 */
const R = require('path').resolve(__dirname, '..');
const ADDR = require(R + '/src/lib/address');
const CANON = require(R + '/src/lib/address-canon');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const eq = (a, b, m) => ok(a === b, `${m}\n     expected: ${JSON.stringify(b)}\n     actual:   ${JSON.stringify(a)}`);

// The owner's real values.
const REAL = '1727 S 2nd St, Piscataway, NJ 08854';
const ON_CARD = '1727 2nd St, Piscataway, NJ 08854, USA';   // what ClickUp held before
const CORRUPT = '2nd St, Piscataway, NJ 07063';             // what we wrote over it

// ── 1. the guard ───────────────────────────────────────────────────────────
console.log('1. geocodeRewriteIsSafe — the provider may restyle, never contradict');
const safe = ADDR.geocodeRewriteIsSafe.bind(ADDR);

ok(!safe(REAL, CORRUPT), 'the owner\'s case: a road-level answer must NOT replace the real address');
ok(!safe(ON_CARD, CORRUPT), 'the same, from the value that was actually on the card');
ok(!safe('1727 S 2nd St, Piscataway, NJ 08854', '1727 S 2nd St, Piscataway, NJ 07063'),
  'a changed ZIP is refused (never silently re-ZIP a property)');
ok(!safe('1727 S 2nd St, Piscataway, NJ', '1727 2nd St, Piscataway, NJ'),
  'a dropped leading directional is refused — "S 2nd St" is a different street');
ok(!safe('1727 S 2nd St, Piscataway, NJ 08854', '1725 S 2nd St, Piscataway, NJ 08854'),
  'a changed house number is refused');

// THE SECOND CORRUPTION ON THE SAME FILE, found live in ClickUp 2026-07-28.
// Google normalizes "1727 S 2nd St, Piscataway, NJ 08854" to the Plainfield house.
// These are NOT two labels for one property — the US Census geocoder resolves BOTH,
// ~130 m apart on opposite sides of the Piscataway/Plainfield municipal line, where
// S 2nd St keeps its numbering across the boundary:
//   1727 S 2ND ST, PISCATAWAY, NJ 08854  @ 40.595432,-74.454210
//   1727 S 2ND ST, PLAINFIELD, NJ 07063  @ 40.596109,-74.453144
// So adopting the provider's answer silently moved the file to a DIFFERENT BUILDING.
ok(!safe(REAL, '1727 S 2nd St, Plainfield, NJ 07063, USA'),
  'the Plainfield case: a same-street, same-number answer in another ZIP is refused');

ok(safe('26 South 10th Street, Brooklyn, NY 11249', '26 S 10th St, Brooklyn, NY 11249'),
  'abbreviating the street IS allowed (the whole point of asking a geocoder)');
ok(safe('1727 S 2nd St, Piscataway, NJ', '1727 S 2nd St, Piscataway, NJ 08854'),
  'FILLING a ZIP we never had is allowed');
ok(safe('12 Churchill Ln, Lakewood Township, NJ 08701', '12 Churchill Ln, Lakewood, NJ 08701'),
  'normalizing the mailing city is allowed');
ok(safe('1254 42nd St Apt 6B, Brooklyn, NY 11219', '1254 42nd St, Brooklyn, NY 11219'),
  'the building-level answer for a unit address is allowed (withUnit re-adds the unit)');
ok(safe('', CORRUPT), 'with nothing of our own, the provider is all we have');
ok(!safe(REAL, ''), 'an empty provider answer never replaces anything');
eq(ADDR.houseNumberOf('1727 S 2nd St'), '1727', 'houseNumberOf reads the leading number');
eq(ADDR.houseNumberOf('2nd St'), '', '"2nd St" has no house number');
eq(ADDR.leadingDirectionalOf('1727 S 2nd St'), 'S', 'leadingDirectionalOf reads the directional');
eq(ADDR.leadingDirectionalOf('2nd St'), '', '"2nd St" has no directional');
eq(ADDR.leadingDirectionalOf('Main St'), '', 'an ordinary street name is not a directional');
// Detection is applied to BOTH sides, so a street NAMED for a direction still matches
// itself however it is spelled — the check only ever catches a directional that VANISHED.
ok(safe('26 West St, Brooklyn, NY 11211', '26 W St, Brooklyn, NY 11211'),
  'a street named "West" matches its own abbreviation — no false refusal');
ok(!safe('5 S Main, Newark, NJ 07102', '5 Main, Newark, NJ 07102'),
  'a directional that vanished is still caught on a suffix-less street');

// ── 2. the OSM parser ──────────────────────────────────────────────────────
console.log('2. parseOsmResult — a road-level match gives coordinates, never text');
// VERBATIM from the live Nominatim response for the owner's address.
const OSM_ROAD = {
  osm_id: 12345678, osm_type: 'way', addresstype: 'road', type: 'residential',
  lat: '40.5623', lon: '-74.4518',
  display_name: '2nd Street, Piscataway Township, Middlesex County, New Jersey, 07063, United States',
  address: {
    road: '2nd Street', town: 'Piscataway Township', county: 'Middlesex County',
    state: 'New Jersey', postcode: '07063', country: 'United States', country_code: 'us',
  },
};
const road = CANON.parseOsmResult(OSM_ROAD);
ok(road, 'a road-level match still returns a result (its coordinates are useful)');
eq(road.formatted, null, 'a road-level match offers NO address text');
eq(road.zip, null, 'a road-level match offers NO zip (07063 is the ROAD\'s, not the property\'s)');
eq(road.precision, 'road', 'the match is labelled road-level');
ok(road.lat === 40.5623 && road.lng === -74.4518, 'the coordinates are kept');
// Proof the fixture really is the bug: the OLD code built its text this way.
eq(ADDR.canonicalOneLine(ADDR.osmComponentsToAddress(OSM_ROAD.address)), CORRUPT,
  'the fixture reproduces the owner\'s exact corrupted string');

const OSM_HOUSE = {
  osm_id: 999, osm_type: 'node', addresstype: 'building',
  lat: '40.7128', lon: '-73.9578',
  display_name: '26, South 10th Street, Williamsburg, Brooklyn, Kings County, New York, 11249, United States',
  address: {
    house_number: '26', road: 'South 10th Street', borough: 'Brooklyn', city: 'New York',
    county: 'Kings County', state: 'New York', postcode: '11249', country_code: 'us',
  },
};
const house = CANON.parseOsmResult(OSM_HOUSE);
eq(house.formatted, '26 S 10th St, Brooklyn, NY 11249', 'a house-level match still returns the mailing form');
eq(house.zip, '11249', 'a house-level match still returns its zip');
eq(house.precision, 'rooftop', 'the match is labelled rooftop');
eq(CANON.parseOsmResult(null), null, 'no match → null');
eq(CANON.parseOsmResult({ lat: 'x', lon: 'y' }), null, 'unusable coordinates → null');

// ── 3. the Google parser ───────────────────────────────────────────────────
console.log('3. parseGeocodeResult — an imprecise match is rejected outright');
const g = (types) => CANON.parseGeocodeResult({
  results: [{ place_id: 'p1', types, formatted_address: 'X', geometry: { location: { lat: 1, lng: 2 } }, address_components: [] }],
});
eq(g(['route']), null, 'a route (street) match is rejected — it also backs samePlace');
eq(g(['postal_code']), null, 'a ZIP centroid is rejected');
eq(g(['neighborhood', 'political']), null, 'a neighbourhood is rejected');
eq(g(['locality', 'political']), null, 'a locality is still rejected');
ok(g(['street_address']) && g(['street_address']).place_id === 'p1', 'a real street address is accepted');
ok(g(['premise']) && g(['premise']).place_id === 'p1', 'a premise is accepted');
ok(g(['subpremise']) && g(['subpremise']).place_id === 'p1', 'a subpremise is accepted');

// ── 4. end-to-end through the ClickUp push ─────────────────────────────────
console.log('4. withCoords — the push keeps OUR address and takes only the coordinates');
// Patch the module object the orchestrator lazily requires (same reference).
CANON.geocode = async () => ({ ...road });
const orch = require(R + '/src/clickup/orchestrator');

(async () => {
  const out = await orch.withCoords({
    line1: '1727 S 2nd St', city: 'Piscataway', state: 'NJ', zip: '08854',
    oneLine: REAL, formatted_address: REAL, place_id: 'ours',
  });
  eq(out.formatted_address, REAL, 'THE BUG: the real address survives the push');
  ok(out.formatted_address !== CORRUPT, 'the corrupted string can no longer be produced');
  ok(out.lat === 40.5623 && out.lng === -74.4518, 'the coordinates ARE adopted (so the address still reaches the card)');
  eq(out.place_id, 'ours', 'a road-level place_id is NOT adopted (it identifies the street, not this house)');

  // The Plainfield case end-to-end: a PRECISE (rooftop, Google) match that resolves
  // the neighbouring municipality's house must not move the file there either.
  CANON.geocode = async () => ({
    place_id: 'ChIJplainfield', formatted: '1727 S 2nd St, Plainfield, NJ 07063, USA',
    lat: 40.596109, lng: -74.453144, zip: '07063',
  });
  const outP = await orch.withCoords({
    line1: '1727 S 2nd St', city: 'Piscataway', state: 'NJ', zip: '08854', oneLine: REAL,
  });
  eq(outP.formatted_address, REAL, 'the Piscataway address is kept, not relabelled to Plainfield');

  // A house-level match may still restyle.
  CANON.geocode = async () => ({ ...CANON.parseOsmResult(OSM_HOUSE) });
  const out2 = await orch.withCoords({
    line1: '26 South 10th Street', city: 'Brooklyn', state: 'NY', zip: '11249',
    oneLine: '26 South 10th Street, Brooklyn, NY 11249',
  });
  eq(out2.formatted_address, '26 S 10th St, Brooklyn, NY 11249',
    'a genuine rooftop match still improves the formatting');
  eq(out2.place_id, 'osm:999', 'a rooftop place_id IS adopted');

  // The unit still rides along on a building-level match.
  CANON.geocode = async () => ({
    place_id: 'osm:1', formatted: '1254 42nd St, Brooklyn, NY 11219', lat: 40.6, lng: -73.9,
    zip: '11219', precision: 'rooftop',
  });
  const out3 = await orch.withCoords({
    line1: '1254 42nd St', unit: 'Apt 6B', city: 'Brooklyn', state: 'NY', zip: '11219',
    oneLine: '1254 42nd St Apt 6B, Brooklyn, NY 11219',
  });
  ok(/Apt 6B/.test(out3.formatted_address), 'the apartment is kept on the stored value');

  // An address that already has coordinates is never re-resolved.
  CANON.geocode = async () => { throw new Error('must not be called'); };
  const out4 = await orch.withCoords({ oneLine: REAL, formatted_address: REAL, lat: 1, lng: 2 });
  eq(out4.formatted_address, REAL, 'an already-located address is returned untouched');

  await dbSection();

  console.log(`\n${fail ? 'FAILED' : 'PASSED'} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// ── 5. the permanent cache repair (DB) ─────────────────────────────────────
async function dbSection() {
  if (!process.env.DATABASE_URL) { console.log('5. (skipped — no DATABASE_URL)'); return; }
  console.log('5. healDowngradedGeocodeCache — the poisoned row is repaired');
  const db = require(R + '/src/db');
  const HEAL = require(R + '/src/lib/address-heal');
  const osmKey = 'osm:1727 2nd st, piscataway, nj 08854, usa';
  const googleKey = '1727 s 2nd st, piscataway, nj 08854';
  const cleanKey = '26 south 10th street, brooklyn, ny 11249';
  try {
    await db.query(`DELETE FROM address_canon_cache WHERE input_key = ANY($1)`, [[osmKey, googleKey, cleanKey]]);
    await db.query(
      `INSERT INTO address_canon_cache (input_key, place_id, formatted, lat, lng, zip) VALUES
         ($1,'osm:12345678',$4,40.5623,-74.4518,'07063'),
         ($2,'ChIJroad',    $4,40.5623,-74.4518,'07063'),
         ($3,'ChIJgood','26 S 10th St, Brooklyn, NY 11249',40.7128,-73.9578,'11249')`,
      [osmKey, googleKey, cleanKey, CORRUPT]);

    const n = await HEAL.healDowngradedGeocodeCache(500);
    ok(n >= 2, `both poisoned rows were repaired (repaired ${n})`);

    const osmRow = (await db.query(`SELECT formatted, zip, lat FROM address_canon_cache WHERE input_key=$1`, [osmKey])).rows[0];
    ok(osmRow, 'the OSM row is kept');
    eq(osmRow.formatted, null, 'the OSM row can no longer hand out the wrong text');
    eq(osmRow.zip, null, 'the OSM row can no longer hand out the wrong zip');
    ok(Number(osmRow.lat) === 40.5623, 'the OSM row keeps its coordinates');

    const goog = (await db.query(`SELECT 1 FROM address_canon_cache WHERE input_key=$1`, [googleKey])).rows[0];
    ok(!goog, 'the Google row is deleted (its place_id is the ROAD\'s identity)');

    const clean = (await db.query(`SELECT formatted FROM address_canon_cache WHERE input_key=$1`, [cleanKey])).rows[0];
    eq(clean && clean.formatted, '26 S 10th St, Brooklyn, NY 11249', 'a good row is left byte-for-byte alone');

    eq(await HEAL.healDowngradedGeocodeCache(500), 0, 'the pass is idempotent (a second run is a no-op)');

    // END-TO-END on the REAL cache: with no Google key the resolver falls through to
    // the OSM cache, so this is a pure cache hit — no network. The repaired row must
    // hand back coordinates and NOTHING a caller could adopt as an address.
    delete require.cache[require.resolve(R + '/src/lib/address-canon')];
    const LIVE = require(R + '/src/lib/address-canon');
    const hit = await LIVE.geocode(ON_CARD);
    ok(hit, 'the repaired row is still a usable geocode result');
    eq(hit.formatted, null, 'the cached row can no longer hand back the wrong address');
    eq(hit.precision, 'road', 'a cache HIT reports the same precision as a fresh lookup');
    ok(Number(hit.lat) === 40.5623, 'the cached coordinates still come through');
  } catch (e) {
    fail++; console.log('  FAIL: DB section threw:', e.message);
  } finally {
    try { await db.query(`DELETE FROM address_canon_cache WHERE input_key = ANY($1)`, [[osmKey, googleKey, cleanKey]]); } catch (_) {}
    try { await db.pool.end(); } catch (_) {}
  }
}
