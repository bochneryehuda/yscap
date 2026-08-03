/**
 * PLACING A PROPERTY FROM THE COMPARABLES THAT SURROUND IT.
 *
 * Measured on the real 152-report corpus, and the two numbers together are the
 * whole argument:
 *
 *   · **Every one of the 132 properties we have actually lent on is unplaced.**
 *     Not one subject in the warehouse has a coordinate, because appraisers give
 *     coordinates for their COMPARABLES and not for the subject. So the property
 *     the loan is secured against is the one property no distance search, no
 *     radius filter and no map can find.
 *   · **102 reports carry three or more comparables that have real coordinates
 *     AND state their distance from the subject** — "0.55 miles SW" — on the
 *     grid. Three distances from three known points determine one location.
 *
 * That is a free, offline placement for 102 of our own subject properties out of
 * data we already paid for, and it is why the paid geocoder is a nice-to-have
 * rather than a blocker.
 *
 * AN ESTIMATE IS NOT A MEASUREMENT, and everything here exists to keep the two
 * apart:
 *   · It REFUSES below three circles. Two circles meet at two points and there
 *     is nothing to choose between them.
 *   · It REFUSES a set whose MIRROR fits as well. Points strung along one road
 *     leave a second answer reflected across that road — the classic
 *     trilateration trap — and the answer looks perfectly confident either way.
 *     The reflection is actually COMPUTED and scored, not guessed at with an
 *     angle threshold: measured on the real corpus, every borderline set fits its
 *     stated distances to within 2–107 feet, so a residual test would have waved
 *     all of them through. Of 102 REPORTS, 98 resolve and 4 are genuinely
 *     ambiguous — which is 91 of the 132 PROPERTIES, the number
 *     `place-subjects` reports; the rest have fewer than three usable points.
 *   · It REPORTS ITS RESIDUAL and refuses when the circles genuinely disagree. A
 *     stated distance is rounded to a hundredth of a mile and an appraiser's
 *     coordinate is their own, so a small residual is expected; a large one means
 *     a distance or a coordinate is wrong and the answer would be confidently
 *     somewhere else.
 *   · The caller must never write it over a real coordinate, and must record that
 *     it is derived. `properties.geo_source` exists to say so.
 *
 * The projection is a local flat approximation around the first point. Over the
 * few miles a comparable set spans, the error is far below the rounding already
 * present in "0.55 miles", and it keeps the whole thing pure arithmetic.
 *
 * Pure. No database, no network.
 */
'use strict';

// The same sphere the distance search measures on, derived rather than typed so
// the two can never drift apart (see `search.js`).
const MI_PER_DEG = (2 * Math.PI * 3958.7613) / 360;
const rad = (d) => (d * Math.PI) / 180;

/** Default refusal thresholds. Every one of them is a judgement, so name it. */
const MIN_POINTS = 3;
// A stated proximity is rounded to 0.01 mi and an appraiser's coordinate is their
// own; residuals of a few hundredths are ordinary. A quarter of a mile is not.
const MAX_RESIDUAL_MI = 0.25;
// The conditioning floor is only an ARITHMETIC guard now — a system this close to
// singular has no stable solution to test a mirror against. The real collinearity
// judgement is the mirror test in `trilaterate`, which is a proof rather than a
// threshold: measured on the real corpus, every set this number would have
// rejected fits its stated distances to within 2–107 feet, so a threshold picked
// on the residual would have waved all of them through.
const MIN_CONDITION = 1e-4;

/**
 * @param {Array<{lat:number, lng:number, miles:number}>} points
 * @returns {{ok:boolean, lat:number|null, lng:number|null, n:number,
 *            residualMi:number|null, maxResidualMi:number|null,
 *            condition:number|null, code:string|null, why:string|null}}
 */
