/**
 * BRACKETING — does the set actually SURROUND the subject, or only sit near it?
 *
 * The oldest quality check in appraisal review, and the one a grid full of
 * plausible-looking comparables most often fails. If every comparable is bigger
 * than the subject, the indicated value rests on extrapolating DOWN from all of
 * them — nothing in the set says what a smaller house sells for, and the
 * adjustment is doing all the work. One comparable on each side turns that
 * extrapolation into an interpolation, which is a completely different quality
 * of evidence.
 *
 * IT IS ADVISORY AND ALWAYS WILL BE. A set that does not bracket is common,
 * often unavoidable in a thin market, and frequently still the best available
 * evidence. Nothing here blocks a valuation, changes a number, or refuses to
 * reconcile — it tells a human which direction the answer is unsupported in, so
 * they can decide whether they care.
 *
 * THREE RULES THAT KEEP IT HONEST:
 *
 *  · A DIMENSION NOBODY STATED IS NOT A FAILURE. If the subject has no lot size
 *    on file, "the comparables do not bracket the lot size" is a statement about
 *    our data, not about the set — so the dimension is reported as unknown and
 *    never as a miss.
 *  · AN EXACT MATCH BRACKETS ON BOTH SIDES. A comparable identical to the
 *    subject on a dimension needs no extrapolation in either direction, so
 *    counting it as neither would report the strongest possible support as the
 *    weakest.
 *  · CONDITION AND QUALITY RUN BACKWARDS. C1 is the best grade and C6 the worst,
 *    so "better than the subject" is a LOWER rank. Comparing the codes as text
 *    gives exactly the wrong answer, which is why the ranks come from
 *    `valuation.CONDITION_SCALE` rather than from a private table here.
 *
 * Pure. No database, no network.
 */
'use strict';

const V = require('./valuation');

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** The subject's baths as one number, the same way the grid counts them. */
const bathsOf = (x) => {
  if (!x) return null;
  const f = num(x.baths_full);
  const h = num(x.baths_half);
  if (f == null && h == null) return num(x.baths);
  return (f || 0) + (h || 0) * 0.5;
};
const rankIn = (scale, code) => {
  if (!code) return null;
  const i = scale.indexOf(String(code).toUpperCase());
  return i < 0 ? null : i;
};

/**
 * The dimensions worth bracketing, and how to read each one off a property.
 * `higherIsBigger` is about the WORDS used in the finding, not the arithmetic:
 * for condition a lower rank is a better house, so the wording has to flip.
 */
const DIMENSIONS = Object.freeze([
  { key: 'gla', label: 'living area', unit: 'sq ft', of: (x) => num(x.gla) },
  { key: 'beds', label: 'bedrooms', unit: '', of: (x) => num(x.beds) },
  { key: 'baths', label: 'bathrooms', unit: '', of: bathsOf },
  { key: 'year_built', label: 'age', unit: '', of: (x) => num(x.year_built) },
  { key: 'lot', label: 'lot size', unit: '', of: (x) => num(x.lot_size_sqft != null ? x.lot_size_sqft : x.lot_area) },
  { key: 'condition', label: 'condition', unit: '', better: 'lower',
    of: (x) => rankIn(V.CONDITION_SCALE, x.condition_uad) },
  { key: 'quality', label: 'quality', unit: '', better: 'lower',
    of: (x) => rankIn(V.QUALITY_SCALE, x.quality_uad) },
]);

/**
 * @param {object} subject
 * @param {Array}  comps    the comparables ACTUALLY used (a switched-off comp
 *                          supports nothing, so callers pass the included set)
 * @param {object} [opts]
 * @param {number} [opts.indicatedValue] to check the value is bracketed too
 * @returns {{dimensions:Array, bracketed:number, judged:number, misses:Array,
 *            value:object|null, summary:string}}
 */
