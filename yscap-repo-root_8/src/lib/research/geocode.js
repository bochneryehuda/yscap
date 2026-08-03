'use strict';
/**
 * WHERE IS THIS PROPERTY? — coordinates for the research warehouse (db/412).
 *
 * The owner asked for "a Google Maps system that tells us how far each comparable
 * in the database is" from a subject property. The distance arithmetic was already
 * right (`search.js`); what was missing was the coordinates to do it on.
 *
 * ─── WHY NOT GOOGLE ────────────────────────────────────────────────────────────
 * This is a permanent database of properties, and it is looked up once per property
 * and then read forever. Google Maps Platform's terms let you keep a `place_id`
 * indefinitely but cap a stored latitude/longitude at 30 consecutive days unless
 * the cache is isolated to a single end user — which a shared comp warehouse is
 * not. Complying would mean re-geocoding the whole warehouse every month, forever,
 * which turns a one-off cost into a permanent monthly bill for a number that has
 * not moved. The full comparison, with the terms quoted, is in
 * docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md.
 *
 * So this module uses TWO free, keyless services and stores the answer permanently:
 *
 *   1. THE US CENSUS BUREAU GEOCODER — a US federal service, no account, no key,
 *      no card, and no term restricting what you do with the answer. It covers US
 *      addresses only, which is every property this lender will ever see.
 *   2. OpenStreetMap NOMINATIM — the same keyless fallback `lib/address-canon`
 *      already uses in this repo, for the addresses Census cannot place.
 *
 * ─── THREE RULES ───────────────────────────────────────────────────────────────
 *
 *  1. ONLY AN EXACT ADDRESS MATCH IS STORED. A street-level or town-level answer
 *     puts every house on one road — or in one town — at the same point, and a
 *     quarter-mile radius search over those is worse than no radius search at all,
 *     because it looks like it worked. A vague answer is recorded as an ATTEMPT
 *     with no coordinate.
 *
 *  2. IT NEVER THROWS AND NEVER BLOCKS. This runs as a bounded background sweep. A
 *     service being down means fewer properties placed today, never a failed boot,
 *     a failed import or a slow page.
 *
 *  3. IT WRITES ONLY THE `geo_*` COLUMNS. `latitude`/`longitude` are the
 *     appraiser's own figures and are re-derived from the reports on every ingest;
 *     writing a geocode there would be silently erased (db/412 explains).
 */
const https = require('https');
const { URL } = require('url');
// The one place that decides whether a provider's answer is still about OUR
// address — written after the 2026-07-28 Piscataway/Plainfield incident.
const ADDR = require('../address');

const UA = 'PILOT-Research/1.0 (YS Capital; property research warehouse)';

// Both services are courtesy services with no contract behind them, so the sweep is
// paced and bounded rather than run flat out.
const REQ_TIMEOUT_MS = 12000;
const PACE_MS = Number(process.env.RESEARCH_GEOCODE_PACE_MS || 350);
const MAX_ATTEMPTS = 3;   // after three tries an address is left alone

const txt = (v) => { const s = v == null ? '' : String(v).trim(); return s === '' ? null : s; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A bounded GET returning parsed JSON, or null. Never throws. */
function getJson(url) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      const u = new URL(url);
      req = https.get({
        hostname: u.hostname, path: u.pathname + u.search, port: u.port || 443,
        headers: { 'user-agent': UA, accept: 'application/json' },
        timeout: REQ_TIMEOUT_MS,
      }, (res) => {
        // A redirect, a 403, a 500 — all the same to us: no answer today.
        if (res.statusCode !== 200) { res.resume(); return finish(null); }
        let body = '';
        res.setEncoding('utf8');
        // A runaway response must not eat the process.
        res.on('data', (c) => { body += c; if (body.length > 4e6) { req.destroy(); finish(null); } });
        res.on('end', () => { try { finish(JSON.parse(body)); } catch (_) { finish(null); } });
      });
      req.on('timeout', () => { req.destroy(); finish(null); });
      req.on('error', () => finish(null));
    } catch (_) { finish(null); }
  });
}

const inUS = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng)
  && lat >= 17 && lat <= 72 && lng >= -180 && lng <= -64;   // 50 states + PR, generously

