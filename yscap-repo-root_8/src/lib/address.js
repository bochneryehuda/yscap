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
// A bare house number — 12, 12A, 27-29, 12/14. Used by splitUnit's street-name
// guard AND by the parser, so it is declared above both (const is not hoisted).
const isHouseNumber = (t) => /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(String(t || '').trim());

const UNIT_RE = /\b(?:apt|apartment|unit|ste|suite|fl|floor|rm|room|bldg|building|lot|trlr|trailer|dept|department)\b\.?\s*#?\s*([A-Za-z0-9-]+)|#\s*([A-Za-z0-9-]+)/i;

/**
 * Pull an apartment/suite token out of a street string. Returns { line1, unit }.
 *
 * A STREET WHOSE NAME IS A UNIT KEYWORD MUST NOT BE EATEN. "5 Building Rd" and
 * "5 Room Rd" both matched `\b(building|room)\b\s*(\S+)`, so the STREET NAME went
 * into `unit` and `line1` came back as the bare house number "5" — and every
 * property on either road collapsed to one key, `5|rd|newark|nj`. Two different
 * streets merged into one property, which is the single worst thing this
 * codebase's address handling can do.
 *
 * `withoutUnit` has carried exactly this guard since 2026-07-27 and documents the
 * same failure; it belongs HERE, at the split itself, so every caller inherits it
 * rather than each one re-discovering the trap. If the split leaves nothing but a
 * house number, the keyword was part of the street name and no unit was found.
 */
function splitUnit(street) {
  const s = String(street || '').trim();
  const m = s.match(UNIT_RE);
  if (!m) return { line1: s, unit: '' };
  const unit = (m[0].replace(/^#/, '# ').trim());
  const line1 = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s*,\s*$/, '').replace(/\s{2,}/g, ' ').trim().replace(/,\s*$/, '');
  if (!line1 || isHouseNumber(line1)) return { line1: s, unit: '' };
  return { line1, unit };
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
    // A STREET SUFFIX IS NOT A TOWN. "100 Broadway Ave, NJ" has no town in it at
    // all, and popping the last token read "Ave" as the city — which then looked
    // like a complete address to everything downstream. A geocoder handed
    // "100 Broadway, Ave, NJ" does not object: it answers with 100 Broadway in
    // whichever New Jersey town it finds first, at full address precision, and the
    // result is a confident pin on a house nobody named (measured: "15 Elm Road,
    // NY" came back placed at 15 ELM ST, ALBANY). Leaving the suffix on the street
    // and the town empty is the honest reading, and an empty town is something a
    // caller can refuse.
    if (out.state && toks.length > 2 && !STREET_SUFFIXES[wordKey(toks[toks.length - 1])]) {
      out.city = toks.pop(); out.line1 = toks.join(' ');
    } else { out.line1 = u.line1; }
  }
  return out;
}

/**
 * Coerce a track-record address VALUE into the canonical stored object shape
 * `{ line1, unit, city, state, zip, oneLine }` that every reader expects
 * (the tool bridge `propFromRow` reads `.street||.line1||.oneLine`; the to-do
 * `addressOf` and `trackRecordAddressText` read `.oneLine` first).
 *
 * The public-records importer feeds this a bare one-line STRING (elementix
 * `shapes.js` flattens `addresses[{addressFull}]` to a one-liner), which is why
 * an imported line showed "(no address)": a JS string has no `.line1`/`.city`.
 * A string is PARSED into parts, and its verbatim text is kept as `oneLine` —
 * the authoritative display form, so display fidelity never depends on the
 * parse. An object is returned unchanged (the tool / ClickUp / Encompass writers
 * already produce the canonical shape). Null/blank → null.
 */
function parseToAddressObject(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return Array.isArray(v) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  const p = parseAddress(s);
  return {
    line1: p.line1 || '', unit: p.unit || '',
    city: p.city || '', state: p.state || '', zip: p.zip || '',
    oneLine: s,
  };
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
  // The COUNTRY is deliberately never appended (owner-directed 2026-07-26
  // evening: "we don't need the USA — our address should finish with the zip
  // code"). Encompass, the mailing form and most of our own surfaces stop at the
  // ZIP, and a trailing country was the single most common cosmetic difference
  // in the review queue. `country` is accepted (and ignored) so existing callers
  // keep working; comparisons strip a country on BOTH sides regardless, so a
  // value that still carries one — an older record, a ClickUp import — is never
  // read as a different address.
  return line;
}

