/**
 * Address autocomplete / verification proxy. The frontend (marketing site AND
 * portal) calls these; the real provider key never leaves the server.
 *
 *   GET /api/address/suggest?q=123 main   -> { provider, suggestions:[{id,label,address?}] }
 *   GET /api/address/details?id=<id>      -> { address:{line1,city,state,zip,country} }
 *
 * Providers (auto-selected in config): 'osm' (OpenStreetMap Nominatim, KEYLESS,
 * default), 'google' (Places), 'smarty' (US Autocomplete Pro). When a provider
 * returns structured components with the suggestion (osm/smarty), `address` is
 * embedded so the client can fill instantly with no second call; Google needs a
 * details lookup, so the client calls /details with the suggestion id.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const cfg = require('../config');
const { parseAddress, normalizeAddress, splitUnit } = require('../lib/address');

const US_STATE_ABBR = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE','district of columbia':'DC',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY' };
const stateAbbr = (s) => !s ? '' : (s.length === 2 ? s.toUpperCase() : (US_STATE_ABBR[s.toLowerCase()] || s));

// NYC quirk (#93): geocoders label ALL FIVE boroughs with the municipality
// "New York" (Google `locality`, OSM `city`), but USPS — and residents — use the
// BOROUGH as the mailing city: Brooklyn, Bronx, Staten Island, Queens. The one
// exception is Manhattan, whose mailing city really is "New York". So when the
// municipality is New York and a distinct borough component is present, prefer the
// borough (stripping a leading "The " from "The Bronx"); otherwise keep the city.
// Narrowly gated on locality === "New York", so no ordinary city is affected.
function preferBorough(locality, borough) {
  const city = String(locality || '').trim();
  const b = String(borough || '').replace(/^the\s+/i, '').trim();
  if (!city) return b;                                    // no municipality → borough/sublocality fallback
  if (/^(city of )?new york$/i.test(city) && b && !/^manhattan$/i.test(b)) return b;
  return city;
}

// small TTL cache + a min-interval throttle (Nominatim asks for <=1 req/sec)
const cache = new Map();
const TTL = 5 * 60 * 1000;
function cget(k) { const v = cache.get(k); if (v && Date.now() - v.at < TTL) return v.val; if (v) cache.delete(k); return null; }
function cset(k, val) { cache.set(k, { at: Date.now(), val }); if (cache.size > 2000) cache.delete(cache.keys().next().value); }
let osmChain = Promise.resolve(); let osmLast = 0;
function osmThrottle(fn) {
  // Serialize calls ~1.1s apart (Nominatim asks for <=1 req/sec). The promise
  // returned to the caller carries fn()'s success/failure, but the internal
  // `osmChain` gate must always RESOLVE — a rejection propagating into it would
  // make every future call chain off a rejected promise, permanently breaking
  // address autocomplete until the process restarted.
  const run = osmChain.then(async () => {
    const wait = 1100 - (Date.now() - osmLast);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    osmLast = Date.now();
    return fn();
  });
  osmChain = run.then(() => {}, () => {});   // gate swallows the outcome; never carries a rejection forward
  return run;
}

async function fetchJson(url, opts = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 6000);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    if (!r.ok) throw new Error('provider ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ---- OpenStreetMap Nominatim (keyless) ----
function osmAddress(a = {}) {
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
  return normalizeAddress({
    line1: line1 || a.neighbourhood || '',
    unit: '',
    city: preferBorough(a.city || a.town || a.village || a.hamlet || '', a.borough || a.city_district || a.suburb),
    state: stateAbbr(a.state || ''),
    zip: a.postcode || '',
    county: (a.county || '').replace(/\s+County$/i, ''),  // kept for backend only
    country: (a.country_code || 'us').toUpperCase(),
  });
}
// A clean, tight label — street, city, ST ZIP — so the borrower isn't shown the
// county / country / raw provider noise in the suggestion list.
function cleanLabel(addr) {
  return [[addr.line1, addr.unit].filter(Boolean).join(' '), addr.city,
    [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
async function osmSuggest(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=us&q=' + encodeURIComponent(q);
  const rows = await osmThrottle(() => fetchJson(url, {
    headers: { 'User-Agent': `YSCapitalPortal/1.0 (${cfg.osmContact})`, 'Accept-Language': 'en-US' },
  }));
  return (rows || []).map((r) => {
    const address = osmAddress(r.address);
    return { id: 'osm:' + r.place_id, label: cleanLabel(address) || r.display_name, address };
  });
}

// ---- Google Places ----
async function googleSuggest(q) {
  const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json?types=address&components=country:us'
    + '&input=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(cfg.googlePlacesKey);
  const j = await fetchJson(url);
  if (j.status && j.status !== 'OK' && j.status !== 'ZERO_RESULTS') throw new Error('google ' + j.status);
  return (j.predictions || []).map((p) => ({ id: 'g:' + p.place_id, label: p.description })); // address via /details
}
async function googleDetails(placeId) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json?fields=address_component'
    + '&place_id=' + encodeURIComponent(placeId) + '&key=' + encodeURIComponent(cfg.googlePlacesKey);
  const j = await fetchJson(url);
  const comp = (j.result && j.result.address_components) || [];
  const get = (type) => { const c = comp.find((x) => x.types.includes(type)); return c ? c : null; };
  const num = get('street_number'), route = get('route');
  return normalizeAddress({
    line1: [num && num.long_name, route && route.long_name].filter(Boolean).join(' '),
    unit: (get('subpremise') || {}).long_name || '',
    city: preferBorough((get('locality') || {}).long_name || '',
      (get('sublocality_level_1') || get('sublocality') || {}).long_name)
      || (get('postal_town') || {}).long_name || '',
    state: (get('administrative_area_level_1') || {}).short_name || '',
    zip: (get('postal_code') || {}).long_name || '',
    county: ((get('administrative_area_level_2') || {}).long_name || '').replace(/\s+County$/i, ''),
    country: (get('country') || {}).short_name || 'US',
  });
}

// ---- Smarty US Autocomplete Pro ----
async function smartySuggest(q) {
  const url = 'https://us-autocomplete-pro.api.smarty.com/lookup?auth-id=' + encodeURIComponent(cfg.smartyAuthId)
    + '&auth-token=' + encodeURIComponent(cfg.smartyAuthToken) + '&search=' + encodeURIComponent(q);
  const j = await fetchJson(url);
  return (j.suggestions || []).map((s, i) => ({
    id: 'sm:' + i,
    label: [s.street_line, s.secondary, [s.city, s.state, s.zipcode].filter(Boolean).join(', ')].filter(Boolean).join(' '),
    address: normalizeAddress({ line1: s.street_line || '', unit: s.secondary || '', city: s.city || '', state: s.state || '', zip: s.zipcode || '', country: 'US' }),
  }));
}

router.get('/suggest', async (req, res) => {
  const q = String(req.query.q || '').trim();
  res.set('Cache-Control', 'public, max-age=60');
  if (q.length < 3) return res.json({ provider: cfg.addressProvider, suggestions: [] });
  const key = cfg.addressProvider + ':' + q.toLowerCase();
  const hit = cget(key);
  if (hit) return res.json({ provider: cfg.addressProvider, suggestions: hit });
  try {
    let suggestions = [];
    if (cfg.addressProvider === 'google' && cfg.googlePlacesKey) suggestions = await googleSuggest(q);
    else if (cfg.addressProvider === 'smarty' && cfg.smartyAuthId) suggestions = await smartySuggest(q);
    else suggestions = await osmSuggest(q);
    cset(key, suggestions);
    res.json({ provider: cfg.addressProvider, suggestions });
  } catch (e) {
    // Never break the form — the field still works as manual entry.
    res.json({ provider: cfg.addressProvider, suggestions: [], error: 'lookup unavailable' });
  }
});

router.get('/details', async (req, res) => {
  const id = String(req.query.id || '');
  try {
    if (id.startsWith('g:')) return res.json({ address: await googleDetails(id.slice(2)) });
    // osm/smarty embed the address in /suggest, so /details is only needed for
    // google. If asked otherwise, return empty and let the client keep its copy.
    res.json({ address: null });
  } catch (e) { res.json({ address: null, error: 'lookup unavailable' }); }
});

// Parse a free-text address into components (manual entry, imports, etc.).
router.get('/parse', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ address: parseAddress(String(req.query.q || '')) });
});

// Property photo — proxies Google Street View Static so the key stays
// server-side. 404s cleanly when no key is set (or no imagery exists), so the
// UI can simply hide the image. Activate with GOOGLE_MAPS_API_KEY (or the
// Places key with "Street View Static API" enabled).
router.get('/photo', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'q required' });
  if (!cfg.googleMapsKey) return res.status(404).json({ error: 'property photos not enabled' });
  try {
    // Metadata first (free) — only fetch the image if imagery actually exists.
    const meta = await fetchJson('https://maps.googleapis.com/maps/api/streetview/metadata?location='
      + encodeURIComponent(q) + '&key=' + encodeURIComponent(cfg.googleMapsKey));
    if (meta.status !== 'OK') return res.status(404).json({ error: 'no imagery for this address' });
    const img = await fetch('https://maps.googleapis.com/maps/api/streetview?size=640x400&location='
      + encodeURIComponent(q) + '&key=' + encodeURIComponent(cfg.googleMapsKey));
    if (!img.ok) return res.status(404).json({ error: 'no imagery' });
    res.set('Content-Type', img.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(Buffer.from(await img.arrayBuffer()));
  } catch (e) { res.status(404).json({ error: 'photo unavailable' }); }
});

module.exports = router;
