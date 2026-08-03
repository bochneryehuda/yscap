/**
 * THE VIEW AND LOCATION LINES — a UAD rating code, or the appraiser's own words.
 *
 * UAD writes these two grid cells as a semicolon list: a one-letter RATING
 * followed by up to two FACTOR codes — `N;Res;` is "neutral rating, residential
 * view", `A;BsySt;` is "adverse rating, busy street". Everything else on the
 * form (condition, quality) got a reader; these two never did, and the corpus
 * shows both halves of the cost:
 *
 *   · **360 of 769 real comparables carry NO view or location rating at all**,
 *     while every single one of them has a View/Location adjustment line whose
 *     description states one. `Adverse` is a real underwriting signal — the
 *     appraisal tab badges it — and it was missing from nearly half the grid.
 *   · **136 comparables show the RAW CODE to a human.** `location_type` holds
 *     `N;Res;` (110), `N;Res` (11), `A;BsySt;` (6), `N;res;` (5) and even
 *     `N;Res;2.5%` (4) — a code with the adjustment percentage stuck on the end
 *     — and the appraisal tab renders that string verbatim as "Location". Same
 *     class as a raw database key reaching a screen: not a missing answer, a
 *     confident unreadable one.
 *
 * WHAT IT REFUSES, and this is the half that matters:
 *   · A RELATIVE WORD IS NOT A RATING. `similar` appears 8 times in the location
 *     slot. It says how this comparable compared with THAT report's subject, not
 *     what the location is — the identical rule `condition-scale.js` applies, and
 *     for the identical reason.
 *   · A FACTOR IS NOT A RATING. `Residential` (370), `Suburban` (34) and
 *     `BusyRoad` (21) name WHAT you are looking at. Reading "Residential" as
 *     neutral would manufacture a judgement the appraiser never wrote — and the
 *     one that matters, `BusyRoad`, would be manufactured as neutral too.
 *   · An adjustment amount stuck to the end (`N;Res;2.5%`, `AVERAGE-4%`) is
 *     stripped before anything is read, never treated as part of the value.
 *
 * `Average` / `Typical` DO give a rating, because in ordinary appraisal English
 * they are a judgement about the cell rather than a description of it, and the
 * corpus writes them in the rating position (98 rows across the two slots).
 *
 * Pure. No database, no network.
 */
'use strict';

