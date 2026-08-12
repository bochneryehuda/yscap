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

console.log(`\ntest-address-county-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