/**
 * Strip an apartment/suite/unit suffix for a GEOCODER lookup. A geocoder resolves
 * a BUILDING, not an apartment — and a unit token ("Apartment 6B", "Unit 4D",
 * "#3") makes some providers (notably the keyless OSM Nominatim fallback) return
 * NO MATCH for an address that resolves cleanly without it (owner-reported
 * 2026-07-27: the borrower home address "1254 42nd St Apartment 6B, Brooklyn, NY
 * 11219" could not be placed on the map, so it never reached ClickUp). The
 * coordinates are building-level regardless of the unit, so dropping it for the
 * lookup loses nothing. Only strips when a unit is actually DETECTED — otherwise
 * the input is returned unchanged. Returns the clean mailing one-line (same form
 * we push).
 */
function withoutUnit(text) {
  const s = String(text || '').trim();
  if (!s) return s;
  const p = parseAddress(s);
  if (!p || !p.unit || !p.line1) return s;   // no unit found → leave the input untouched
  // Guard a FALSE unit-detection: a street whose NAME is a unit keyword ("5 Floor
  // Ave", "100 Lot 5") makes parseAddress swallow the street into `unit`, leaving
  // line1 as just the house number. Stripping then yields a wrong geocode query
  // ("5, Nowhere, NY …"), reintroducing the very failure this fixes. If the parse
  // ate the street, don't strip — geocode the full text as before.
  if (isHouseNumber(p.line1.trim())) return s;
  const rebuilt = canonicalOneLine({ line1: p.line1, city: p.city, state: p.state, zip: p.zip });
  return rebuilt || s;
}

/**
 * Re-insert a unit into a mailing one-line after the street (the first comma
 * part), unless the line already carries it. Pairs with withoutUnit: we geocode
 * the BUILDING (unit stripped so it resolves) but keep the apartment on the value
 * we STORE and DISPLAY — "1254 42nd St, Brooklyn, NY 11219" + "Apt 6B" →
 * "1254 42nd St Apt 6B, Brooklyn, NY 11219". Idempotent (a line that already
 * names the unit is returned unchanged).
 */
function withUnit(oneLine, unit) {
  const line = String(oneLine || '').trim();
  const u = String(unit || '').trim();
  if (!line || !u) return line;
  const i = line.indexOf(',');
  const street = i === -1 ? line : line.slice(0, i);
  const compact = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const cs = compact(street), cu = compact(u);
  // Already carries the unit only when the STREET segment (where withUnit puts it)
  // ENDS with it — anchoring on the street end, not a whole-line substring, so a
  // bare-numeric unit ("6") is never falsely matched by a digit elsewhere in the
  // address (a house number / ZIP), which would drop it.
  if (cu && (cs === cu || cs.endsWith(cu))) return line;
  return i === -1 ? `${line} ${u}` : `${line.slice(0, i)} ${u}${line.slice(i)}`;
}

/** The house number a street line STARTS with ("1727 S 2nd St" -> "1727"), or ''. */
function houseNumberOf(line1) {
  const t = String(line1 || '').trim().split(' ').filter(Boolean)[0];
  return isHouseNumber(t) ? String(t).toUpperCase() : '';
}

/**
 * The leading directional on a street ("1727 S 2nd St" -> "S"), or ''.
 *
 * Threshold note: `abbreviateStreet` needs THREE tokens before it will shorten a
 * directional ("26 West St" must stay "26 West St", because "26 W St" reads as
 * gibberish). Here TWO is right, because this is only ever used to compare two
 * spellings of the same address and it is applied to BOTH sides — so "26 West St"
 * and "26 W St" both report 'W' and still match, while a genuinely dropped
 * directional ("5 S Main" -> "5 Main") is still caught.
 */
function leadingDirectionalOf(line1) {
  const toks = String(line1 || '').trim().split(' ').filter(Boolean);
  if (!toks.length) return '';
  const i = isHouseNumber(toks[0]) ? 1 : 0;
  if (toks.length - i < 2) return '';   // a one-word street IS the name, not a directional
  return DIRECTIONALS[wordKey(toks[i])] || '';
}

