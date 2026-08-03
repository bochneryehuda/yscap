/**
 * PLACING THE PROPERTIES WE LENT ON, FROM THE COMPARABLES AROUND THEM.
 *
 * Measured on the real corpus: **every one of the 132 subject properties is
 * unplaced**, because appraisers give coordinates for their comparables and not
 * for the subject — so the property the loan is secured against is the one no
 * radius search, no map and no distance can find. And **98 of 102 reports carry
 * enough comparables with real coordinates and stated distances to fix that
 * subject's position** (median residual 17 feet, worst 67).
 *
 * THE NUMBER THIS PASS REPORTS IS DIFFERENT, AND IT IS THE ONE TO QUOTE. It works
 * per PROPERTY, not per report: **91 of the 132 are placed, 41 refused** — 37 of
 * those because the only report naming them carries fewer than three usable
 * comparables (`too_few`), and 4 by the mirror test. "98 of 102" is true about
 * reports and would read as a promise about properties.
 *
 * Free, offline, out of reports we already paid for.
 *
 * FOUR RULES, and none of them is decoration:
 *   · IT ONLY EVER FILLS A BLANK. A property with a coordinate — the appraiser's
 *     own, or a real geocoder's — is never touched.
 *   · IT WRITES `geo_source = 'comp_trilateration'` and its own `geo_precision`
 *     token, so nothing downstream can mistake an estimate for a measurement.
 *     The fit itself is REPORTED (the pass summary, the boot log) rather than
 *     written into `geo_precision`, which is a categorical column the geocoders
 *     fill with the single token 'address'.
 *   · IT USES ONE REPORT AT A TIME. Two reports about the same house are two
 *     independent placements; mixing their comparables would mix two sets of
 *     stated distances measured from the same point but rounded differently, and
 *     there is no gain in it. The best-fitting report wins.
 *   · IT NEVER THROWS and is bounded per pass, like every other boot sweep here.
 *
 * The maths, the mirror test and every refusal live in `trilaterate.js`.
 */
'use strict';
const T = require('./trilaterate');

const SOURCE = 'comp_trilateration';
// `geo_precision` is CATEGORICAL — the real geocoders write 'address' and nothing
// else. This is its own token so a derived position can never be read as one.
const PRECISION = 'trilaterated';

/**
 * Place unplaced subject properties. Bounded and self-draining: a property is
 * picked only while it has no coordinate at all, so each success permanently
 * reduces the queue, and a report that cannot resolve is simply not written.
 *
 * @returns {{scanned:number, placed:number, refused:number, residualsMi:number[],
 *            reasons:Object<string,{count:number, example:string}>, error?:string}}
 *          `reasons` is keyed on `trilaterate`'s stable refusal CODE, with one
 *          example of the words a person would read.
 */
