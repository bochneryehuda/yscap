/**
 * THE MARKET AREA — "is this house inside the shape the appraiser drew?"
 *
 * Getting this subtly wrong is INVISIBLE. The comparable search still returns
 * houses, they still look plausible, and nobody can tell that the two on the far
 * side of the highway were included. So every case here has an answer fixed by
 * geometry rather than by eyeballing a picture — the same standard the search's
 * bounding box and the map's projection are held to.
 *
 * The two that break a naive ray-cast, and the reason the assertions look
 * fussy:
 *   · A VERTEX ON THE RAY is counted twice or not at all depending on which way
 *     the comparison is written, which flips the answer for every point at
 *     exactly that latitude — a whole horizontal line of wrong answers.
 *   · A POINT ON THE BOUNDARY is genuinely ambiguous, so the rule has to be
 *     chosen and then held: INSIDE, because a market area is a judgement and not
 *     a legal description.
 *
 * Pure. Run: node scripts/test-market-area-pure.js
 */
'use strict';
const {
  pointInRing, cleanRing, ringProblem, boundsOf, approxAreaSqMi, describeArea,
} = require('../src/lib/research/market-area');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

/** A one-degree square, corners at (0,0)-(1,1). Every answer below is arithmetic. */
const SQUARE = [{ lat: 0, lng: 0 }, { lat: 0, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];

// ---------------------------------------------------------------------------
// THE OBVIOUS CASES, WHICH STILL HAVE TO BE RIGHT
// ---------------------------------------------------------------------------
ok(pointInRing(0.5, 0.5, SQUARE), 'the middle of a square is inside it');
ok(!pointInRing(1.5, 0.5, SQUARE), 'a point north of it is outside');
ok(!pointInRing(-0.5, 0.5, SQUARE), 'south of it is outside');
ok(!pointInRing(0.5, 1.5, SQUARE), 'east of it is outside');
ok(!pointInRing(0.5, -0.5, SQUARE), 'west of it is outside');
ok(!pointInRing(2, 2, SQUARE), 'and a point well away on the diagonal is outside');

// ---------------------------------------------------------------------------
// THE VERTEX PROBLEM — a whole latitude of wrong answers if the rule is wrong
// ---------------------------------------------------------------------------
{
  // A ray cast west→east at exactly the latitude of a corner. A naive `>=` on
  // both ends counts that corner's two edges twice and reports INSIDE points as
  // outside, all the way along that line.
  ok(pointInRing(0, 0.5, SQUARE), 'a point level with the bottom edge, inside it, is inside');
  ok(pointInRing(1, 0.5, SQUARE), 'and level with the top edge');
  ok(!pointInRing(0, 1.5, SQUARE), 'while level with the bottom edge and OUTSIDE stays outside');
  ok(!pointInRing(1, -0.5, SQUARE), 'and level with the top edge on the other side');
}
{
  // A DIAMOND puts vertices at four different latitudes, so the half-open rule
  // is exercised at a corner that is not shared by a horizontal edge.
  const D = [{ lat: 0, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 1 }, { lat: 1, lng: 0 }];
  ok(pointInRing(1, 1, D), 'the centre of a diamond is inside');
  ok(pointInRing(1, 0.5, D), 'a point level with the left and right corners, inside, is inside');
  ok(!pointInRing(1, 2.5, D), 'and the same latitude outside is outside');
  ok(!pointInRing(0.2, 1.9, D), 'a point in the corner of the bounding box but outside the diamond is OUT');
  ok(!pointInRing(0.2, 0.1, D), 'in every corner of it');
  ok(!pointInRing(1.9, 1.9, D), 'including the top two');
  ok(!pointInRing(1.9, 0.1, D), 'and the other one');
}

// ---------------------------------------------------------------------------
// PROVED BY COVERAGE, NOT BY CHOSEN POINTS
// ---------------------------------------------------------------------------
// Hand-picked cases only prove what you thought to pick. This walks a grid
// straight ACROSS every vertex latitude of a concave shape and checks each
// point against an independent answer worked out from the shape's own
// definition — so an inversion along any single latitude, which is exactly what
// a mis-written vertex rule produces, cannot hide between the chosen cases.
{
  // The "C" again: two arms and a bite, with vertices at latitudes 0,1,2,3.
  const C = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 3 }, { lat: 1, lng: 3 }, { lat: 1, lng: 1 },
    { lat: 2, lng: 1 }, { lat: 2, lng: 3 }, { lat: 3, lng: 3 }, { lat: 3, lng: 0 },
  ];
  // Independent truth: inside the 0..3 box, minus the bite (lat 1..2, lng 1..3).
  const truth = (lat, lng) => lat >= 0 && lat <= 3 && lng >= 0 && lng <= 3
    && !(lat > 1 && lat < 2 && lng > 1 && lng <= 3);
  const wrong = [];
  for (let a = 0; a <= 60; a++) {
    const lat = -0.5 + a * (4 / 60);
    for (let b = 0; b <= 60; b++) {
      const lng = -0.5 + b * (4 / 60);
      // Points ON the boundary are their own rule, tested below; skip them here
      // so this section is only about the crossing count.
      const onEdge = [0, 1, 2, 3].some((v) => Math.abs(lat - v) < 1e-9)
        || [0, 1, 3].some((v) => Math.abs(lng - v) < 1e-9);
      if (onEdge) continue;
      const got = pointInRing(lat, lng, C);
      if (got !== truth(lat, lng)) wrong.push(`(${lat.toFixed(3)},${lng.toFixed(3)}) got ${got}`);
    }
  }
  ok(!wrong.length, `every point on a 61x61 scan agrees with the shape's own definition `
    + `(${wrong.length} disagreed${wrong.length ? ': ' + wrong.slice(0, 3).join(' ') : ''})`);
}
{
  // AND AT THE VERTEX LATITUDES THEMSELVES, off the boundary. This is the line
  // a mis-written rule inverts wholesale.
  const D = [{ lat: 0, lng: 1 }, { lat: 1, lng: 2 }, { lat: 2, lng: 1 }, { lat: 1, lng: 0 }];
  const bad = [];
  for (const lng of [0.55, 0.8, 1.0, 1.2, 1.45]) {
    if (!pointInRing(1, lng, D)) bad.push(`inside@${lng}`);
  }
  // At this latitude the diamond spans lng 0..2, so "outside" means beyond that
  // — 0.4 is INSIDE and was wrong in the first cut of this assertion.
  for (const lng of [-0.2, -1, 2.2, 3]) {
    if (pointInRing(1, lng, D)) bad.push(`outside@${lng}`);
  }
  ok(!bad.length, `at the latitude of two vertices, inside stays inside and outside stays outside `
    + `(${bad.join(' ') || 'all correct'})`);
}
// NOTE FOR WHOEVER CHANGES THIS: writing `>=` on BOTH ends of the crossing test
// is NOT a defect — it is the other half-open convention and gives identical
// answers. What breaks it is a MIXED comparison (`>` on one end, `>=` on the
// other), which makes a vertex belong to both of its edges or to neither. That
// variant fails the diamond assertions above; the symmetric one does not, and
// should not.

