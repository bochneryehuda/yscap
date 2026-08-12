'use strict';

/**
 * Canonical address resolution via Google Geocoding (owner-directed
 * 2026-07-15: formatting variants of the SAME property — "Ave"/"Avenue",
 * "Unit 114"/"114", "Village of Spring Valley"/"Spring Valley" — must compare
 * as the same). Each distinct input resolves ONCE to a stable `place_id`
 * (cached forever in address_canon_cache, db/124); comparisons after that are
 * cache hits. Fully degradable: no GOOGLE_PLACES_API_KEY / network error /
 * unresolvable input → null, and every caller falls back to the existing
 * heuristics (same-street comparator, normalized identity) — canonicalization
 * only ever ADDS matches, it never blocks anything.
 */
const db = require('../db');
const cfg = require('../config');
const ADDR = require('./address');   // canonical one-line formatting (pure)

// An OSM-sourced row is keyed and identified with this prefix so it can never be
// confused with a Google place_id — which is also what decides whether its
// coordinates expire (db/413).
const OSM_PREFIX = 'osm:';
const inputKey = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

// A match that resolves only to a STREET (or coarser) is not this property.
// `route` is the dangerous one and was previously accepted: Google answers a
// house number it cannot place with the road it sits on, and that road carries
// its OWN postcode — which is how "1727 S 2nd St, Piscataway, NJ 08854" became
// "2nd St, Piscataway, NJ 07063" (see address.geocodeRewriteIsSafe). It matters
// twice over here, because `canonicalize` also backs `samePlace`: a road-level
// place_id would make every house on one street compare as the SAME property.
const IMPRECISE_TYPES = new Set([
  'route', 'intersection', 'postal_code', 'postal_code_prefix',
  'neighborhood', 'sublocality', 'locality', 'administrative_area_level_1',
  'administrative_area_level_2', 'administrative_area_level_3', 'country',
]);

// Pure parser (unit-tested): Google Geocoding JSON → our cache row shape.
function parseGeocodeResult(json) {
  const r = json && Array.isArray(json.results) ? json.results[0] : null;
  if (!r || !r.place_id) return null;
  // Reject imprecise matches: a street address must geocode to the ADDRESS, never
  // to the road it sits on nor a locality/ZIP centroid.
  const types = r.types || [];
  if (types.some((t) => IMPRECISE_TYPES.has(t))) return null;
  const comp = (r.address_components || []).find((c) => (c.types || []).includes('postal_code'));
  const loc = r.geometry && r.geometry.location;
  return {
    place_id: r.place_id,
    formatted: r.formatted_address || null,
    lat: loc && Number.isFinite(Number(loc.lat)) ? Number(loc.lat) : null,
    lng: loc && Number.isFinite(Number(loc.lng)) ? Number(loc.lng) : null,
    zip: comp ? comp.long_name : null,
  };
}

// ---------------------------------------------------------------------------
// NEVER CACHE A TRANSIENT FAILURE (owner-reported 2026-07-28: a subject property
// address typed in PILOT that never reached the ClickUp card).
//
// This cache is PERMANENT by design, and a row with a NULL place_id means "we
// asked, and there is no such place" — every later lookup short-circuits on it.
// Both providers used to write that row for ANY answer that wasn't a match,
// INCLUDING answers that were never about the address at all: an OSM 429/403
// (Nominatim rate-limits hard), or a Google `OVER_QUERY_LIMIT` / `REQUEST_DENIED`
// / `UNKNOWN_ERROR` — all of which arrive as an HTTP 200 body, not an exception.
// One such blip marked a perfectly real property UNRESOLVABLE FOREVER, and
// because a ClickUp `location` field REQUIRES coordinates (mapper.addressField
// correctly refuses to write one without them), the subject property and the
// borrower's home address could then never reach the card again — no matter how
// many times the file was re-pushed. The catch below already knew the rule
// ("network failure: DON'T cache — retry later"); it just never covered a
// failure that arrives as a RESPONSE instead of a thrown error.
//
// So: only a DEFINITIVE provider answer ("we looked; there is no such place") is
// cached as unresolvable, and even that is re-checked after NEGATIVE_TTL_DAYS —
// new construction does get added to the map. A RESOLVED row is never rewritten:
// `samePlace` compares place_id identity, so a resolved place_id stays stable
// forever, exactly as before.
// ---------------------------------------------------------------------------
const NEGATIVE_TTL_DAYS = Math.max(1, parseInt(process.env.GEOCODE_NEGATIVE_TTL_DAYS || '30', 10) || 30);