/**
 * May a GEOCODER's answer REPLACE our own address text?
 *
 * Owner-reported 2026-07-28: the subject address on YSCAP258134762 was rewritten
 * by our own ClickUp push, over and over, from
 *   "1727 S 2nd St, Piscataway, NJ 08854"   (the real property)
 * to
 *   "2nd St, Piscataway, NJ 07063"          (a DIFFERENT street, in Plainfield)
 * — and the corrupted value then came back INBOUND from the card, so correcting
 * it in PILOT never stuck.
 *
 * ROOT CAUSE: a geocode is a request for COORDINATES, but `withCoords` adopted the
 * provider's `formatted_address` unconditionally. Nominatim (and Google) answer a
 * house number they cannot place with the ROAD it sits on — a match with no
 * `house_number` and the ROAD's own postcode. Verified live: querying that exact
 * address returns `addresstype: "road"`, `display_name: "2nd Street, Piscataway
 * Township, …, 07063"`. So the "answer" silently dropped the house number AND
 * re-ZIPped the property, and we wrote it to the card as fact.
 *
 * This is the guard that makes the class impossible, whatever the provider: a
 * geocoder may only RESTYLE an address (abbreviate, add a missing ZIP, fix the
 * city), never contradict it. Refuses when the provider
 *   - dropped or changed the HOUSE NUMBER   ("1727 S 2nd St" -> "2nd St")
 *   - disagrees on a ZIP we already hold    (08854 -> 07063)
 *   - dropped a leading DIRECTIONAL we had  ("S 2nd St" -> "2nd St" is another street)
 * Everything a good geocode legitimately does still passes: "26 South 10th Street,
 * Brooklyn, NY 11249" -> "26 S 10th St, Brooklyn, NY 11249" is safe, and so is
 * filling in a ZIP we never had. Pure: no DB, no network.
 */
function geocodeRewriteIsSafe(ours, provider) {
  const p = String(provider || '').trim();
  if (!p) return false;                 // nothing offered
  const o = String(ours || '').trim();
  if (!o) return true;                  // nothing of ours to lose

  const a = parseAddress(o), b = parseAddress(p);

  // 1. the house number identifies the PROPERTY — it may never be dropped or moved
  const ha = houseNumberOf(a.line1);
  if (ha && ha !== houseNumberOf(b.line1)) return false;

  // 2. never silently re-ZIP a property (only compare when BOTH sides state one,
  //    so a provider FILLING a missing ZIP is still welcome)
  const five = (z) => String(z || '').trim().slice(0, 5);
  const za = five(a.zip), zb = five(b.zip);
  if (za && zb && za !== zb) return false;

  // 3. "S 2nd St" and "2nd St" are two different streets in the same town
  const da = leadingDirectionalOf(a.line1);
  if (da && da !== leadingDirectionalOf(b.line1)) return false;

  return true;
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
  return canonicalOneLine(parsed) || s;
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
  const line = canonicalOneLine(out);
  set('formatted_address', line);
  set('oneLine', line);
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


// ===========================================================================
// SAME-ADDRESS COMPARISON — "is this the same place?", not "is this the same
// string?" (owner-reported 2026-07-26 evening: 54 sync-review rows where both
// sides were plainly the same address).
// ---------------------------------------------------------------------------
// Encompass writes "5701 15 Ave 4D, Brooklyn, NY 11219"; PILOT holds
// "5701 15th Ave Apt 4d, Brooklyn, NY 11219, USA". Same home. Every comparison
// in the system used a "strip the punctuation and compare the letters" key, so
// EVERY such pair read as a disagreement and queued a manual review nobody can
// act on. This is the ONE place that decides whether two addresses are the same
// place; every comparer (Encompass enrichment, the sync-review re-check, the
// ClickUp no-op suppression) calls it.
//
// IGNORED (pure spelling of the same address):
//   trailing country, case, punctuation, ZIP+4, "Avenue"/"Ave", "South"/"S",
//   ordinal suffixes ("15 Ave" = "15th Ave", and a typo'd "61th" = "61st"),
//   unit KEYWORDS ("Apt 5B" = "Unit 5B" = "#5b" = "5B"), a leading descriptive
//   part ("Bedford Gardens, 74 Ross St"), a doubled or missing municipality, and
//   the CITY NAME when both sides carry the same ZIP (the ZIP is the authority:
//   Cedarhurst/Hempstead, Spring Valley/Ramapo, Jackson/Jackson Township are the
//   same place — that difference is a mailing-vs-municipality naming choice).
//
// NEVER IGNORED (a real difference a human must settle):
//   a different house number (755 vs 702 Bedford), a different street
//   (34 Baila Dr vs 5 14th St), a different ZIP (08701 vs 08071, 10950 vs
//   10350 — usually a typo worth fixing), a different state, and two units that
//   are both present and DIFFERENT (Apt 3L vs Apt 5B).
//
// One side missing the unit entirely is NOT a conflict: it is the same address
// written with less detail, and the review offered no decision to make.
// ===========================================================================

// Unit keywords, including the forms Encompass uses.
const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'ste', 'suite', 'fl', 'floor', 'rm', 'room',
  'bldg', 'building', 'lot', 'trlr', 'trailer', 'dept', 'department', 'condo', 'no', 'num', 'number']);
