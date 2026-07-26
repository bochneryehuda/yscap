/**
 * Server-side US address normalization. Turns any address — whether picked from
 * autocomplete or typed free-hand as one line — into discrete components so the
 * rest of the system always stores a properly divided address:
 *   { line1 (street), unit (apt/suite), city, state (2-letter), zip, country }
 * All splitting happens here, on the backend.
 */
const US_STATE_ABBR = { alabama:'AL',alaska:'AK',arizona:'AZ',arkansas:'AR',california:'CA',colorado:'CO',connecticut:'CT',delaware:'DE','district of columbia':'DC',florida:'FL',georgia:'GA',hawaii:'HI',idaho:'ID',illinois:'IL',indiana:'IN',iowa:'IA',kansas:'KS',kentucky:'KY',louisiana:'LA',maine:'ME',maryland:'MD',massachusetts:'MA',michigan:'MI',minnesota:'MN',mississippi:'MS',missouri:'MO',montana:'MT',nebraska:'NE',nevada:'NV','new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC','north dakota':'ND',ohio:'OH',oklahoma:'OK',oregon:'OR',pennsylvania:'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',tennessee:'TN',texas:'TX',utah:'UT',vermont:'VT',virginia:'VA',washington:'WA','west virginia':'WV',wisconsin:'WI',wyoming:'WY' };
const STATE_ABBRS = new Set(Object.values(US_STATE_ABBR));
function stateAbbr(s) { if (!s) return ''; s = s.trim(); if (s.length === 2 && STATE_ABBRS.has(s.toUpperCase())) return s.toUpperCase(); return US_STATE_ABBR[s.toLowerCase()] || (s.length === 2 ? s.toUpperCase() : s); }

// The keyword must be a whole word (\b on BOTH sides) so an abbreviation like
// "Fl" never matches inside a longer street name; plus a bare "#unit" form.
const UNIT_RE = /\b(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|trailer|dept|department)\b\.?\s*#?\s*([A-Za-z0-9-]+)|#\s*([A-Za-z0-9-]+)/i;

/** Pull an apartment/suite token out of a street string. Returns { line1, unit }. */
function splitUnit(street) {
  const s = String(street || '').trim();
  const m = s.match(UNIT_RE);
  if (!m) return { line1: s, unit: '' };
  const unit = (m[0].replace(/^#/, '# ').trim());
  const line1 = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s*,\s*$/, '').replace(/\s{2,}/g, ' ').trim().replace(/,\s*$/, '');
  return { line1: line1 || s, unit };
}

// county is captured for underwriting but is intentionally NOT part of the
// visible autocomplete label or oneLine — it lives in the backend record only.
const empty = () => ({ line1: '', unit: '', city: '', state: '', zip: '', county: '', country: 'US' });

/** Parse a free-text US address string into components. */
function parseAddress(raw) {
  const out = empty();
  if (!raw || typeof raw !== 'string') return out;
  let s = raw.replace(/\s+/g, ' ').trim().replace(/,?\s*(USA|United States)\.?$/i, '').trim();

  // ZIP at the end (5 or ZIP+4).
  const zip = s.match(/\b(\d{5}(?:-\d{4})?)\s*$/);
  if (zip) { out.zip = zip[1]; s = s.slice(0, zip.index).trim().replace(/,\s*$/, ''); }

  // State at the end (2-letter or full name).
  let st = s.match(/[,\s]([A-Za-z]{2})\s*$/);
  if (st && STATE_ABBRS.has(st[1].toUpperCase())) { out.state = st[1].toUpperCase(); s = s.slice(0, st.index).trim().replace(/,\s*$/, ''); }
  else {
    const full = Object.keys(US_STATE_ABBR).sort((a, b) => b.length - a.length).find(n => new RegExp('[,\\s]' + n + '\\s*$', 'i').test(s));
    if (full) { out.state = US_STATE_ABBR[full]; s = s.replace(new RegExp('[,\\s]' + full + '\\s*$', 'i'), '').trim().replace(/,\s*$/, ''); }
  }

  // Remaining: "street[, unit], city" or "street city".
  const parts = s.split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.city = parts[parts.length - 1];
    const streetPart = parts.slice(0, parts.length - 1).join(', ');
    const u = splitUnit(streetPart);
    out.line1 = u.line1; out.unit = u.unit;
    // A middle comma part that is purely a unit token also counts.
    if (!out.unit && parts.length >= 3) { const mid = splitUnit(parts[1]); if (mid.unit) { out.unit = mid.unit; out.line1 = parts[0]; } }
  } else if (parts.length === 1) {
    // No commas: last token before the (removed) state is likely the city.
    const u = splitUnit(parts[0]);
    out.unit = u.unit;
    const toks = u.line1.split(' ');
    if (out.state && toks.length > 2) { out.city = toks.pop(); out.line1 = toks.join(' '); }
    else { out.line1 = u.line1; }
  }
  return out;
}

