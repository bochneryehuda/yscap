/**
 * WHAT OUR OWN COMPARABLES SAY ABOUT AN APPRAISER'S VALUE — and when to say nothing.
 *
 * The appraiser states a value. The warehouse holds every comparable sale every
 * report we have ever paid for described. Comparing the two is the in-house
 * analogue of the desk review a capital partner buys (Fannie's Collateral
 * Underwriter does the same thing at national scale), and it is worth having
 * because it is free and immediate.
 *
 * IT IS ALSO THE EASIEST THING IN THIS WHOLE BUILD TO GET DANGEROUSLY WRONG, so
 * this module is mostly refusals. "The appraisal is 14% high" is an accusation
 * about a licensed professional's work; produced from four sales in the wrong
 * town it is a false accusation that reads exactly like a true one.
 *
 * FOUR GATES, and every one of them exists because of something specific:
 *
 *  1. COVERAGE. The warehouse holds only houses that appeared in an appraisal WE
 *     paid for — measured at roughly 7% of a town (`docs/research/
 *     WHERE-THIS-IS-GOING.md`). For most subjects there is simply not enough to
 *     form an independent opinion, and that is the ordinary case, not the
 *     exception.
 *
 *  2. INDEPENDENCE — the one nobody thinks of. If the comparables come from the
 *     very report being reviewed, the "independent" check is the appraiser's own
 *     grid handed back to them. It would agree beautifully and mean NOTHING, and
 *     it would agree most closely on exactly the reports where a reviewer most
 *     needs a second opinion. Comparables sourced from the report under review
 *     are removed BEFORE coverage is counted, never after.
 *
 *  3. DISTINCT OPINIONS, not distinct rows. Everything here is our own
 *     appraisers' work, so five comparables lifted from one report are ONE
 *     opinion wearing five hats — and two reports by the same appraiser are one
 *     person. The counts that gate this are distinct REPORTS and distinct
 *     APPRAISERS, with the row count reported alongside so nothing is hidden.
 *
 *  4. AGREEMENT. A set whose own indications are all over the place has not
 *     produced a value to compare against. The spread is reported either way.
 *
 * WHAT THIS IS NOT, and the wording must never drift: it is not an appraisal, not
 * an appraisal review, not a CDA, and not USPAP work product. It is what OUR
 * OWN FILES say, offered to a human who then goes and looks. `DISCLAIMER` travels
 * with every result that carries a number.
 *
 * Pure. No database, no network.
 */
'use strict';

const V = require('./valuation');

/** The gates, named so a refusal can point at the one it hit. */
const GATES = Object.freeze({
  // Three is the floor for a value indication anywhere in this codebase, and it
  // is the floor an appraisal itself uses.
  MIN_COMPS: 3,
  // TWO INDEPENDENT REPORTS, minimum. One report is one opinion, and comparing an
  // opinion against itself is not a check.
  MIN_REPORTS: 2,
  // …and two distinct appraisers, for the same reason one level up: the same
  // person's two reports share the same habits, the same adjustment rates and the
  // same blind spots.
  MIN_APPRAISERS: 2,
  // Above this the sales do not agree with each other, so there is no "our value"
  // to state a variance from. Expressed as the coefficient of variation, the same
  // measure `valuation.confidenceOf` already uses.
  MAX_SPREAD_CV: 0.20,
  // A variance smaller than this is noise: our indication is built from adjusted
  // sales and the appraiser's is too, and the two methods differ by more than
  // this on identical data.
  NOISE_PCT: 5,
  // Where a reviewer should genuinely look. Not a verdict — a threshold for
  // "worth a human's time".
  NOTABLE_PCT: 10,
});

const DISCLAIMER = 'This compares the appraiser\'s value with an indication built from the comparable '
  + 'sales in our OWN appraisal reports. It is not an appraisal, not an appraisal review and not a '
  + 'CDA, and it is not USPAP work product. It is a prompt to go and look, never a conclusion.';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);