function trilaterate(points, opts = {}) {
  const maxResidual = Number.isFinite(opts.maxResidualMi) ? opts.maxResidualMi : MAX_RESIDUAL_MI;
  const minCondition = Number.isFinite(opts.minCondition) ? opts.minCondition : MIN_CONDITION;

  const pts = (points || []).filter((p) => p
    && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
    && Number.isFinite(Number(p.miles)) && Number(p.miles) >= 0
    && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180)
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), r: Number(p.miles) }));

  // EVERY REFUSAL CARRIES A STABLE `code` ALONGSIDE ITS WORDS. The prose is what a
  // person reads and it deliberately contains the numbers ("the mirror-image
  // position 0.75 miles away"), so anything that TALLIES refusals must group on
  // the code — grouping on the sentence makes one bucket per distance, and
  // truncating the sentence to fix that cuts off the half that says what to do.
  const refuse = (code, why, extra = {}) => Object.assign(
    { ok: false, lat: null, lng: null, n: pts.length, residualMi: null, maxResidualMi: null,
      condition: null, code, why },
    extra);

  if (pts.length < MIN_POINTS) {
    return refuse('too_few', `only ${pts.length} comparable${pts.length === 1 ? '' : 's'} with both a position and a stated `
      + 'distance — two circles meet at two places and there is nothing to choose between them');
  }
  // A DISTANCE OF ZERO IS THE COMPARABLE ITSELF, not a placement, and it makes
  // the geometry degenerate. Real grids do carry "0.00 miles" for a comparable
  // on the same block.
  const usable = pts.filter((p) => p.r > 0);
  if (usable.length < MIN_POINTS) {
    return refuse('all_zero', 'too many of the stated distances are zero to fix a position from them');
  }

  // Local flat projection in miles, centred on the first point.
  const lat0 = usable[0].lat, lng0 = usable[0].lng;
  const kx = MI_PER_DEG * Math.cos(rad(lat0));
  const P = usable.map((p) => ({ x: (p.lng - lng0) * kx, y: (p.lat - lat0) * MI_PER_DEG, r: p.r }));

  // Linearize against the first circle: subtracting its equation from each of the
  // others removes the quadratic terms and leaves A·[x,y] = b.
  const A = [], b = [];
  for (let i = 1; i < P.length; i++) {
    A.push([2 * (P[0].x - P[i].x), 2 * (P[0].y - P[i].y)]);
    b.push((P[i].r * P[i].r) - (P[0].r * P[0].r)
      + (P[0].x * P[0].x) + (P[0].y * P[0].y) - (P[i].x * P[i].x) - (P[i].y * P[i].y));
  }
  // Normal equations for the least-squares solution (2×2, solved directly).
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < A.length; i++) {
    a11 += A[i][0] * A[i][0]; a12 += A[i][0] * A[i][1]; a22 += A[i][1] * A[i][1];
    b1 += A[i][0] * b[i]; b2 += A[i][1] * b[i];
  }
  const det = a11 * a22 - a12 * a12;
  // A DEGENERATE SYSTEM has no solution at all — this is the arithmetic floor,
  // not the collinearity test. That one is below, and it is a PROOF rather than
  // a threshold.
  const scale = (a11 + a22) || 1;
  const condition = Math.abs(det) / (scale * scale / 4);
  if (!Number.isFinite(condition) || condition < minCondition) {
    return refuse('collinear', 'the comparables sit exactly in a straight line — there is no single solution',
      { condition: Number.isFinite(condition) ? Number(condition.toFixed(4)) : null });
  }

  const x = (b1 * a22 - b2 * a12) / det;
  const y = (a11 * b2 - a12 * b1) / det;

  // WHAT THE ANSWER COSTS: how far each stated distance is from the distance to
  // the point we chose.
  const residAt = (px, py) => {
    const e = P.map((p) => Math.abs(Math.sqrt((px - p.x) ** 2 + (py - p.y) ** 2) - p.r));
    return { rms: Math.sqrt(e.reduce((s, v) => s + v * v, 0) / e.length), worst: Math.max(...e) };
  };
  const here = residAt(x, y);
  const rms = here.rms, worst = here.worst;

  // DO THE CIRCLES AGREE AT ALL? Asked FIRST, because a set whose distances
  // contradict each other fits badly EVERYWHERE — including at its mirror — so
  // the mirror test would fire on it and blame the geometry for a wrong number.
  // Reproduced: one distance three miles out was refused as "nearly in a line"
  // when the real problem was that a stated distance is wrong.
  if (rms > maxResidual) {
    return refuse('distances_disagree', `the stated distances disagree by ${rms.toFixed(2)} miles on average — `
      + 'one of them, or one of the comparables\' own coordinates, is wrong',
    { condition: Number(condition.toFixed(4)), residualMi: Number(rms.toFixed(4)),
      maxResidualMi: Number(worst.toFixed(4)) });
  }

  // THE MIRROR IS THE TRAP, AND IT IS TESTED RATHER THAN GUESSED AT. Comparables
  // strung along one road leave a second answer reflected across that road which
  // fits the stated distances almost as well — and the residual does NOT give it
  // away. Measured on the real corpus: every borderline set would have produced a
  // residual of 2 to 107 FEET if accepted, so a residual test alone would have
  // waved all of them through with total confidence.
  //
  // So the reflection is actually computed. The point set's principal axis is its
  // best-fit line; the solution is reflected across it and scored the same way. If
  // the mirror fits comparably, there is nothing to choose between them and the
  // answer is refused. If ours is decisively better, the geometry resolved it and
  // a low conditioning number is not by itself a reason to refuse.
  const cx = P.reduce((s, p) => s + p.x, 0) / P.length;
  const cy = P.reduce((s, p) => s + p.y, 0) / P.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of P) { sxx += (p.x - cx) ** 2; syy += (p.y - cy) ** 2; sxy += (p.x - cx) * (p.y - cy); }
  // Principal direction: the eigenvector of the 2×2 covariance for the larger
  // eigenvalue, written directly rather than through a solver.
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(theta), uy = Math.sin(theta);
  // Reflect (x,y) across the line through (cx,cy) with direction (ux,uy).
  const dx = x - cx, dy = y - cy;
  const proj = dx * ux + dy * uy;
  const mx = cx + 2 * proj * ux - dx, my = cy + 2 * proj * uy - dy;
  const mirror = residAt(mx, my);
  const apart = Math.hypot(mx - x, my - y);
  // A mirror that lands on essentially the same spot is not a second answer.
  const AMBIGUOUS_APART_MI = 0.02;
  if (apart > AMBIGUOUS_APART_MI && mirror.rms <= Math.max(rms * 3, rms + 0.01)) {
    return refuse('mirror', `the comparables sit nearly in a line, and the mirror-image position `
      + `${apart.toFixed(2)} miles away fits their stated distances just as well — `
      + 'there is no way to tell the two apart',
    { condition: Number(condition.toFixed(4)), residualMi: Number(rms.toFixed(4)),
      maxResidualMi: Number(worst.toFixed(4)) });
  }
  const out = {
    ok: true,
    code: null,
    lat: Number((lat0 + y / MI_PER_DEG).toFixed(6)),
    lng: Number((lng0 + x / kx).toFixed(6)),
    n: usable.length,
    residualMi: Number(rms.toFixed(4)),
    maxResidualMi: Number(worst.toFixed(4)),
    condition: Number(condition.toFixed(4)),
    why: null,
  };
  if (!Number.isFinite(out.lat) || !Number.isFinite(out.lng)
    || Math.abs(out.lat) > 90 || Math.abs(out.lng) > 180) {
    return refuse('not_a_place', 'the arithmetic did not land on a real place');
  }
  return out;
}

