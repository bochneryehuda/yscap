'use strict';

/**
 * Canonical address resolution via Google Geocoding (owner-directed
 * 2026-07-15: formatting variants of the SAME property — "Ave"/"Avenue",
 * "Unit 114"/"114", "Village of Spring Valley"/"Spring Valley" — must compare
 * as the same). Each distinct input resolves ONCE to a stable `place_id`
 * (cached forever in address_canon_cache, db/113); comparisons after that are
 * cache hits. Fully degradable: no GOOGLE_PLACES_API_KEY / network error /
 * unresolvable input → null, and every caller falls back to the existing
 * heuristics (same-street comparator, normalized identity) — canonicalization
 * only ever ADDS matches, it never blocks anything.
 */
const db = require('../db');
const cfg = require('../config');

const inputKey = (t) => String(t || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 300);

// Pure parser (unit-tested): Google Geocoding JSON → our cache row shape.
function parseGeocodeResult(json) {
  const r = json && Array.isArray(json.results) ? json.results[0] : null;
  if (!r || !r.place_id) return null;
  // Reject wildly-imprecise matches: a street address should geocode to at
  // least street level, never a bare locality/state centroid.
  const types = r.types || [];
  if (types.includes('locality') || types.includes('administrative_area_level_1') || types.includes('country')) return null;
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

module.exports = { canonicalize, samePlace, parseGeocodeResult, inputKey };