// Street-type words whose PRESENCE is optional when the rest matches
// ("100 Whisper Vlg" = "100 Whisper Vlg Wy"). Deliberately EXCLUDES
// extension/ext — "Oak Street" and "Oak Street Extension" are different streets
// (the SharePoint matcher depends on that distinction too).
const OPTIONAL_TYPE = new Set(['st', 'street', 'ave', 'avenue', 'av', 'rd', 'road', 'dr', 'drive',
  'ln', 'lane', 'ct', 'court', 'pl', 'place', 'blvd', 'boulevard', 'ter', 'terr', 'terrace',
  'cir', 'circle', 'pkwy', 'parkway', 'hwy', 'highway', 'way', 'wy', 'trl', 'trail', 'sq', 'square',
  'plz', 'plaza', 'ct', 'cv', 'cove', 'loop', 'row', 'walk', 'path', 'run', 'pt', 'point']);
// Canonical spelling for every street-type / directional token, so "Avenue",
// "Ave" and "Av" collapse to one word before comparing.
const TYPE_CANON = {
  st: 'street', str: 'street', street: 'street', ave: 'avenue', av: 'avenue', avenue: 'avenue',
  rd: 'road', road: 'road', dr: 'drive', drive: 'drive', ln: 'lane', lane: 'lane',
  ct: 'court', court: 'court', pl: 'place', place: 'place', blvd: 'boulevard', boulevard: 'boulevard',
  ter: 'terrace', terr: 'terrace', terrace: 'terrace', cir: 'circle', circle: 'circle',
  pkwy: 'parkway', parkway: 'parkway', hwy: 'highway', highway: 'highway', wy: 'way', way: 'way',
  trl: 'trail', trail: 'trail', sq: 'square', square: 'square', plz: 'plaza', plaza: 'plaza',
  tpke: 'turnpike', turnpike: 'turnpike', hts: 'heights', heights: 'heights', pt: 'point', point: 'point',
  cv: 'cove', cove: 'cove', xing: 'crossing', crossing: 'crossing', jct: 'junction', junction: 'junction',
  n: 'north', north: 'north', s: 'south', south: 'south', e: 'east', east: 'east', w: 'west', west: 'west',
  ne: 'northeast', northeast: 'northeast', nw: 'northwest', northwest: 'northwest',
  se: 'southeast', southeast: 'southeast', sw: 'southwest', southwest: 'southwest',
};

/** Any stored address shape -> the best one-line text we can compare. */
function addressTextOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v !== 'object') return '';
  const pick = (x) => (typeof x === 'string' && x.trim() ? x.trim() : '');
  const direct = pick(v.formatted_address) || pick(v.formattedAddress) || pick(v.oneLine) || pick(v.address);
  if (direct) return direct;
  const street = [pick(v.line1) || pick(v.street), pick(v.unit)].filter(Boolean).join(' ');
  const tail = [pick(v.state), pick(v.zip)].filter(Boolean).join(' ');
  return [street, pick(v.city), tail].filter(Boolean).join(', ');
}

