'use strict';
/**
 * THE PROPERTY IDENTITY KEY — how the research database decides that two address
 * lines on two different appraisals are the SAME house (db/409).
 *
 * PURE, DETERMINISTIC, OFFLINE. No network, no API key, no cache. That is a hard
 * requirement, not a convenience: the warehouse ingests every appraisal we have
 * ever imported (thousands of comparable rows), it runs inside a boot back-fill,
 * and `lib/address-canon` — the Google place_id resolver this repo uses for
 * loan-file address comparison — costs one HTTP round trip per distinct string
 * and returns null with no key configured. A warehouse that cannot dedupe
 * without a vendor is a warehouse that silently stores every property twice.
 *
 * What the key folds together (all of these are ONE property):
 *     "26 South 10th Street, Piscataway, NJ 08854"
 *     "26 S 10th St, Piscataway, New Jersey"
 *     "26 S. 10th St. #2, PISCATAWAY, nj 08854-1234"   (unit kept, see below)
 *
 * WHAT IT DELIBERATELY WILL NOT DO:
 *   • It never drops the UNIT. Unit 2 and Unit 5 of the same building are two
 *     properties that sell for different prices — folding them together would
 *     corrupt every price-per-foot read in the comparable search.
 *   • It never keys on ZIP when a city is present. A property routinely appears
 *     with ZIP+4 on one report, no ZIP on the next, and an occasional wrong ZIP;
 *     keying on it splits one house into three. ZIP is the fallback locality
 *     ONLY when the report gave no city.
 *   • It returns null rather than guess. No house number (a bare street name),
 *     no state, or no locality at all → no key, and the caller SKIPS the row
 *     instead of inventing a property. "26 S 10th St" with nothing else is not
 *     an address, and a warehouse full of half-addresses is worse than a smaller
 *     one that is right.
 */
const ADDR = require('../address');