/** Google Geocoding: was that answer about the ADDRESS, or about our quota/key? */
function googleDefinitive(httpOk, json) {
  if (!httpOk) return false;                        // 4xx/5xx — the provider, not the address
  const s = json && json.status;
  return s === 'OK' || s === 'ZERO_RESULTS';        // anything else = quota / denied / unknown
}
/** Nominatim: a results ARRAY on a 200 is a real answer (empty = no such place). */
function osmDefinitive(httpOk, json) { return !!httpOk && Array.isArray(json); }

/** Is a cached "unresolvable" row old enough to ask the provider again? */
function negativeExpired(resolvedAt, nowMs = Date.now()) {
  const t = Date.parse(resolvedAt instanceof Date ? resolvedAt.toISOString() : String(resolvedAt || ''));
  if (!Number.isFinite(t)) return true;             // no timestamp we can trust → re-check
  return (nowMs - t) > NEGATIVE_TTL_DAYS * 24 * 3600 * 1000;
}

/**
 * Cache read. Three distinct answers, which is the whole point:
 *   row       — resolved; use it (permanent)
 *   null      — cached "unresolvable" and still fresh; the caller returns null
 *   undefined — nothing usable cached; the caller asks the provider
 */
async function cacheGet(key) {
  try {
    const hit = (await db.query(
      `SELECT place_id, formatted, lat, lng, zip, resolved_at, coords_expire_at
         FROM address_canon_cache WHERE input_key=$1`,
      [key])).rows[0];
    if (!hit) return undefined;
    if (hit.place_id) return hit;
    return negativeExpired(hit.resolved_at) ? undefined : null;
  } catch (_) { return undefined; }   // cache is an optimization
}

/**
 * Cache write. A RESOLVED row is immutable (place_id identity is what samePlace
 * compares); a negative row may be refreshed, or upgraded to a real resolution.
 */