/** Normalize a partial address object (autocomplete-sourced) — extract a unit
 *  embedded in line1 and 2-letter the state. */
function normalizeAddress(a) {
  const out = Object.assign(empty(), a || {});
  if (out.line1 && !out.unit) { const u = splitUnit(out.line1); out.line1 = u.line1; out.unit = u.unit; }
  out.state = stateAbbr(out.state);
  out.country = (out.country || 'US').toUpperCase();
  // convenient single-line form
  out.oneLine = [ [out.line1, out.unit].filter(Boolean).join(' '), out.city, [out.state, out.zip].filter(Boolean).join(' ') ].filter(Boolean).join(', ');
  return out;
}

// ===========================================================================
// CANONICAL ONE-LINE — the short "mailing" form PILOT shows and ClickUp stores
// ---------------------------------------------------------------------------
// Owner-reported 2026-07-26: subject/home addresses in PILOT turned into the
// raw geocoder display name —
//   "26, South 10th Street, Williamsburg, Brooklyn, Kings County, New York,
//    11249, United States"
// — instead of the mailing form the ClickUp location picker shows:
//   "26 S 10th St, Brooklyn, NY 11249, USA".
// The long string is OpenStreetMap Nominatim's `display_name` (neighbourhood +
// county + spelled-out state + "United States"), which the keyless geocode
// fallback wrote straight onto the record as `formatted_address` — and almost
// every reader prefers `formatted_address` over `oneLine`, so the long form
// won on every surface.
//
// These helpers are the ONE place that decides what a canonical one-line looks
// like: USPS-style abbreviations (Publication 28), borough/municipality naming,
// no county, no neighbourhood, 2-letter state, "USA" as the country — i.e. the
// exact shape Google/ClickUp produce. Pure: no DB, no network.
// ===========================================================================

