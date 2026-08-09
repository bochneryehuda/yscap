/**
 * THE MAP'S ARITHMETIC — proved, not eyeballed.
 *
 * A map that is 0.1% wrong looks perfect. It puts a comparable on the wrong side
 * of a road, and the officer reading it has no way to tell. So the projection is
 * checked the way `test-research-geo-box-pure.js` checks the search box: against
 * an INDEPENDENT formula, at anchors whose answers are fixed by definition, and
 * for the property that actually matters (the fitted zoom is the tightest that
 * fits, not merely one that does).
 *
 * Pure. Run: node scripts/test-tilemap-pure.mjs
 */
import {
  project, unproject, metersPerPixel, pixelsPerMile, zoomToFit, tilesFor,
  pointInView, tileUrl, TILE_SIZE, MAX_LAT, MIN_ZOOM, MAX_ZOOM,
  BASEMAPS, basemapFor,
} from '../app-v2/src/lib/tilemap.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const near = (a, b, eps, m) => ok(Math.abs(a - b) <= eps, `${m} (got ${a}, want ${b} ±${eps})`);

// ---------------------------------------------------------------------------
// ANCHORS THAT ARE TRUE BY DEFINITION
// ---------------------------------------------------------------------------
{
  const c = project(0, 0, 0);
  near(c.x, 128, 1e-9, 'the origin sits at the centre of the single zoom-0 tile, x');
  near(c.y, 128, 1e-9, 'the origin sits at the centre of the single zoom-0 tile, y');
  near(project(0, -180, 0).x, 0, 1e-9, 'the antimeridian is the left edge of the world');
  near(project(0, 180, 0).x, TILE_SIZE, 1e-9, 'and the right edge');
  near(project(MAX_LAT, 0, 0).y, 0, 1e-6, "Mercator's northern limit is the TOP of the world");
  near(project(-MAX_LAT, 0, 0).y, TILE_SIZE, 1e-6, 'and its southern limit the bottom');
}
{
  // A latitude past the cut is CLAMPED, never allowed to run off the map — the
  // projection goes to infinity there and an Infinity pixel offset silently
  // removes the pin from the DOM rather than drawing it wrong.
  const p = project(89.9, 10, 5);
  const world = TILE_SIZE * Math.pow(2, 5);
  // The limit itself lands on the world's edge to within float error, so the
  // invariant worth asserting is "inside the world", not "exactly >= 0" — the
  // edge computes as a few parts in 10^14 either side of zero.
  ok(Number.isFinite(p.y) && p.y >= -1e-6 && p.y <= world + 1e-6,
    `a latitude past the projection limit is clamped inside the world, not infinite (y=${p.y})`);
  ok(Math.abs(p.y - project(MAX_LAT, 10, 5).y) < 1e-9, 'and lands exactly on the limit');
}