async function cachePut(key, parsed) {
  try {
    await db.query(
      `INSERT INTO address_canon_cache (input_key, place_id, formatted, lat, lng, zip,
                                        resolved_at, coords_expire_at)
       VALUES ($1,$2,$3,$4,$5,$6, now(), $7)
       ON CONFLICT (input_key) DO UPDATE
          SET place_id=EXCLUDED.place_id, formatted=EXCLUDED.formatted,
              lat=EXCLUDED.lat, lng=EXCLUDED.lng, zip=EXCLUDED.zip, resolved_at=now(),
              coords_expire_at=EXCLUDED.coords_expire_at
        WHERE address_canon_cache.place_id IS NULL`,
      [key, parsed && parsed.place_id, parsed && parsed.formatted,
       parsed && parsed.lat, parsed && parsed.lng, parsed && parsed.zip,
       coordsExpiryFor(key, parsed)]);
  } catch (_) { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// GOOGLE COORDINATES EXPIRE; THE PLACE ID DOES NOT (db/413)
// ---------------------------------------------------------------------------
/**
 * Google Maps Platform permits keeping a `place_id` indefinitely and caps a stored
 * latitude/longitude at 30 consecutive calendar days. OpenStreetMap's licence has
 * no such cap. So the expiry is decided by WHICH SERVICE ANSWERED, and that is read
 * off the row's own key/id rather than passed in — a caller that forgot to say
 * would otherwise silently create a row we may not keep.
 *
 * Returns a Date for a Google row, or null for an OSM row (never expires) and for
 * an unresolvable row (no coordinates to expire). PURE.
 */
const GOOGLE_COORD_TTL_DAYS = Math.max(1, parseInt(process.env.GOOGLE_COORD_TTL_DAYS || '30', 10) || 30);
function coordsExpiryFor(key, parsed) {
  if (!parsed || !parsed.place_id) return null;
  if (String(key || '').startsWith(OSM_PREFIX) || String(parsed.place_id).startsWith(OSM_PREFIX)) return null;
  return new Date(Date.now() + GOOGLE_COORD_TTL_DAYS * 24 * 3600 * 1000);
}

/** Have this row's coordinates passed the window we are licensed to hold them for? */
function coordsLapsed(row, nowMs = Date.now()) {
  if (!row || !row.coords_expire_at) return false;      // OSM, or never stamped
  const t = Date.parse(row.coords_expire_at instanceof Date
    ? row.coords_expire_at.toISOString() : String(row.coords_expire_at));
  return Number.isFinite(t) ? nowMs > t : false;
}

/**
 * Refresh the COORDINATES on a row whose identity we already hold.
 *
 * Deliberately separate from `cachePut`, whose whole contract is that a resolved
 * row is immutable — `place_id` identity is what `samePlace` compares, and letting
 * a later lookup rewrite it would silently re-point every past comparison. This
 * updates only the licensed-window fields, and ONLY where the place id still
 * matches, so a provider that answers differently today changes nothing.
 */
async function cacheRefreshCoords(key, parsed) {
  if (!parsed || !parsed.place_id) return;
  try {
    await db.query(
      `UPDATE address_canon_cache
          SET formatted=$3, lat=$4, lng=$5, zip=$6, coords_expire_at=$7, resolved_at=now()
        WHERE input_key=$1 AND place_id=$2`,
      [key, parsed.place_id, parsed.formatted, parsed.lat, parsed.lng, parsed.zip,
       coordsExpiryFor(key, parsed)]);
  } catch (_) { /* best-effort */ }
}

/**
 * BLANK THE COORDINATES WE ARE NO LONGER LICENSED TO HOLD — bounded, idempotent,
 * never throws. Keeps `place_id` and `resolved_at`, so `samePlace()` and the whole
 * address-matching feature this table exists for are completely unaffected: no
 * extra API call, no behaviour change, nothing slower.
 *
 * Self-draining, because a swept row no longer has a `lat` and drops out of the
 * partial index the query rides.
 */
async function expireGoogleCoordsOnce({ limit = 5000 } = {}) {
  try {
    const r = await db.query(
      `UPDATE address_canon_cache
          SET formatted = NULL, lat = NULL, lng = NULL, zip = NULL
        WHERE input_key IN (
          SELECT input_key FROM address_canon_cache
           WHERE coords_expire_at IS NOT NULL
             AND coords_expire_at < now()
             AND lat IS NOT NULL
           LIMIT $1)`,
      [Math.min(50000, Math.max(1, limit))]);
    return { expired: r.rowCount || 0 };
  } catch (e) { return { expired: 0, error: (e && e.message) || String(e) }; }
}

/** Resolve free text → { place_id, formatted, lat, lng, zip } | null. Cached. */
async function canonicalize(text, { needCoords = false } = {}) {
  const key = inputKey(text);
  if (!key || key.length < 8) return null;
  const cached = await cacheGet(key);
  if (cached !== undefined) {
    if (cached === null) return null;                 // a still-fresh "unresolvable"
    // A RESOLVED ROW STILL PROVES IDENTITY EVEN WITH ITS COORDINATES GONE (db/413).
    // `samePlace` — the reason this cache exists — compares `place_id` and asks for
    // no coordinates, so it is served from cache exactly as before, forever. Only a
    // caller that actually NEEDS coordinates (the ClickUp location push) pays for a
    // fresh lookup, and only when the licensed window has lapsed.
    if (!needCoords || cached.lat != null) return cached;
  }
  // Nothing to re-ask with: hand back whatever we hold rather than pretending the
  // address is unknown. The identity is still good, and the caller's own fallback
  // (the keyless provider in `geocode`) can supply coordinates.
  if (!cfg.googlePlacesKey) return cached === undefined ? null : cached;
  let parsed = null, definitive = false;
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?components=country:US'
      + '&address=' + encodeURIComponent(key) + '&key=' + encodeURIComponent(cfg.googlePlacesKey);
    // Shared-across-processes pacing (lib/api-rate-limit.js, db/482). Its own bucket, far
    // above Nominatim's: this backs the live autocomplete and must not crawl.
    await require('./api-rate-limit').acquire('google_geocode');
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const j = r.ok ? await r.json() : null;
    definitive = googleDefinitive(r.ok, j);
    if (definitive) parsed = parseGeocodeResult(j);
  } catch (_) { return cached && cached.place_id ? cached : null; }   // network failure: DON'T cache — retry later
  // quota / denied / unknown: about US, not the address. A row we already hold is
  // still the truth about the property, so it is returned rather than discarded.
  if (!definitive) return cached && cached.place_id ? cached : null;
  // An already-resolved row keeps its identity: only the licensed-window fields are
  // rewritten, and only if the provider still names the same place.
  if (cached && cached.place_id) await cacheRefreshCoords(key, parsed);
  else await cachePut(key, parsed);
  return parsed;
}

/** Do two free-text addresses refer to the SAME property?
 *  true / false when both resolve; null when either can't be canonicalized
 *  (caller falls back to its heuristic). */
async function samePlace(a, b) {
  const ta = String(a || '').trim(), tb = String(b || '').trim();
  if (!ta || !tb) return null;
  if (inputKey(ta) === inputKey(tb)) return true;
  const [ca, cb] = [await canonicalize(ta), await canonicalize(tb)];
  if (!ca || !cb) return null;
  return ca.place_id === cb.place_id;
}

// ---------------------------------------------------------------------------
// geocode(text) — "give me coordinates for this address, however you can".
//
// Added 2026-07-26 for the ClickUp subject-address sync. A ClickUp `location`
// field REQUIRES real coordinates, and the push resolver was calling a
// `geocode` function that never existed on `lib/address` — so no address ever
// gained coordinates and the subject property + borrower home address were
// silently dropped from every push (the address typed in PILOT never reached
// the card). This is the resolver that call always meant.
//
// Google first (canonicalize above: precise, cached forever, gives the exact
// `formatted_address` string ClickUp's own location picker produces). Without
// GOOGLE_PLACES_API_KEY it falls back to OpenStreetMap Nominatim — the SAME
// keyless provider that already backs the address autocomplete staff type into
// (src/routes/address.js), so this works with zero configuration rather than
// quietly doing nothing. OSM results are cached in the same table under an
// `osm:` key prefix so they can never be confused with a Google `place_id`
// (place_id identity is what samePlace compares).
// ---------------------------------------------------------------------------
// Nominatim asks for at most 1 request/second — for the PROCESS, not per module.
// Four places here call it, and each used to keep its OWN clock, so any two of
// them running together could fire twice inside one second while every one of
// them looked correct on its own. There is one clock now (`lib/osm-gate`).
const osmPolite = require('./osm-gate').osmRun;

/**
 * Pure (unit-tested): one Nominatim match → our cache row shape, or null.
 *
 * PRECISION IS THE WHOLE POINT. Nominatim answers a house number it cannot place
 * with the ROAD — `addresstype: "road"`, no `address.house_number`, and the road's
 * OWN postcode (verified live on the owner's file: "1727 S 2nd St, Piscataway, NJ
 * 08854" → "2nd Street, Piscataway Township, …, 07063"). Such a match is still
 * worth its COORDINATES (the pin lands on the right street, which is what lets the
 * address reach the ClickUp location field at all), but its TEXT is a different
 * address and must never be offered: `formatted` and `zip` are left NULL so no
 * caller — and no permanently-cached row — can adopt them.
 */
function parseOsmResult(m) {
  if (!m) return null;
  const lat = Number(m.lat), lng = Number(m.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const comp = m.address ? ADDR.osmComponentsToAddress(m.address) : null;
  // House-level only, keyed on `house_number` — the one unambiguous signal.
  // (`addresstype` is deliberately NOT trusted: "place" covers a hamlet as well as
  // a house, and without a house_number there is no property address to build —
  // `osmComponentsToAddress` composes line1 from [house_number, road].)
  const houseLevel = !!(m.address && m.address.house_number);
  // NEVER store `display_name` — that raw string ("26, South 10th Street,
  // Williamsburg, Brooklyn, Kings County, New York, 11249, United States") is what
  // leaked onto files and ClickUp cards as the address. Build the mailing form
  // Google/ClickUp show, from the components; fall back to compacting display_name
  // when components are missing.
  const formatted = houseLevel
    ? ((comp && ADDR.canonicalOneLine(comp)) || ADDR.compactFormattedAddress(m.display_name) || null)
    : null;
  return {
    place_id: OSM_PREFIX + (m.osm_id != null ? m.osm_id : m.place_id),
    formatted, lat, lng,
    zip: (houseLevel && comp && comp.zip) || null,
    precision: houseLevel ? 'rooftop' : 'road',
  };
}

async function osmGeocode(text) {
  const key = OSM_PREFIX + inputKey(text);
  const cached = await cacheGet(key);
  if (cached !== undefined) {
    // Compact on READ too: rows cached before the formatting fix below still
    // hold a raw display_name, and a resolved row is permanent.
    // `precision` is DERIVED rather than stored (the table has no such column):
    // after parseOsmResult, a resolved row with no `formatted` IS a road-level
    // match — that is the only way one is now written, and it is also what
    // address-heal leaves behind when it strips a downgraded row. Deriving it here
    // keeps a CACHE HIT behaving exactly like a fresh lookup for callers that check
    // precision (orchestrator.withCoords).
    if (!cached) return null;
    const formatted = ADDR.compactFormattedAddress(cached.formatted) || null;
    return { ...cached, formatted, precision: formatted ? 'rooftop' : 'road' };
  }
  let parsed = null, definitive = false;
  try {
    // addressdetails=1 so we can build the MAILING form from real components
    // rather than shortening Nominatim's display_name after the fact.
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&addressdetails=1&q='
      + encodeURIComponent(text);
    const r = await osmPolite(() => fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': `YSCapitalPortal/1.0 (${cfg.osmContact || 'admin@yscapgroup.com'})`, accept: 'application/json' },
    }));
    const j = (r && r.ok) ? await r.json() : null;
    definitive = osmDefinitive(r && r.ok, j);
    // Only a DEFINITIVE answer is parsed (and therefore cached). parseOsmResult
    // then decides PRECISION — a road-level match keeps its coordinates but offers
    // no text, so a downgrade can never be cached as this property's address.
    if (definitive) parsed = parseOsmResult(j[0] || null);
  } catch (_) { return null; }   // network failure: DON'T cache — retry later
  // A 429 / 403 / 5xx is Nominatim throttling US, not a statement about the
  // property. Caching it would blank this address on the ClickUp card forever.
  if (!definitive) return null;
  await cachePut(key, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// resolveCounty(input) — the COUNTY of a property, however we can get it.
//
// Class Valuation REQUIRES a county on every order ("The County field is
// required"), and a mailing address never carries one — county is not part of a
// mailing one-line. So the order desk works it out from the address: geocode the
// property and read the county the provider states (Google's
// administrative_area_level_2 is the US county; OSM's address.county), then cache
// it so a second order of the same property is a single DB read.
//
// The county is stored under a `county:`-PREFIXED input_key, deliberately: a
// county-only row carries no place_id, and a NULL-place_id row under a PLAIN key
// would be read by cacheGet() as "we asked, there is no such place" and would
// silently blank that address for canonicalize()/samePlace forever. The prefix
// keeps county rows in their own keyspace that the place_id resolver never reads.
//
// Best-effort throughout: no key / network error / unresolvable → null, and the
// caller (order-build) then blocks the order with a plain reason rather than let
// Class 400 the whole thing.
// ---------------------------------------------------------------------------

// A bare county string from a raw provider value, or null. We send whatever the
// vendor names ("Kings County" / "Los Angeles County") — Class only requires a
// non-empty county, and the full "<Name> County" form is the safe, unambiguous one.
function countyText(v) { const s = String(v == null ? '' : v).trim(); return s || null; }

// Pure (unit-tested): county from a Google Geocoding response. In the US the
// county is administrative_area_level_2; a match with none (a few independent
// cities) yields null rather than a guess.
function googleCounty(json) {
  const r = json && Array.isArray(json.results) ? json.results[0] : null;
  if (!r) return null;
  const c = (r.address_components || []).find((x) => (x.types || []).includes('administrative_area_level_2'));
  return c ? countyText(c.long_name) : null;
}
// Pure (unit-tested): county from a Nominatim match. Most states file it under
// `county`; a few (Louisiana parishes, Alaska boroughs, and states where the
// county sits a level up) surface it as `state_district`.
function osmCounty(match) {
  const a = match && match.address;
  return a ? countyText(a.county || a.state_district) : null;
}

// A geocodable one-line from either a plain string or a property-parts object
// ({ addressLine|line1|street, city, state, postalCode|zip }). Line 2 / unit is
// deliberately left off — a unit suffix makes some providers return no match, and
// the county is the same for the whole building.
function countyQueryFrom(input) {
  if (typeof input === 'string') return input;
  const a = (input && typeof input === 'object') ? input : {};
  const line1 = a.addressLine || a.line1 || a.street || '';
  return [line1, a.city, a.state, a.postalCode || a.zip]
    .map((x) => String(x == null ? '' : x).trim()).filter(Boolean).join(', ');
}

async function resolveCounty(input) {
  const t = String(countyQueryFrom(input) || '').trim();
  if (t.length < 8) return null;
  const key = 'county:' + inputKey(t);
  try {
    const hit = (await db.query(`SELECT county FROM address_canon_cache WHERE input_key=$1`, [key])).rows[0];
    if (hit && hit.county) return hit.county;
  } catch (_) { /* cache is an optimization */ }

  let county = null;
  // Google first (precise, and already paced by the shared google_geocode bucket).
  // A NON-definitive answer (quota / denied / unknown, all arriving as an HTTP 200
  // body) is treated exactly as canonicalize does — as being about US, not the
  // address — so we fall through to the keyless provider rather than cache nothing.
  if (cfg.googlePlacesKey) {
    try {
      const url = 'https://maps.googleapis.com/maps/api/geocode/json?components=country:US'
        + '&address=' + encodeURIComponent(t) + '&key=' + encodeURIComponent(cfg.googlePlacesKey);
      await require('./api-rate-limit').acquire('google_geocode');
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      const j = r.ok ? await r.json() : null;
      // Only read the county off a PRECISE match. Google answers a house number it
      // cannot place with the ROAD it sits on, and that road can lie in a DIFFERENT
      // county (the geocodeRewriteIsSafe incident — "1727 S 2nd St, Piscataway"
      // resolved across the Middlesex→Union county line). parseGeocodeResult returns
      // null for a route / locality / ZIP-level match, so an imprecise answer yields
      // no county and the order BLOCKS (the owner's stated preference) rather than
      // adopting a neighbouring county nobody would notice on the preview.
      if (googleDefinitive(r.ok, j) && parseGeocodeResult(j)) county = googleCounty(j);
    } catch (_) { /* fall through to the keyless provider */ }
  }
  if (!county) {
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&addressdetails=1&q='
        + encodeURIComponent(ADDR.withoutUnit(t));
      const r = await osmPolite(() => fetch(url, {
        signal: AbortSignal.timeout(6000),
        headers: { 'User-Agent': `YSCapitalPortal/1.0 (${cfg.osmContact || 'admin@yscapgroup.com'})`, accept: 'application/json' },
      }));
      const j = (r && r.ok) ? await r.json() : null;
      // Same precision rule as the Google branch: parseOsmResult reports 'rooftop'
      // only when the match carries a house_number; a road-level match (no house
      // number, the road's own data) is refused so a county is never taken from the
      // wrong side of a boundary.
      const m = (osmDefinitive(r && r.ok, j) && Array.isArray(j)) ? j[0] : null;
      const parsed = m ? parseOsmResult(m) : null;
      if (parsed && parsed.precision === 'rooftop') county = osmCounty(m);
    } catch (_) { /* best-effort */ }
  }
  if (county) {
    try {
      // county-only row (place_id stays NULL); the `county:` key keeps it out of the
      // place_id resolver's keyspace. Immutable once set (a county does not change).
      await db.query(
        `INSERT INTO address_canon_cache (input_key, county, resolved_at)
         VALUES ($1,$2, now())
         ON CONFLICT (input_key) DO UPDATE SET county = EXCLUDED.county, resolved_at = now()
          WHERE address_canon_cache.county IS NULL`,
        [key, county]);
    } catch (_) { /* best-effort */ }
  }
  return county || null;
}

/** Free text → { lat, lng, formatted, place_id } | null. Never throws. */
async function geocode(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // Geocode the BUILDING, not the apartment. A unit suffix ("Apartment 6B",
  // "Unit 4D", "#3") makes some providers — the keyless OSM fallback especially —
  // return NO MATCH for an address that resolves cleanly without it (owner-reported
  // 2026-07-27: a borrower home address with an apartment "could not be placed on
  // the map" so it never reached ClickUp). The coordinates are building-level
  // regardless, so this loses nothing; ADDR.withoutUnit leaves a unit-less address
  // untouched.
  const q = ADDR.withoutUnit(t);
  try {
    // COORDINATES ARE WHAT THIS CALLER IS FOR, so it asks for them explicitly —
    // which is what re-fetches a Google row whose licensed window has lapsed
    // (db/413) instead of quietly answering with a row that no longer has any.
    const g = await canonicalize(q, { needCoords: true });
    if (g && g.lat != null && g.lng != null) return g;
  } catch (_) { /* fall through to the keyless provider */ }
  try { return await osmGeocode(q); } catch (_) { return null; }
}

module.exports = {
  canonicalize, samePlace, geocode, parseGeocodeResult, parseOsmResult, inputKey,
  // County resolution for the Class order desk (db/539). resolveCounty geocodes +
  // caches; googleCounty/osmCounty are pure and unit-tested.
  resolveCounty, googleCounty, osmCounty, countyQueryFrom,
  // Pure — exported for the never-cache-a-transient-failure test.
  googleDefinitive, osmDefinitive, negativeExpired, NEGATIVE_TTL_DAYS,
  // Google's 30-day coordinate window (db/413).
  expireGoogleCoordsOnce, coordsExpiryFor, coordsLapsed, cacheRefreshCoords,
  GOOGLE_COORD_TTL_DAYS,
};