const DIRECTIONALS = {
  north: 'N', south: 'S', east: 'E', west: 'W',
  northeast: 'NE', northwest: 'NW', southeast: 'SE', southwest: 'SW',
  n: 'N', s: 'S', e: 'E', w: 'W', ne: 'NE', nw: 'NW', se: 'SE', sw: 'SW',
};
// Common street suffixes only — an unknown suffix is left exactly as written
// (never guessed), so a street named "Newport Avenue Extension" or "The Circle"
// can't be mangled.
const STREET_SUFFIXES = {
  street: 'St', st: 'St', avenue: 'Ave', ave: 'Ave', av: 'Ave', road: 'Rd', rd: 'Rd',
  drive: 'Dr', dr: 'Dr', boulevard: 'Blvd', blvd: 'Blvd', lane: 'Ln', ln: 'Ln',
  court: 'Ct', ct: 'Ct', place: 'Pl', pl: 'Pl', terrace: 'Ter', ter: 'Ter',
  circle: 'Cir', cir: 'Cir', parkway: 'Pkwy', pkwy: 'Pkwy', highway: 'Hwy', hwy: 'Hwy',
  trail: 'Trl', trl: 'Trl', square: 'Sq', sq: 'Sq', turnpike: 'Tpke', tpke: 'Tpke',
  expressway: 'Expy', expy: 'Expy', freeway: 'Fwy', fwy: 'Fwy', alley: 'Aly', aly: 'Aly',
  plaza: 'Plz', plz: 'Plz', crossing: 'Xing', xing: 'Xing', extension: 'Ext', ext: 'Ext',
  heights: 'Hts', hts: 'Hts', junction: 'Jct', jct: 'Jct', landing: 'Lndg', lndg: 'Lndg',
  manor: 'Mnr', mnr: 'Mnr', ridge: 'Rdg', rdg: 'Rdg', cove: 'Cv', cv: 'Cv',
  point: 'Pt', pt: 'Pt', crescent: 'Cres', cres: 'Cres', gardens: 'Gdns', gdns: 'Gdns',
};
const wordKey = (t) => String(t || '').toLowerCase().replace(/[.,]/g, '');
const isHouseNumber = (t) => /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(String(t || '').trim());

/**
 * "26 South 10th Street" -> "26 S 10th St". Abbreviates the trailing street
 * suffix, a leading directional, and a trailing post-directional — the three
 * things Google shortens. A leading directional is only abbreviated when the
 * street still has a NAME of its own after it ("26 West Street" stays
 * "26 West St", because "W St" reads as gibberish).
 */
