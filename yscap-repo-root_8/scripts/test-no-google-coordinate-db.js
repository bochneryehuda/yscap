/**
 * A GOOGLE COORDINATE MAY NEVER BE STORED IN THE PROPERTY WAREHOUSE — proved
 * against the DATABASE, not against our intentions.
 *
 * This is a licensing rule: Google Maps Platform caps a stored latitude/longitude
 * at 30 consecutive days unless the cache belongs to a single end user, and
 * `properties` is a permanent warehouse read by the whole company. Google may
 * SUGGEST an address and may DRAW a map; it may never place a property here.
 *
 * WHY THIS TEST IS ABOUT THE CONSTRAINT AND NOT ABOUT THE CODE. Every other guard
 * on this rule is one somebody has to remember — a comment, a provider list, a
 * source-level assertion. Each catches the change written the way we expect. The
 * change that will actually break this is the one nobody reviewed: an import
 * script, a hand-run migration, a new module written next year by someone reading
 * only the column names. So what is asserted here is that the DATABASE refuses it,
 * however the write is phrased.
 *
 * The point is deliberately narrow and the negative cases matter as much as the
 * positive one: every source we DO use must still be storable, or the constraint
 * would be a rule that breaks the warehouse instead of protecting it.
 *
 * Real Postgres. Run: node scripts/test-no-google-coordinate-db.js
 */
'use strict';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

if (!process.env.DATABASE_URL) {
  console.log('test-no-google-coordinate-db: skipped (no DATABASE_URL)');
  process.exit(0);
}

const db = require('../src/db');
const G = require('../src/lib/research/geocode');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
const made = [];
let seq = 0;                                   // every fixture row needs its OWN key

async function insertWith(source) {
  seq += 1;
  const r = await db.query(
    `INSERT INTO properties (address_key, display_address, street, city, state,
       geo_latitude, geo_longitude, geo_source)
     VALUES ($1,$2,'1 Guard St','Guardtown','NJ',40.1,-74.1,$3) RETURNING id`,
    [`nj|guardtown|1 guard st|${sfx}|${seq}`, `1 Guard St ${sfx}`, source]);
  made.push(r.rows[0].id);
  return r.rows[0].id;
}

(async () => {
  try {
    await require('../src/migrate-boot').ensureSchema();

    // ---- 1. THE DATABASE REFUSES IT, HOWEVER IT IS SPELLED ----------------
    // Broad on purpose: refusing a source we invented that merely contains the
    // word is a clear error the moment somebody writes it; letting one through is
    // a licensing breach nobody notices for a year.
    for (const bad of ['google', 'Google', 'GOOGLE', 'google_places', 'places-google',
      'geocoded by Google', 'google-maps-platform']) {
      let refused = false;
      try { await insertWith(bad); } catch (e) { refused = /properties_no_google_geo_ck/.test(String(e.message)); }
      ok(refused, `the database refuses a coordinate sourced from "${bad}"`);
    }

    // An UPDATE is a write too — a row that got in clean must not be relabelled.
    const clean = await insertWith('census');
    let updateRefused = false;
    try { await db.query('UPDATE properties SET geo_source=$2 WHERE id=$1', [clean, 'google']); }
    catch (e) { updateRefused = /properties_no_google_geo_ck/.test(String(e.message)); }
    ok(updateRefused, 'and refuses RELABELLING an existing row as Google — an update is a write');

    // ---- 2. EVERY SOURCE WE DO USE IS STILL STORABLE ----------------------
    // A guard that breaks the warehouse it protects is worse than no guard.
    for (const good of ['census', 'osm', 'comp_trilateration', null]) {
      let stored = false;
      try { await insertWith(good); stored = true; } catch (e) { stored = false; }
      ok(stored, `a coordinate from "${good}" is still stored normally`);
    }

    // ---- 3. THE CODE REFUSES IT FIRST, WITH A REASON ----------------------
    // Refused only by the constraint, this surfaces as a 500 three layers up, at
    // the moment of a write, on a background sweep nobody is watching. Refused in
    // the geocoder it is a named answer a caller can read and report.
    const fake = async () => ({ lat: 40.1, lng: -74.1, source: 'google', precision: 'address',
      matched: '1 Guard St, Guardtown, NJ' });
    const out = await G.geocodeProperty(
      { street: '1 Guard St', city: 'Guardtown', state: 'NJ' }, { providers: [fake] });
    ok(out && out.ok === false, 'the geocoder refuses a Google answer rather than returning it');
    ok(out && out.forbiddenSource === 'google', 'and names the source it refused');
    ok(out && /30 days|permanent/i.test(String(out.why || '')),
      'saying WHY in words: ' + JSON.stringify(out && out.why));

    // The same function still accepts the sources we do use, so the guard is not
    // quietly refusing everything.
    const fine = await G.geocodeProperty(
      { street: '1 Guard St', city: 'Guardtown', state: 'NJ' },
      { providers: [async () => ({ lat: 40.1, lng: -74.1, source: 'census', precision: 'address', matched: '1 GUARD ST, GUARDTOWN, NJ' })] });
    ok(fine && fine.ok === true && fine.source === 'census', 'and still accepts a Census answer');

    console.log(`\ntest-no-google-coordinate-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    console.error(e);
    fail++;
  } finally {
    for (const id of made) await db.query('DELETE FROM properties WHERE id=$1', [id]).catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(fail ? 1 : 0);
  }
})();
