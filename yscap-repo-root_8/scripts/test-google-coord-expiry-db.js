/**
 * GOOGLE COORDINATES ARE KEPT ONLY AS LONG AS GOOGLE ALLOWS (db/413,
 * src/lib/address-canon.js) — owner-authorized 2026-08-02.
 *
 * `address_canon_cache` (db/124) was designed to be permanent, and for its actual
 * job — proving two differently-typed addresses are the same property — that is
 * exactly right. Google Maps Platform permits keeping a `place_id` indefinitely and
 * caps a stored latitude/longitude at 30 consecutive calendar days, so only the
 * COORDINATES were ever out of window.
 *
 * The whole risk in this change is breaking something to fix a compliance point, so
 * that is what this suite is mostly about:
 *
 *   1. THE MATCHING FEATURE IS UNTOUCHED. `samePlace()` still answers from the
 *      cache, with no coordinates and no fresh lookup, after the sweep has run.
 *      If this ever fails, address matching across the whole platform has been
 *      slowed down or broken by a compliance fix, which would be a bad trade.
 *   2. AN `osm:` ROW NEVER EXPIRES. OpenStreetMap's licence permits keeping the
 *      result, and the ClickUp address push leans on those rows.
 *   3. THE SWEEP KEEPS `place_id` AND DROPS ONLY THE LICENSED-WINDOW FIELDS.
 *   4. IT IS BOUNDED, IDEMPOTENT AND SELF-DRAINING.
 *   5. THE BACK-DATE gives every existing Google row the expiry it should always
 *      have had — which for old rows is in the past, so the first sweep clears
 *      them. That IS the compliance action.
 *   6. A RESOLVED ROW'S IDENTITY IS NEVER REWRITTEN, even by a refresh.
 *
 * Requires DATABASE_URL with migrations applied. Skips cleanly otherwise.
 */
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';

const AC = require('../src/lib/address-canon');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

// ---------------------------------------------------------------------------
// PURE — which rows expire, and when
// ---------------------------------------------------------------------------
const exp = AC.coordsExpiryFor;
ok(exp('123 main st newark nj', { place_id: 'ChIJabc' }) instanceof Date,
  'a GOOGLE row is stamped with an expiry');
ok(exp('osm:123 main st newark nj', { place_id: 'osm:99' }) === null,
  'an OSM-keyed row is NEVER stamped — its licence permits keeping the result');
ok(exp('123 main st newark nj', { place_id: 'osm:99' }) === null,
  'and an OSM place id is recognised even if the key is not prefixed');
ok(exp('123 main st newark nj', { place_id: null }) === null,
  'an unresolvable row has no coordinates to expire');
ok(exp('123 main st newark nj', null) === null, 'and neither does nothing at all');
{
  const d = exp('123 main st newark nj', { place_id: 'ChIJabc' });
  const days = (d.getTime() - Date.now()) / 86400000;
  ok(days > 29.9 && days < 30.1, `the window is 30 days (got ${days.toFixed(2)})`);
}

const lapsed = AC.coordsLapsed;
ok(lapsed({ coords_expire_at: new Date(Date.now() - 1000) }) === true, 'a past expiry has lapsed');
ok(lapsed({ coords_expire_at: new Date(Date.now() + 86400000) }) === false, 'a future one has not');
ok(lapsed({ coords_expire_at: null }) === false,
  'a row with NO expiry never lapses — that is an OSM row, and blanking one would be wrong');
ok(lapsed(null) === false && lapsed({}) === false, 'and a missing row is not treated as lapsed');
ok(lapsed({ coords_expire_at: 'not a date' }) === false,
  'an unreadable stamp is left ALONE rather than guessed as expired — never destroy data on a parse failure');

if (!process.env.DATABASE_URL) {
  console.log(`test-google-coord-expiry-db: ${pass} passed, ${fail} failed (pure only — no DATABASE_URL)`);
  process.exit(fail ? 1 : 0);
}

const db = require('../src/db');
const RUN = `${process.pid}${Math.floor(Math.random() * 1000)}`;

const put = (key, row) => db.query(
  `INSERT INTO address_canon_cache (input_key, place_id, formatted, lat, lng, zip, resolved_at, coords_expire_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
   ON CONFLICT (input_key) DO UPDATE SET place_id=EXCLUDED.place_id, formatted=EXCLUDED.formatted,
     lat=EXCLUDED.lat, lng=EXCLUDED.lng, zip=EXCLUDED.zip, resolved_at=EXCLUDED.resolved_at,
     coords_expire_at=EXCLUDED.coords_expire_at`,
  [key, row.place_id, row.formatted, row.lat, row.lng, row.zip,
   row.resolved_at || new Date(), row.coords_expire_at || null]);

const get = async (key) => (await db.query(
  `SELECT * FROM address_canon_cache WHERE input_key=$1`, [key])).rows[0] || null;

