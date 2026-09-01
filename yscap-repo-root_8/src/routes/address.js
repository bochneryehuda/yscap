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
const ADDR = require('../lib/address');
const { parseAddress, normalizeAddress, splitUnit } = ADDR;
// (the state map + 2-letter abbreviation live in lib/address.js — one copy)
// Borough preference + OSM component mapping + the canonical mailing one-line
// live in lib/address.js so the autocomplete, the geocoder, the ClickUp sync and
// the repair pass all agree on what an address looks like (2026-07-26).
const { preferBorough, osmComponentsToAddress, compactFormattedAddress } = ADDR;


// small TTL cache + a min-interval throttle (Nominatim asks for <=1 req/sec)
const cache = new Map();
const TTL = 5 * 60 * 1000;
function cget(k) { const v = cache.get(k); if (v && Date.now() - v.at < (v.ttl || TTL)) return v.val; if (v) cache.delete(k); return null; }
// `ttl` is per entry: a coordinate does not move, but "nobody could place it" is
// often a service having a bad minute, and pinning that for the full window means
// a person who retries is answered by a cache rather than by a lookup.
function cset(k, val, ttl) { cache.set(k, { at: Date.now(), val, ttl }); if (cache.size > 2000) cache.delete(cache.keys().next().value); }
// Nominatim asks for at most 1 request/second — for the PROCESS, not per module.
// The clock is SHARED with the research geocoder and the ClickUp canonicaliser
// (`lib/osm-gate`): each of the three used to keep its own, so any two running
// together could fire twice inside one second while every one of them looked
// correct in isolation. The gate never carries a rejection forward — a failed
// lookup poisoning the chain would break address autocomplete until restart.
const OSM = require('../lib/osm-gate');
const osmThrottle = OSM.osmRun;
/* HOW LONG SOMEBODY WILL WAIT FOR A SUGGESTION BEFORE IT IS NOT A SUGGESTION.
 * Past this, answering with nothing is kinder than a spinner: the field still
 * works as plain typing, which is what it does when the provider is down. */
const SUGGEST_MAX_WAIT_MS = 2500;
/* EVERY QUERY VALUE IS COERCED, AT EVERY DOOR. Express's extended query parser
 * turns `?q[x]=1` into an OBJECT; `String(obj)` is "[object Object]", which is
 * three characters long and therefore spent a real provider request and a slot of
 * OpenStreetMap's process-wide budget on garbage. A non-string is not a query. */