function assessBracketing(subject, comps, opts = {}) {
  const subj = (subject && typeof subject === 'object') ? subject : {};
  const rows = Array.isArray(comps) ? comps.filter((c) => c && typeof c === 'object') : [];

  const dimensions = DIMENSIONS.map((d) => {
    const s = d.of(subj);
    if (s == null) {
      return { key: d.key, label: d.label, known: false, subject: null,
        why: `we hold no ${d.label} for the subject, so nothing can be said about bracketing it` };
    }
    let above = 0, below = 0, equal = 0, stated = 0;
    for (const c of rows) {
      const v = d.of(c);
      if (v == null) continue;
      stated++;
      if (v > s) above++;
      else if (v < s) below++;
      else equal++;
    }
    if (!stated) {
      return { key: d.key, label: d.label, known: false, subject: s,
        why: `none of the comparables states a ${d.label}` };
    }
    // AN EXACT MATCH NEEDS NO EXTRAPOLATION IN EITHER DIRECTION, so it counts on
    // both sides — treating it as neither would report the strongest possible
    // support as the weakest.
    const hasAbove = above + equal > 0;
    const hasBelow = below + equal > 0;
    const brackets = hasAbove && hasBelow;
    // The wording flips where a lower number is the better house.
    const moreWord = d.better === 'lower' ? 'worse' : 'larger';
    const lessWord = d.better === 'lower' ? 'better' : 'smaller';
    return {
      key: d.key, label: d.label, known: true, subject: s,
      above, below, equal, stated, brackets,
      why: brackets ? null
        : (hasAbove
          ? `every comparable that states a ${d.label} is ${moreWord} than the subject, so the value `
            + 'rests on adjusting downward from all of them — nothing in the set shows what the other '
            + 'side looks like'
          : `every comparable that states a ${d.label} is ${lessWord} than the subject, so the value `
            + 'rests on adjusting upward from all of them — nothing in the set shows what the other '
            + 'side looks like'),
    };
  });

  /* THE VALUE ITSELF SHOULD SIT INSIDE THE ADJUSTED PRICES. If the indicated
     value is above every adjusted comparable, no sale in the set supports it —
     which is a different and more serious thing than a dimension not bracketing,
     because it is about the conclusion rather than about the evidence. */
  let value = null;
  const indicated = num(opts.indicatedValue);
  if (indicated != null) {
    const adj = rows.map((c) => num(c.adjustedPrice)).filter((x) => x != null);
    if (adj.length) {
      const lo = Math.min(...adj);
      const hi = Math.max(...adj);
      value = {
        indicated, low: lo, high: hi, n: adj.length,
        inside: indicated >= lo && indicated <= hi,
        why: indicated >= lo && indicated <= hi ? null
          : (indicated > hi
            ? 'the indicated value is above EVERY adjusted comparable — no sale in this set supports it'
            : 'the indicated value is below EVERY adjusted comparable — no sale in this set supports it'),
      };
    }
  }

  const judged = dimensions.filter((d) => d.known).length;
  const bracketed = dimensions.filter((d) => d.known && d.brackets).length;
  const misses = dimensions.filter((d) => d.known && !d.brackets);

  let summary;
  if (!rows.length) summary = 'No comparables are in use, so there is nothing to bracket.';
  else if (!judged) {
    summary = 'Nothing here can be checked for bracketing — neither the subject nor the comparables '
      + 'state enough for the comparison. That is a gap in our records, not a fault in the set.';
  } else if (!misses.length) {
    summary = `The set brackets the subject on all ${judged} thing${judged === 1 ? '' : 's'} that can be `
      + 'checked — for each one there is a comparable on either side, so the value is interpolated '
      + 'rather than extrapolated.';
  } else {
    summary = `The set brackets the subject on ${bracketed} of ${judged}. `
      + `Not bracketed: ${misses.map((m) => m.label).join(', ')} — the value is extrapolated on `
      + `${misses.length === 1 ? 'that one' : 'those'}, so the adjustment is doing the work rather than a sale.`;
  }

  return { dimensions, bracketed, judged, misses, value, summary, advisory: true };
}

module.exports = { assessBracketing, DIMENSIONS, _internals: { bathsOf, rankIn } };
