/**
 * A MARKET AREA THE APPRAISER WOULD RECOGNISE — drawn, not derived.
 *
 * A radius is a bad model of a neighbourhood and every appraiser knows it. A
 * mile in one direction crosses a river, a rail line, a school-district boundary
 * or a town line; a mile in another is the same houses on the same streets. The
 * 1004MC form itself asks the appraiser to define the "neighbourhood" and then
 * report on it — so the boundary is a judgement a person makes, and the only
 * honest way to capture it is to let them draw it.
 *
 * ─── WHY THE GEOMETRY LIVES HERE, PURE AND TESTED ───────────────────────────
 *
 * "Is this house inside that shape" decides which comparables an officer sees.
 * Getting it subtly wrong is invisible: the search still returns houses, they
 * still look plausible, and nobody can tell that the two on the far side of the
 * highway were included. So the test is written the way the search's bounding
 * box and the map's projection are — against cases whose answer is fixed by
 * geometry rather than by eyeballing a picture.
 *
 * RAY CASTING, and the two things that break a naive version:
 *
 *  · A VERTEX ON THE RAY is counted twice or not at all depending on which way
 *    you write the comparison, which flips the answer for every point at exactly
 *    that latitude. The half-open rule below (`>` on one end, `<=` on the other)
 *    counts each edge once and is what makes a point sitting level with a corner
 *    come out right.
 *  · A POINT EXACTLY ON THE BOUNDARY is genuinely ambiguous, and a market area
 *    is not a legal description — so it is treated as INSIDE. Excluding it would
 *    drop a house whose own coordinate happens to land on the line the user drew
 *    through its street.
 *
 * Longitude wrapping is deliberately NOT handled: a market area spanning the
 * antimeridian is not a neighbourhood, and pretending to support it would add a
 * branch nothing can test against real data.
 */
'use strict';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** A drawn ring, cleaned: at least 3 usable points, no duplicate closing point. */
function cleanRing(points) {
  const out = [];
  for (const p of Array.isArray(points) ? points : []) {
    const lat = num(p && (Array.isArray(p) ? p[0] : p.lat));
    const lng = num(p && (Array.isArray(p) ? p[1] : p.lng));
    if (lat == null || lng == null) continue;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) continue;
    // A drawing tool emits the closing point again; a repeated vertex is a
    // zero-length edge, which contributes nothing and confuses the area.
    const last = out[out.length - 1];
    if (last && last.lat === lat && last.lng === lng) continue;
    out.push({ lat, lng });
  }
  // The ring may also close back onto its first point.
  while (out.length > 1
    && out[0].lat === out[out.length - 1].lat && out[0].lng === out[out.length - 1].lng) {
    out.pop();
  }
  return out;
}

/** Is the shape usable at all? A named refusal, never a silent empty result. */
function ringProblem(points) {
  const ring = cleanRing(points);
  if (ring.length < 3) {
    return { problem: 'too_few_points', why: 'a market area needs at least three corners — two points '
      + 'are a line, and a line contains nothing' };
  }
  if (ring.length > 500) {
    return { problem: 'too_many_points', why: 'that shape has more corners than a neighbourhood '
      + 'boundary needs, and every comparable search would have to test all of them' };
  }
  return null;
}

/**
 * Is a point inside the ring? Ray casting, half-open so each edge counts once.
 * A point ON the boundary is INSIDE — a market area is a judgement, not a legal
 * description, and dropping a house whose coordinate lands on the drawn line is
 * the wrong way to be wrong.
 */
function pointInRing(lat, lng, points) {
  const ring = cleanRing(points);
  if (ring.length < 3) return false;
  const y = num(lat);
  const x = num(lng);
  if (y == null || x == null) return false;

  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng;
    const yj = ring[j].lat, xj = ring[j].lng;

    // ON THE EDGE COUNTS AS IN. Checked before the crossing test, because the
    // crossing test's answer on the boundary depends on which side you approach
    // from and is therefore not an answer at all.
    if (onSegment(y, x, yi, xi, yj, xj)) return true;

    // The half-open rule: an edge is counted when the ray's latitude is at or
    // above one endpoint and strictly below the other. A vertex therefore
    // belongs to exactly one of its two edges.
    if ((yi > y) !== (yj > y)) {
      const xCross = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
      if (x < xCross) inside = !inside;
    }
  }
  return inside;
}

/** Is (y,x) on the segment (y1,x1)-(y2,x2), within floating-point reach? */
function onSegment(y, x, y1, x1, y2, x2) {
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1);
  // A degree is ~69 miles, so 1e-12 degrees is well under a millimetre — tight
  // enough that it only catches a point genuinely on the line.
  if (Math.abs(cross) > 1e-12) return false;
  return Math.min(x1, x2) - 1e-12 <= x && x <= Math.max(x1, x2) + 1e-12
    && Math.min(y1, y2) - 1e-12 <= y && y <= Math.max(y1, y2) + 1e-12;
}

/** The ring's bounding box — what a SQL pre-filter uses before the exact test. */
function boundsOf(points) {
  const ring = cleanRing(points);
  if (!ring.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of ring) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return { minLat, maxLat, minLng, maxLng };
}

/**
 * Roughly how big the area is, in square miles — so a screen can say "you have
 * drawn 200 square miles", which is a county rather than a neighbourhood.
 *
 * The shoelace formula on degrees, scaled: a degree of latitude is ~69.09 miles
 * everywhere, a degree of longitude is that times cos(latitude). Scaling by the
 * cosine at the ring's MIDDLE latitude is the ordinary small-area
 * approximation — good to a fraction of a percent over a neighbourhood, and it
 * is reported as approximate rather than dressed up as a survey.
 */
function approxAreaSqMi(points) {
  const ring = cleanRing(points);
  if (ring.length < 3) return null;
  const b = boundsOf(ring);
  const midLat = (b.minLat + b.maxLat) / 2;
  const MI_PER_DEG = 69.0932;
  const kx = MI_PER_DEG * Math.cos((midLat * Math.PI) / 180);
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    sum += (ring[j].lng * kx) * (ring[i].lat * MI_PER_DEG)
         - (ring[i].lng * kx) * (ring[j].lat * MI_PER_DEG);
  }
  return Math.abs(sum) / 2;
}

/** Everything a caller needs to judge a drawn shape before saving it. */
function describeArea(points) {
  const problem = ringProblem(points);
  const ring = cleanRing(points);
  if (problem) return Object.assign({ ok: false, corners: ring.length, areaSqMi: null }, problem);
  const areaSqMi = approxAreaSqMi(ring);
  return {
    ok: true, problem: null, why: null,
    corners: ring.length,
    areaSqMi: Number(areaSqMi.toFixed(2)),
    bounds: boundsOf(ring),
    // NOT a refusal — a big shape is legitimate in a rural market. It is said,
    // so nobody saves a county believing they drew a neighbourhood.
    note: areaSqMi > 50
      ? `That is about ${Math.round(areaSqMi)} square miles, which is larger than most neighbourhoods `
        + '— worth a second look if you meant to draw one.'
      : null,
  };
}

module.exports = {
  pointInRing, cleanRing, ringProblem, boundsOf, approxAreaSqMi, describeArea,
  _internals: { onSegment },
};