/**
 * Read a MISMO proximity string into miles. `ProximityToSubjectDescription` is
 * free text — "0.55 miles SW", "0.14 mi NW", ".80 miles" — and a description
 * with no explicit mile figure ("2 blocks", "same street") is REFUSED rather
 * than guessed at.
 */
function proximityMiles(text) {
  const t = String(text == null ? '' : text).trim();
  // A WRITTEN FRACTION IS REFUSED, NOT READ AS ITS DENOMINATOR. The pattern below
  // takes the number nearest the unit, so "1/2 mile" came back as TWO — four
  // times the real distance, in the direction that widens a search and drags a
  // least-squares fit. Reading it properly is possible and is deliberately not
  // done: this module's rule is that an unclear proximity is refused rather than
  // interpreted, and a refusal costs one comparable while a silent 4× error
  // costs the position. Zero occurrences in the real corpus (all 769 proximity
  // strings match `^[0-9.]+ *mi` and none contains a slash), so this is a guard
  // against the first vendor that writes one, not a repair.
  if (/\d\s*\/\s*\d/.test(t)) return null;
  const m = /(\d+(?:\.\d+)?|\.\d+)\s*(?:mi\b|mile)/i.exec(t);
  if (!m) return null;
  const n = Number(m[1]);
  // A comparable 60 miles away is a data error, not a rural comparable — and a
  // wrong big number drags a least-squares fit further than a wrong small one.
  return Number.isFinite(n) && n >= 0 && n <= 50 ? n : null;
}

module.exports = { trilaterate, proximityMiles,
  _internals: { MI_PER_DEG, MIN_POINTS, MAX_RESIDUAL_MI, MIN_CONDITION } };