/* A NUMBERED STREET IS THE SAME STREET HOWEVER IT IS SPELLED.
 *
 * "15th" -> "15", "61th" -> "61" (a typo for 61st is the same street) — and,
 * added 2026-08-09 after a live miss, the WORD form too: a county clerk writes
 * "SECOND STREET", the vendor returns "2ND ST", and a borrower types "2nd St".
 * Without this they are three different streets, which in a book concentrated
 * in Brooklyn and Lakewood — where a large share of addresses ARE numbered
 * streets — is a routine false mismatch, and a false mismatch here does not
 * merely fail to match: it stages a DUPLICATE candidate for a property already
 * on the record.
 *
 * Only ever applied to a whole token, so "Secondary Rd" and "Fortieth Manor"
 * (a real name, not a number) are untouched — a token that IS the number word
 * and nothing else. Compounds are handled by the caller joining the parts, so
 * "Twenty First" and "Twenty-First" both reach here as two tokens and become
 * "21" via the tens + unit combination below.
 */
const ORDINAL_WORD = {
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
  sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
  eleventh: '11', twelfth: '12', thirteenth: '13', fourteenth: '14', fifteenth: '15',
  sixteenth: '16', seventeenth: '17', eighteenth: '18', nineteenth: '19', twentieth: '20',
  thirtieth: '30', fortieth: '40', fiftieth: '50', sixtieth: '60',
  seventieth: '70', eightieth: '80', ninetieth: '90', hundredth: '100',
};
/* The TENS PREFIX of a compound ("twenty first"). Cardinal, not ordinal, because
 * only the last word of a compound ordinal carries the ordinal ending. */
const TENS_WORD = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const dropOrdinal = (t) => {
  const s = t.replace(/^(\d+)(?:st|nd|rd|th)$/i, '$1');
  if (s !== t) return s;
  /* Strip the hyphen so "Twenty-First" is read as one number word. The token
     loop folds the SPACED form ("Twenty First"); a hyphen makes it arrive here
     as a single token instead, and both spellings are ordinary on a deed. */
  const w = String(t || '').toLowerCase().replace(/[^a-z]/g, '');
  if (Object.prototype.hasOwnProperty.call(ORDINAL_WORD, w)) return ORDINAL_WORD[w];
  const m = w.match(/^(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth)$/);
  if (m) return String(TENS_WORD[m[1]] + Number(ORDINAL_WORD[m[2]]));
  return t;
};
const alnum = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Split any address into the pieces that decide identity.
 * Returns { house, street, streetBase, unit, city, state, zip } — all lowercase
 * comparison keys, '' when absent. Never throws.
 */