function abbreviateStreet(line1) {
  const s = String(line1 || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const toks = s.split(' ');
  // trailing post-directional ("10th St NW") — abbreviate but keep in place
  let post = null;
  if (toks.length >= 3 && DIRECTIONALS[wordKey(toks[toks.length - 1])]) post = toks.pop();
  // trailing suffix
  if (toks.length >= 2) {
    const ab = STREET_SUFFIXES[wordKey(toks[toks.length - 1])];
    if (ab) toks[toks.length - 1] = ab;
  }
  // leading directional (after the house number, if any)
  const i = isHouseNumber(toks[0]) ? 1 : 0;
  const dir = DIRECTIONALS[wordKey(toks[i])];
  if (dir && toks.length - i >= 3) toks[i] = dir;
  if (post) toks.push(DIRECTIONALS[wordKey(post)] || post);
  return toks.join(' ');
}

/**
 * Mailing city name. Geocoders return the legal municipality ("Lakewood
 * Township", "Village of Spring Valley"); the mail — and ClickUp/Google — use
 * the plain name ("Lakewood", "Spring Valley").
 */
function normalizeCityName(city) {
  const raw = String(city || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const out = raw
    .replace(/^(?:city|town|township|village|borough)\s+of\s+/i, '')
    .replace(/\s+(?:township|twp\.?|borough|village)$/i, '')
    .trim();
  return out || raw;   // never blank a city we were given
}

// NYC quirk (#93): geocoders label ALL FIVE boroughs with the municipality
// "New York", but USPS — and residents — use the BOROUGH as the mailing city:
// Brooklyn, Bronx, Staten Island, Queens. The one exception is Manhattan, whose
// mailing city really is "New York". Narrowly gated on locality === "New York",
// so no ordinary city is affected. (Shared with the autocomplete route.)
function preferBorough(locality, borough) {
  const city = String(locality || '').trim();
  const b = String(borough || '').replace(/^the\s+/i, '').trim();
  if (!city) return b;
  if (/^(city of )?new york$/i.test(city) && b && !/^manhattan$/i.test(b)) return b;
  return city;
}

/** OSM Nominatim `address` components -> our canonical address object. */
function osmComponentsToAddress(a = {}) {
  const line1 = [a.house_number, a.road].filter(Boolean).join(' ');
  return normalizeAddress({
    line1: line1 || a.neighbourhood || '',
    unit: '',
    city: normalizeCityName(preferBorough(a.city || a.town || a.village || a.hamlet || '',
      a.borough || a.city_district || a.suburb)),
    state: stateAbbr(a.state || ''),
    zip: a.postcode || '',
    county: (a.county || '').replace(/\s+County$/i, ''),   // backend only — never displayed
    country: (a.country_code || 'us').toUpperCase(),
  });
}

/**
 * Address components -> the canonical one-line.
 *   { line1:'26 South 10th Street', city:'Brooklyn', state:'NY', zip:'11249' }
 *   -> "26 S 10th St, Brooklyn, NY 11249"      (country:false)
 *   -> "26 S 10th St, Brooklyn, NY 11249, USA" (country:true — the ClickUp form)
 */
function canonicalOneLine(a, { country = false } = {}) {
  const addr = a || {};
  const street = [abbreviateStreet(addr.line1 || addr.street || ''), String(addr.unit || '').trim()]
    .filter(Boolean).join(' ');
  const city = normalizeCityName(addr.city);
  const tail = [stateAbbr(addr.state), String(addr.zip || '').trim()].filter(Boolean).join(' ');
  const parts = [street, city, tail].filter(Boolean);
  if (!parts.length) return '';
  const line = parts.join(', ');
  const cc = String(addr.country || 'US').toUpperCase();
  return country && (cc === 'US' || cc === 'USA') ? line + ', USA' : line;
}

/**
 * Does this string look like a raw geocoder display name rather than a mailing
 * address? Signatures, any one of which is conclusive:
 *   - the house number sits in its OWN comma part  ("26, South 10th Street, …")
 *   - a county component                            ("…, Kings County, …")
 *   - the country spelled out                       ("…, United States")
 * A Google/ClickUp `formatted_address` ("26 S 10th St, Brooklyn, NY 11249, USA")
 * matches none of them.
 */
function looksLikeProviderLongForm(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return false;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 4) return false;
  if (isHouseNumber(parts[0])) return true;
  if (parts.some((p) => /\bcounty$/i.test(p))) return true;
  if (/^united states(?: of america)?\.?$/i.test(parts[parts.length - 1])) return true;
  return false;
}

/**
 * Parse a geocoder display name into components. Deliberately NOT parseAddress:
 * the long form puts the house number in its own part and pads the middle with
 * neighbourhood/county parts, which parseAddress reads as street/city (that is
 * how "Kings County" ended up stored as the city).
 */
function parseProviderLongForm(text) {
  const out = empty();
  const parts = String(text || '').replace(/\s+/g, ' ').trim().split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return out;
  const last = () => parts[parts.length - 1];
  if (parts.length && /^(?:usa|united states(?: of america)?)\.?$/i.test(last())) { parts.pop(); out.country = 'US'; }
  if (parts.length && /^\d{5}(?:-\d{4})?$/.test(last())) out.zip = parts.pop();
  if (parts.length) {
    const st = stateAbbr(last());
    if (st && STATE_ABBRS.has(st)) { out.state = st; parts.pop(); }
  }
  // county / "County of X" parts are administrative, never part of the mail form
  const rest = parts.filter((p) => !/\bcounty$/i.test(p) && !/^county of\b/i.test(p));
  if (rest.length) {
    // house number in its own part -> it belongs with the road that follows
    if (isHouseNumber(rest[0]) && rest.length >= 2) out.line1 = rest.shift() + ' ' + rest.shift();
    else out.line1 = rest.shift();
    // everything between the road and the municipality is neighbourhood noise;
    // the LAST remaining part is the municipality.
    if (rest.length) out.city = normalizeCityName(rest[rest.length - 1]);
  }
  const u = splitUnit(out.line1);
  out.line1 = u.line1; out.unit = u.unit;
  return out;
}

/**
 * Any address string -> the canonical mailing one-line. A string that is
 * already in the mailing form is returned untouched (never re-shortened, never
 * blanked); only a provider long form is rewritten.
 */
function compactFormattedAddress(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s || !looksLikeProviderLongForm(s)) return s;
  const parsed = parseProviderLongForm(s);
  return canonicalOneLine(parsed, { country: /,\s*(?:usa|united states(?: of america)?)\.?$/i.test(s) }) || s;
}

