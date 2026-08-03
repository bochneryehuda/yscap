/**
 * PLACING A PROPERTY FROM THE COMPARABLES AROUND IT — and refusing to.
 *
 * Every one of the 132 properties we have lent on is unplaced: appraisers give
 * coordinates for their COMPARABLES and not for the subject, so the property the
 * loan is secured against is the one nothing can find on a map. 98 of 102 real
 * reports carry enough comparables with coordinates and a stated distance to fix
 * it — median residual 17 feet, worst 67.
 *
 * The whole risk is the MIRROR: comparables strung along one road leave a second
 * answer reflected across that road that fits the stated distances just as well.
 * Measured on the real corpus, every borderline set fits to within 2–107 feet
 * either way — so a residual test would have waved all of them through with total
 * confidence, which is why the reflection is actually computed and scored.
 *
 * Pure. Run: node scripts/test-trilaterate-pure.js
 */
'use strict';
const { trilaterate, proximityMiles, _internals } = require('../src/lib/research/trilaterate');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const MI = _internals.MI_PER_DEG;
const rad = (d) => (d * Math.PI) / 180;
/** Build a point `miles` away from (lat,lng) on a bearing, with its true distance to a target. */
function at(lat, lng, dLatMi, dLngMi) {
  return { lat: lat + dLatMi / MI, lng: lng + dLngMi / (MI * Math.cos(rad(lat))) };
}
function distMi(a, b) {
  const dy = (b.lat - a.lat) * MI;
  const dx = (b.lng - a.lng) * MI * Math.cos(rad(a.lat));
  return Math.hypot(dx, dy);
}
/** Comparables placed around a known truth, each stating its true distance. */
function around(truth, offsets, round = 0.01) {
  return offsets.map(([dy, dx]) => {
    const p = at(truth.lat, truth.lng, dy, dx);
    const d = distMi(truth, p);
    return { lat: p.lat, lng: p.lng, miles: round ? Math.round(d / round) * round : d };
  });
}

const TRUTH = { lat: 40.7128, lng: -74.006 };

// ---------------------------------------------------------------------------
// IT FINDS THE PLACE
// ---------------------------------------------------------------------------
{
  const pts = around(TRUTH, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7]]);
  const r = trilaterate(pts);
  ok(r.ok, 'three comparables around a property fix its position');
  const off = distMi(TRUTH, r) * 5280;
  ok(off < 120, `and it lands on the real place (${off.toFixed(0)} feet off, from distances rounded to 0.01 mi)`);
  ok(r.n === 3 && r.residualMi != null && r.maxResidualMi != null,
    'and it reports how many it used and how well they agreed');
}
{
  const pts = around(TRUTH, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7], [-0.6, -0.3], [0.8, 0.05]]);
  const r = trilaterate(pts);
  ok(r.ok && distMi(TRUTH, r) * 5280 < 80, 'more comparables place it more tightly');
}
// EXACT distances, no rounding — the arithmetic itself must be right.
{
  const pts = around(TRUTH, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7]], 0);
  const r = trilaterate(pts);
  ok(r.ok && distMi(TRUTH, r) * 5280 < 3 && r.residualMi < 0.001,
    'with unrounded distances it is exact to a few feet and says the residual is ~0');
}

