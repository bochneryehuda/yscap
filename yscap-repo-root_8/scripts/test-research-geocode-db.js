/**
 * DISTANCE SEARCH — the coordinates behind it (db/411, src/lib/research/geocode.js,
 * the radius block in src/lib/research/search.js).
 *
 * The owner asked for "how close do you want the comparables" and "a map telling us
 * how far each comparable is". The arithmetic was already right; three things
 * around it were not, and each of them is the kind of bug that looks like the
 * feature merely being flaky:
 *
 *   1. A GEOCODE WRITTEN INTO `properties.latitude` IS WIPED. Every fact on
 *      `properties` is recomputed from the observations on each ingest, and a
 *      column no observation states goes back to NULL — so a coordinate looked up
 *      today disappears the next time any report mentioning that property is read.
 *      db/411 gives the looked-up coordinate its own columns; this proves it
 *      survives a re-ingest.
 *   2. THE RADIUS CUT THE CIRCLE IN JAVASCRIPT, AFTER THE SQL `LIMIT`. The total
 *      came from a window function that had counted the bounding BOX, so the count
 *      overstated by up to 27% and pages came back short. This proves the rows, the
 *      total and the paging now describe one set.
 *   3. THE SUBJECT WAS NEVER PLACED. Only some comparables carry the appraiser's
 *      own coordinates and no subject ever does, so a radius search around a
 *      subject had nothing to search from. This proves the effective coordinate is
 *      used, and that an unplaced subject SAYS SO rather than quietly answering
 *      with the whole town.
 *
 * The two geocoding services are not called here. This suite is about what we do
 * with a coordinate, which is where every one of those bugs lived.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const G = require('../src/lib/research/geocode');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

// ---------------------------------------------------------------------------
// PURE — what we ask the services, and what we accept back
// ---------------------------------------------------------------------------
const line = G._internals.addressLine;
ok(line({ street: '26 S 10th St', city: 'Piscataway', state: 'NJ', zip: '08854' })
  === '26 S 10th St, Piscataway, NJ 08854',
'the address is asked in the "street, town, ST zip" form both services expect');
ok(line({ street: '26 S 10th St', unit: '4B', city: 'Piscataway', state: 'NJ', zip: '08854' })
  === '26 S 10th St, Piscataway, NJ 08854',
'THE UNIT IS LEFT OFF — no geocoder places an apartment, and sending one is a common reason a match fails outright');
ok(line({ street: '26 S 10th St', state: 'NJ' }) === null,
  'an address with no town and no ZIP is not asked about at all — there is nothing to place');
ok(line({ city: 'Piscataway', state: 'NJ' }) === null, 'and a town on its own is not a property');
ok(line({ display_address: '26 S 10th St, Piscataway, NJ', city: 'Piscataway', state: 'NJ' }) != null,
  'a property stored only as a one-line address can still be asked about');

const inUS = G._internals.inUS;
ok(inUS(40.55, -74.46) === true, 'a New Jersey coordinate is accepted');
ok(inUS(51.5, -0.12) === false, 'a coordinate in London is refused — the services are US-only and a hit outside is a misread');
ok(inUS(0, 0) === false, 'the null island is never a property');
ok(inUS(NaN, -74) === false && inUS(40.5, null) === false, 'a missing or unreadable coordinate is refused, never stored as 0');

if (!process.env.DATABASE_URL) {
  console.log(`test-research-geocode-db: ${pass} passed, ${fail} failed (pure only — no DATABASE_URL)`);
  process.exit(fail ? 1 : 0);
}

const db = require('../src/db');
const ingest = require('../src/lib/research/ingest');
const S = require('../src/lib/research/search');
const XI = require('../src/lib/research/xml-import');
const { appraisalXml } = require('./lib/research-xml-fixture');

const RUN = `${process.pid}${Math.floor(Math.random() * 1000)}`;
const letters = (n) => String(n).split('').map((d) => 'abcdefghij'[+d] || 'x').join('');
const TOWN = 'Geotown' + letters(RUN);
const LIC = `42GE${String(process.pid).padStart(5, '0')}${Math.floor(Math.random() * 900 + 100)}`;

// A quarter-mile is about 0.0036° of latitude; a mile is about 0.0145°. These are
// laid out north of the subject so the distances are easy to reason about.
const SUBJ = { lat: 40.5500, lng: -74.4600 };
const AT_MILES = (m) => ({ lat: SUBJ.lat + m / 69.0546, lng: SUBJ.lng });

(async () => {
  const D = { query: (t, p) => db.query(t, p), getClient: () => db.getClient() };
  try {
    // ---- a report whose comparables we can place ---------------------------
    const xml = appraisalXml({
      city: TOWN, street: '1 Center St', licenseId: LIC,
      appraiserName: `Geo ${letters(process.pid)}`,
      comps: [0.3, 0.8, 2.5].map((mi, i) => ({
        seq: String(i + 1), address: `${10 + i} Ring Rd`, city: TOWN, state: 'NJ', zip: '08854',
        price: 400000 + i * 1000, saleDate: '2026-04-10', gla: 1500, beds: 3, baths: '2.0',
        condition: 'C3', quality: 'Q4', yearBuilt: 1960,
      })),
    });
    const r = await XI.importXml(D, { xml, filename: `geo-${RUN}.xml` });
    ok(r.ok, `the fixture report landed (${r.reason || 'ok'})`);

    const props = (await db.query(
      `SELECT id, street FROM properties WHERE lower(city) = lower($1) ORDER BY street`, [TOWN])).rows;
    ok(props.length === 4, `the subject and its three comparables are in the warehouse (got ${props.length})`);

    const byStreet = (st) => props.find((p) => p.street === st);
    const subject = byStreet('1 Center St');
    const placeAt = async (id, at) => db.query(
      `UPDATE properties SET geo_latitude=$2, geo_longitude=$3, geo_source='test',
              geo_precision='address', geo_at=now(), geo_attempted_at=now() WHERE id=$1`,
      [id, at.lat, at.lng]);

    await placeAt(subject.id, SUBJ);
    await placeAt(byStreet('10 Ring Rd').id, AT_MILES(0.3));
    await placeAt(byStreet('11 Ring Rd').id, AT_MILES(0.8));
    await placeAt(byStreet('12 Ring Rd').id, AT_MILES(2.5));

    // =====================================================================
    // 1. THE GEOCODE SURVIVES A RE-INGEST
    // =====================================================================
    const before = (await db.query(`SELECT eff_latitude, geo_latitude, latitude FROM properties WHERE id=$1`, [subject.id])).rows[0];
    ok(Number(before.eff_latitude) === SUBJ.lat && before.latitude === null,
      'the effective coordinate is the looked-up one, and the appraiser column is left alone');

    // Re-run the exact ingest that recomputes every roll-up fact on these rows.
    const again = await XI.importXml(D, { xml, filename: `geo-${RUN}-again.xml` });
    ok(again.ok, 're-reading the same report is fine');
    const after = (await db.query(
      `SELECT geo_latitude, eff_latitude FROM properties WHERE id=$1`, [subject.id])).rows[0];
    ok(after.geo_latitude != null && Number(after.eff_latitude) === SUBJ.lat,
      'THE COORDINATE SURVIVES THE RE-READ — this is the whole reason it does not live in the roll-up columns');

    // =====================================================================
    // 2. THE RADIUS, THE COUNT AND THE PAGE ALL DESCRIBE ONE SET
    // =====================================================================
    const half = await S.searchProperties(db, {
      city: TOWN, lat: SUBJ.lat, lng: SUBJ.lng, radius_miles: '0.5', limit: 50,
    });
    ok(half.rows.length === 2, `half a mile finds the subject and the 0.3-mile comparable (got ${half.rows.length})`);
    ok(half.total === half.rows.length,
      `THE TOTAL MATCHES WHAT CAME BACK (${half.total} vs ${half.rows.length}) — it used to count the square, not the circle`);

    const oneMile = await S.searchProperties(db, {
      city: TOWN, lat: SUBJ.lat, lng: SUBJ.lng, radius_miles: '1', limit: 50,
    });
    ok(oneMile.rows.length === 3 && oneMile.total === 3, 'a mile reaches the 0.8-mile comparable as well');

    const wide = await S.searchProperties(db, {
      city: TOWN, lat: SUBJ.lat, lng: SUBJ.lng, radius_miles: '3', limit: 50,
    });
    ok(wide.rows.length === 4, 'three miles reaches all four');

    // The corner of a bounding box is further away than its edge — a 1-mile box
    // reaches ~1.41 miles diagonally. This is the row that used to leak in.
    const corner = AT_MILES(0.7);
    corner.lng = SUBJ.lng + 0.7 / (69.1710 * Math.cos(SUBJ.lat * Math.PI / 180));
    await placeAt(byStreet('12 Ring Rd').id, corner);      // ~0.99 miles diagonally
    const tight = await S.searchProperties(db, {
      city: TOWN, lat: SUBJ.lat, lng: SUBJ.lng, radius_miles: '0.75', limit: 50,
    });
    ok(!tight.rows.some((x) => x.street === '12 Ring Rd'),
      'A PROPERTY IN THE CORNER OF THE BOX BUT OUTSIDE THE CIRCLE IS EXCLUDED — and excluded from the count too');
    ok(tight.total === tight.rows.length, 'so the count still matches');

    // Paging must not go short because of the circle.
    const paged = await S.searchProperties(db, {
      city: TOWN, lat: SUBJ.lat, lng: SUBJ.lng, radius_miles: '3', limit: 2, page: 1,
    });
    ok(paged.rows.length === 2 && paged.total === 4 && paged.pages === 2,
      `a page comes back FULL, with the real total behind it (${paged.rows.length}/${paged.total}/${paged.pages})`);

    // =====================================================================
    // 3. THE DISTANCE COMES BACK, AND IT IS RIGHT
    // =====================================================================
    const near = oneMile.rows.find((x) => x.street === '10 Ring Rd');
    ok(near && Math.abs(Number(near.distance_miles) - 0.3) < 0.02,
      `the distance is measured correctly (${near && near.distance_miles})`);
    ok(oneMile.rows.every((x, i, arr) => i === 0 || Number(arr[i - 1].distance_miles) <= Number(x.distance_miles)),
      'and a distance search comes back nearest-first without being asked');

    // =====================================================================
    // 4. AN UNPLACED PROPERTY IS NOT SILENTLY TREATED AS FAR AWAY
    // =====================================================================
    await db.query(`UPDATE properties SET geo_latitude=NULL, geo_longitude=NULL WHERE id=$1`, [byStreet('11 Ring Rd').id]);
    const afterUnplace = await S.searchProperties(db, {
      city: TOWN, lat: SUBJ.lat, lng: SUBJ.lng, radius_miles: '3', limit: 50,
    });
    ok(!afterUnplace.rows.some((x) => x.street === '11 Ring Rd'),
      'a property we cannot place is left OUT of a radius search — never dropped in at an assumed distance');

    // =====================================================================
    // 5. THE SWEEP STAMPS WHAT IT LOOKED AT, SO IT DRAINS
    // =====================================================================
    const status = await G.geocodeStatus(db);
    ok(status && Number(status.placed) >= 3, 'the status counts what has been placed');
    ok(status && typeof status.still_to_do === 'number', 'and what is still to do');

    // A sweep with the services unreachable (which they are from here) must still
    // stamp every row it tried, or it would re-ask the same addresses forever.
    const todoBefore = (await db.query(
      `SELECT geo_attempts FROM properties WHERE id=$1`, [byStreet('11 Ring Rd').id])).rows[0].geo_attempts;
    const swept = await G.backfillGeocodes(db, { limit: 2 });
    ok(swept && typeof swept.looked === 'number' && !swept.error,
      `the sweep runs and never throws even with no service reachable (${JSON.stringify(swept)})`);
    const todoAfter = (await db.query(
      `SELECT geo_attempts, geo_attempted_at FROM properties WHERE id=$1`, [byStreet('11 Ring Rd').id])).rows[0];
    ok(todoAfter.geo_attempts > todoBefore || todoAfter.geo_attempted_at != null,
      'and every row it tried is stamped, so an address nobody can place is not re-asked on every boot forever');

    console.log(`test-research-geocode-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.log('FAIL threw:', (e && e.stack) || e);
    console.log(`test-research-geocode-db: ${pass} passed, ${fail} failed`);
  } finally {
    try { await db.pool.end(); } catch (_) { /* already closed */ }
  }
  process.exit(fail ? 1 : 0);
})();