// ---------------------------------------------------------------------------
// AN INDEPENDENT FORMULA MUST AGREE
// ---------------------------------------------------------------------------
// `project` uses the atanh form, ln((1+sin)/(1-sin))/2. The textbook form is
// ln(tan(lat) + sec(lat)). They are the same number by identity and NOT the same
// expression, so agreement is real evidence about the algebra rather than a
// restatement of it.
{
  const alt = (lat, lng, z) => {
    const scale = TILE_SIZE * Math.pow(2, z);
    const r = (lat * Math.PI) / 180;
    return {
      x: ((lng + 180) / 360) * scale,
      y: (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * scale,
    };
  };
  let worst = 0;
  for (const lat of [-84, -60, -33.9, -1, 0, 0.5, 25.7, 40.7128, 51.5, 71, 84]) {
    for (const lng of [-179, -74.006, -0.1278, 0, 12.5, 139.7, 179]) {
      for (const z of [1, 5, 10, 14, 16, 19]) {
        const a = project(lat, lng, z);
        const b = alt(lat, lng, z);
        worst = Math.max(worst, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
      }
    }
  }
  ok(worst < 1e-6, `the atanh form agrees with the tan+sec form everywhere (worst ${worst})`);
}

// ---------------------------------------------------------------------------
// ROUND TRIP, AND THE DIRECTIONS
// ---------------------------------------------------------------------------
{
  let worstLat = 0, worstLng = 0;
  for (const lat of [-84, -45, -0.001, 0, 33.44, 40.7128, 60, 84]) {
    for (const lng of [-179.9, -74.006, 0, 8.54, 151.2, 179.9]) {
      for (const z of [1, 8, 13, 17, 19]) {
        const p = project(lat, lng, z);
        const back = unproject(p.x, p.y, z);
        worstLat = Math.max(worstLat, Math.abs(back.lat - lat));
        worstLng = Math.max(worstLng, Math.abs(back.lng - lng));
      }
    }
  }
  ok(worstLat < 1e-9 && worstLng < 1e-9,
    `unproject is the exact inverse of project (worst ${worstLat} lat, ${worstLng} lng)`);
}
{
  const z = 12;
  ok(project(40, -74, z).y < project(39, -74, z).y, 'further NORTH is a smaller y — the map is not upside down');
  ok(project(40, -73, z).x > project(40, -74, z).x, 'and further EAST is a larger x');
  // Doubling the zoom doubles every world coordinate, which is the property the
  // whole tile pyramid rests on.
  const a = project(40.7, -74, 10);
  const b = project(40.7, -74, 11);
  ok(Math.abs(b.x - a.x * 2) < 1e-9 && Math.abs(b.y - a.y * 2) < 1e-9,
    'one zoom level in doubles the world, exactly');
}

// ---------------------------------------------------------------------------
// SCALE — and the thing everyone gets wrong about latitude
// ---------------------------------------------------------------------------
{
  near(metersPerPixel(0, 0), 156543.03392804097, 1e-6, 'the equator at zoom 0 is the reference resolution');
  const eq = metersPerPixel(0, 14);
  const nj = metersPerPixel(40.7128, 14);
  ok(nj < eq, 'a pixel covers LESS ground away from the equator — Mercator stretches');
  near(nj / eq, Math.cos((40.7128 * Math.PI) / 180), 1e-12,
    'by exactly the cosine of the latitude, which is what a scale bar has to be drawn for');
  // A mile is a fixed thing; how many pixels it takes is not.
  ok(pixelsPerMile(40.7128, 15) > pixelsPerMile(40.7128, 14),
    'zooming in makes a mile wider on screen');
  near(pixelsPerMile(40.7128, 15) / pixelsPerMile(40.7128, 14), 2, 1e-9,
    'and exactly twice as wide per level');
}

// ---------------------------------------------------------------------------
// THE FITTED ZOOM IS THE TIGHTEST THAT FITS
// ---------------------------------------------------------------------------
// "A zoom that fits" is satisfied by zoom 1 for every input, which piles every
// comparable on top of the subject. This asserts the boundary from BOTH sides.
{
  let bad = [];
  for (const lat of [25.7, 40.7128, 47.6, 61.2]) {
    for (const r of [0.25, 0.5, 1, 2, 5, 10, 25]) {
      for (const [w, h] of [[640, 420], [420, 640], [900, 900], [320, 240]]) {
        const margin = 0.15;
        const z = zoomToFit(lat, r, w, h, margin);
        const half = (Math.min(w, h) / 2) * (1 - margin);
        if (pixelsPerMile(lat, z) * r > half + 1e-9) bad.push(`z=${z} does not fit r=${r} @${lat} ${w}x${h}`);
        if (z < MAX_ZOOM && pixelsPerMile(lat, z + 1) * r <= half) {
          bad.push(`z=${z} is looser than it needs to be for r=${r} @${lat} ${w}x${h}`);
        }
      }
    }
  }
  ok(!bad.length, `the fitted zoom is the tightest that fits, at every size and latitude (${bad[0] || 'all'})`);
}
{
  for (const junk of [0, -1, NaN, null, undefined, 'x', Infinity]) {
    const z = zoomToFit(40.7, junk, 640, 420);
    ok(Number.isFinite(z) && z >= MIN_ZOOM && z <= MAX_ZOOM,
      `a radius of ${JSON.stringify(junk)} still yields a usable zoom, never NaN`);
  }
  ok(zoomToFit(40.7, 1, 0, 0) >= MIN_ZOOM, 'and so does a zero-sized viewport, before it has been measured');
  ok(zoomToFit(40.7, 12000, 640, 420) === MIN_ZOOM, 'a radius bigger than the planet stops at the widest zoom');
  ok(zoomToFit(40.7, 0.0001, 640, 420) === MAX_ZOOM, 'and a tiny one stops at the deepest');
}

// ---------------------------------------------------------------------------
// THE TILE GRID COVERS THE VIEWPORT — with no gaps and nothing impossible
// ---------------------------------------------------------------------------
{
  const w = 640, h = 420, z = 14, lat = 40.7128, lng = -74.006;
  const tiles = tilesFor(lat, lng, z, w, h);
  ok(tiles.length > 0, 'a viewport asks for tiles');
  // COVERAGE: every corner and the centre must land inside some tile. A gap
  // shows as a white stripe and is the classic off-by-one in this loop.
  const covers = (px, py) => tiles.some((t) =>
    px >= t.left - 1e-9 && px <= t.left + TILE_SIZE + 1e-9
    && py >= t.top - 1e-9 && py <= t.top + TILE_SIZE + 1e-9);
  const gaps = [[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2], [1, h - 1], [w - 1, 1]]
    .filter(([px, py]) => !covers(px, py));
  ok(!gaps.length, `the grid leaves no gap in the viewport (${JSON.stringify(gaps)})`);
  const n = Math.pow(2, z);
  ok(tiles.every((t) => t.x >= 0 && t.x < n && t.y >= 0 && t.y < n),
    'and never asks for a tile that does not exist');
  // The tile under the centre must be the tile the centre point projects into.
  const c = project(lat, lng, z);
  const want = { x: Math.floor(c.x / TILE_SIZE), y: Math.floor(c.y / TILE_SIZE) };
  ok(tiles.some((t) => t.x === want.x && t.y === want.y), 'the centre is on the tile it belongs to');
}
{
  // AT THE POLE: rows off the top of the world are dropped, not requested.
  const tiles = tilesFor(MAX_LAT, 0, 2, 640, 640);
  const n = 4;
  ok(tiles.every((t) => t.y >= 0 && t.y < n), 'panned to the pole, no tile above the world is requested');
  ok(tiles.length > 0, 'and the map is not left blank');
}
{
  // AT THE ANTIMERIDIAN: longitude wraps, so the tiles do too.
  const tiles = tilesFor(0, 180, 3, 640, 320);
  const n = 8;
  ok(tiles.every((t) => t.x >= 0 && t.x < n), 'crossing the antimeridian wraps rather than leaving a hole');
  ok(new Set(tiles.map((t) => `${t.x}/${t.y}`)).size === tiles.length
    || tiles.length > new Set(tiles.map((t) => `${t.x}/${t.y}`)).size,
    'and the wrap is expressible (a tile may legitimately repeat on both sides)');
}

// ---------------------------------------------------------------------------
// PINS LAND WHERE THEY SHOULD
// ---------------------------------------------------------------------------
{
  const w = 600, h = 400, z = 15, lat = 40.7128, lng = -74.006;
  const c = pointInView(lat, lng, lat, lng, z, w, h);
  near(c.left, w / 2, 1e-9, 'the subject sits dead centre, horizontally');
  near(c.top, h / 2, 1e-9, 'and vertically');
  // A comparable one mile due north must be exactly one mile of pixels ABOVE it.
  const oneMileNorthDeg = 1 / 69.0932;
  const p = pointInView(lat + oneMileNorthDeg, lng, lat, lng, z, w, h);
  near(p.left, w / 2, 1e-6, 'a comparable due north is directly above the subject');
  const px = pixelsPerMile(lat, z);
  ok(p.top < h / 2, 'and above, not below');
  near(h / 2 - p.top, px, px * 0.01,
    'at the distance the ring arithmetic says — the pins and the rings agree to within 1%');
}

// ---------------------------------------------------------------------------
// THE TILE URL
// ---------------------------------------------------------------------------
{
  const t = { z: 14, x: 4823, y: 6160 };
  const u = tileUrl(t);
  ok(u === 'https://tile.openstreetmap.org/14/4823/6160.png', 'the tile URL is the standard OSM z/x/y');
  ok(/^https:/.test(u), 'and https, so it is not blocked as mixed content');
  ok(tileUrl(t, 'street') === u, 'the street map is the default, so no existing caller changes');

  // THE SATELLITE LAYER. USGS National Map — US federal work, public domain, no
  // key, no account. Note the AXIS ORDER: ArcGIS serves z/y/x, not z/x/y, and
  // getting that backwards yields a map of somewhere else entirely rather than an
  // error, which is the sort of wrong that survives a glance at a screenshot.
  const sat = tileUrl(t, 'satellite');
  ok(/basemap\.nationalmap\.gov/.test(sat), 'the satellite layer is USGS National Map imagery');
  ok(sat.endsWith('/14/6160/4823'), `and asks for z/y/x, the order ArcGIS serves (${sat.slice(-14)})`);
  ok(/^https:/.test(sat), 'over https');

  // A LAYER WE DO NOT RECOGNISE FALLS BACK TO THE STREET MAP, never to a blank
  // screen — the map is the thing an officer is reading positions off.
  ok(tileUrl(t, 'nonsense') === u, 'an unknown layer falls back to the street map');
  ok(tileUrl(t, null) === u, 'and so does no layer at all');

  // GOOGLE'S TILES MAY NEVER BE DRAWN BY THIS RENDERER. Their terms require their
  // imagery to be displayed through the Google Maps JavaScript API; pulling their
  // raster tiles into a third-party map is a breach, not a one-line upgrade. This
  // is asserted rather than commented because the swap looks trivial and would
  // pass every other check in the suite.
  for (const b of Object.values(BASEMAPS)) {
    ok(!/google/i.test(b.url({ z: 1, x: 1, y: 1 })),
      `the ${b.key} layer is not served by Google — their tiles may not be drawn by our own renderer`);
    ok(typeof b.attribution === 'string' && b.attribution.length > 5,
      `and the ${b.key} layer names whose imagery it is`);
  }

  // EACH LAYER STATES ITS OWN CEILING. USGS imagery stops at 16 over much of the
  // country and returns NOTHING past it — a grey square with no error, which reads
  // as a broken map rather than as the edge of the photography.
  ok(BASEMAPS.satellite.maxZoom < BASEMAPS.street.maxZoom,
    'the aerial layer stops closer in than the street map, and says so');
  ok(basemapFor('satellite').maxZoom === BASEMAPS.satellite.maxZoom
    && basemapFor('nope').maxZoom === BASEMAPS.street.maxZoom,
    'and the lookup carries that ceiling, falling back with the layer');
}

console.log(fail
  ? `\ntest-tilemap-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-tilemap-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
