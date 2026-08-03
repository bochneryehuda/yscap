/**
 * THE BOUNDING BOX MUST BE A SUPERSET OF THE CIRCLE.
 *
 * A radius search does its cutting with a bounding box on the indexed lat/lng
 * columns and then refines with haversine. That is only correct if the box
 * CONTAINS the whole circle: the refine can throw away a point the box let
 * through, but nothing can recover a point the box excluded. A box that is a few
 * feet short drops real comparables off the edges of every distance search, and
 * there is no symptom — the answer is simply smaller than the truth.
 *
 * Two constants made it short, and both are the kind that read as fine:
 *   · a degree of LATITUDE was taken as 69.0546 miles, a mid-latitude average. It
 *     runs 68.703 (equator) to 69.407 (poles), so anywhere the degree is shorter
 *     than the average the box under-covers.
 *   · a degree of LONGITUDE was scaled by cos(CENTRE latitude). Longitude
 *     degrees shrink as you leave the equator, so the far corner of the box sits
 *     where they are shorter still — at 40.7°N with a 10-mile radius that is a
 *     0.24% shortfall, roughly 125 feet.
 *
 * PROVEN BY CONSTRUCTION, not by arithmetic: for a battery of latitudes and
 * radii, walk 360 bearings around the exact circle and assert every point lands
 * inside the box. This is the same test that catches the classic version of the
 * bug (one delta used for both axes), which clips the east-west edges hard.
 *
 * Pure. Run: node scripts/test-research-geo-box-pure.js
 */
'use strict';
const S = require('../src/lib/research/search');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const R_EARTH_MI = 3958.7613;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** The point exactly `dist` miles from (lat,lng) on a given bearing. */
function destination(lat, lng, bearingDeg, dist) {
  const d = dist / R_EARTH_MI;
  const br = rad(bearingDeg), la = rad(lat), lo = rad(lng);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la),
    Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: deg(la2), lng: deg(lo2) };
}

/**
 * Pull the box the query builder actually produced out of its own SQL, so this
 * tests the shipped predicate rather than a copy of the formula. The two BETWEEN
 * clauses are the only ones that mention `eff_latitude` / `eff_longitude` with a
 * range, and their bounds are the last four parameters bound before the exact
 * haversine cut.
 */
function boxFor(lat, lng, radius) {
  const q = S.buildQuery({ lat, lng, radius_miles: radius });
  const latIdx = q.where.match(/p\.eff_latitude BETWEEN \$(\d+) AND \$(\d+)/);
  const lngIdx = q.where.match(/p\.eff_longitude BETWEEN \$(\d+) AND \$(\d+)/);
  if (!latIdx || !lngIdx) return null;
  return {
    latMin: q.params[Number(latIdx[1]) - 1], latMax: q.params[Number(latIdx[2]) - 1],
    lngMin: q.params[Number(lngIdx[1]) - 1], lngMax: q.params[Number(lngIdx[2]) - 1],
  };
}

// Every US latitude the warehouse could plausibly hold, plus the extremes that
// break a naive formula.
const LATS = [0, 18.0, 25.7, 33.4, 40.7, 42.3, 47.6, 61.2, 71.3, -33.9];
const RADII = [0.25, 0.5, 1, 3, 5, 10, 25];

let checked = 0, escaped = 0, worst = 0;
for (const lat of LATS) {
  for (const r of RADII) {
    const box = boxFor(lat, -74.0, r);
    if (!box) { fail++; console.log(`FAIL no box produced for lat ${lat} r ${r}`); continue; }
    for (let b = 0; b < 360; b += 1) {
      const p = destination(lat, -74.0, b, r);
      checked++;
      const inLat = p.lat >= box.latMin && p.lat <= box.latMax;
      const inLng = p.lng >= box.lngMin && p.lng <= box.lngMax;
      if (!inLat || !inLng) {
        escaped++;
        const missLat = Math.max(box.latMin - p.lat, p.lat - box.latMax, 0);
        const missLng = Math.max(box.lngMin - p.lng, p.lng - box.lngMax, 0);
        worst = Math.max(worst, missLat, missLng);
      }
    }
  }
}
ok(escaped === 0,
  `every point on the circle is inside the box — ${checked} bearings across ${LATS.length} latitudes `
  + `and ${RADII.length} radii${escaped ? `, ${escaped} escaped by up to ${worst.toFixed(6)}°` : ''}`);

// AND THE BOX IS NOT ABSURDLY LARGE. A superset is only useful if it still cuts:
// the box should stay within a few per cent of the circle's own extent, or the
// haversine refine is doing all the work and the index none.
for (const lat of [25.7, 40.7, 61.2]) {
  const r = 5;
  const box = boxFor(lat, -74.0, r);
  const north = destination(lat, -74.0, 0, r).lat;
  const east = destination(lat, -74.0, 90, r).lng;
  const slackLat = (box.latMax - lat) / (north - lat);
  const slackLng = (box.lngMax + 74.0) / (east + 74.0);
  ok(slackLat > 1 && slackLat < 1.05 && slackLng > 1 && slackLng < 1.05,
    `at ${lat}°N the box is a superset without being loose (lat ×${slackLat.toFixed(4)}, lng ×${slackLng.toFixed(4)})`);
}

// THE CLASSIC VERSION OF THE BUG, so this test is known to be able to fail: one
// delta used for BOTH axes clips the east-west edges badly at any real latitude.
{
  const lat = 40.7, r = 5;
  const dBoth = r / 69.0546;
  let clipped = 0;
  for (let b = 0; b < 360; b += 1) {
    const p = destination(lat, -74.0, b, r);
    if (p.lng < -74.0 - dBoth || p.lng > -74.0 + dBoth) clipped++;
  }
  ok(clipped > 0,
    `the one-delta-for-both-axes version clips ${clipped} of 360 bearings at 40.7°N — the test can fail`);
}

// A radius of zero or nothing at all must not produce a box at all.
ok(boxFor(40.7, -74.0, 0) === null, 'no radius means no box — the whole warehouse stays reachable');
ok(S.buildQuery({ lat: 40.7, lng: -74.0 }).where.includes('eff_latitude IS NOT NULL'),
  'coordinates with no radius still restrict to placed properties, so a distance can be shown');

console.log(fail
  ? `\ntest-research-geo-box-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-research-geo-box-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
