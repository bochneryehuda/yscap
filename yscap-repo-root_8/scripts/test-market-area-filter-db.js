/**
 * A DRAWN NEIGHBOURHOOD CUTS THE COMPARABLE SEARCH — and cuts it exactly.
 *
 * A radius is a bad model of a neighbourhood and every appraiser knows it: a mile
 * in one direction crosses a river, a rail line or a town line; a mile in another
 * is the same houses on the same streets. The 1004MC form itself asks the
 * appraiser to define the neighbourhood, so the boundary is a JUDGEMENT a person
 * makes — and once somebody has drawn one, the comparable search has to honour it
 * or the drawing was theatre.
 *
 * FIVE THINGS ARE PINNED HERE, and each is a way this goes silently wrong:
 *
 *  1. THE CUT IS EXACT. The bounding box is what SQL can index, and it includes
 *     the corners a drawn shape deliberately cuts off. A property in the box but
 *     outside the ring must NOT come back — that is the whole point of drawing
 *     rather than dragging a circle, and it is invisible when wrong: the search
 *     still returns houses and they still look plausible.
 *
 *  2. THE CUT HAPPENS IN SQL, NOT AFTER. The LIMIT and the total both run inside
 *     the query, so filtering the rows afterwards leaves the page short and the
 *     total overstated. The reported total must equal what is actually inside.
 *
 *  3. AN EMPTY AREA RETURNS NOTHING, NOT EVERYTHING. A shape containing none of
 *     our properties resolves to an empty id list, and a filter that quietly
 *     disappears when its list is empty would answer with the whole town while the
 *     screen still said the search was cut to a neighbourhood.
 *
 *  4. THE LADDER NEVER RELAXES IT. The relaxation ladder widens size, distance and
 *     recency until it has enough rows. It must never widen past a boundary a
 *     person drew — that answers a different question than the one on screen.
 *
 *  5. AN ARCHIVED OR UNKNOWN SHAPE IS A REFUSAL. Not a dropped filter.
 *
 * Real Postgres, real HTTP. Run: node scripts/test-market-area-filter-db.js
 */
'use strict';

const http = require('http');
const express = require('express');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('test-market-area-filter-db: skipped (no DATABASE_URL)');
  process.exit(0);
}
process.env.JWT_SECRET = process.env.JWT_SECRET || 'market-area-filter-test';

const db = require('../src/db');
const C = require('../src/lib/crypto');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
const CITY = `Ringtown${sfx}`;

// A DIAMOND, and the two points that make it a real test. The ring spans
// lat 40.0..40.2 and lng -74.2..-74.0, so its BOUNDING BOX is that whole square —
// but the shape itself excludes the corners. `outside` sits in a corner of the
// box: inside every SQL predicate an index can express, and outside the boundary
// the officer actually drew.
const RING = [
  { lat: 40.20, lng: -74.10 },   // N
  { lat: 40.10, lng: -74.00 },   // E
  { lat: 40.00, lng: -74.10 },   // S
  { lat: 40.10, lng: -74.20 },   // W
];
const INSIDE = { lat: 40.10, lng: -74.10 };          // the middle
const INSIDE2 = { lat: 40.12, lng: -74.09 };         // also comfortably inside
const CORNER = { lat: 40.19, lng: -74.19 };          // in the BOX, outside the RING

let staffId, areaId, emptyAreaId, archivedId;
const propIds = {};
let server, port;

const post = async (path, body, token) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const get = async (path, token) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() };
};

async function addProperty(name, at, extra = {}) {
  const id = (await db.query(
    `INSERT INTO properties (address_key, display_address, street, city, state, zip,
       property_type, units, gla, beds, baths_full, year_built, condition_uad,
       last_sale_price, last_sale_date, observation_count, geo_latitude, geo_longitude)
     VALUES ($1,$2,$3,$4,'NJ','07001',$5,1,1500,3,2,1975,'C3',
             $6, current_date - interval '3 months', 2, $7, $8)
     RETURNING id`,
    [`nj|${CITY.toLowerCase()}|${name}|${sfx}`, `${name} ${sfx}`, name, CITY,
      extra.property_type || 'Single Family', extra.price || 400000, at.lat, at.lng])).rows[0].id;
  propIds[name] = id;
  return id;
}