const qstr = (v) => (typeof v === 'string' ? v.trim() : '');

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
// Component mapping (borough preference, mailing city name, 2-letter state) is
// the shared one in lib/address.js — never re-implement it here.
const osmAddress = osmComponentsToAddress;
// A clean, tight label — street, city, ST ZIP — so the borrower isn't shown the
// county / country / raw provider noise in the suggestion list.
function cleanLabel(addr) {
  return [[addr.line1, addr.unit].filter(Boolean).join(' '), addr.city,
    [addr.state, addr.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}
/* ⛔ THE HOUSE NUMBER THE PERSON TYPED IS NOT OURS TO DROP (owner-reported
   2026-08-31: *"his address is not populated correctly"*).

   REPRODUCED against the live provider with the reported address before anything
   was changed. Typing `9 Hurley St, Keyport, NJ 07735-1607` returns TWO rows,
   both `addresstype: "road"`, both carrying NO `house_number`, identical in every
   field a person can see and differing only in `place_id` — OSM holds that street
   as two segments. So the officer was offered "Hurley Street, Keyport, NJ 07735"
   TWICE, and picking either one silently replaced their property with a STREET.

   This is the same class CLAUDE.md already records for the ClickUp push — "a
   geocoder answers a house number it cannot place with the ROAD it sits on" —
   which `geocodeRewriteIsSafe` closed on THAT path and nowhere else. Same root,
   a second surface.

   ⛔ IT PRESERVES, IT NEVER INVENTS. The number is carried over ONLY from what the
   person actually typed, and only onto a row whose street/town/state the provider
   itself returned. We are completing the parts they left off, never asserting a
   house exists: with no number typed, a road match is still offered exactly as it
   was, and a row the provider DID place is untouched. */
const TYPED_HOUSE_RE = /^\s*(\d+[A-Za-z]?(?:\s*-\s*\d+[A-Za-z]?)?)\s+\S/;
function typedHouseNumber(q) {
  const m = TYPED_HOUSE_RE.exec(String(q || ''));
  return m ? m[1].replace(/\s+/g, '') : null;
}

async function osmSuggest(q) {
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=6&countrycodes=us&q=' + encodeURIComponent(q);
  const rows = await osmThrottle(() => fetchJson(url, {
    headers: { 'User-Agent': `YSCapitalPortal/1.0 (${cfg.osmContact})`, 'Accept-Language': 'en-US' },
  }));
  const typedHouse = typedHouseNumber(q);
  const seen = new Set();
  const mapped = (rows || []).map((r) => {
    const address = osmAddress(r.address);
    // Fallback label is COMPACTED, never the raw display_name — picking a
    // suggestion copies the label into the field, and that is one of the ways
    // the long "…, Kings County, New York, 11249, United States" form got into
    // files in the first place (2026-07-26).
    const out = { id: 'osm:' + r.place_id, label: cleanLabel(address) || compactFormattedAddress(r.display_name), address };
    // THE POSITION RIDES ALONG FREE. Nominatim's search response already carries
    // lat/lon on every row, and a screen that wants to run a distance search from
    // the address needs it — so throwing it away meant a second lookup (or, as
    // the owner found, a half-mile search with nothing to measure from). Only an
    // answer that actually placed the HOUSE is carried: a road-level match puts
    // every house on the street at one point, which is worse than no position.
    const house = r.address && (r.address.house_number || r.address.housenumber);
    const lat = Number(r.lat), lng = Number(r.lon);
    if (house && Number.isFinite(lat) && Number.isFinite(lng)) {
      out.position = { lat, lng, source: 'osm', precision: 'address' };
    }
    /* The provider placed the street but not the house. Put the typed number back
       on the line so choosing this suggestion cannot cost the officer their own
       property, and SAY it is street-level: `position` is deliberately still
       absent (a road point puts every house on the street in one spot, which is
       worse than none), and `housePreserved` lets a screen mark the row rather
       than implying we confirmed the address. */
    if (!house && typedHouse && out.address && out.address.line1) {
      out.address = { ...out.address, line1: `${typedHouse} ${out.address.line1}` };
      out.label = cleanLabel(out.address) || out.label;
      out.precision = 'street';
      out.housePreserved = true;
    }
    return out;
  }).filter((out) => {
    /* ⛔ TWO ROWS A PERSON CANNOT TELL APART ARE ONE SUGGESTION. OSM splits a
       street into segments, so the reported address came back as two rows with
       the SAME label and different `place_id`s. Keying the de-dupe on the LABEL
       is the point — the id is exactly the thing that differs and the thing
       nobody can see. First one wins, so a row the provider genuinely placed
       (which is emitted with its own richer label) is never dropped for a
       later duplicate. */
    const k = String(out.label || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return mapped;
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
    city: ADDR.normalizeCityName(preferBorough((get('locality') || {}).long_name || '',
      (get('sublocality_level_1') || get('sublocality') || {}).long_name)
      || (get('postal_town') || {}).long_name || ''),
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
  const q = qstr(req.query.q);
  res.set('Cache-Control', 'public, max-age=60');
  if (q.length < 3) return res.json({ provider: cfg.addressProvider, suggestions: [] });
  const key = cfg.addressProvider + ':' + q.toLowerCase();
  const hit = cget(key);
  if (hit) return res.json({ provider: cfg.addressProvider, suggestions: hit });
  try {
    let suggestions = [];
    if (cfg.addressProvider === 'google' && cfg.googlePlacesKey) suggestions = await googleSuggest(q);
    else if (cfg.addressProvider === 'smarty' && cfg.smartyAuthId) suggestions = await smartySuggest(q);
    else if (OSM.osmWouldWait() > SUGGEST_MAX_WAIT_MS) {
      // A BACKGROUND SWEEP MUST NOT MAKE SOMEBODY'S TYPING STALL. OpenStreetMap's
      // one-per-second limit is per process and correctly shared, but that means a
      // 25-address backfill tick parks ~27 seconds in front of the next keystroke.
      // Not cached: this is about this moment, not about this address.
      res.set('Cache-Control', 'no-store');
      return res.json({ provider: cfg.addressProvider, suggestions: [], busy: true });
    } else suggestions = await osmSuggest(q);
    cset(key, suggestions);
    res.json({ provider: cfg.addressProvider, suggestions });
  } catch (e) {
    // Never break the form — the field still works as manual entry.
    res.json({ provider: cfg.addressProvider, suggestions: [], error: 'lookup unavailable' });
  }
});

router.get('/details', async (req, res) => {
  const id = qstr(req.query.id);
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
  res.json({ address: parseAddress(qstr(req.query.q)) });
});

/**
 * WHERE IS THIS ADDRESS? — the position, so a distance search can actually run.
 *
 * The owner reported that a half-mile search "comes up properties from different
 * states". It did: the search measures from a point, the typed subject had no
 * point, and a radius with nothing to measure from is unanswerable (the search
 * now refuses instead of quietly answering with the country). This endpoint is
 * the other half of that fix — it gives a typed address the position the radius
 * needs, so the search can be answered rather than refused.
 *
 * KEYLESS SOURCES ONLY, AND THAT IS A RULE, NOT A COST SAVING. Google Maps
 * Platform caps a stored latitude/longitude at 30 days unless the cache belongs
 * to a single end user, and a shared comparable warehouse is not that — so a
 * Google coordinate can never be written into this system (the full comparison,
 * with the terms quoted, is in docs/research/GEOCODING-DISTANCE-VENDOR-RESEARCH.md).
 * Google may SUGGEST the address; the coordinate always comes from the US Census
 * geocoder (a federal service, no key, no term on the answer) or OpenStreetMap.
 * That way a position from this endpoint is safe to store anywhere, and nothing
 * downstream has to know which provider the address came from.
 *
 * IT GOES THROUGH `geocodeProperty`, NOT THE PROVIDERS DIRECTLY — and that is the
 * whole safety of it. Calling `census()`/`osm()` here would have skipped the two
 * refusals written after the 2026-07-28 Piscataway incident, both of which live
 * inside that function:
 *
 *   · `geocodeRewriteIsSafe` — a geocoder answers a DIFFERENT HOUSE rather than
 *     admit it cannot find yours. Verified live: Census answers "26 S 10th St,
 *     Piscataway NJ" with "26 10TH ST" — the directional dropped, a different
 *     street, `precision: 'address'`, full confidence. Adopting that pin puts the
 *     subject on the wrong street and every distance measured from it is wrong
 *     WITHOUT LOOKING WRONG, which is precisely the class this endpoint exists to
 *     close, re-armed one layer up.
 *   · "A STATE IS NOT A PLACE" — "26 S 10th St, NJ" has a house number and a
 *     state and still names nothing; there are dozens of them and both services
 *     will happily return the first. `addressLine` refuses it; a bare length
 *     check does not.
 *
 * So the components are handed over as COMPONENTS and that function decides what
 * is lookup-able. Its refusals already carry a plain-language reason.
 */
const RG = require('../lib/research/geocode');

/* THE PUBLIC DOOR GETS ITS OWN QUEUE, AND IT SHEDS RATHER THAN GROWS.
 *
 * `/api/address/*` is public and unauthenticated (it backs the marketing loan
 * application), rate-limited only per IP. A position lookup can cost a second or
 * more of OpenStreetMap's process-wide one-per-second budget, so running it on
 * the SAME chain as `/suggest` meant a burst from one visitor queued behind
 * itself and stalled the address autocomplete for everybody — measured at 67 ms
 * on an empty chain against 10,989 ms behind ten queued lookups, and the backlog
 * grows without bound because the arrival rate can exceed the drain rate.
 *
 * Two separate limits, because they answer different questions: how many of these
 * may be in flight at once (`POS_MAX_INFLIGHT`), and how many may be WAITING
 * (`POS_MAX_QUEUE`). Past the queue limit the request is answered immediately
 * with no position — which is a truthful answer this endpoint already has to be
 * able to give, and infinitely better than a queue that never drains. */
const POS_MAX_INFLIGHT = 2;
const POS_MAX_QUEUE = 8;
let posInflight = 0, posQueued = 0;
const posBusy = () => posQueued >= POS_MAX_QUEUE;
async function posSlot(fn) {
  posQueued++;
  try {
    while (posInflight >= POS_MAX_INFLIGHT) await new Promise((r) => setTimeout(r, 120));
    posInflight++;
    try { return await fn(); } finally { posInflight--; }
  } finally { posQueued--; }
}

const NO_POSITION = (why) => ({ lat: null, lng: null, source: null, precision: null, matched: null, why });
// A POSITIVE ANSWER KEEPS; A NEGATIVE ONE EXPIRES SOON. A coordinate does not
// move, but "nobody could place it" is often a service having a bad minute — and
// pinning that for the full window means a person who retries is told the same
// thing by a cache rather than by a lookup.
const POS_NEG_TTL = 45 * 1000;

router.get('/position', async (req, res) => {
  res.set('Cache-Control', 'public, max-age=600');
  // EVERY QUERY VALUE IS COERCED. Express's extended query parser turns
  // `?state[x]=1` into an OBJECT, and handing that to the address helpers threw
  // out of the handler as a 500 on a public endpoint — the same "a value must fit
  // what reads it, and the door refuses politely" discipline as everywhere else.
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const q = str(req.query.q);
  // NORMALIZED, NOT TAKEN AS TYPED. `geocodeProperty` reads `street` verbatim —
  // right for a warehouse row, where the unit lives in its own column and the
  // state is already a code, and wrong for a query string, where they arrive
  // however a person typed them. Two things had to be handled here:
  //   · A GEOCODER RESOLVES A BUILDING, NOT AN APARTMENT. "Apt 4D" on the end of
  //     the street line is a common cause of a match failing outright, and every
  //     unit of one building sharing a coordinate is correct — they ARE at the
  //     same place. `normalizeAddress` splits the unit off into its own field,
  //     which `geocodeProperty` then simply never asks about.
  //   · A SPELLED-OUT STATE is not what either service is asked for elsewhere;
  //     `stateAbbr` inside the same helper turns "New York" into "NY".
  const parts = normalizeAddress(q ? parseAddress(q) : {
    line1: str(req.query.line1) || str(req.query.street),
    city: str(req.query.city), state: str(req.query.state), zip: str(req.query.zip),
  });
  const subject = {
    street: ADDR.abbreviateStreet(parts.line1 || ''),
    city: ADDR.normalizeCityName(parts.city || ''),
    state: parts.state || '', zip: parts.zip || '',
  };
  const key = 'pos:' + [subject.street, subject.city, subject.state, subject.zip].join('|').toLowerCase();
  const hit = cget(key);
  if (hit) return res.json(hit);
  if (posBusy()) {
    // Never cached, and the HEADER has to say so too — the handler sets a
    // ten-minute cache up front, so a browser would answer "busy, try again" for
    // the next ten minutes without ever asking again. This says nothing about the
    // address, only about this moment.
    res.set('Cache-Control', 'no-store');
    return res.json(NO_POSITION('the address lookup is busy right now — try again in a moment'));
  }
  try {
    const p = await posSlot(() => RG.geocodeProperty(subject));
    const out = p && p.ok
      ? { lat: p.lat, lng: p.lng, source: p.source, precision: p.precision, matched: p.matched || null, why: null }
      : NO_POSITION((p && p.why) || 'we could not place that address on the map');
    cset(key, out, out.lat == null ? POS_NEG_TTL : undefined);
    // THE BROWSER'S CACHE MUST NOT OUTLIVE OURS. A short server-side TTL on a
    // negative answer is pointless if the response tells the browser to keep it
    // for ten minutes — the person who retries is answered by their own cache.
    if (out.lat == null) res.set('Cache-Control', `public, max-age=${Math.round(POS_NEG_TTL / 1000)}`);
    res.json(out);
  } catch (e) {
    // Never break the form, and never quote a provider's error text to a caller
    // — this endpoint is public. No position simply means no distance search.
    res.json(NO_POSITION('the address lookup is not answering right now'));
  }
});

// Verify / standardize an address against USPS — the authoritative standardizer.
// The autocomplete provider (Google/Smarty/OSM) suggests the address; this makes it
// exactly USPS-correct after the pick. Returns { configured, status, address, dpv,
// changed }. Never breaks the form: if USPS isn't set up yet (or can't confirm the
// address) it says so and the caller keeps whatever it had.
const uspsVerify = require('../lib/usps-verify');
async function handleVerify(input, res) {
  try {
    const out = await uspsVerify.standardize(input);
    // Never expose the raw USPS error text to an anonymous caller (this endpoint is
    // public — it backs the marketing loan application). `detail` is for server logs.
    if (out && out.detail) delete out.detail;
    res.set('Cache-Control', 'private, max-age=300');
    res.json(out);
  } catch (e) {
    res.json({ configured: uspsVerify.configured(), status: 'error', address: null, dpv: null, changed: false });
  }
}
// Accept either discrete components OR a single free-text line (some tools store
// only the address label). A free-text `q` (or a bare string) is parsed into
// components server-side so USPS has something to match on.
const verifyInput = (src) => {
  if (typeof src === 'string') return parseAddress(src.trim());
  const o = src || {};
  // Same coercion as every other door: a non-string query value is not an address,
  // and `String({})` is "[object Object]", which USPS is then asked about.
  if (qstr(o.q) && !qstr(o.line1) && !qstr(o.street)) return parseAddress(qstr(o.q));
  return {
    line1: qstr(o.line1) || qstr(o.street), unit: qstr(o.unit) || qstr(o.secondary),
    city: qstr(o.city), state: qstr(o.state), zip: qstr(o.zip) || qstr(o.zipcode),
  };
};
router.get('/verify', (req, res) => handleVerify(verifyInput(req.query), res));
router.post('/verify', (req, res) => handleVerify(verifyInput((req.body && (req.body.address || req.body)) || {}), res));

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