// The UAD rating letters, in the order the form lists them.
const RATING_CODE = { N: 'Neutral', B: 'Beneficial', A: 'Adverse' };
// Spelled out, and the ordinary words appraisers use in the same cell.
// `avg` is here because the corpus writes it in the RATING position (`Avg`,
// `Avg/Corner`, `Avg/BsyRd`) and without it the abbreviation was stored as the
// PLACE — a screen reading "Location: Avg", which is this module's whole reason
// for existing. `condition-scale.js` already reads `\bavg\b` as the same word, so
// leaving it out also made the two readers disagree about one abbreviation.
// NOT here: `superior view`, which was dead code — `RELATIVE` matches `superior`
// first and returns before this list is ever consulted.
const RATING_WORD = [
  [/^(neutral|average|avg|typical|ordinary|standard)$/i, 'Neutral'],
  [/^(beneficial|good|favou?rable)$/i, 'Beneficial'],
  [/^(adverse|negative|unfavou?rable|poor)$/i, 'Adverse'],
];
// The UAD factor abbreviations. Anything not on this list is passed through as
// the appraiser wrote it — a factor we have not seen is still their word.
const FACTOR_CODE = {
  res: 'Residential', ind: 'Industrial', comm: 'Commercial', bsyrd: 'BusyRoad',
  bsyst: 'BusyRoad', wtrfr: 'Waterfront', golf: 'GolfCourse', lndfl: 'Landfill',
  pstn: 'PowerLines', pwrln: 'PowerLines', ltraf: 'LimitedSight', mtn: 'MountainView',
  ctystr: 'CityStreet', ctyvw: 'CityView', prkvw: 'ParkView', pstrl: 'PastoralView',
  wtr: 'WaterView', woods: 'Woods', park: 'Park', athlt: 'AthleticField',
  cmtry: 'Cemetery', ntrl: 'Neutral', bsy: 'BusyRoad',
  // THE SPELLED-OUT FORMS OF CODES ALREADY ABOVE. A vendor that writes
  // `N;Residential` or `A;Cemetery;` means exactly what `N;Res;` and `A;Cmtry;`
  // mean, and without these the same fact reached a screen under two different
  // words — so one property read "Residential" and its neighbour "RESIDENTIAL"
  // while a third read the code. Counted in the corpus: Residential 3,
  // CityStreet 3, Cemetery 2, BusyRd 2.
  residential: 'Residential', commercial: 'Commercial', industrial: 'Industrial',
  citystreet: 'CityStreet', cemetery: 'Cemetery', waterfront: 'Waterfront',
  busyrd: 'BusyRoad', busyst: 'BusyRoad', busyroad: 'BusyRoad', busystreet: 'BusyRoad',
  powerlines: 'PowerLines', golfcourse: 'GolfCourse', landfill: 'Landfill',
};
// A RELATIVE WORD IS ABOUT THAT REPORT'S SUBJECT, NOT ABOUT THIS PROPERTY.
const RELATIVE = /^(similar|same|equal|superior|inferior|comparable)\b/i;
// A trailing (or leading) adjustment amount written into the same cell.
//
// THIS REGEX RAN IN CUBIC TIME AND THE INPUT IS AN UPLOADED FILE. The first cut
// was `/[+-]?\s*\$?\s*\d[\d,]*(?:\.\d+)?\s*%?\s*$/`, which has two ambiguous
// whitespace runs — `\s*\$?\s*` and `\s*%?\s*$` — so on a cell ending in a long
// space run the engine tries every way of splitting it, at every start offset.
// Measured on the real `extract()` path with one `_Description="N;Res;<spaces>x"`:
// 1,000 spaces took 0.45 s, 2,000 took 2.8 s, 3,000 took 9.9 s, and the bare
// regex at 8,000 took 86 SECONDS. It is applied up to 3× per call and called 4×
// per comparable, and Node is single-threaded — so one appraisal XML, which any
// borrower or officer can upload, stalls the entire server.
//
// Two independent fixes, and neither is decoration:
//   · EVERY WHITESPACE RUN IS `\s?`, NOT `\s*`. One optional space can be
//     consumed exactly one way, so there is nothing to backtrack over and the
//     match is linear at any input size — including for anything that reaches
//     the exported regex directly rather than through this module.
//   · THE PARSER NEVER SEES A RUN LONGER THAN ONE ANYWAY. `collapse()` reduces
//     every whitespace run to a single space before any matching, which is what
//     makes `\s?` exactly right rather than merely stricter: after collapsing,
//     `N;Res;   2.5%` and `N;Res; 2.5%` are the same string.
// `test-uad-rating-pure.js` pins the timing, so a rewrite that reintroduces the
// blowup fails rather than merely being slow.
//
// AN AMOUNT MUST CARRY ITS MARKER — a `$` or a `%`. Stripping any trailing number
// ate the numbered roads that live in exactly this cell: `I-95` read as the factor
// "I", `Route 9` as "Route", `US 1` as "US", and `N;Res;Route 9` as
// "Residential; Route". Every one of the 86 distinct View/Location descriptions in
// the real corpus writes its amount with a marker (`2.5%`, `-4%`, `-$5,000`) and
// NOT ONE ends in a bare digit, so requiring the marker loses nothing real and
// keeps a highway number attached to its highway.
const ADJUSTMENT = /[+-]?\s?(?:\$\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s?%)\s?$/;

// …AND THE REGEX ALONE IS NOT ENOUGH, WHICH THE FIRST FIX GOT WRONG. `collapse`
// bounds a WHITESPACE run; a trailing DIGIT run is untouched, and the pattern is
// unanchored at the start, so `\d[\d,]*` is retried at every offset. Measured
// through the real `extract()` path with `N;Res;<N digits>x`: 8,000 digits took
// 0.9 s, 20,000 took 5.8 s, 50,000 took **34.9 SECONDS** — a 301 KB file against
// a 20 MB upload ceiling. Requiring the `$`/`%` marker even INTRODUCED a case the
// old pattern answered in O(n): a bare digit run used to match immediately.
//
// So the strip runs over a WINDOW, not the whole cell. A real adjustment amount
// is under twenty characters (`-$1,234,567.89 %` is eighteen), so only the tail
// can hold one, and the work becomes constant whatever the cell's length. If the
// digits run PAST the window the value is not an amount at all — it is garbage —
// and it is left alone rather than truncated, so nothing is ever half-stripped.
const AMOUNT_TAIL = 48;
function stripAmount(s) {
  if (s.length <= AMOUNT_TAIL) return s.replace(ADJUSTMENT, '');
  const cut = s.length - AMOUNT_TAIL;
  const head = s.slice(0, cut);
  if (/[\d,]$/.test(head)) return s;          // the run continues past the window
  return head + s.slice(cut).replace(ADJUSTMENT, '');
}