// ---------------------------------------------------------------------------
// IT REFUSES
// ---------------------------------------------------------------------------
{
  const pts = around(TRUTH, [[0.5, 0.2], [-0.4, 0.6]]);
  const r = trilaterate(pts);
  ok(!r.ok && /two circles meet at two places/.test(r.why || ''),
    'TWO comparables are refused — two circles meet at two points and nothing chooses between them');
}
{
  // PERFECTLY COLLINEAR — there is no single solution at all, and that is caught
  // by the arithmetic before any judgement is needed.
  const pts = around(TRUTH, [[0.6, 0.4], [0.0, 0.4], [-0.6, 0.4]]);
  const r = trilaterate(pts);
  ok(!r.ok && /straight line/.test(r.why || ''),
    'comparables in an exact line are refused — the system has no single answer');
}
{
  // THE MIRROR, which is the case that actually needs judging: four comparables
  // strung along ONE ROAD, with their distances stated the way a real grid states
  // them — to a hundredth of a mile ("1.00", "0.48", "0.52", "0.97").
  //
  // THE ROUNDING IS THE WHOLE POINT, not a detail of the fixture. Given exact
  // distances even a nearly-collinear set resolves itself: the true point fits to
  // a few feet and its reflection is measurably worse, so the geometry settles it.
  // What an appraiser actually writes down is rounded, and in a set this close to
  // a straight line that rounding is bigger than the asymmetry — so BOTH answers
  // fit the stated numbers, and there is genuinely nothing to choose between them.
  // That is why the module refuses on a computed reflection rather than on an
  // angle threshold, and why the real corpus refuses 4 of its 102 reports here.
  const pts = around(TRUTH, [[0.9, 0.43], [0.3, 0.37], [-0.3, 0.43], [-0.9, 0.37]], 0.01);
  const r = trilaterate(pts);
  ok(!r.ok && /mirror-image/.test(r.why || ''),
    'comparables NEARLY in a line are refused — the mirror across that line fits just as well');
  ok(/no way to tell the two apart/.test(r.why || ''),
    'and the refusal says WHY, in words a person can act on');
  ok(/0\.\d\d miles away/.test(r.why || ''),
    'and it says HOW FAR the other answer is — a mirror a street away and one a mile away '
    + 'are not the same problem');
  // …AND THIS IS THE ASSERTION THAT JUSTIFIES THE WHOLE DESIGN: it was refused
  // while fitting the stated distances FAR inside the residual the module itself
  // refuses at, so a residual test would have accepted it with total confidence.
  ok(r.residualMi != null && r.residualMi < _internals.MAX_RESIDUAL_MI / 10,
    `it was refused DESPITE fitting to ${((r.residualMi || 0) * 5280).toFixed(0)} feet, against a `
    + `refusal threshold of ${(_internals.MAX_RESIDUAL_MI * 5280).toFixed(0)} — `
    + 'a residual test could never have caught it');
}
{
  // A distance that is simply wrong.
  const pts = around(TRUTH, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7]]);
  pts[1].miles = pts[1].miles + 3;
  const r = trilaterate(pts);
  ok(!r.ok && /disagree/.test(r.why || ''),
    'a stated distance that contradicts the others is refused rather than averaged into a wrong place');
  ok(!/mirror/.test(r.why || ''),
    '…and it is refused for the RIGHT reason: asking about the mirror first blamed the geometry '
    + 'for a number that is simply wrong');
}
{
  const pts = around(TRUTH, [[0.5, 0.2], [-0.4, 0.6], [0.1, -0.7]]);
  pts.forEach((p) => { p.miles = 0; });
  ok(!trilaterate(pts).ok, 'all-zero distances state nothing');
}
for (const junk of [null, undefined, [], [{}], [{ lat: 'x', lng: 'y', miles: 1 }],
  [{ lat: 999, lng: 0, miles: 1 }, { lat: 0, lng: 0, miles: 1 }, { lat: 1, lng: 1, miles: 1 }]]) {
  const r = trilaterate(junk);
  ok(!r.ok && r.lat === null && r.lng === null,
    `${JSON.stringify(junk)} is refused without inventing a place`);
}

// ---------------------------------------------------------------------------
// THE PROXIMITY STRING
// ---------------------------------------------------------------------------
for (const [t, want] of [
  ['0.55 miles SW', 0.55], ['0.14 mi NW', 0.14], ['1.00 miles S', 1],
  ['.80 miles', 0.8], ['0.08 MILES SE', 0.08], ['2 miles', 2],
]) ok(proximityMiles(t) === want, `"${t}" reads as ${want} miles`);
for (const t of ['2 blocks', 'same street', 'adjacent', '', null, undefined, 'SW']) {
  ok(proximityMiles(t) === null, `${JSON.stringify(t)} states no mile figure and is not guessed at`);
}
ok(proximityMiles('120 miles NE') === null,
  'a 120-mile "comparable" is a data error, not a rural comparable — and a wrong big number '
  + 'drags a least-squares fit further than a wrong small one');

console.log(fail
  ? `\ntest-trilaterate-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-trilaterate-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
