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
const RATING_WORD = [
  [/^(neutral|average|typical|ordinary|standard)$/i, 'Neutral'],
  [/^(beneficial|good|favou?rable|superior view)$/i, 'Beneficial'],
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
};
// A RELATIVE WORD IS ABOUT THAT REPORT'S SUBJECT, NOT ABOUT THIS PROPERTY.
const RELATIVE = /^(similar|same|equal|superior|inferior|comparable)\b/i;
// A trailing (or leading) adjustment amount written into the same cell.
const ADJUSTMENT = /[+-]?\s*\$?\s*\d[\d,]*(?:\.\d+)?\s*%?\s*$/;

const clean = (v) => String(v == null ? '' : v).trim();

/**
 * Read one View or Location cell.
 * @returns {{rating:string|null, factor:string|null, source:string|null, original:string|null, why:string|null}}
 */
function readUadRating(text) {
  const raw = clean(text);
  if (!raw) return { rating: null, factor: null, source: null, original: null, why: 'nothing was stated' };

  // Strip an adjustment amount the appraiser typed into the same cell BEFORE
  // anything is read, so `N;Res;2.5%` is a code and not an unknown string.
  let body = raw.replace(ADJUSTMENT, '').trim().replace(/[;,]\s*$/, '');
  if (!body) body = raw;

  const parts = body.split(/[;|]/).map((s) => s.trim()).filter(Boolean);
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
    .map((p) => p.replace(ADJUSTMENT, '').trim())
    .filter((p) => p && !RELATIVE.test(p))
    .map((p) => FACTOR_CODE[p.toLowerCase().replace(/[^a-z]/g, '')] || p);

  // A CELL THAT IS ONLY A FACTOR STATES NO RATING. "Residential" names what you
  // are looking at; reading it as neutral would manufacture a judgement, and
  // would manufacture "BusyRoad" as neutral too — the one that matters.
  if (!rating && parts.length) {
    const asFactor = parts
      .map((p) => p.replace(ADJUSTMENT, '').trim())
      .filter(Boolean)
      .map((p) => FACTOR_CODE[p.toLowerCase().replace(/[^a-z]/g, '')] || p);
    return { rating: null, factor: asFactor.join('; ') || null, source: 'factor', original: raw,
      why: 'this names what the view or location IS, and states no rating for it' };
  }

  return { rating, factor: factors.join('; ') || null, source, original: raw, why: null };
}

module.exports = { readUadRating, _internals: { RATING_CODE, FACTOR_CODE, RELATIVE, ADJUSTMENT } };
