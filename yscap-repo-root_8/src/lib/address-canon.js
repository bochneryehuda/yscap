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

/** Resolve free text → { place_id, formatted, lat, lng, zip } | null. Cached. */
async function canonicalize(text) {
  const key = inputKey(text);
  if (!key || key.length < 8) return null;
  try {
    const hit = (await db.query(`SELECT place_id, formatted, lat, lng, zip FROM address_canon_cache WHERE input_key=$1`, [key])).rows[0];
    if (hit) return hit.place_id ? hit : null;   // cached "unresolvable" too
  } catch (_) { /* cache is an optimization */ }
  if (!cfg.googlePlacesKey) return null;
  let parsed = null;
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?components=country:US'
      + '&address=' + encodeURIComponent(key) + '&key=' + encodeURIComponent(cfg.googlePlacesKey);
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) parsed = parseGeocodeResult(await r.json());
  } catch (_) { return null; }   // network failure: DON'T cache — retry later
  try {
    await db.query(
      `INSERT INTO address_canon_cache (input_key, place_id, formatted, lat, lng, zip)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (input_key) DO NOTHING`,
      [key, parsed && parsed.place_id, parsed && parsed.formatted,
       parsed && parsed.lat, parsed && parsed.lng, parsed && parsed.zip]);
  } catch (_) { /* best-effort */ }
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
const OSM_PREFIX = 'osm:';
let _osmChain = Promise.resolve(); let _osmLast = 0;
function osmPolite(fn) {
  // Nominatim's usage policy asks for at most 1 request/second. Serialize and
  // space them; the gate always RESOLVES so one failure can't poison the chain.
  const run = _osmChain.then(async () => {
    const wait = 1100 - (Date.now() - _osmLast);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    _osmLast = Date.now();
    return fn();
  });
  _osmChain = run.then(() => {}, () => {});
  return run;
}

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
  try {
    const hit = (await db.query(`SELECT place_id, formatted, lat, lng FROM address_canon_cache WHERE input_key=$1`, [key])).rows[0];
    // Compact on READ too: rows cached before the formatting fix below still
    // hold a raw display_name, and this cache is permanent.
    // `precision` is derived rather than stored (the table has no such column):
    // after parseOsmResult, a row with no `formatted` IS a road-level match — that
    // is the only way one is now written, and it is also what address-heal leaves
    // behind when it strips a downgraded row. Deriving it here keeps a CACHE HIT
    // behaving exactly like a fresh lookup for callers that check precision.
    if (hit) {
      if (!hit.place_id) return null;
      const formatted = ADDR.compactFormattedAddress(hit.formatted) || null;
      return { ...hit, formatted, precision: formatted ? 'rooftop' : 'road' };
    }
  } catch (_) { /* cache is an optimization */ }
  let parsed = null;
  try {
    // addressdetails=1 so we can build the MAILING form from real components
    // rather than shortening Nominatim's display_name after the fact.
    const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=us&addressdetails=1&q='
      + encodeURIComponent(text);
    const r = await osmPolite(() => fetch(url, {
      signal: AbortSignal.timeout(6000),
      headers: { 'User-Agent': `YSCapitalPortal/1.0 (${cfg.osmContact || 'admin@yscapgroup.com'})`, accept: 'application/json' },
    }));
    if (r && r.ok) {
      const j = await r.json();
      parsed = parseOsmResult(Array.isArray(j) ? j[0] : null);
    }
  } catch (_) { return null; }   // network failure: DON'T cache — retry later
  try {
    await db.query(
      `INSERT INTO address_canon_cache (input_key, place_id, formatted, lat, lng, zip)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (input_key) DO NOTHING`,
      [key, parsed && parsed.place_id, parsed && parsed.formatted, parsed && parsed.lat, parsed && parsed.lng, parsed && parsed.zip]);
  } catch (_) { /* best-effort */ }
  return parsed;
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
    const g = await canonicalize(q);
    if (g && g.lat != null && g.lng != null) return g;
  } catch (_) { /* fall through to the keyless provider */ }
  try { return await osmGeocode(q); } catch (_) { return null; }
}

module.exports = { canonicalize, samePlace, geocode, parseGeocodeResult, parseOsmResult, inputKey };