/**
 * Repair a stored address VALUE (the jsonb we keep on applications /
 * borrowers / track records / leads) that a geocoder long form leaked into.
 * Returns the corrected value, or null when nothing needed changing — so
 * callers can skip the write entirely.
 *
 * Only ever fires on a record whose one-line IS a provider long form; a clean
 * record is left exactly as it is.
 */
function canonicalizeAddressValue(v) {
  if (!v) return null;
  if (typeof v === 'string') { const c = compactFormattedAddress(v); return c && c !== v ? c : null; }
  if (typeof v !== 'object' || Array.isArray(v)) return null;
  const long = looksLikeProviderLongForm(v.formatted_address) ? v.formatted_address
    : looksLikeProviderLongForm(v.oneLine) ? v.oneLine
      : looksLikeProviderLongForm(v.line1) ? v.line1 : null;
  if (!long) return null;
  const p = parseProviderLongForm(long);
  const out = { ...v };
  let changed = false;
  const set = (k, val) => { if (val && out[k] !== val) { out[k] = val; changed = true; } };
  // A component the long form poisoned: a street carrying commas, a city that is
  // really a county, or a component that was never filled in.
  if (!out.line1 || String(out.line1).includes(',')) set('line1', p.line1);
  if (!out.unit && p.unit) set('unit', p.unit);
  if (!out.city || /\bcounty$/i.test(String(out.city))) set('city', p.city);
  else set('city', normalizeCityName(out.city));
  if (!out.state) set('state', p.state);
  else set('state', stateAbbr(out.state));
  if (!out.zip) set('zip', p.zip);
  set('formatted_address', canonicalOneLine(out, { country: true }));
  set('oneLine', canonicalOneLine(out, { country: false }));
  return changed ? out : null;
}

/**
 * SEMANTIC state key — "New York" and "NY" are the SAME state.
 *
 * The SQL twin is `pilot_state_norm()` (db/326), used by the reopen trigger so
 * a re-spelling of an address (the address-format repair, a ClickUp import, a
 * geocoder) can never flag a registration stale and demand a pointless
 * re-register. KEEP THE TWO IN SYNC — scripts/test-address-format.js asserts
 * they agree on every sample.
 *
 * An unrecognized value compares to ITSELF (upper-cased, whitespace squeezed):
 * nothing is guessed into a state, so a new value can neither false-fire nor be
 * silently collapsed into another state. (Different from the conditions
 * engine's `normState`, which nulls an unknown because a RULE must not evaluate
 * on a value it can't read — a comparison and a rule need opposite defaults.)
 */
const STATE_CODES = new Set([...Object.values(US_STATE_ABBR), 'PR', 'VI', 'GU', 'AS', 'MP']);
const EXTRA_STATE_NAMES = { 'puerto rico': 'PR', 'virgin islands': 'VI', guam: 'GU' };
function stateCompareKey(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return null;
  const squeezed = raw.replace(/\s+/g, ' ');
  if (STATE_CODES.has(squeezed.toUpperCase())) return squeezed.toUpperCase();
  const named = US_STATE_ABBR[squeezed.toLowerCase()] || EXTRA_STATE_NAMES[squeezed.toLowerCase()];
  return named || squeezed.toUpperCase();
}

module.exports = {
  parseAddress, normalizeAddress, splitUnit, stateAbbr, stateCompareKey,
  abbreviateStreet, normalizeCityName, preferBorough, osmComponentsToAddress,
  canonicalOneLine, looksLikeProviderLongForm, parseProviderLongForm,
  compactFormattedAddress, canonicalizeAddressValue,
};