/**
 * THE US CENSUS BUREAU GEOCODER.
 *
 * `.../geocoder/locations/onelineaddress?address=…&benchmark=Public_AR_Current&format=json`
 * answers `{result:{addressMatches:[{coordinates:{x,y}, matchedAddress, tigerLine…}]}}`,
 * where **x is longitude and y is latitude** — the opposite order to how everyone
 * says it out loud, and the single easiest thing to get backwards here.
 *
 * Every match this service returns is an address-level (rooftop-interpolated)
 * match; it simply returns NOTHING when it cannot place a house number, which is
 * exactly the behaviour rule 1 wants. There is no partial-match tier to filter out.
 */
async function census(address) {
  const url = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress'
    + `?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`;
  const j = await getJson(url);
  const m = j && j.result && Array.isArray(j.result.addressMatches) ? j.result.addressMatches[0] : null;
  if (!m || !m.coordinates) return null;
  const lat = Number(m.coordinates.y), lng = Number(m.coordinates.x);
  if (!inUS(lat, lng)) return null;
  return { lat, lng, source: 'census', precision: 'address', matched: txt(m.matchedAddress) };
}

/**
 * OpenStreetMap NOMINATIM — the fallback, and the one that needs the precision
 * guard. Nominatim answers happily with the ROAD when it cannot find the house
 * number (`addresstype:"road"`, no `address.house_number`), which is the exact
 * failure `lib/address-canon` was already bitten by: a road-level answer took over
 * a real address and put a file on a different street. So a match with no house
 * number is refused here too, rather than stored as if it were the house.
 */
// OSM's public service has a HARD published limit of one request per second, and
// exceeding it is a policy breach that gets a user agent blocked — for everyone
// using it, not just this sweep. The main pace (350ms) is set for Census, which has
// no such limit, so the OSM call has to hold its own floor. This is a module-level
// clock on purpose: it is the process's shared budget, not one sweep's.
let lastOsmAt = 0;
const OSM_MIN_GAP_MS = 1100;

async function osm(address) {
  const wait = OSM_MIN_GAP_MS - (Date.now() - lastOsmAt);
  if (wait > 0) await sleep(wait);
  lastOsmAt = Date.now();
  const url = 'https://nominatim.openstreetmap.org/search'
    + `?q=${encodeURIComponent(address)}&format=json&addressdetails=1&limit=1&countrycodes=us`;
  const j = await getJson(url);
  const m = Array.isArray(j) ? j[0] : null;
  if (!m) return null;
  const houseNo = m.address && (m.address.house_number || m.address.housenumber);
  if (!houseNo) return null;                       // a road is not a property
  const lat = Number(m.lat), lng = Number(m.lon);
  if (!inUS(lat, lng)) return null;
  return { lat, lng, source: 'osm', precision: 'address', matched: txt(m.display_name) };
}

const PROVIDERS = [census, osm];

