/**
 * THE ADDRESS CARRIES ITS POSITION — and the position is never Google's.
 *
 * The owner reported a half-mile comparable search returning "properties from
 * different states". It did: the search measures from a point, a TYPED subject
 * address had no point, and the radius was silently ignored. The search now
 * refuses rather than answer wrongly — honest, but on its own it made a typed
 * address unanswerable. This is the other half: picking an address from the
 * suggestions gives it the point the radius needs.
 *
 * FOUR THINGS ARE PINNED HERE, and each is a way the fix could quietly rot:
 *
 *  1. GOOGLE IS NEVER A SOURCE OF A COORDINATE. Google Maps Platform caps a
 *     stored latitude/longitude at 30 days unless the cache belongs to a single
 *     end user, and a shared comparable warehouse is not that. So Google may
 *     SUGGEST an address and must never supply its position — which is what makes
 *     a position from this endpoint safe to store anywhere. A future "we already
 *     have the place_id, just ask Google for the geometry" is the obvious
 *     shortcut and it is the one thing that must not happen, so it is asserted
 *     against the SOURCE rather than against behaviour.
 *
 *  2. ONLY THE HOUSE COUNTS. A road-level answer puts every house on the street
 *     at one point, and a quarter-mile search over that looks like it worked.
 *     Nominatim answers with the ROAD when it cannot find the house number, so a
 *     suggestion with no house number must carry no position.
 *
 *  3. THE UNIT COMES OFF BEFORE THE LOOKUP. No geocoder places an apartment, and
 *     including one is a common way a match fails outright.
 *
 *  4. A FAILURE IS AN ANSWER, NEVER A 500. The form has to keep working; no
 *     position simply means no distance search, and the screen says so.
 *
 * Run: node scripts/test-address-position.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

// ---------------------------------------------------------------------------
// A. THE SOURCE GUARD — Google can never become a coordinate source.
// ---------------------------------------------------------------------------
const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'address.js'), 'utf8');

// The position handler's body, so the assertions are about IT and not about the
// whole file (the file legitimately talks to Google for suggestions).
const posStart = SRC.indexOf("router.get('/position'");
ok(posStart > 0, 'the address route exposes GET /position');
const posBody = SRC.slice(posStart, SRC.indexOf('\n});', posStart));

ok(!/google/i.test(posBody),
  'the position handler never mentions Google — a coordinate must come from a keyless source');
ok(/RG\.geocodeProperty/.test(posBody),
  'the position handler goes through geocodeProperty — where the post-incident guards live');
ok(!/_internals\./.test(posBody),
  'and never reaches past it to a raw provider, which would skip those guards');

// Google's details lookup must not start requesting geometry: the moment it does,
// a coordinate we may not store is one destructure away from every caller.
const gd = SRC.slice(SRC.indexOf('async function googleDetails'), SRC.indexOf('// ---- Smarty'));
ok(gd.length > 50, 'found the Google details helper');
ok(!/geometry/.test(gd), 'the Google details lookup does not ask for geometry (a stored Google coordinate is capped at 30 days)');
ok(!/\blat\b|\blng\b/.test(gd), 'the Google details lookup returns no coordinate at all');

// ---------------------------------------------------------------------------
// B. THE OSM SUGGESTION CARRIES A POSITION — but only when it placed the HOUSE.
// ---------------------------------------------------------------------------
const cfg = require('../src/config');
const realProvider = cfg.addressProvider;
cfg.addressProvider = 'osm';                       // the keyless default

const app = express();
app.use(express.json());
app.use('/api/address', require('../src/routes/address'));
const server = http.createServer(app);

const listen = () => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
// THE TEST'S OWN REQUESTS MUST NOT GO THROUGH THE STUB. `fetchJson` inside the
// route calls the global `fetch`, and so does this helper — so it holds the real
// one from the start, or stubbing the provider also hijacks the test client.
const realFetch = global.fetch;
const get = async (port, url) => {
  const res = await realFetch(`http://127.0.0.1:${port}${url}`);
  return { status: res.status, body: await res.json() };
};

// A Nominatim search answer: one row that placed the house, one that answered
// with the road (no house_number) — the exact shape that must NOT carry a point.
const OSM_ROWS = [
  { place_id: 1, lat: '40.7142', lon: '-73.9614', display_name: '26, South 10th Street, Brooklyn, Kings County, New York, 11249, United States',
    address: { house_number: '26', road: 'South 10th Street', city: 'New York', suburb: 'Brooklyn', state: 'New York', postcode: '11249' } },
  { place_id: 2, lat: '40.5989', lon: '-74.4801', display_name: '2nd Street, Piscataway Township, Middlesex County, New Jersey, 07063, United States',
    address: { road: '2nd Street', town: 'Piscataway', state: 'New Jersey', postcode: '07063' } },
];

function stubFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = realFetch; }

(async () => {
  const port = await listen();

  // ---- B: suggestions -----------------------------------------------------
  stubFetch(async (url) => {
    ok(/nominatim/.test(String(url)), 'the osm provider is the one queried');
    return { ok: true, status: 200, json: async () => OSM_ROWS };
  });
  const sug = await get(port, '/api/address/suggest?q=26+S+10th+St+Brooklyn');
  restoreFetch();
  const rows = sug.body.suggestions || [];
  ok(rows.length === 2, 'both suggestions came back');
  ok(rows[0].position && Math.abs(rows[0].position.lat - 40.7142) < 1e-6
    && Math.abs(rows[0].position.lng + 73.9614) < 1e-6,
    'the suggestion that placed the HOUSE carries its position');
  ok(rows[0].position.source === 'osm' && rows[0].position.precision === 'address',
    'and the position says where it came from and how precise it is');
  ok(!rows[1].position,
    'the ROAD-level suggestion carries NO position — every house on one street at one point is worse than none');
  ok(!/Kings County|United States/.test(rows[0].label),
    'the label is still the compact mailing form, not the provider long form');

  // ---- C: the position endpoint ------------------------------------------
  //
  // The route calls `geocodeProperty`, and the point of that is the two refusals
  // living INSIDE it — so the provider is injected and the real function runs.
  // Stubbing `_internals.census` would prove nothing: `PROVIDERS` captured the
  // originals at module load, so the stub would never be reached.
  const RG = require('../src/lib/research/geocode');
  const realGeocodeProperty = RG.geocodeProperty;
  let answer = () => null;                       // what the (single) provider says
  let asked = [];                                // the lines it was asked about
  RG.geocodeProperty = (subject) => realGeocodeProperty(subject, {
    providers: [async (line) => { asked.push(line); return answer(line); }],
  });
  const CENSUS_HIT = (matched) => ({ lat: 40.7142, lng: -73.9614, source: 'census', precision: 'address', matched });

  answer = () => CENSUS_HIT('26 S 10TH ST, BROOKLYN, NY, 11249');
  const p1 = await get(port, '/api/address/position?line1=26+South+10th+Street+Apt+4D&city=Brooklyn&state=New+York&zip=11249');
  ok(p1.status === 200 && p1.body.lat === 40.7142 && p1.body.lng === -73.9614, 'a real address comes back placed');
  ok(p1.body.source === 'census', 'the Census geocoder answered first — no key, no cap on the answer');
  ok(asked.length === 1 && !/4D|Apt/i.test(asked[0]),
    `the UNIT is stripped before the lookup (asked: ${JSON.stringify(asked[0])})`);
  ok(/26 S 10th St/.test(asked[0]) && /Brooklyn/.test(asked[0]) && /NY 11249/.test(asked[0]),
    'and it is asked in the canonical mailing form');

  // The cache: the same address must not re-ask the provider.
  asked = [];
  const p1b = await get(port, '/api/address/position?line1=26+South+10th+Street+Apt+4D&city=Brooklyn&state=New+York&zip=11249');
  ok(p1b.body.lat === 40.7142 && asked.length === 0, 'the same address is served from cache, not re-asked');

  // THE WRONG-HOUSE REFUSAL — the reason this goes through `geocodeProperty` at
  // all. Verified live in 2026-07-28: Census answers "26 S 10th St, Piscataway"
  // with "26 10TH ST" — the directional dropped, a DIFFERENT STREET, at full
  // address precision. Adopting that pin measures every distance from the wrong
  // house without looking wrong, which is the exact class this endpoint exists to
  // close. It must refuse rather than answer confidently.
  asked = [];
  answer = () => CENSUS_HIT('26 10TH ST, PISCATAWAY, NJ, 08854');
  const pw = await get(port, '/api/address/position?line1=26+S+10th+St&city=Piscataway&state=NJ&zip=08854');
  ok(pw.status === 200 && pw.body.lat === null,
    'a geocoder answering with a DIFFERENT street is refused, not adopted');
  ok(/different property|wrong pin|unplaced/i.test(String(pw.body.why || '')),
    'and it says the answer was a different property: ' + JSON.stringify(pw.body.why));

  // The other half of the same incident: a rooftop-precise match on a house ~130m
  // away across a municipal line, where the ZIP we already hold disagrees.
  asked = [];
  answer = () => ({ lat: 40.61, lng: -74.41, source: 'census', precision: 'address', matched: '1727 S 2nd St, Plainfield, NJ 07063' });
  const pz = await get(port, '/api/address/position?line1=1727+S+2nd+St&city=Piscataway&state=NJ&zip=08854');
  ok(pz.body.lat === null, 'a precise match whose ZIP disagrees with ours is refused too');

  // "A STATE IS NOT A PLACE" — a house number and a state names nothing; there
  // are dozens of them and a geocoder returns the first it finds. A bare length
  // check let this through; `geocodeProperty` refuses before asking anyone.
  asked = [];
  answer = () => CENSUS_HIT('26 S 10TH ST, SOMEWHERE, NJ');
  const ps = await get(port, '/api/address/position?line1=26+S+10th+St&state=NJ');
  ok(ps.body.lat === null && asked.length === 0,
    'a house number with only a state is refused WITHOUT troubling a provider');

  // Nobody can place it — an ANSWER, with a reason a person can act on.
  asked = [];
  answer = () => null;
  const p3 = await get(port, '/api/address/position?q=99999+Nowhere+Rd,+Nowheresville,+NJ+08608');
  ok(p3.status === 200 && p3.body.lat === null && p3.body.lng === null, 'an address nobody can place answers with no position');
  ok(typeof p3.body.why === 'string' && p3.body.why.length > 10, 'and says why, in words: ' + JSON.stringify(p3.body.why));
  // A NEGATIVE IS CACHED ONLY BRIEFLY. "Nobody could place it" is usually a
  // service having a bad minute, and pinning that for the full window answers a
  // person who retries from a cache rather than from a lookup.
  asked = [];
  answer = () => CENSUS_HIT('99999 NOWHERE RD, NOWHERESVILLE, NJ, 08608');
  const p3b = await get(port, '/api/address/position?q=99999+Nowhere+Rd,+Nowheresville,+NJ+08608');
  ok(p3b.body.lat === null && asked.length === 0, 'within the short window the refusal is still cached');
  await new Promise((r) => setTimeout(r, 50));

  // A provider that THROWS must still leave the form working.
  asked = [];
  answer = () => { throw new Error('census exploded'); };
  const p4 = await get(port, '/api/address/position?q=5+Broken+Ave,+Trenton,+NJ+08608');
  ok(p4.status === 200 && p4.body.lat === null, 'a provider blowing up is answered, never 500');
  ok(!/exploded/.test(JSON.stringify(p4.body)), 'and the provider error text is never handed to the caller');

  // Not enough of an address to be worth a lookup.
  asked = [];
  const p5 = await get(port, '/api/address/position?q=NJ');
  ok(p5.body.lat === null && asked.length === 0, 'a scrap of text is refused without troubling a provider');

  // A NON-STRING QUERY VALUE IS AN ANSWER, NOT A 500. Express's extended query
  // parser turns `?state[x]=1` into an OBJECT; handing that to the address helpers
  // threw out of the handler on a PUBLIC endpoint.
  const p6 = await get(port, '/api/address/position?line1=26+S+10th+St&city=Brooklyn&state[x]=1&zip=11249');
  ok(p6.status === 200, `an object-valued query parameter is answered, not 500ed (got ${p6.status})`);
  ok(!/server error/i.test(JSON.stringify(p6.body)), 'and never as a server error');

  // IT SHEDS RATHER THAN QUEUES. This endpoint is public and unauthenticated, and
  // a position lookup can cost a second of OpenStreetMap's process-wide budget —
  // so a burst that queued would stall the address autocomplete for everybody.
  // Past the waiting limit it answers immediately with no position, which is a
  // truthful answer it already has to be able to give.
  asked = [];
  // The provider is held just long enough for the burst to arrive together — on a
  // TIMER, not released after the await, or the in-flight requests would be
  // waiting on a promise this test only resolves once they have all answered.
  answer = () => new Promise((r) => setTimeout(() => r(null), 400));
  const burst = [];
  for (let i = 0; i < 20; i++) burst.push(get(port, `/api/address/position?q=${i}+Burst+St,+Trenton,+NJ+08608`));
  const settled = await Promise.all(burst);
  ok(settled.every((r) => r.status === 200), 'every request in a burst is answered');
  const shed = settled.filter((r) => /busy/i.test(String(r.body.why || ''))).length;
  ok(shed > 0, `a burst sheds rather than queueing without bound (${shed} of 20 shed)`);
  ok(settled.every((r) => r.body.lat === null), 'and a shed request never claims a position it does not have');

  RG.geocodeProperty = realGeocodeProperty;
  cfg.addressProvider = realProvider;
  server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
