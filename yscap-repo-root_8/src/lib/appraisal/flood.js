/**
 * FEMA flood cross-check — confirm the appraisal's stated flood zone against the OFFICIAL
 * government flood map, using only FREE, no-signup public services:
 *   1. U.S. Census geocoder  (geocoding.geo.census.gov) — subject address → lat/long.
 *   2. FEMA National Flood Hazard Layer (hazards.fema.gov, public NFHL MapServer layer 28) —
 *      point → FLD_ZONE.
 *
 * Then compare the FEMA zone to what the appraiser wrote. The underwriting-critical catch is a
 * property the appraisal calls NOT in a flood zone (X) that FEMA actually maps INSIDE a Special
 * Flood Hazard Area (A/V) — i.e. flood insurance is required but may have been missed.
 *
 * NEVER guesses: if geocoding or FEMA can't be reached, or returns nothing, we report "not
 * checked" and raise no finding — we never invent a zone. Network is best-effort + time-limited;
 * this module never throws. All network functions accept an injectable `fetchImpl` for testing.
 *
 * Pure comparison helpers (isSfha / compareZones) are dependency-free and unit-tested without
 * the network.
 */

const CENSUS_URL = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const FEMA_URL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query';
const TIMEOUT_MS = 8000;

// A FEMA zone code (A, AE, AH, AO, AR, A99, V, VE, X, D, …). Special Flood Hazard Areas — the
// zones that carry a mandatory-insurance / higher-risk implication — begin with A or V.
function isSfha(zone) {
  const z = String(zone || '').trim().toUpperCase();
  if (!z) return null;                       // unknown, not "no"
  if (/^(A|V)/.test(z)) return true;         // AE, AH, AO, AR, A99, VE …
  if (/^(X|B|C|D)/.test(z)) return false;    // X (and legacy B/C), D = undetermined→treated non-SFHA here but flagged
  return null;
}
function normZone(zone) { return String(zone || '').trim().toUpperCase().replace(/\s+/g, ''); }

/**
 * Compare the appraiser's zone to the FEMA zone.
 * @returns {{agrees:boolean|null, severity:'warning'|'info'|null, kind:string, note:string}}
 *   agrees null = can't compare (one side unknown). kind: 'match'|'sfha_mismatch'|'zone_diff'|
 *   'fema_only'|'appraisal_only'|'unknown'.
 */
function compareZones(appraisalZone, femaZone) {
  const a = normZone(appraisalZone), f = normZone(femaZone);
  if (!f && !a) return { agrees: null, severity: null, kind: 'unknown', note: 'No flood zone on either side.' };
  if (f && !a) return { agrees: null, severity: 'info', kind: 'fema_only', note: `The appraisal did not state a flood zone; FEMA maps this location as zone ${f}.` };
  if (!f && a) return { agrees: null, severity: null, kind: 'appraisal_only', note: 'FEMA returned no zone for this location.' };
  if (a === f) return { agrees: true, severity: null, kind: 'match', note: `Both the appraisal and FEMA show flood zone ${f}.` };
  const aS = isSfha(a), fS = isSfha(f);
  if (aS != null && fS != null && aS !== fS) {
    // The material catch: in/out of a Special Flood Hazard Area disagrees.
    return { agrees: false, severity: 'warning', kind: 'sfha_mismatch',
      note: fS
        ? `The appraisal shows zone ${a} (not a special flood hazard area) but FEMA maps this location as zone ${f} — a Special Flood Hazard Area. Flood insurance is likely required; confirm the zone and the flood-cert.`
        : `The appraisal shows zone ${a} (a special flood hazard area) but FEMA maps zone ${f}. Confirm the correct zone — it changes the insurance requirement.` };
  }
  // Same SFHA status, different sub-zone (e.g. AE vs A) — a soft note, not a blocker.
  return { agrees: false, severity: 'info', kind: 'zone_diff', note: `The appraisal shows zone ${a}; FEMA maps zone ${f}. Same broad risk category — confirm the exact zone.` };
}

// A fetch with a hard timeout that resolves to null on ANY failure (never throws).
async function safeFetchJson(url, fetchImpl) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await f(url, ctl ? { signal: ctl.signal, headers: { accept: 'application/json' } } : { headers: { accept: 'application/json' } });
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (_) { return null; }
  finally { if (timer) clearTimeout(timer); }
}

// Census one-line-address geocode → { lat, lng, matched } or null.
async function geocode(address, fetchImpl) {
  const addr = String(address || '').trim();
  if (!addr) return null;
  const url = `${CENSUS_URL}?address=${encodeURIComponent(addr)}&benchmark=Public_AR_Current&format=json`;
  const j = await safeFetchJson(url, fetchImpl);
  const m = j && j.result && j.result.addressMatches && j.result.addressMatches[0];
  if (!m || !m.coordinates) return null;
  const lng = Number(m.coordinates.x), lat = Number(m.coordinates.y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng, matched: m.matchedAddress || addr };
}

// FEMA NFHL layer-28 point query → { zone, subtype, sfha } or null.
async function femaZoneAt(lat, lng, fetchImpl) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const geom = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
  const url = `${FEMA_URL}?geometry=${geom}&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=FLD_ZONE,ZONE_SUBTY,SFHA_TF&returnGeometry=false&f=json`;
  const j = await safeFetchJson(url, fetchImpl);
  const feat = j && j.features && j.features[0];
  if (!feat || !feat.attributes) {
    // FEMA returns no feature when the point is in an unmapped / Zone-X-by-omission area.
    return j && j.features ? { zone: null, subtype: null, sfha: null, unmapped: true } : null;
  }
  const at = feat.attributes;
  const zone = at.FLD_ZONE || null;
  return { zone, subtype: at.ZONE_SUBTY || null, sfha: at.SFHA_TF === 'T' ? true : at.SFHA_TF === 'F' ? false : isSfha(zone) };
}

/**
 * Full cross-check for a subject: geocode → FEMA zone → compare to the appraiser's zone.
 * @param {{address:string, appraisalZone:string, lat?:number, lng?:number, fetchImpl?:function}}
 * @returns {{checked:boolean, femaZone:string|null, sfha:boolean|null, matched:string|null,
 *            comparison:object|null, reason?:string}}
 */
async function crossCheckFlood({ address, appraisalZone, lat, lng, fetchImpl } = {}) {
  let coords = (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng, matched: address } : await geocode(address, fetchImpl);
  if (!coords) return { checked: false, femaZone: null, sfha: null, matched: null, comparison: null, reason: 'could not geocode the subject address' };
  const fema = await femaZoneAt(coords.lat, coords.lng, fetchImpl);
  if (!fema) return { checked: false, femaZone: null, sfha: null, matched: coords.matched, comparison: null, reason: 'FEMA flood service was unreachable' };
  const comparison = compareZones(appraisalZone, fema.zone);
  return { checked: true, femaZone: fema.zone, sfha: fema.sfha, matched: coords.matched, comparison };
}

module.exports = { crossCheckFlood, geocode, femaZoneAt, compareZones, isSfha, _internals: { normZone, safeFetchJson } };