/**
 * The values of `key` on one row, as a SET — a comparable can have reached our
 * warehouse through several reports, and which ones matters twice below.
 * Accepts a scalar or an array so a caller with only one source still works.
 */
function idsOf(row, key) {
  const v = row && (row[`${key}s`] != null ? row[`${key}s`] : row[key]);
  const arr = Array.isArray(v) ? v : (v == null || v === '' ? [] : [v]);
  return arr.filter((x) => x != null && x !== '').map(String);
}

/** Distinct non-null values of `key` across rows. */
function distinct(rows, key) {
  const s = new Set();
  for (const r of rows || []) for (const v of idsOf(r, key)) s.add(v);
  return s.size;
}

/**
 * @param {object} opts
 * @param {number} opts.appraisedValue   what the appraiser concluded
 * @param {object} opts.subject          the subject's facts, as the grid wants them
 * @param {Array}  opts.comps            warehouse comparables, each carrying
 *                                       `source_appraisal_id` and `appraiser_id`
 * @param {string} opts.appraisalId      the report UNDER REVIEW — its own comparables
 *                                       are not independent evidence about it
 * @param {string} [opts.today]
 * @returns {{available:boolean, why:string|null, gate:string|null, ourValue:number|null,
 *            variancePct:number|null, direction:string|null, notable:boolean,
 *            coverage:object, disclaimer:string}}
 */
