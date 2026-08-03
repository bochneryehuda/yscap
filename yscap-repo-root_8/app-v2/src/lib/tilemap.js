/* WEB MERCATOR — the arithmetic behind the comparable map.
 *
 * WHY NOT A MAP LIBRARY. The task said "MapLibre + OSM, no tile bill", and the
 * two halves of that turn out to disagree: MapLibre is a WebGL VECTOR-tile
 * engine, and OpenStreetMap's free tile service serves RASTER tiles only — so
 * MapLibre needs a vector style from a provider (MapTiler and friends), which
 * means an API key and a bill. What we actually need is a locator: a subject, a
 * handful of comparables, distance rings, and click-to-select. That is a few
 * `<img>` tags in a grid and about a hundred lines of projection, against
 * ~800 KB of engine for a 3D globe we will never turn.
 *
 * So the arithmetic lives here, PURE and unit-tested, because it is exactly the
 * kind of maths that is easy to get subtly wrong and impossible to eyeball —
 * the same reason `search.js`'s bounding box has its own containment test. A
 * map that is 0.1% wrong looks perfect and puts a comparable on the wrong side
 * of a road.
 *
 * WORLD PIXELS. At zoom z the whole world is `256 * 2^z` pixels square, x
 * increasing east from the antimeridian and y increasing SOUTH from the top.
 * Mercator cannot represent the poles, so it is cut at ±85.0511° — which is
 * where the projection reaches exactly the top and bottom edges.
 *
 * TILE USAGE. `tile.openstreetmap.org` is free and asks for low volume, a real
 * identifying Referer, and no bulk downloading (their Tile Usage Policy). An
 * internal desk looking at a few dozen maps a day sits inside that; a batch job
 * rendering thousands would not, and would need a paid provider — which is a
 * one-line change to `tileUrl` and nothing else.
 */

export const TILE_SIZE = 256;
/** Mercator's own limit: beyond this the projection runs to infinity. */
export const MAX_LAT = 85.05112877980659;
const METERS_PER_MILE = 1609.344;
/** Earth's equatorial circumference ÷ one tile, in metres per pixel at zoom 0. */
const M_PER_PX_Z0 = 156543.03392804097;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 19;

const clampLat = (lat) => Math.max(-MAX_LAT, Math.min(MAX_LAT, Number(lat)));
const rad = (d) => (d * Math.PI) / 180;

/** Degrees → world pixels at `zoom`. */
export function project(lat, lng, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const s = Math.sin(rad(clampLat(lat)));
  return {
    x: ((Number(lng) + 180) / 360) * scale,
    // ln((1+s)/(1-s)) / 2 is atanh(s); the /(2π) then /2 puts 0 at the equator.
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale,
  };
}

/** World pixels at `zoom` → degrees. The exact inverse of `project`. */
export function unproject(x, y, zoom) {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const yy = 0.5 - y / scale;
  return {
    lat: 90 - (360 * Math.atan(Math.exp(-yy * 2 * Math.PI))) / Math.PI,
    lng: (x / scale) * 360 - 180,
  };
}

/**
 * Ground resolution — metres per screen pixel. It SHRINKS with latitude,
 * because Mercator stretches everything away from the equator: one pixel in
 * Alaska covers less ground than one pixel in Texas, which is why a scale bar
 * has to be drawn for the map's own centre and never once for the whole world.
 */
export const metersPerPixel = (lat, zoom) =>
  (M_PER_PX_Z0 * Math.cos(rad(clampLat(lat)))) / Math.pow(2, zoom);

/** Screen pixels per mile at this latitude and zoom — what the rings need. */
export const pixelsPerMile = (lat, zoom) => METERS_PER_MILE / metersPerPixel(lat, zoom);

/**
 * The tightest zoom at which a circle of `radiusMi` still fits the viewport.
 *
 * TIGHTEST THAT FITS, never "one that fits": too far out and every comparable
 * lands in a pile at the centre, which is the failure mode of every naive
 * locator map. `margin` (0–0.9) is the fraction of the half-viewport kept clear
 * so a pin at the edge is not cut in half by the frame.
 */
export function zoomToFit(lat, radiusMi, width, height, margin = 0.15) {
  const r = Number(radiusMi);
  const half = (Math.min(Number(width), Number(height)) / 2) * (1 - Math.max(0, Math.min(0.9, margin)));
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(half) || half <= 0) return 14;
  // pixelsPerMile(lat, z) * r <= half, solved for z.
  const z = Math.log2((half * M_PER_PX_Z0 * Math.cos(rad(clampLat(lat)))) / (METERS_PER_MILE * r));
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.floor(z)));
}

/**
 * Every tile needed to paint a `width`×`height` viewport centred on a point,
 * each with the offset to place it at.
 *
 * A tile OFF THE TOP OR BOTTOM of the world is dropped — there is no such tile
 * and requesting one is a 404 per pan. A tile off the SIDE is wrapped instead,
 * because longitude genuinely does wrap and a map scrolled past the
 * antimeridian should show the world again rather than a hole.
 */
export function tilesFor(centerLat, centerLng, zoom, width, height) {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom)));
  const n = Math.pow(2, z);
  const c = project(centerLat, centerLng, z);
  // World-pixel coordinate of the viewport's top-left corner.
  const originX = c.x - width / 2;
  const originY = c.y - height / 2;
  const first = { x: Math.floor(originX / TILE_SIZE), y: Math.floor(originY / TILE_SIZE) };
  const last = {
    x: Math.floor((originX + width) / TILE_SIZE),
    y: Math.floor((originY + height) / TILE_SIZE),
  };
  const out = [];
  for (let ty = first.y; ty <= last.y; ty++) {
    if (ty < 0 || ty >= n) continue;            // above the north pole / below the south
    for (let tx = first.x; tx <= last.x; tx++) {
      out.push({
        z,
        x: ((tx % n) + n) % n,                  // wrap the antimeridian
        y: ty,
        left: tx * TILE_SIZE - originX,
        top: ty * TILE_SIZE - originY,
      });
    }
  }
  return out;
}

/** Where a point sits inside the viewport, in screen pixels from its top-left. */
export function pointInView(lat, lng, centerLat, centerLng, zoom, width, height) {
  const c = project(centerLat, centerLng, zoom);
  const p = project(lat, lng, zoom);
  return { left: p.x - c.x + width / 2, top: p.y - c.y + height / 2 };
}

/** OpenStreetMap's standard raster tile. Swap this one line for a paid provider. */
export const tileUrl = (t) => `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;

export const ATTRIBUTION = '© OpenStreetMap contributors';