(async () => {
  try {
    // The keys are built with the module's OWN normalizer, so the fixture is keyed
    // exactly the way a real lookup would key it — a hand-typed key that merely
    // looks right would make the samePlace assertions below prove nothing.
    const TXT_A = `${RUN} Google Ave, Newark, NJ 07103`;
    const TXT_B = `${RUN} Google Avenue, Newark, New Jersey`;
    const TXT_FRESH = `${RUN} Fresh St, Newark, NJ 07103`;
    const A = AC.inputKey(TXT_A);
    const B = AC.inputKey(TXT_B);
    const O = `osm:${AC.inputKey(`${RUN} Osm Rd, Newark, NJ 07103`)}`;
    const FRESH = AC.inputKey(TXT_FRESH);

    // Two spellings of ONE property, both already resolved to the same place id —
    // exactly what db/124 exists to record — with coordinates past the window.
    const past = new Date(Date.now() - 86400000);
    await put(A, { place_id: `ChIJ-${RUN}`, formatted: '1 Google Ave, Newark, NJ 07103', lat: 40.73, lng: -74.17, zip: '07103', coords_expire_at: past });
    await put(B, { place_id: `ChIJ-${RUN}`, formatted: '1 Google Ave, Newark, NJ 07103', lat: 40.73, lng: -74.17, zip: '07103', coords_expire_at: past });
    // An OSM row with coordinates and NO expiry — must never be touched.
    await put(O, { place_id: `osm:${RUN}`, formatted: '2 Osm Rd, Newark, NJ 07103', lat: 40.74, lng: -74.18, zip: '07103', coords_expire_at: null });
    // A Google row still inside its window.
    await put(FRESH, { place_id: `ChIJfresh-${RUN}`, formatted: '3 Fresh St, Newark, NJ 07103', lat: 40.75, lng: -74.19, zip: '07103', coords_expire_at: new Date(Date.now() + 86400000) });

    // =====================================================================
    // 1. THE SWEEP
    // =====================================================================
    /* DRAIN, DON'T TAKE ONE CAPPED PASS. `expireGoogleCoordsOnce` is a GLOBAL
       sweep with a row LIMIT and no ORDER BY, so on a re-used database the rows
       seeded above are simply not in the batch it happens to read: the sweep
       reports a big `expired` count, every assertion about OUR rows fails, and
       nothing is wrong with the sweep. It is self-draining (a cleared row has a
       NULL lat and drops out of its own queue), so we loop until a pass clears
       nothing. Draining also makes section 6's cap assertions honest — they
       measure a table with nothing else left to expire. */
    const drain = async () => {
      const tot = { expired: 0, passes: 0, stuck: false, error: null };
      for (let i = 0; i < 60; i++) {
        const p = await AC.expireGoogleCoordsOnce({ limit: 1000 });
        tot.passes++;
        tot.expired += p.expired || 0;
        if (p.error) { tot.error = p.error; return tot; }
        if (!p.expired) return tot;
      }
      tot.stuck = true;
      return tot;
    };

    const r1 = await drain();
    ok(!r1.error && !r1.stuck && r1.expired >= 2, `the sweep clears the lapsed Google rows (${JSON.stringify(r1)})`);

    const a = await get(A);
    ok(a && a.place_id === `ChIJ-${RUN}`,
      'THE PLACE ID IS KEPT — this is what samePlace compares, and the whole feature rides on it');
    ok(a && a.lat === null && a.lng === null && a.formatted === null && a.zip === null,
      'and only the licensed-window fields are dropped');
    ok(a && a.resolved_at != null, 'the row itself stays, with its history');

    const o = await get(O);
    ok(o && o.lat != null && o.formatted != null,
      'AN OSM ROW IS UNTOUCHED — its licence permits keeping the result permanently');

    const f = await get(FRESH);
    ok(f && f.lat != null, 'a Google row still inside its window is untouched');

    // =====================================================================
    // 2. THE MATCHING FEATURE STILL WORKS, WITH NO COORDINATES AND NO LOOKUP
    // =====================================================================
    // Both spellings kept their place id, so the answer comes straight out of the
    // cache. There is no Google key in this environment, so if it needed a live
    // call this would answer null instead of true — which is the proof.
    const same = await AC.samePlace(TXT_A, TXT_B);
    ok(same === true,
      'TWO SPELLINGS OF ONE PROPERTY STILL MATCH after the sweep — from cache, with no coordinates and no API call');

    const diff = await AC.samePlace(TXT_A, TXT_FRESH);
    ok(diff === false, 'and two different properties still do not match');

    // =====================================================================
    // 3. IDEMPOTENT AND SELF-DRAINING
    // =====================================================================
    const r2 = await AC.expireGoogleCoordsOnce({ limit: 1000 });
    ok(!r2.error, 'running it again is safe');
    const aAgain = await get(A);
    ok(aAgain && aAgain.place_id === `ChIJ-${RUN}` && aAgain.lat === null,
      'and changes nothing — a swept row drops out of the queue it rides');

    // =====================================================================
    // 4. IDENTITY IS NEVER REWRITTEN, EVEN BY A REFRESH
    // =====================================================================
    await AC.cacheRefreshCoords(A, { place_id: 'ChIJ-SOMEONE-ELSE', formatted: 'Wrong Pl', lat: 1, lng: 2, zip: '99999' });
    const aStill = await get(A);
    ok(aStill && aStill.place_id === `ChIJ-${RUN}` && aStill.lat === null,
      'A PROVIDER THAT NAMES A DIFFERENT PLACE CHANGES NOTHING — a resolved identity is immutable, or every past comparison would silently re-point');

    await AC.cacheRefreshCoords(A, { place_id: `ChIJ-${RUN}`, formatted: '1 Google Ave, Newark, NJ 07103', lat: 40.73, lng: -74.17, zip: '07103' });
    const aFilled = await get(A);
    ok(aFilled && Number(aFilled.lat) === 40.73 && aFilled.coords_expire_at != null,
      'while the SAME place refills its coordinates and starts a fresh 30-day window');
    ok(aFilled && AC.coordsLapsed(aFilled) === false, 'which has not lapsed');

    // =====================================================================
    // 5. THE BACK-DATE COVERS ROWS THAT PREDATE THE COLUMN
    // =====================================================================
    const LEGACY = AC.inputKey(`${RUN} Legacy St, Newark, NJ 07103`);
    const LEGACY_OSM = `osm:${AC.inputKey(`${RUN} Legacy Rd, Newark, NJ 07103`)}`;
    await db.query(
      `INSERT INTO address_canon_cache (input_key, place_id, formatted, lat, lng, zip, resolved_at, coords_expire_at)
       VALUES ($1,$2,'4 Legacy St',40.76,-74.20,'07103', now() - interval '400 days', NULL),
              ($3,$4,'5 Legacy Rd',40.77,-74.21,'07103', now() - interval '400 days', NULL)`,
      [LEGACY, `ChIJlegacy-${RUN}`, LEGACY_OSM, `osm:legacy-${RUN}`]);

    // Re-run the migration's own statement, which is what a boot does.
    await db.query(
      `UPDATE address_canon_cache
          SET coords_expire_at = resolved_at + INTERVAL '30 days'
        WHERE coords_expire_at IS NULL AND place_id IS NOT NULL
          AND place_id NOT LIKE 'osm:%' AND input_key NOT LIKE 'osm:%'`);

    const leg = await get(LEGACY);
    ok(leg && leg.coords_expire_at != null && AC.coordsLapsed(leg) === true,
      'a Google row that predates the column is given the expiry it should always have had — in the past');
    const legOsm = await get(LEGACY_OSM);
    ok(legOsm && legOsm.coords_expire_at === null,
      'and an OSM row is left with none — it never expires');

    // Drained, not one pass: the back-date above just gave EVERY Google row in
    // the table an expiry in the past, so on a re-used database one capped pass
    // may never reach this row.
    await drain();
    const legAfter = await get(LEGACY);
    ok(legAfter && legAfter.lat === null && legAfter.place_id === `ChIJlegacy-${RUN}`,
      'so the first sweep clears it — which IS the compliance action — while keeping its identity');
    const legOsmAfter = await get(LEGACY_OSM);
    ok(legOsmAfter && legOsmAfter.lat != null, 'and the OSM row still has its coordinates');

    // =====================================================================
    // 6. THE BOUND IS REAL
    // =====================================================================
    for (let i = 0; i < 5; i++) {
      await put(AC.inputKey(`${RUN} Bulk ${i} St, Newark, NJ`), {
        place_id: `ChIJbulk-${RUN}-${i}`, formatted: `${i} Bulk St`, lat: 40.7 + i / 1000, lng: -74.1, zip: '07103',
        coords_expire_at: past,
      });
    }
    const capped = await AC.expireGoogleCoordsOnce({ limit: 2 });
    ok(capped.expired === 2, `it clears at most what it was asked to (${capped.expired})`);
    const rest = await AC.expireGoogleCoordsOnce({ limit: 100 });
    ok(rest.expired === 3, 'and the next pass picks up the rest — self-draining, not lost');

    console.log(`test-google-coord-expiry-db: ${pass} passed, ${fail} failed`);
  } catch (e) {
    fail++;
    console.log('FAIL threw:', (e && e.stack) || e);
    console.log(`test-google-coord-expiry-db: ${pass} passed, ${fail} failed`);
  } finally {
    try { await db.pool.end(); } catch (_) { /* already closed */ }
  }
  process.exit(fail ? 1 : 0);
})();