async function placeSubjectsOnce(db, { limit = 200 } = {}) {
  // `residualsMi` is where the fit quality goes, since `geo_precision` is a
  // categorical column and cannot carry it — the boot log prints the summary.
  const out = { scanned: 0, placed: 0, refused: 0, reasons: {}, residualsMi: [] };
  try {
    // The candidates: a property that has been some report's SUBJECT and has no
    // position of any kind.
    //
    // THE LIMIT IS ON PROPERTIES, NOT ON (property, report) PAIRS, and that is not
    // tidiness. A house can be the subject of several reports and the best-fitting
    // one wins — so a limit counted in pairs can cut a property's reports in half,
    // place it from the worse one, and then never look again (the write is
    // fill-only, so the property drops out of the queue for good). Bounding by
    // property means every attempt sees ALL of that property's reports.
    const targets = (await db.query(
      `SELECT p.id AS property_id
         FROM properties p
        WHERE p.latitude IS NULL AND p.longitude IS NULL
          AND p.geo_latitude IS NULL AND p.geo_longitude IS NULL
          AND EXISTS (SELECT 1 FROM property_observations o
                       WHERE o.property_id = p.id AND o.role = 'subject'
                         AND o.appraisal_id IS NOT NULL)
        ORDER BY p.id
        LIMIT $1`, [Math.max(1, Math.min(1000, limit))])).rows;
    if (!targets.length) return out;

    for (const { property_id: propertyId } of targets) {
      // Every report this house was the subject of — each an independent attempt.
      const appraisalIds = (await db.query(
        `SELECT DISTINCT appraisal_id FROM property_observations
          WHERE property_id = $1 AND role = 'subject' AND appraisal_id IS NOT NULL`,
        [propertyId])).rows.map((r) => r.appraisal_id);
      out.scanned++;
      let best = null;
      let lastWhy = null;
      for (const appraisalId of appraisalIds) {
        const comps = (await db.query(
          `SELECT latitude, longitude, proximity FROM appraisal_comparables
            WHERE appraisal_id = $1 AND is_subject = false
              AND latitude IS NOT NULL AND longitude IS NOT NULL`, [appraisalId])).rows;
        const points = comps
          .map((c) => ({ lat: Number(c.latitude), lng: Number(c.longitude), miles: T.proximityMiles(c.proximity) }))
          .filter((p) => p.miles != null);
        const fix = T.trilaterate(points);
        // A REASON IS RECORDED FOR THE PROPERTY, NOT FOR EACH REPORT THAT MISSED.
        // Counting per report puts a refusal in the tally for a house that was
        // placed perfectly well by its OTHER report, so the summary reads as
        // failures that never happened. Held until the property is settled.
        if (!fix.ok) { lastWhy = fix; continue; }
        // THE BEST-FITTING REPORT WINS, not the newest — a tighter residual is a
        // better position, and that is the only thing being chosen here.
        if (!best || fix.residualMi < best.residualMi) best = fix;
      }
      if (!best) {
        out.refused++;
        // TALLIED BY THE STABLE CODE, never by the sentence. The refusal prose
        // carries its own numbers ("the mirror-image position 0.75 miles away"),
        // so grouping on it makes one bucket per property — and truncating it to
        // fix that cuts off exactly the half that tells a person what to do.
        const code = (lastWhy && lastWhy.code) || 'no_usable_comparables';
        const r = out.reasons[code] || (out.reasons[code] = { count: 0, example: null });
        r.count++;
        if (!r.example) r.example = (lastWhy && lastWhy.why) || 'no comparable stated both a position and a distance';
        continue;
      }

      // FILL-ONLY, RE-CHECKED IN THE WRITE. Another pass — or a real geocoder —
      // may have placed it between the read and here.
      //
      // `geo_precision` IS CATEGORICAL — the geocoders write the single token
      // 'address' and consumers group on it, so the residual is deliberately NOT
      // smuggled in as prose ("4 comparables, ±0.003 mi" would become its own
      // bucket per property and quietly break every GROUP BY on that column).
      // Its own token instead, which can never be mistaken for a real geocode.
      const r = await db.query(
        `UPDATE properties
            SET geo_latitude = $2, geo_longitude = $3, geo_source = $4,
                geo_precision = $5, geo_at = now()
          WHERE id = $1
            AND latitude IS NULL AND longitude IS NULL
            AND geo_latitude IS NULL AND geo_longitude IS NULL`,
        [propertyId, best.lat, best.lng, SOURCE, PRECISION]);
      if (r.rowCount) {
        out.placed++;
        out.residualsMi.push(Number(best.residualMi));
      }
    }
  } catch (e) {
    // BEST-EFFORT, BUT NEVER SILENT. A placement is not worth breaking a boot
    // for — but a swallowed error here is exactly how `buildWholeLoanContext`
    // ran dark for weeks on three wrong column names, reporting a clean null
    // every single time. The error is REPORTED so a query that stops matching
    // the schema is visible in the boot log instead of looking like "nothing to
    // place", and `out.error` lets a caller (and the test) see it too.
    out.error = e.message;
    console.error('[research] subject placement failed:', e.message);
  }
  return out;
}

/** The pass in one line, for the boot log — median/worst fit, not just a count. */
function describePass(out) {
  if (!out || !out.placed) return null;
  const r = out.residualsMi.slice().sort((a, b) => a - b);
  const ft = (m) => `${Math.round(m * 5280)} ft`;
  return `placed ${out.placed} of ${out.scanned} (refused ${out.refused}); `
    + `fit median ${ft(r[Math.floor(r.length / 2)])}, worst ${ft(r[r.length - 1])}`;
}

module.exports = { placeSubjectsOnce, describePass, SOURCE, PRECISION };