const clean = (v) => String(v == null ? '' : v).trim();
// The appraiser's own text is kept VERBATIM as `original`; this is the copy the
// parser reads, so collapsing runs here changes nothing anybody is shown.
const collapse = (v) => v.replace(/\s+/g, ' ');

/**
 * Read one View or Location cell.
 * @returns {{rating:string|null, factor:string|null, source:string|null, original:string|null, why:string|null}}
 */
function readUadRating(text) {
  const raw = clean(text);
  if (!raw) return { rating: null, factor: null, source: null, original: null, why: 'nothing was stated' };

  // Strip an adjustment amount the appraiser typed into the same cell BEFORE
  // anything is read, so `N;Res;2.5%` is a code and not an unknown string.
  // Read from the COLLAPSED copy — `raw` stays the appraiser's own text and is
  // what `original` returns.
  let body = stripAmount(collapse(raw)).trim().replace(/[;,]\s*$/, '');
  if (!body) body = collapse(raw);

  // A SLASH SEPARATES, like a semicolon. Every slash cell in the real corpus is a
  // genuine list — `Avg/Corner` and `Avg/BsyRd` (a rating then a factor),
  // `COMM/APART`, `Pond/Residential`, `Suburban/Busy` (two factors) — and without
  // this the whole string was one unrecognised token, so `Avg/Corner` was filed
  // as the place rather than as a neutral rating on a corner lot.
  const parts = body.split(/[;|/]/).map((s) => s.trim()).filter(Boolean);
  const first = parts[0] || '';

  if (RELATIVE.test(first)) {
    return { rating: null, factor: null, source: null, original: raw,
      why: 'this says how it compared with that report’s subject, not what the view or location is' };
  }

  // A ONE-LETTER UAD RATING, which is only a rating when it stands alone —
  // otherwise "A" would claim every word beginning with A.
  let rating = null, source = null, rest = parts;
  if (/^[NBA]$/i.test(first)) {
    rating = RATING_CODE[first.toUpperCase()];
    source = 'code';
    rest = parts.slice(1);
  } else {
    const hit = RATING_WORD.find(([re]) => re.test(first));
    if (hit) { rating = hit[1]; source = 'word'; rest = parts.slice(1); }
  }

  // THE FACTORS. Every remaining part, expanded when we know the abbreviation
  // and passed through when we do not. A part that is only an adjustment amount
  // is dropped rather than shown as a place you can look at.
  const factors = rest
    .map((p) => stripAmount(p).trim())
    .filter((p) => p && !RELATIVE.test(p))
    .map((p) => FACTOR_CODE[p.toLowerCase().replace(/[^a-z]/g, '')] || p);

  // A CELL THAT IS ONLY A FACTOR STATES NO RATING. "Residential" names what you
  // are looking at; reading it as neutral would manufacture a judgement, and
  // would manufacture "BusyRoad" as neutral too — the one that matters.
  if (!rating && parts.length) {
    const asFactor = parts
      .map((p) => stripAmount(p).trim())
      .filter(Boolean)
      .map((p) => FACTOR_CODE[p.toLowerCase().replace(/[^a-z]/g, '')] || p);
    return { rating: null, factor: asFactor.join('; ') || null, source: 'factor', original: raw,
      why: 'this names what the view or location IS, and states no rating for it' };
  }

  return { rating, factor: factors.join('; ') || null, source, original: raw, why: null };
}

module.exports = { readUadRating,
  _internals: { RATING_CODE, FACTOR_CODE, RELATIVE, ADJUSTMENT, stripAmount, AMOUNT_TAIL } };