// ---------------------------------------------------------------------------
// ON THE BOUNDARY IS INSIDE — a rule, chosen and held
// ---------------------------------------------------------------------------
ok(pointInRing(0, 0, SQUARE), 'a corner is inside');
ok(pointInRing(0, 0.5, SQUARE), 'a point on the bottom edge is inside');
ok(pointInRing(0.5, 0, SQUARE), 'on the left edge');
ok(pointInRing(1, 1, SQUARE), 'and the far corner');
{
  const D = [{ lat: 0, lng: 0 }, { lat: 2, lng: 2 }, { lat: 0, lng: 4 }];
  ok(pointInRing(1, 1, D), 'a point exactly on a SLOPED edge is inside — the case a naive '
    + 'cross-product test misses because the arithmetic never lands on exact zero');
  ok(!pointInRing(1.01, 1, D), 'while just outside that same edge is out');
}

// ---------------------------------------------------------------------------
// A CONCAVE SHAPE — the whole point of drawing rather than a radius
// ---------------------------------------------------------------------------
{
  // A "C": the bite out of the right-hand side is the highway, the river, the
  // rail line — the thing a radius cannot express and a drawn area can.
  const C = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 3 }, { lat: 1, lng: 3 }, { lat: 1, lng: 1 },
    { lat: 2, lng: 1 }, { lat: 2, lng: 3 }, { lat: 3, lng: 3 }, { lat: 3, lng: 0 },
  ];
  ok(pointInRing(0.5, 2, C), 'the bottom arm of a C is inside');
  ok(pointInRing(2.5, 2, C), 'the top arm is inside');
  ok(!pointInRing(1.5, 2, C), 'and the BITE between them is OUTSIDE — which is the entire reason '
    + 'to draw a shape instead of using a radius');
  ok(pointInRing(1.5, 0.5, C), 'while the spine joining the two arms is inside');
}