const collapse = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** Lowercase, strip punctuation that never distinguishes two addresses. */
function tokenKey(s) {
  return collapse(s).toLowerCase().replace(/[.,'’]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * "Unit 4B" / "#4B" / "Apt. 4-B" / "Ste 200" → "4b" / "4-b" / "ste200".
 *
 * THE KIND WORD IS NOT ALWAYS NOISE. Stripping every one of them collapsed
 * `Apt 5`, `Suite 5`, `Floor 5`, `Building 5` and `Lot 5` into the same key `5` —
 * so in a mixed-use building the commercial Suite 5 and the residential Apt 5
 * became one property, and a whole BUILDING 5 became one of its own apartments.
 *
 * But keeping every kind distinct is worse in the other direction, and far more
 * often: `Apt 5`, `Unit 5`, `#5` and a bare `5` are the same apartment written by
 * five different appraisers, and splitting those would fracture the corpus on its
 * commonest variation.
 *
 * So the DWELLING words form ONE equivalence class (they are synonyms for "the
 * apartment") and drop out, while a kind that names a genuinely DIFFERENT thing —
 * a suite, a floor, a room, a building, a lot — is KEPT as a canonical prefix.
 * `Ste 200` and `Suite 200` still agree; `Ste 200` and `Apt 200` no longer do.
 */
const DWELLING_WORDS = /^(unit|apt|apartment|trlr|trailer|condo|no|num|number|#)\s*\.?\s*/i;
// LONGEST SPELLING FIRST, and `\b` after it. Without both, `fl|floor` matched the
// "Fl" inside "Floor 5" and left "oor 5" behind, so the key came out `floor5` —
// which LOOKS right and is actually the prefix 'fl' glued to the debris 'oor5',
// and would never match a file that wrote "Fl 5".
const KEPT_KINDS = [
  [/^(suite|ste)\b\s*\.?\s*/i, 'ste'],
  [/^(floor|fl)\b\s*\.?\s*/i, 'fl'],
  [/^(room|rm)\b\s*\.?\s*/i, 'rm'],
  [/^(building|bldg)\b\s*\.?\s*/i, 'bldg'],
  [/^(lot)\b\s*\.?\s*/i, 'lot'],
  [/^(department|dept)\b\s*\.?\s*/i, 'dept'],
];
function unitKey(raw) {
  let u = collapse(raw).replace(/^#\s*/, '');
  // A KEPT kind is read once, from the front, and becomes the prefix. Read before
  // the dwelling words so "Building 5" is a building rather than a bare 5.
  let kind = '';
  for (const [re, canon] of KEPT_KINDS) {
    if (re.test(u)) { kind = canon; u = u.replace(re, ''); break; }
  }
  if (!kind) { let prev; do { prev = u; u = u.replace(DWELLING_WORDS, ''); } while (u !== prev); }
  const rest = tokenKey(u).replace(/\s+/g, '');
  return rest ? kind + rest : '';
}

/** Is the first token a house number? A street with none is a ROAD, not a property. */
function hasHouseNumber(line1) {
  const t = collapse(line1).split(' ').filter(Boolean)[0];
  return /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?$/.test(String(t || ''));
}

const zip5 = (z) => {
  const m = /(\d{5})/.exec(String(z == null ? '' : z));
  return m ? m[1] : '';
};

/**
 * Normalize whatever an appraisal row gave us into address parts.
 * Accepts a free-text one-liner OR a parts object; a street that CONTAINS commas
 * is re-parsed as a one-liner, because some vendors put the whole address in the
 * street field even though MISMO has separate elements for city/state/ZIP.
 */
function normalizeParts(input) {
  let src = input || {};
  if (typeof input === 'string') src = { street: input };
  let street = collapse(src.street || src.line1 || src.address || '');
  let city = collapse(src.city || '');
  // A town we are INFERRING rather than reading — today, the subject's town lent
  // to a comparable that named none (gated on the ZIPs matching, see ingest.js).
  // It is applied LAST, after the packed-street parse below, because a town the
  // comparable actually WROTE — even buried inside its own address line — must
  // always beat one we inherited. Passing it as `city` put it in front of that
  // parse and filed the house in the wrong town, creating the very split the
  // inheritance exists to close.
  const fallbackCity = collapse(src.fallbackCity || '');
  let state = collapse(src.state || '');
  let zip = collapse(src.zip || src.postal_code || '');
  let unit = collapse(src.unit || '');
  const county = collapse(src.county || '');

  // A comma in the street means the vendor packed the whole address into it.
  // Take the parsed city/state/ZIP only for the pieces we do not already have —
  // the explicit XML elements always win over anything re-parsed out of prose.
  if (street.includes(',')) {
    const p = ADDR.parseAddress(street);
    if (p.line1) street = p.line1;
    if (!unit && p.unit) unit = p.unit;
    if (!city && p.city) city = p.city;
    if (!state && p.state) state = p.state;
    if (!zip && p.zip) zip = p.zip;
  }
  // Pull an inline unit out of the street line ("26 S 10th St Apt 2"). splitUnit is
  // the same whole-word matcher the loan-file address code uses, so a street named
  // "Floral Ave" can never be read as a "Fl"(oor) unit.
  if (!unit && street) {
    const s = ADDR.splitUnit(street);
    if (s.unit) { unit = s.unit; street = s.line1; }
  }
  // LAST: the inferred town, only if nothing we READ produced one — not the
  // explicit element, not the packed address line.
  if (!city && fallbackCity) city = fallbackCity;
  return {
    street: ADDR.abbreviateStreet(street) || street,
    unit,
    city: ADDR.normalizeCityName(city) || city,
    state: ADDR.stateAbbr(state),
    zip: zip5(zip) || '',
    county,
  };
}

/**
 * The dedupe key, or null when the address is not identifiable.
 * Shape: `street|unit|locality|state`, where locality is the city, or `z<zip>`
 * when the report carried no city.
 */
function propertyKey(input) {
  const p = normalizeParts(input);
  if (!p.street || !hasHouseNumber(p.street)) return null;
  if (!p.state || p.state.length !== 2) return null;
  const locality = p.city ? tokenKey(p.city) : (p.zip ? 'z' + p.zip : '');
  if (!locality) return null;
  return [streetKey(p.street), unitKey(p.unit), locality, p.state.toLowerCase()].join('|');
}

/**
 * THE STREET, REDUCED TO WHAT MAKES IT THAT STREET.
 *
 * Deliberately KEY-ONLY: it never touches a displayed or stored address, so it
 * cannot re-open the 2026-07-26 "PILOT addresses got messed up again" incident.
 * `abbreviateStreet` already did the mailing-form work above; this closes the
 * three ways one street was still producing several keys, each measured:
 *
 *   150 15 Ave  ≠  150 15th Ave          (the ordinal)
 *   8 St James  ≠  8 Saint James         (the saint)
 *   12 Oak Street Ext ≠ 12 Oak St Ext    (a suffix left long mid-name)
 *
 * The ordinal is STRIPPED rather than added, because the two forms are the same
 * street and stripping is the direction that cannot invent one ("100 Route 9"
 * must never become "Route 9th"). Word-ordinals are deliberately NOT handled:
 * "First St" and "1st St" do differ in the wild and guessing between them would
 * be the kind of merge this file exists to prevent.
 */
const SAINT_RE = /\bsaint\b/gi;
const ORDINAL_RE = /\b(\d+)(st|nd|rd|th)\b/gi;
const STREET_WORD = {
  street: 'st', avenue: 'ave', road: 'rd', drive: 'dr', lane: 'ln', place: 'pl',
  court: 'ct', boulevard: 'blvd', circle: 'cir', terrace: 'ter', parkway: 'pkwy',
  highway: 'hwy', extension: 'ext', turnpike: 'tpke', square: 'sq', trail: 'trl',
  north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};
function streetKey(street) {
  const base = tokenKey(street).replace(SAINT_RE, 'st').replace(ORDINAL_RE, '$1');
  // The FIRST token is the house number and is never a street word — "1 North St"
  // must not have its number rewritten, and a range like "27-29" must survive.
  const toks = base.split(' ').filter(Boolean);
  return toks.map((t, i) => (i === 0 ? t : (STREET_WORD[t] || t))).join(' ');
}

/**
 * Title-case a city for DISPLAY only (the key always lowercases, so casing can
 * never split one property in two). A report that shouts "PISCATAWAY" and one
 * that writes "piscataway" both read as Piscataway on the screen.
 */
function titleCity(city) {
  return collapse(city).toLowerCase().replace(/(^|[\s\-'/])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

/** The human one-line address stored on the property row. */
function displayAddress(input) {
  const p = normalizeParts(input);
  const city = /[a-z]/.test(p.city) && /[A-Z]/.test(p.city) ? p.city : titleCity(p.city);
  return ADDR.canonicalOneLine({ line1: p.street, unit: p.unit, city, state: p.state, zip: p.zip })
    || collapse([p.street, p.unit, city, p.state, p.zip].filter(Boolean).join(' '));
}

/**
 * A comparable's sale date as a real date.
 *
 * The parser already normalizes the UAD grid line ("s07/25;c06/25", "06/20/2025")
 * to `YYYY-MM-01` before storing it, so the common case is a straight pass-through.
 * This exists for the rows that predate that normalization and for the subject's
 * prior-sale field, which is stored as free text. Returns 'YYYY-MM-DD' or null —
 * NEVER a JS Date (this repo's date-only rule: a date is a string end to end).
 */
const CUR_YEAR = new Date().getUTCFullYear();
function saleDate(raw) {
  const s = collapse(raw);
  if (!s) return null;
  let y, mo, d = 1;
  let m = /(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s);           // 2025-06-14 / 2025-06
  if (m) { y = +m[1]; mo = +m[2]; d = m[3] ? +m[3] : 1; }
  else if ((m = /(\d{1,2})\/(\d{1,2})\/(\d{4})(?!\d)/.exec(s))) { // 06/20/2025
    mo = +m[1]; d = +m[2]; y = +m[3];
  } else {
    // Prefer the SETTLED "s MM/YY" over a contract-only date, exactly as the
    // parser's settledMonth() does, so both sides read one report the same way.
    m = /s\s*(\d{1,2})\/(\d{2,4})/i.exec(s) || /(\d{1,2})\/(\d{2,4})/.exec(s);
    if (!m) return null;
    mo = +m[1]; y = +m[2]; if (y < 100) y += 2000;
  }
  if (!(mo >= 1 && mo <= 12)) return null;
  if (!(y >= 1900 && y <= CUR_YEAR + 1)) return null;
  if (!(d >= 1 && d <= 31)) d = 1;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A LOT SIZE AS A NUMBER OF SQUARE FEET, from the free text the report wrote.
 *
 * `lot_area` is prose on every form — "0.17 ac", "7,405 sf", "50x100", "10890 Sq.Ft."
 * — so it cannot be range-searched as it stands. Four shapes are understood and
 * anything else returns null, because a lot size guessed off an unrecognized
 * string is worse than an empty filter.
 *
 * Bounds: a residential lot below 100 sq ft or above 100 acres is a typo or a
 * unit mix-up, not a lot, and is rejected.
 */
const ACRE_SQFT = 43560;
function lotSqft(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  const n = (t) => Number(String(t).replace(/,/g, ''));
  let v = null;
  let m;
  if ((m = /(\d[\d,]*\.?\d*)\s*(?:ac\b|acre)/.exec(s))) v = n(m[1]) * ACRE_SQFT;
  else if ((m = /(\d[\d,]*\.?\d*)\s*(?:sq\.?\s*\.?\s*(?:ft|feet)|sf\b|square\s*feet)/.exec(s))) v = n(m[1]);
  else if ((m = /^(\d[\d,]*\.?\d*)\s*[x×]\s*(\d[\d,]*\.?\d*)/.exec(s))) v = n(m[1]) * n(m[2]);
  else if (/^\d[\d,]*\.?\d*$/.test(s)) {
    // A bare number. Under 10 it is acres (nobody has a 5-square-foot lot);
    // anything larger is square feet.
    const bare = n(s);
    v = bare > 0 && bare < 10 ? bare * ACRE_SQFT : bare;
  }
  if (v == null || !Number.isFinite(v)) return null;
  return v >= 100 && v <= 100 * ACRE_SQFT ? Math.round(v) : null;
}

/** A year-built value as an integer, or null. Bounded the same way the parser bounds it. */
function yearBuilt(raw) {
  const m = /(\d{4})/.exec(String(raw == null ? '' : raw));
  if (!m) return null;
  const y = +m[1];
  return y >= 1700 && y <= CUR_YEAR + 1 ? y : null;
}

/** A finite positive number, or null. Used for every money / area column. */
function num(raw, { min = null, max = null } = {}) {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[$,\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  if (min != null && n < min) return null;
  if (max != null && n > max) return null;
  return n;
}

/** An integer within bounds, or null. */
function int(raw, { min = 0, max = 999 } = {}) {
  const n = num(raw);
  if (n == null) return null;
  const i = Math.round(n);
  return i >= min && i <= max ? i : null;
}

/**
 * Baths as a single comparable number: "2.1" (UAD full.half) → 2.5.
 * The research search filters on bath COUNT, and the two halves of the UAD
 * notation are not a decimal — 2.1 means two full and one half, i.e. 2.5.
 */
function bathsNumeric({ bathsFull, bathsHalf, bathsText }) {
  const full = int(bathsFull, { max: 99 });
  const half = int(bathsHalf, { max: 99 });
  if (full != null || half != null) return (full || 0) + (half || 0) * 0.5;
  const t = collapse(bathsText);
  if (!t) return null;
  const m = /^(\d{1,2})(?:\.(\d))?$/.exec(t);
  if (!m) return null;
  return +m[1] + (m[2] ? +m[2] * 0.5 : 0);
}

/**
 * WHICH VERSION OF THE IDENTITY RULE THIS FILE IMPLEMENTS.
 *
 * `address_key` IS a property's identity, so changing how it is computed makes
 * every stored row's key stale — and a stale key does not fail loudly, it mints a
 * DUPLICATE the next time a report arrives about that house. BUMP THIS whenever
 * `propertyKey` (or anything it calls) can produce a different string for the
 * same address, and the boot sweep in `research/rekey.js` re-keys the back book.
 */
// 2 — the street name eaten as a unit ("5 Building Rd"), the unit KIND collapsed
//     ("Apt 5" = "Suite 5" = "Floor 5"), and one street split several ways by
//     ordinals, "Saint" and a long suffix mid-name.
const KEY_VERSION = 2;

module.exports = {
  propertyKey, normalizeParts, displayAddress, titleCity, saleDate, yearBuilt, lotSqft, num, int, bathsNumeric,
  KEY_VERSION,
  _internals: { tokenKey, unitKey, streetKey, hasHouseNumber, zip5 },
};