function assessVariance(input) {
  // A DEFAULT PARAMETER ONLY CATCHES `undefined`. `assessVariance(null)` threw —
  // and this is called from a route with whatever a caller assembled, so a null
  // is an ordinary Tuesday rather than an abuse. Every other refusal here is
  // careful; crashing on the emptiest possible input would have been the one
  // path that took the page down instead of saying nothing.
  const opts = (input && typeof input === 'object') ? input : {};
  const appraised = num(opts.appraisedValue);
  const all = Array.isArray(opts.comps) ? opts.comps : [];

  // ── 2. INDEPENDENCE FIRST, ALWAYS ──────────────────────────────────────────
  // Before anything is counted. Counting coverage and THEN removing the report's
  // own comparables would let a set pass the gate on rows that are about to be
  // dropped — and it is precisely the reports with the most comparables in our
  // warehouse (their own) that would sail through.
  // …AND "CAME FROM THIS REPORT" MEANS *ONLY* FROM IT. A house our warehouse
  // learned about from this report AND from somebody else's is independent
  // evidence — a second appraiser described the same sale, which is exactly the
  // corroboration this check wants. Dropping it because the report under review
  // also mentioned it would throw away the best rows we have.
  const me = opts.appraisalId == null ? null : String(opts.appraisalId);
  const onlyMine = (c) => {
    if (me == null) return false;
    const ids = idsOf(c, 'source_appraisal_id');
    return ids.length > 0 && ids.every((x) => x === me);
  };
  const own = all.filter(onlyMine).length;
  const comps = all.filter((c) => !onlyMine(c));

  const reports = distinct(comps, 'source_appraisal_id');
  const appraisers = distinct(comps, 'appraiser_id');
  const coverage = {
    comps: comps.length,
    fromThisReport: own,            // removed, and SAID, so the count is never a mystery
    reports,
    appraisers,
    spreadCv: null,
  };
  const no = (gate, why) => ({ available: false, why, gate, ourValue: null, variancePct: null,
    direction: null, notable: false, coverage, disclaimer: DISCLAIMER });

  if (appraised == null || appraised <= 0) {
    return no('no_appraised_value', 'the report states no value to compare against');
  }
  if (comps.length < GATES.MIN_COMPS) {
    return no('too_few_comps', own > 0
      ? `only ${comps.length} comparable${comps.length === 1 ? '' : 's'} in our warehouse for this `
        + `property that did not come from this report itself (${own} did) — not enough to form an `
        + 'independent opinion'
      : `only ${comps.length} comparable${comps.length === 1 ? '' : 's'} in our warehouse near this `
        + 'property — we hold what our own reports have described, which in most towns is a small '
        + 'share of what sold');
  }
  if (reports < GATES.MIN_REPORTS) {
    return no('one_report', `all ${comps.length} comparables come from a single report — that is one `
      + 'opinion, not a second one');
  }
  if (appraisers < GATES.MIN_APPRAISERS) {
    return no('one_appraiser', `all ${comps.length} comparables come from reports by the same `
      + 'appraiser — the same habits and the same adjustment rates, so it is not an independent check');
  }

  // ── OUR INDICATION, through the ONE valuation the rest of the system uses ──
  // Never a private average: a second definition of "our value" would disagree
  // with the valuation screen about the same property, and a reviewer would have
  // no way to tell which was wrong.
  let grid;
  try {
    grid = V.buildGrid(opts.subject || {}, comps, { today: opts.today || null, roundTo: 1000 });
  } catch (e) {
    return no('could_not_value', 'our own comparables could not be reconciled into a value');
  }
  const val = (grid && grid.value) || {};
  const ourValue = num(val.indicatedValue);
  if (ourValue == null || ourValue <= 0) {
    return no('could_not_value', 'our own comparables did not produce a value');
  }
  coverage.confidence = (val.confidence && val.confidence.label) || null;

  // ── 4. DO OUR OWN SALES AGREE? ────────────────────────────────────────────
  // The spread is read from what `reconcile` ALREADY publishes, not recomputed:
  // `likelyHigh` is the indication plus one standard deviation by construction,
  // so this is the same measure `confidenceOf` scores on and the same one the
  // valuation screen shows. A private second definition of "do the sales agree"
  // would let this module and that screen disagree about one property with no way
  // to tell which was wrong.
  const raw = num(val.indicatedValueRaw);
  const hi = num(val.likelyHigh);
  const sd = (hi != null && raw != null) ? Math.abs(hi - raw) : null;
  const cv = sd != null && ourValue ? sd / ourValue : null;
  coverage.spreadCv = cv == null ? null : Number(cv.toFixed(3));
  if (cv != null && cv > GATES.MAX_SPREAD_CV) {
    return no('comps_disagree', `our own comparables disagree with each other by too much `
      + `(±${Math.round(cv * 100)}%) to say anything about somebody else's value`);
  }

  const variancePct = pct(appraised, ourValue);
  const abs = Math.abs(variancePct);
  return {
    available: true,
    why: null,
    gate: null,
    ourValue,
    variancePct: Number(variancePct.toFixed(1)),
    // Stated from the APPRAISAL's point of view, because that is what the reader
    // is holding: "the appraisal is above what our files show".
    direction: abs < GATES.NOISE_PCT ? 'in line' : (variancePct > 0 ? 'above ours' : 'below ours'),
    notable: abs >= GATES.NOTABLE_PCT,
    coverage,
    disclaimer: DISCLAIMER,
  };
}

/** One plain line for a screen or a finding — never a verdict. */
function describeVariance(v) {
  if (!v) return null;
  if (!v.available) return v.why;
  const n = Math.abs(v.variancePct);
  if (v.direction === 'in line') {
    return `In line with our own files (within ${n.toFixed(1)}%, on ${v.coverage.comps} comparables `
      + `from ${v.coverage.reports} reports).`;
  }
  return `The appraisal is ${n.toFixed(1)}% ${v.direction === 'above ours' ? 'above' : 'below'} what our `
    + `own ${v.coverage.comps} comparables from ${v.coverage.reports} reports indicate `
    + `($${Math.round(v.ourValue).toLocaleString('en-US')}). Worth a look, not a conclusion.`;
}

module.exports = { assessVariance, describeVariance, GATES, DISCLAIMER };