// ---------------------------------------------------------------------------
// A SHAPE THAT IS NOT A SHAPE IS REFUSED, BY NAME
// ---------------------------------------------------------------------------
for (const bad of [[], [{ lat: 0, lng: 0 }], [{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]]) {
  const p = ringProblem(bad);
  ok(p && p.problem === 'too_few_points', `${bad.length} point(s) is refused as not a shape`);
  ok(/two points are a line/.test(p.why), 'and says why in words');
  ok(!pointInRing(0.5, 0.5, bad), 'and nothing is inside it');
}
{
  const huge = Array.from({ length: 600 }, (_, i) => ({ lat: Math.sin(i) , lng: Math.cos(i) }));
  ok(ringProblem(huge).problem === 'too_many_points',
    'a shape with more corners than a boundary needs is refused — every search would test them all');
}
ok(ringProblem(SQUARE) === null, 'and a real shape has no problem');

// ---------------------------------------------------------------------------
// A DRAWING TOOL'S OUTPUT IS CLEANED, NOT TRUSTED
// ---------------------------------------------------------------------------
{
  // Tools close the ring by repeating the first point, and a double-click emits
  // the same corner twice. A repeated vertex is a zero-length edge.
  const closed = SQUARE.concat([{ lat: 0, lng: 0 }]);
  ok(cleanRing(closed).length === 4, 'a ring closed back onto its first point is not counted twice');
  const doubled = [{ lat: 0, lng: 0 }, { lat: 0, lng: 0 }, { lat: 0, lng: 1 },
    { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];
  ok(cleanRing(doubled).length === 4, 'and neither is a double-clicked corner');
  ok(pointInRing(0.5, 0.5, closed) && pointInRing(0.5, 0.5, doubled),
    'both still contain what they should');
}
{
  const junk = [{ lat: 0, lng: 0 }, { lat: 'x', lng: 1 }, null, { lat: 0, lng: 1 },
    { lat: 999, lng: 1 }, { lat: 1, lng: 1 }, { lat: 1, lng: 0 }];
  ok(cleanRing(junk).length === 4, 'unreadable and impossible corners are dropped, not guessed at');
  ok(pointInRing(0.5, 0.5, junk), 'and what survives is still the square');
}
ok(cleanRing([[0, 0], [0, 1], [1, 1], [1, 0]]).length === 4,
  'a corner given as [lat, lng] is read the same as {lat, lng}');
ok(pointInRing(0.5, 0.5, [[0, 0], [0, 1], [1, 1], [1, 0]]), 'and contains what it should');

// ---------------------------------------------------------------------------
// THE BOX, AND HOW BIG IT IS
// ---------------------------------------------------------------------------
{
  const b = boundsOf(SQUARE);
  ok(b.minLat === 0 && b.maxLat === 1 && b.minLng === 0 && b.maxLng === 1,
    'the bounding box is exact — the SQL pre-filter runs on it before the exact test');
  ok(boundsOf([]) === null, 'and an empty ring has no box rather than a box of zeros');
}
{
  // A degree of latitude is ~69.09 miles; at the equator a degree of longitude
  // is the same, so a 1° square there is ~69.09² ≈ 4,774 square miles.
  const eq = approxAreaSqMi(SQUARE);
  ok(Math.abs(eq - 69.0932 * 69.0932) / (69.0932 * 69.0932) < 0.01,
    `a one-degree square at the equator is about 4,774 square miles (${Math.round(eq)})`);
  // The same square at 60° north is about half as wide on the ground.
  const north = approxAreaSqMi(SQUARE.map((p) => ({ lat: p.lat + 59.5, lng: p.lng })));
  ok(north < eq * 0.6 && north > eq * 0.4,
    `and the same square near 60° north is about half the ground area (${Math.round(north)})`);
  ok(approxAreaSqMi([{ lat: 0, lng: 0 }, { lat: 1, lng: 1 }]) === null,
    'a shape that is not a shape has no area, rather than zero');
}
{
  // Wound the other way round, the shoelace sum is negative — the area is not.
  const cw = SQUARE.slice().reverse();
  ok(Math.abs(approxAreaSqMi(cw) - approxAreaSqMi(SQUARE)) < 1e-6,
    'the area does not depend on which way round the shape was drawn');
  ok(pointInRing(0.5, 0.5, cw), 'and neither does what is inside it');
}

// ---------------------------------------------------------------------------
// WHAT A SCREEN IS TOLD BEFORE IT SAVES
// ---------------------------------------------------------------------------
{
  const d = describeArea(SQUARE);
  ok(d.ok && d.corners === 4, 'a usable shape reports its corner count');
  ok(d.areaSqMi > 0 && d.bounds, 'with its size and its box');
  ok(/larger than most neighbourhoods/.test(d.note || ''),
    'and a shape the size of a county SAYS SO — not a refusal, since a rural market is genuinely '
    + 'big, but nobody should save one believing they drew a neighbourhood');
}
{
  // A quarter-mile-ish block: about 0.06 square miles. No note.
  const small = [{ lat: 40.70, lng: -74.00 }, { lat: 40.70, lng: -73.995 },
    { lat: 40.704, lng: -73.995 }, { lat: 40.704, lng: -74.00 }];
  const d = describeArea(small);
  ok(d.ok && d.note === null, `a neighbourhood-sized shape gets no warning (${d.areaSqMi} sq mi)`);
  ok(d.areaSqMi < 1, 'and its area reads as a fraction of a square mile');
}
{
  const d = describeArea([{ lat: 0, lng: 0 }]);
  ok(!d.ok && d.problem === 'too_few_points' && d.areaSqMi === null,
    'and an unusable one is refused with its reason and no area');
}

// ---------------------------------------------------------------------------
// NOTHING THROWS
// ---------------------------------------------------------------------------
for (const junk of [undefined, null, 'x', 5, {}, [1, 2, 3]]) {
  let threw = null;
  try {
    pointInRing(0, 0, junk); cleanRing(junk); ringProblem(junk);
    boundsOf(junk); approxAreaSqMi(junk); describeArea(junk);
  } catch (e) { threw = e; }
  ok(!threw, `${JSON.stringify(junk)} does not throw through any entry point`);
}
ok(pointInRing(null, null, SQUARE) === false, 'a point with no position is not inside anything');
ok(pointInRing('x', 0.5, SQUARE) === false, 'and neither is an unreadable one');

console.log(fail
  ? `\ntest-market-area-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-market-area-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