/** The one-line address the services are asked about. */
function addressLine(p) {
  const street = txt(p.street) || txt(p.display_address);
  if (!street) return null;
  const locality = txt(p.city) || null;
  const state = txt(p.state) || null;
  const zip = txt(p.zip) || null;
  // Both services want "street, city, ST zip". The UNIT is deliberately left off:
  // no geocoder places an apartment, and including it is a common cause of a match
  // failing outright. Every unit of one building sharing a coordinate is correct —
  // they ARE at the same place — while still being separate properties everywhere
  // else, because the dedupe key keeps the unit.
  // A STATE IS NOT A PLACE. "26 S 10th St, NJ" has a house number and a state and
  // still names nothing — there are dozens of them — and both services will happily
  // return the first one they find. A town or a ZIP is the minimum.
  if (!locality && !zip) return null;
  const tail = [locality, [state, zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  if (!tail) return null;
  return `${street}, ${tail}`;
}

/**
 * Place ONE property. Returns the coordinate, or null with a reason. Never throws.
 * Exported so a single property can be placed on demand from a screen.
 */
async function geocodeProperty(p, { providers = PROVIDERS } = {}) {
  const line = addressLine(p);
  if (!line) return { ok: false, why: 'the address is not complete enough to look up' };
  let rejected = null;
  for (const provider of providers) {
    let hit = null;
    try { hit = await provider(line); } catch (_) { hit = null; }
    if (!hit) continue;
    // A GEOCODER ANSWERS A DIFFERENT HOUSE RATHER THAN SAY IT CANNOT FIND YOURS.
    // Verified live: the Census geocoder answers "26 S 10th St, Piscataway, NJ
    // 08854" with "26 10TH ST, PISCATAWAY, NJ, 08854" — the directional dropped,
    // `precision: 'address'`, and the IDENTICAL coordinate it returns for "26
    // 10th St", which is a different street. Google normalises the same address
    // to a Plainfield ZIP: a real, rooftop-precise match on a house ~130 m away
    // across a municipal line where the numbering runs on.
    //
    // `address.geocodeRewriteIsSafe` was written after exactly that incident
    // (2026-07-28) and refuses a provider answer that drops or moves the house
    // number, disagrees on a ZIP we already hold, or loses a leading directional.
    // Every provider here already RETURNS its matched string; nothing was reading
    // it, and the coordinates were adopted regardless. A confident wrong pin is
    // worse than no pin — it puts a property on the wrong street and every
    // distance measured from it is wrong without looking wrong.
    if (hit.matched && !ADDR.geocodeRewriteIsSafe(line, hit.matched)) {
      rejected = rejected || { source: hit.source, matched: hit.matched };
      continue;
    }
    return { ok: true, ...hit, query: line };
  }
  if (rejected) {
    return { ok: false, query: line, rejected: true, matched: rejected.matched, source: rejected.source,
      why: `the closest thing ${rejected.source} could find was "${rejected.matched}", which is a different `
        + 'property — a wrong pin is worse than none, so this one is left unplaced' };
  }
  return { ok: false, why: 'no service could place that address', query: line };
}

/**
 * PLACE THE PROPERTIES WE HAVE NOT PLACED YET — bounded, resumable, self-draining.
 *
 * Ordered by how many observations a property carries, so the properties the search
 * actually returns are placed first: with tens of thousands of rows and a paced
 * sweep this runs for days, and it matters that day one is useful.
 *
 * Self-draining because every row it looks at is STAMPED whether or not it was
 * placed — otherwise the same unplaceable addresses would be re-asked on every boot
 * forever and the sweep would never reach the rest.
 */
/**
 * WHO IS STILL OWED A ROOFTOP LOOKUP — ONE DEFINITION, because the sweep and the
 * two counters that report on it drifted apart the moment the queue widened.
 *
 * A derived position is still a gap: `place-subjects` fills `geo_latitude` from
 * the comparables around a property (median 17 ft, and still an ESTIMATE with a
 * quarter-mile refusal ceiling), so a plain `geo_latitude IS NULL` queue removed
 * all 90 of those properties from rooftop geocoding FOREVER — an estimate
 * permanently displacing a measurement, the exact inversion of this module's own
 * rule. The queue was widened to re-offer them and the counters were not, so the
 * boot log and the admin panel reported the sweep 88 rows further along than it
 * was, and could print "remaining: 0" with 90 rows still being re-asked. The
 * predicate now lives in one place and every reader uses it. `$1` is
 * `MAX_ATTEMPTS`, so a caller must bind it in that position.
 */
const QUEUE_SQL = `(geo_latitude IS NULL OR geo_source = '${require('./place-subjects').SOURCE}')
          AND geo_attempts < $1
          AND street IS NOT NULL`;

async function backfillGeocodes(db, { limit = 100, onProgress = null } = {}) {
  const out = { looked: 0, placed: 0, unplaceable: 0, wrongProperty: 0, errors: 0, remaining: 0 };
  if (process.env.RESEARCH_GEOCODE_DISABLED === '1') { out.disabled = true; return out; }
  try {
    const rows = (await db.query(
      `SELECT id, street, unit, city, state, zip, display_address, observation_count
         FROM properties
        WHERE ${QUEUE_SQL}
        -- A PROPERTY WITH NO POSITION AT ALL GOES FIRST. Ordering on
        -- geo_attempted_at alone inverted the priority: place-subjects never
        -- stamps an attempt, so every trilaterated row -- which already HAS a
        -- usable position -- sorted ahead of every genuinely unplaced one that
        -- had been tried before. On a realistic later boot that put 89
        -- already-placed rows in the first 120, spending the courtesy-paced
        -- lookup budget re-checking properties we can already find while
        -- hundreds with nothing waited behind them.
        ORDER BY (geo_latitude IS NOT NULL), geo_attempted_at NULLS FIRST, observation_count DESC
        LIMIT $2`, [MAX_ATTEMPTS, Math.min(2000, Math.max(1, limit))])).rows;

    // A DERIVED POSITION IS STILL A GAP. `place-subjects` fills `geo_latitude`
    // from the comparables around a property (median 17 ft, and still an
    // ESTIMATE with a quarter-mile refusal ceiling), so a plain
    // `geo_latitude IS NULL` queue removed all 90 of those properties from
    // rooftop geocoding FOREVER — an estimate permanently displacing a
    // measurement, which is the exact inversion of this module's own rule.
    // They are re-offered here, and the UPDATE below overwrites: a real
    // address match beats a derived one, every time.
    for (const p of rows) {
      out.looked++;
      let hit = null;
      try { hit = await geocodeProperty(p); } catch (_) { hit = null; }
      try {
        if (hit && hit.ok) {
          await db.query(
            `UPDATE properties
                SET geo_latitude = $2, geo_longitude = $3, geo_source = $4, geo_precision = $5,
                    geo_at = now(), geo_attempted_at = now(), geo_attempts = geo_attempts + 1,
                    updated_at = now()
              WHERE id = $1`,
            [p.id, hit.lat, hit.lng, hit.source, hit.precision]);
          out.placed++;
        } else {
          await db.query(
            `UPDATE properties SET geo_attempted_at = now(), geo_attempts = geo_attempts + 1 WHERE id = $1`,
            [p.id]);
          out.unplaceable++;
          // Counted separately: "nothing could place this" and "the only thing on
          // offer was a different house" are different problems, and a climbing
          // wrongProperty count means a whole town's addresses need looking at.
          if (hit && hit.rejected) out.wrongProperty++;
        }
      } catch (_) { out.errors++; }
      if (onProgress) { try { onProgress(out); } catch (_) { /* a hook never breaks the sweep */ } }
      if (PACE_MS > 0) await sleep(PACE_MS);
    }

    // THE SAME PREDICATE THE QUEUE USES, or this reports the sweep as further
    // along than it is and can say "remaining: 0" while rows are still queued.
    out.remaining = (await db.query(
      `SELECT count(*)::int n FROM properties WHERE ${QUEUE_SQL}`, [MAX_ATTEMPTS])).rows[0].n;
  } catch (e) {
    out.error = (e && e.message) || String(e);
  }
  return out;
}

/**
 * How far along the placing is — for the screen and for the admin panel.
 *
 * `looked_up` counts what a GEOCODER placed, and `trilaterated` is reported
 * beside it rather than folded into it: a position worked out from the
 * comparables around a house is an estimate that is still owed a rooftop
 * lookup, so counting it as looked-up would report the sweep as finished on
 * rows it is still re-asking. `still_to_do` uses the queue's own predicate for
 * the same reason.
 */
async function geocodeStatus(db) {
  try {
    const r = (await db.query(
      `SELECT count(*)::int                                                       AS properties,
              count(*) FILTER (WHERE eff_latitude IS NOT NULL)::int               AS placed,
              count(*) FILTER (WHERE geo_latitude IS NOT NULL
                               AND geo_source IS DISTINCT FROM $2)::int           AS looked_up,
              count(*) FILTER (WHERE geo_source = $2)::int                        AS trilaterated,
              count(*) FILTER (WHERE geo_latitude IS NULL AND latitude IS NOT NULL)::int AS from_appraisal,
              count(*) FILTER (WHERE geo_latitude IS NULL AND geo_attempts >= $1)::int   AS gave_up,
              count(*) FILTER (WHERE ${QUEUE_SQL})::int                           AS still_to_do
         FROM properties`, [MAX_ATTEMPTS, require('./place-subjects').SOURCE])).rows[0];
    return r;
  } catch (_) { return null; }
}

module.exports = {
  geocodeProperty, backfillGeocodes, geocodeStatus,
  _internals: { addressLine, census, osm, inUS, MAX_ATTEMPTS },
};