(async () => {
  try {
    await require('../src/migrate-boot').ensureSchema();

    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Market Area Filter','super_admin',true,false,'x',0) RETURNING id`,
      [`maf${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    await addProperty('Middle St', INSIDE);
    await addProperty('Second St', INSIDE2);
    await addProperty('Corner Rd', CORNER);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.headers.authorization = req.headers.authorization || ''; next(); });
    app.use('/api/research', require('../src/routes/research'));
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    // ---- the shapes ------------------------------------------------------
    const made = await post('/api/research/market-areas',
      { name: `North diamond ${sfx}`, city: CITY, state: 'NJ', ring: RING }, token);
    ok(made.status === 201 && made.body.area, `the drawn area saved (${made.status})`);
    areaId = made.body.area && made.body.area.id;

    // A shape somewhere we hold nothing at all.
    const empty = await post('/api/research/market-areas',
      { name: `Empty quarter ${sfx}`, city: CITY, state: 'NJ',
        ring: [{ lat: 44.00, lng: -70.00 }, { lat: 44.10, lng: -70.00 }, { lat: 44.10, lng: -70.10 }] }, token);
    emptyAreaId = empty.body.area && empty.body.area.id;
    ok(!!emptyAreaId, 'an area over ground we hold nothing in also saves');

    const arch = await post('/api/research/market-areas',
      { name: `Retired ${sfx}`, city: CITY, state: 'NJ', ring: RING }, token);
    archivedId = arch.body.area && arch.body.area.id;
    await post(`/api/research/market-areas/${archivedId}/archive`, {}, token);

    // ---- 1 + 2. THE CUT IS EXACT, AND IT IS DONE IN SQL -------------------
    const base = `/api/research/comps?city=${encodeURIComponent(CITY)}&state=NJ&sold_within_months=0`;
    const all = await get(base, token);
    ok(all.status === 200, `the plain search answers (${all.status})`);
    const allIds = (all.body.rows || []).map((r) => r.id);
    ok(allIds.includes(propIds['Middle St']) && allIds.includes(propIds['Corner Rd']),
      'without a boundary the search returns both the middle AND the corner');

    const cut = await get(`${base}&market_area_id=${areaId}`, token);
    ok(cut.status === 200, `the cut search answers (${cut.status})`);
    const cutIds = (cut.body.rows || []).map((r) => r.id);
    ok(cutIds.includes(propIds['Middle St']) && cutIds.includes(propIds['Second St']),
      'the properties inside the drawn shape come back');
    ok(!cutIds.includes(propIds['Corner Rd']),
      'and the one in its BOUNDING BOX but outside the SHAPE does not — the box is not the boundary');
    ok(cut.body.total === cutIds.length,
      `the reported total matches what came back (${cut.body.total} vs ${cutIds.length}) — the cut ran in SQL, not after the LIMIT`);
    ok(cut.body.market_area && cut.body.market_area.id === areaId,
      'the answer names the boundary it applied');
    ok(cut.body.market_area && cut.body.market_area.inArea === 2 && cut.body.market_area.inBox >= 3,
      `and says what it cut: ${cut.body.market_area && cut.body.market_area.inArea} of `
      + `${cut.body.market_area && cut.body.market_area.inBox} in its bounding box`);

    // ---- 3. AN EMPTY AREA RETURNS NOTHING, NOT EVERYTHING ------------------
    const none = await get(`${base}&market_area_id=${emptyAreaId}`, token);
    ok(none.status === 200, 'a boundary containing nothing still answers');
    ok((none.body.rows || []).length === 0 && none.body.total === 0,
      `it returns NOTHING rather than the whole town (got ${(none.body.rows || []).length} rows, `
      + `total ${none.body.total}) — a filter that vanishes when its list is empty is the silent-widening bug`);
    ok(none.body.market_area && none.body.market_area.inArea === 0,
      'and it says the boundary contains none of ours');

    // ---- 4. THE LADDER NEVER RELAXES IT ------------------------------------
    // Ask for something the ladder WILL widen (a tiny size band) alongside the
    // boundary. It must widen the size and still never step outside the shape.
    const laddered = await get(
      `${base}&market_area_id=${areaId}&relaxable=sqft_min,sqft_max&sqft_min=100000&sqft_max=100001&want=6`, token);
    ok(laddered.status === 200, 'the ladder runs with a boundary in place');
    const lIds = (laddered.body.rows || []).map((r) => r.id);
    ok(!lIds.includes(propIds['Corner Rd']),
      'however far the ladder widens, it never steps outside the boundary somebody drew');
    ok((laddered.body.ladder || []).length >= 1, 'and the ladder genuinely ran');

    // ---- 5. AN ARCHIVED OR UNKNOWN SHAPE IS A REFUSAL ----------------------
    const gone = await get(`${base}&market_area_id=${archivedId}`, token);
    ok(gone.body.refused === 'market_area_not_found',
      `an ARCHIVED boundary is refused, never silently dropped (refused: ${gone.body.refused})`);
    ok((gone.body.rows || []).length === 0, 'and it returns nothing rather than the whole town');
    ok(typeof gone.body.why === 'string' && /archived|not there/i.test(gone.body.why),
      'saying so in words a person can act on: ' + JSON.stringify(gone.body.why));

    const bogus = await get(`${base}&market_area_id=not-a-uuid`, token);
    ok(bogus.status === 200 && bogus.body.refused === 'market_area_not_found',
      'and a malformed id is refused the same way, never a 500');

    console.log(`\ntest-market-area-filter-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    if (server) server.close();
    for (const id of [areaId, emptyAreaId, archivedId]) {
      if (id) await db.query('DELETE FROM market_areas WHERE id=$1', [id]).catch(() => {});
    }
    for (const id of Object.values(propIds)) {
      await db.query('DELETE FROM properties WHERE id=$1', [id]).catch(() => {});
    }
    if (staffId) await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