function parseAddressParts(v) {
  const out = { house: '', street: '', streetBase: '', unit: '', city: '', state: '', zip: '' };
  let s = addressTextOf(v).replace(/\s+/g, ' ').trim();
  if (!s) return out;
  // country off the end, then ZIP (+4 collapsed), then state
  s = s.replace(/,?\s*(?:u\.?s\.?a\.?|united states(?: of america)?)\.?\s*$/i, '').replace(/,\s*$/, '').trim();
  const zipM = s.match(/\b(\d{5})(?:-\d{4})?\s*$/);
  if (zipM) { out.zip = zipM[1]; s = s.slice(0, zipM.index).replace(/[,\s]+$/, ''); }
  const stM = s.match(/[,\s]([A-Za-z]{2})\s*$/);
  if (stM && STATE_ABBRS.has(stM[1].toUpperCase())) { out.state = stM[1].toUpperCase(); s = s.slice(0, stM.index).replace(/[,\s]+$/, ''); }
  else {
    const full = Object.keys(US_STATE_ABBR).sort((a, b) => b.length - a.length)
      .find((n) => new RegExp('[,\\s]' + n + '\\s*$', 'i').test(s));
    if (full) { out.state = US_STATE_ABBR[full]; s = s.replace(new RegExp('[,\\s]' + full + '\\s*$', 'i'), '').replace(/[,\s]+$/, ''); }
  }

  let parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return out;
  // A leading descriptive part is noise: "Bedford Gardens, 74 Ross St #1h",
  // "Right side, Back door, 22 Jefferson Ave". Start at the first part that
  // begins with a house number; if none does, keep everything.
  const startsWithNumber = (p) => isHouseNumber(String(p).split(' ')[0]);
  const firstNum = parts.findIndex(startsWithNumber);
  if (firstNum > 0) parts = parts.slice(firstNum);

  let streetPart = parts.shift() || '';
  // The LAST remaining part is the municipality; anything between it and the
  // street is a unit ("175 Hooper St, 1, Brooklyn") or neighbourhood noise.
  if (parts.length) {
    out.city = normalizeCityName(parts.pop()).toLowerCase();
    for (const mid of parts) {
      const m = String(mid).trim();
      const w = alnum(m.split(' ')[0]);
      if (UNIT_WORDS.has(w) || /^[#]?[A-Za-z]?\d+[A-Za-z]?$/.test(m) || m.length <= 4) {
        if (!out.unit) out.unit = alnum(m.replace(new RegExp('^(?:' + [...UNIT_WORDS].join('|') + ')\\.?\\s*', 'i'), ''));
      }
    }
  }

  // House number off the front of the street part.
  let toks = streetPart.split(' ').filter(Boolean);
  // Keep the hyphen: "218-222" is a RANGE, and houseMatches needs to see it.
  if (toks.length && isHouseNumber(toks[0])) out.house = String(toks.shift()).toLowerCase().replace(/[^a-z0-9-]/g, '');

  // Unit inside the street part: an explicit keyword/# form...
  const rest = toks.join(' ');
  const uM = rest.match(UNIT_RE);
  if (uM) {
    const token = (uM[1] || uM[2] || '').trim();
    if (token && !out.unit) out.unit = alnum(token);
    // a "#"/keyword with NOTHING after it ("1341 40th St #", "1220 43rd St Apt")
    // is an empty unit slot — treated as "no unit", never as a difference.
    toks = (rest.slice(0, uM.index) + ' ' + rest.slice(uM.index + uM[0].length)).split(' ').filter(Boolean);
  }
  // Any unit KEYWORD inside the street tokens splits it: everything after the
  // keyword is the unit ("…Skillman St Condo 8 B" -> unit "8b"). Covers the
  // words UNIT_RE doesn't (condo, no., number) and multi-token units.
  {
    const at = toks.findIndex((t) => UNIT_WORDS.has(alnum(t)));
    if (at > 0) {
      const after = toks.slice(at + 1).map(alnum).join('');
      if (after && !out.unit) out.unit = after;
      toks = toks.slice(0, at);
    }
  }
  // A trailing unit keyword with NOTHING after it ("1220 43rd St Apt",
  // "18 Hammond St Unit") is an empty slot — drop it, never let it become
  // part of the street name.
  while (toks.length && UNIT_WORDS.has(alnum(toks[toks.length - 1]))) toks.pop();
  // ...or a bare trailing token after a street type ("142 Clymer Street 2",
  // "814 Bedford Ave 5B"). Only when a street type was actually seen, so a
  // street name's own last word is never eaten.
  if (toks.length >= 2) {
    const last = alnum(toks[toks.length - 1]);
    const prev = alnum(toks[toks.length - 2]);
    const prevIsType = !!TYPE_CANON[prev] && OPTIONAL_TYPE.has(prev);
    if (prevIsType && last && last.length <= 4 && /\d/.test(last) === /\d/.test(last)) {
      if (!/^\d{5}$/.test(last)) { if (!out.unit) out.unit = last; toks.pop(); }
    }
  }

  /* "Twenty First St" and "Twenty-First St" both arrive as two tokens, so the
     tens word and the unit ordinal are folded together BEFORE the per-token
     pass — otherwise "twenty" survives as a word and the street reads
     "twenty1st", matching neither "21st" nor itself written the other way.
     Only a tens word IMMEDIATELY followed by a 1–9 ordinal is folded, so
     "Twenty Oaks Ln" and a street that merely starts with a number word are
     untouched. */
  const folded = [];
  for (let i = 0; i < toks.length; i += 1) {
    const tens = TENS_WORD[String(toks[i] || '').toLowerCase().replace(/[^a-z]/g, '')];
    const nextOrd = i + 1 < toks.length ? Number(dropOrdinal(String(toks[i + 1] || '').replace(/[^a-z0-9]/gi, ''))) : NaN;
    if (tens && Number.isInteger(nextOrd) && nextOrd >= 1 && nextOrd <= 9) { folded.push(String(tens + nextOrd)); i += 1; }
    else folded.push(toks[i]);
  }
  const norm = folded.map((t) => { const k = alnum(dropOrdinal(t)); return TYPE_CANON[k] || k; }).filter(Boolean);
  out.street = norm.join('');
  const tail = norm[norm.length - 1];
  out.streetBase = (norm.length > 1 && tail && OPTIONAL_TYPE.has(tail)) ? norm.slice(0, -1).join('') : out.street;
  return out;
}

/** House numbers match — including a range that starts at the other's number
 *  ("27-29 Tuscany Ter" is "27 Tuscany Ter"; "218-222 Skillman" is "218"). */
function houseMatches(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  // A HYPHEN IS NOT ALWAYS A RANGE, AND READING IT AS ONE MERGED REAL HOMES.
  // In Queens, the Bronx, much of Philadelphia and Hawaii, a hyphenated house
  // number is ONE number — the prefix is the nearest cross-street — so "150-25
  // 78th Rd" and "150-99 78th Rd" are two different houses that merely share a
  // prefix. Matching on ANY shared endpoint made them the same address, and so
  // were "61-20 Grand Ave" and "20-61 Grand Ave". This comparer gates USPS
  // stamping and the closing of sync reviews, and its whole stated discipline is
  // to UNDER-match — so a review about one property could be closed by another.
  //
  // The range case this exists for always has a BARE number on one side ("27-29
  // Tuscany Ter" IS "27 Tuscany Ter"; "218-222 Skillman" IS "218 Skillman" — one
  // building written two ways). Two hyphenated numbers that are not identical are
  // simply two different houses, and no arithmetic can tell a genuine span from a
  // Queens number: "27-29" and "61-63" are the same shape.
  const A = String(a), B = String(b);
  if (A.includes('-') && B.includes('-')) return false;
  const ends = (x) => String(x).split('-').filter(Boolean);
  return ends(A).some((v) => ends(B).includes(v));
}

/**
 * Are these two addresses the SAME PLACE? Conservative: anything it cannot read
 * on both sides (no house number, no street) returns false, so a review is kept
 * rather than silently closed. Pure; never throws.
 */
function sameAddress(a, b) {
  try {
    const x = parseAddressParts(a), y = parseAddressParts(b);
    if (!x.house || !y.house || !x.street || !y.street) return false;
    if (!houseMatches(x.house, y.house)) return false;
    const streetOk = x.street === y.street
      || (!!x.streetBase && x.streetBase === y.streetBase && (x.street === x.streetBase || y.street === y.streetBase));
    if (!streetOk) return false;
    if (x.state && y.state && x.state !== y.state) return false;
    // The ZIP is the authority on locality. Only when one side has no ZIP does
    // the city name have to agree.
    if (x.zip && y.zip) { if (x.zip !== y.zip) return false; }
    else if (x.city && y.city && x.city !== y.city) return false;
    // Both units present and different = a real disagreement. One side blank =
    // the same address written with less detail.
    if (x.unit && y.unit && x.unit !== y.unit) return false;
    return true;
  } catch (_) { return false; }
}

/** Stable key for grouping/deduping addresses: house|street|zip. Unit- and
 *  city-free by design (see sameAddress). '' when unreadable. */
function addressCompareKey(v) {
  try {
    const p = parseAddressParts(v);
    if (!p.house || !p.street) return '';
    return [p.house, p.streetBase || p.street, p.zip].join('|');
  } catch (_) { return ''; }
}

module.exports = {
  parseAddress, parseToAddressObject, normalizeAddress, splitUnit, stateAbbr, stateCompareKey,
  parseAddressParts, sameAddress, addressCompareKey, addressTextOf,
  abbreviateStreet, normalizeCityName, preferBorough, osmComponentsToAddress,
  canonicalOneLine, withoutUnit, withUnit, looksLikeProviderLongForm, parseProviderLongForm,
  compactFormattedAddress, canonicalizeAddressValue,
  geocodeRewriteIsSafe, houseNumberOf, leadingDirectionalOf,
};
