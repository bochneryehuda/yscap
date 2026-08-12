'use strict';
/**
 * address-canon county parsers — pure, no database, no network.
 *
 * resolveCounty() geocodes + caches (exercised end-to-end elsewhere); the two
 * parsers it reads the county off are pure, so they are pinned here: the county
 * must come from the RIGHT field (Google administrative_area_level_2, OSM
 * address.county / state_district) and a match with no county must yield null
 * rather than a guess — Class requires a county, but a WRONG one is worse than a
 * blocked order the reviewer can fix.
 */
const ac = require('../src/lib/address-canon');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };

// --- Google: county is administrative_area_level_2 ---
console.log('\n--- googleCounty reads administrative_area_level_2 ---');
const gJson = {
  status: 'OK',
  results: [{
    place_id: 'x',
    address_components: [
      { long_name: '195', types: ['street_number'] },
      { long_name: 'Parrish Street', types: ['route'] },
      { long_name: 'Wilkes-Barre', types: ['locality', 'political'] },
      { long_name: 'Luzerne County', types: ['administrative_area_level_2', 'political'] },
      { long_name: 'Pennsylvania', types: ['administrative_area_level_1', 'political'] },
      { long_name: '18702', types: ['postal_code'] },
    ],
  }],
};
ok(ac.googleCounty(gJson) === 'Luzerne County', 'the county is read from administrative_area_level_2');
ok(ac.googleCounty({ status: 'OK', results: [{ address_components: [
  { long_name: 'Baltimore', types: ['locality', 'political'] },
  { long_name: 'Maryland', types: ['administrative_area_level_1'] },
] }] }) === null,
  'an independent city with no county component yields null, never a guess');
ok(ac.googleCounty({ status: 'ZERO_RESULTS', results: [] }) === null, 'no result -> null');
ok(ac.googleCounty(null) === null && ac.googleCounty({}) === null, 'junk -> null, never throws');

// --- OSM: address.county, falling back to state_district ---
console.log('\n--- osmCounty reads address.county / state_district ---');
ok(ac.osmCounty({ address: { county: 'Kings County', state: 'New York' } }) === 'Kings County',
  'the county is read from address.county');
ok(ac.osmCounty({ address: { state_district: 'Orleans Parish', state: 'Louisiana' } }) === 'Orleans Parish',
  'a state that files it as state_district (LA parishes) is read too');
ok(ac.osmCounty({ address: { county: 'Kings County', state_district: 'ignored' } }) === 'Kings County',
  'address.county wins when both are present');
ok(ac.osmCounty({ address: { state: 'Rhode Island' } }) === null, 'no county at all -> null');
ok(ac.osmCounty(null) === null && ac.osmCounty({}) === null, 'junk -> null, never throws');

// --- countyQueryFrom: property parts -> a geocodable one-line, unit dropped ---
console.log('\n--- countyQueryFrom builds a geocodable one-line ---');
ok(ac.countyQueryFrom('195 Parrish St, Wilkes-Barre, PA 18702') === '195 Parrish St, Wilkes-Barre, PA 18702',
  'a plain string passes through');
ok(ac.countyQueryFrom({ addressLine: '195 Parrish St', addressLine2: 'Unit 3', city: 'Wilkes-Barre', state: 'PA', postalCode: '18702' })
   === '195 Parrish St, Wilkes-Barre, PA, 18702',
  'property parts compose a one-line, and the unit (line 2) is left off — county is the same for the building');
ok(ac.countyQueryFrom({ street: '10 Main St', city: 'Lakewood', state: 'NJ', zip: '08701' })
   === '10 Main St, Lakewood, NJ, 08701',
  'the alternate part names (street / zip) are accepted');
ok(ac.countyQueryFrom({}) === '' && ac.countyQueryFrom(null) === '', 'nothing in -> empty, never throws');

// --- the precision GATE resolveCounty applies before reading a county ---
// resolveCounty reads a county ONLY from a match parseGeocodeResult / parseOsmResult
// judge precise, so a road-level answer (the road the geocoder fell back to, which
// can sit in a DIFFERENT county) never becomes the property's county. Pin that these
// gate functions really do reject an imprecise match, so the county gate can't rot.
console.log('\n--- the precision gate rejects a road-level match (wrong-county guard) ---');
ok(ac.parseGeocodeResult({ status: 'OK', results: [{ place_id: 'p', types: ['route'],
  formatted_address: '2nd St, Plainfield, NJ 07063', geometry: { location: { lat: 40.6, lng: -74.4 } } }] }) === null,
  'a Google route-level match is refused by parseGeocodeResult (no county taken)');
ok(ac.parseGeocodeResult({ status: 'OK', results: [{ place_id: 'p', types: ['street_address'],
  formatted_address: '1727 S 2nd St, Piscataway, NJ 08854', geometry: { location: { lat: 40.5, lng: -74.4 } },
  address_components: [{ long_name: '08854', types: ['postal_code'] }] }] }) !== null,
  'a precise street_address match passes the gate (its county may be read)');
ok(ac.parseOsmResult({ osm_id: 1, lat: '40.5', lon: '-74.4', address: { road: '2nd Street', county: 'Union County' } }).precision === 'road',
  'an OSM match with no house_number is road-level — refused, so its county is not adopted');
ok(ac.parseOsmResult({ osm_id: 2, lat: '40.5', lon: '-74.4', address: { house_number: '1727', road: 'South 2nd Street', county: 'Middlesex County' } }).precision === 'rooftop',
  'an OSM match WITH a house_number is rooftop — its county may be read');

console.log(`\ntest-address-county-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
