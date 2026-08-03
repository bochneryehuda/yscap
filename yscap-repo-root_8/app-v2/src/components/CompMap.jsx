import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BASEMAPS, basemapFor, MAX_ZOOM, MIN_ZOOM, TILE_SIZE, pixelsPerMile, pointInView,
  project, tileUrl, tilesFor, unproject, zoomToFit,
} from '../lib/tilemap.js';

/* THE MAP — subject pin, numbered comparable pins, distance rings, click to select.
 *
 * The owner asked for "a Google Maps system that tells us how far each
 * comparable in the database is". The distance arithmetic has always been right;
 * what was missing was a picture, because a list of "0.42 mi NE" cannot answer
 * the question an underwriter actually has: are these comparables on the same
 * side of the highway, in the same school district, across the tracks?
 *
 * ─── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 *
 * A PROPERTY WITH NO POSITION IS NEVER PLACED. Two thirds of our subjects were
 * unplaced until `place-subjects` worked them out from the comparables around
 * them, and a map that quietly dropped them would have looked complete while
 * showing half the file. Anything unplaced is listed BELOW the map, by name,
 * with the reason — never guessed onto the middle of the town.
 *
 * AN ESTIMATED POSITION IS DRAWN DIFFERENTLY. A pin worked out by trilateration
 * is a hollow ring, not a solid dot, and says so on hover. It is typically 17
 * feet out — good enough to see the street, not good enough to argue about which
 * side of a boundary a house sits on, and the map must not imply otherwise.
 *
 * IF THE TILES DO NOT LOAD, THE MAP STILL WORKS. The pins and the rings are our
 * own arithmetic and are drawn regardless; only the street picture comes from
 * outside. A blocked or rate-limited tile server leaves a plain background with
 * everything still in the right place and a line saying the streets are missing
 * — never an empty box that reads as "no comparables".
 */

const SUBJECT = '#B4483C';
const COMP = '#2F7F86';
const GOLD = '#AE8746';
const INK = '#141B22';
const MUTED = '#4B585C';

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** A property's position, whichever column carries it, and how it was arrived at. */
function positionOf(p) {
  if (!p) return null;
  const lat = num(p.eff_latitude != null ? p.eff_latitude : (p.latitude != null ? p.latitude : p.geo_latitude));
  const lng = num(p.eff_longitude != null ? p.eff_longitude : (p.longitude != null ? p.longitude : p.geo_longitude));
  if (lat == null || lng == null) return null;
  const src = p.eff_geo_source || p.geo_source || (p.latitude != null ? 'appraiser' : null);
  return { lat, lng, estimated: src === 'comp_trilateration', source: src };
}

const RING_STEPS = [0.25, 0.5, 1, 2, 3, 5, 10];
/* How long a tile may take before its absence is reported. Short, because the
   notice is SELF-CORRECTING — the first tile that paints clears it — so the cost
   of being early is a line that flickers away, and the cost of being late is
   somebody staring at a blank square wondering what they are looking at. */
const TILE_WAIT_MS = 3500;

export default function CompMap({
  subject, comps = [], height = 420, radiusMi = null, selectedId = null, onSelect = null,
  drawing = false, polygon = null, onPolygon = null,
}) {
  const [size, setSize] = useState({ w: 0, h: height });
  const [view, setView] = useState(null);          // {lat, lng, zoom} once we can compute one
  const [drag, setDrag] = useState(null);
  const [tilesBroken, setTilesBroken] = useState(false);
  /* MAP OR SATELLITE. The owner asked to "look on the map actually where around
     you have things" — for a property, the aerial view answers questions the
     street map cannot (what is the lot, what backs on to it, is that a highway).
     The imagery is USGS National Map: US federal work, public domain, keyless.
     Google's own tiles are deliberately NOT an option here — their terms require
     their imagery to be drawn by the Google Maps JavaScript API, and this is our
     own renderer, so pointing at them would be a breach rather than an upgrade
     (the reasoning is written out in `lib/tilemap.js`). */
  const [basemap, setBasemap] = useState('street');
  const base = basemapFor(basemap);
  const [hover, setHover] = useState(null);
  const tilesLoaded = useRef(0);

  const subjPos = useMemo(() => positionOf(subject), [subject]);
  const placed = useMemo(() => comps
    .map((c, i) => ({ c, i, pos: positionOf(c) }))
    .filter((x) => x.pos), [comps]);
  const unplaced = useMemo(() => comps
    .map((c, i) => ({ c, i, pos: positionOf(c) }))
    .filter((x) => !x.pos), [comps]);

  /* MEASURED BY A CALLBACK REF, NOT BY AN EFFECT ON MOUNT.
     This component returns EARLY when it has nothing to place, so on the first
     render the box does not exist and a mount effect observes nothing. When the
     properties then arrive the box appears — and an effect keyed on [height]
     never runs again, so the width stays 0, `zoomToFit` is never called, `view`
     stays null, no tiles are fetched and no click can be turned into a position.
     Measured exactly that: `{drawing: true, view: false, w: 0}` on a map that
     looked fine because the empty grey box is indistinguishable from a loading
     one. A callback ref fires when the node ATTACHES, which is the moment that
     actually matters. */
  const roRef = useRef(null);
  const boxRef = useRef(null);
  const attachBox = useCallback((el) => {
    if (roRef.current) { roRef.current.disconnect(); roRef.current = null; }
    boxRef.current = el;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: height });
    measure();
    // Read off `window` rather than as a bare global: a missing identifier would
    // throw a ReferenceError at render, the class a green build never catches.
    const RO = window.ResizeObserver;
    if (RO) { roRef.current = new RO(measure); roRef.current.observe(el); }
  }, [height]);
  useEffect(() => () => { if (roRef.current) roRef.current.disconnect(); }, []);

  /* THE OPENING VIEW HAS TO CONTAIN EVERY COMPARABLE, not just the radius that
     was searched for. The comp search RELAXES its radius when a market is thin —
     that is the whole point of the ladder — so framing on the requested radius
     would push exactly the comparables that were hardest to find off the edge of
     the map. The frame is the furthest pin, or the radius, whichever is wider. */
  const centre = subjPos || (placed[0] && placed[0].pos) || null;
  const spanMi = useMemo(() => {
    if (!centre) return null;
    let furthest = 0;
    for (const { pos } of placed) {
      const dy = (pos.lat - centre.lat) * 69.0932;
      const dx = (pos.lng - centre.lng) * 69.0932 * Math.cos((centre.lat * Math.PI) / 180);
      furthest = Math.max(furthest, Math.hypot(dx, dy));
    }
    return Math.max(furthest, num(radiusMi) || 0, 0.15);
  }, [centre, placed, radiusMi]);

  useEffect(() => {
    if (!centre || !size.w || view) return;
    setView({ lat: centre.lat, lng: centre.lng, zoom: zoomToFit(centre.lat, spanMi, size.w, size.h) });
  }, [centre, size.w, size.h, spanMi, view]);

  /* A TILE THAT HANGS MUST READ THE SAME AS ONE THAT FAILS. `onError` only fires
     on a definite failure, and a blocked or throttled tile server does not
     always give you one — a proxy can leave the request pending indefinitely.
     Measured in this environment: ten tiles requested, none loaded, no error,
     and the map sat as a silent grey box with pins on it and no explanation,
     which reads as "this area has no streets" rather than "we could not fetch
     them". So the absence is judged on the OUTCOME — has any tile actually
     painted — not on an event that may never arrive. */
  useEffect(() => {
    if (!view) return undefined;
    const t = setTimeout(() => {
      if (tilesLoaded.current === 0) setTilesBroken(true);
    }, TILE_WAIT_MS);
    return () => clearTimeout(t);
  }, [view]);

  const recentre = useCallback(() => {
    if (!centre || !size.w) return;
    setView({ lat: centre.lat, lng: centre.lng, zoom: zoomToFit(centre.lat, spanMi, size.w, size.h) });
  }, [centre, size.w, size.h, spanMi]);

  /* DRAWING AND PANNING SHARE ONE SURFACE, so a click has to mean one thing at
     a time. While drawing, a press that does not MOVE is a corner and a press
     that moves is a pan — decided on release by how far the cursor travelled,
     because deciding on press would make the map unpannable in drawing mode and
     deciding on press-and-hold would make corners feel unresponsive. 4 pixels is
     the ordinary click-versus-drag threshold; a hand on a trackpad moves 1-2. */
  const DRAG_SLOP = 4;
  /* THE PRESS IS HELD IN A REF, NOT IN STATE. `endDrag` is created during a
     render and closes over the `drag` of THAT render — so the handler running on
     mouse-up can be the one built before mouse-down set anything, and it reads
     `drag` as null and places no corner. Measured exactly that: the mousedown,
     mouseup and click all arrived on the map div and not one corner appeared.
     A ref is the same value on every render, which is what a gesture spanning
     two events needs. The state copy is kept only because the CURSOR depends on
     it, and a cursor is allowed to lag a frame. */
  const pressRef = useRef(null);
  const onDown = (e) => {
    if (!view) return;
    pressRef.current = { x: e.clientX, y: e.clientY, lat: view.lat, lng: view.lng, moved: 0 };
    setDrag(pressRef.current);
  };
  const onMove = (e) => {
    const press = pressRef.current;
    if (!press || !view) return;
    const travelled = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (travelled > press.moved) press.moved = travelled;
    const drag = press;
    // In drawing mode a small wobble must not pan the map out from under the
    // corner the user is about to place.
    if (drawing && travelled <= DRAG_SLOP) return;
    const c = pointInView(drag.lat, drag.lng, drag.lat, drag.lng, view.zoom, 0, 0);
    const moved = unproject(
      c.left - (e.clientX - drag.x), c.top - (e.clientY - drag.y), view.zoom);
    setView((v) => ({ ...v, lat: moved.lat, lng: moved.lng }));
  };
  const endDrag = (e) => {
    const press = pressRef.current;
    pressRef.current = null;
    // A press that never really moved, while drawing, is a CORNER.
    if (drawing && press && press.moved <= DRAG_SLOP && onPolygon && view && boxRef.current) {
      const b = boxRef.current.getBoundingClientRect();
      const p = unprojectAt(e.clientX - b.left, e.clientY - b.top);
      if (p) onPolygon([...(polygon || []), p]);
    }
    setDrag(null);
  };
  /** A screen point inside the map box → a real position. */
  const unprojectAt = (px, py) => {
    if (!view || !size.w) return null;
    const c = project(view.lat, view.lng, view.zoom);
    return unproject(c.x - size.w / 2 + px, c.y - size.h / 2 + py, view.zoom);
  };

  /* EACH LAYER HAS ITS OWN CEILING, AND ASKING PAST IT LOOKS LIKE A BROKEN MAP.
     USGS imagery stops at zoom 16 over much of the country; ask for 19 and the
     server returns nothing at all — a grey square with no error, which reads as
     "the map is broken" rather than as "this is as close as the photography
     goes". So the zoom is clamped to the LAYER, and switching to satellite while
     already zoomed in pulls back to what that layer can actually draw. */
  const zoomBy = (d) => setView((v) => (v
    ? { ...v, zoom: Math.max(MIN_ZOOM, Math.min(base.maxZoom || MAX_ZOOM, v.zoom + d)) } : v));

  function switchBasemap(key) {
    setBasemap(key);
    setTilesBroken(false);
    tilesLoaded.current = 0;                       // a fresh layer gets a fresh verdict
    const cap = basemapFor(key).maxZoom || MAX_ZOOM;
    setView((v) => (v && v.zoom > cap ? { ...v, zoom: cap } : v));
  }

  if (!centre) {
    return (
      <div style={panel}>
        <div style={{ color: MUTED, fontSize: 14 }}>
          Nothing here can be put on a map yet — neither the subject nor any comparable has a
          position. We work a subject&apos;s position out from the comparables around it, which needs
          three of them with coordinates and a stated distance.
        </div>
      </div>
    );
  }

  const tiles = view && size.w ? tilesFor(view.lat, view.lng, view.zoom, size.w, size.h) : [];
  const ppm = view ? pixelsPerMile(view.lat, view.zoom) : 0;
  const at = (pos) => pointInView(pos.lat, pos.lng, view.lat, view.lng, view.zoom, size.w, size.h);
  // One ring, at the largest step that still fits — several concentric rings on a
  // small map is noise, not scale.
  const ring = view ? RING_STEPS.filter((r) => r * ppm < Math.min(size.w, size.h) / 2).pop() : null;

  return (
    <div style={panel}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 15, color: INK }}>Where these are</h3>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {ring && <span style={{ color: MUTED, fontSize: 12 }}>ring = {ring} mile{ring === 1 ? '' : 's'}</span>}
          <button type="button" className="btn small" onClick={() => zoomBy(-1)} aria-label="Zoom out">−</button>
          <button type="button" className="btn small" onClick={() => zoomBy(1)} aria-label="Zoom in">+</button>
          <button type="button" className="btn small" onClick={recentre}>Re-centre</button>
        </div>
      </div>

      <div
        ref={attachBox}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={endDrag}
        onMouseLeave={endDrag}
        style={{
          position: 'relative', height, borderRadius: 8, overflow: 'hidden',
          border: '1px solid #E4DECF', background: '#EFEADF',
          cursor: drag ? 'grabbing' : 'grab', userSelect: 'none',
        }}
      >
        {/* THE STREETS. Anything that fails to load leaves the plain background —
            the pins below are ours and do not depend on it. */}
        {tiles.map((t) => (
          <img
            key={`${basemap}/${t.z}/${t.x}/${t.y}/${t.left}`}
            src={tileUrl(t, basemap)}
            alt=""
            draggable={false}
            onLoad={() => { tilesLoaded.current += 1; setTilesBroken(false); }}
            onError={() => setTilesBroken(true)}
            style={{
              position: 'absolute', left: t.left, top: t.top,
              width: TILE_SIZE, height: TILE_SIZE, pointerEvents: 'none',
            }}
          />
        ))}

        {view && ring && (() => {
          const c = at(centre);
          const r = ring * ppm;
          return (
            <div style={{
              position: 'absolute', left: c.left - r, top: c.top - r, width: r * 2, height: r * 2,
              border: `1px dashed ${GOLD}`, borderRadius: '50%', pointerEvents: 'none', opacity: 0.85,
            }} />
          );
        })()}

        {/* THE SHAPE BEING DRAWN. An SVG overlay rather than absolutely-positioned
            divs, because a polygon is one path and a dozen divs would be a dozen
            rectangles pretending to be one. `pointer-events: none` so it never
            swallows the click that adds the next corner. */}
        {view && drawing && Array.isArray(polygon) && polygon.length > 0 && (
          <svg width={size.w} height={size.h} style={{ position: 'absolute', left: 0, top: 0,
            pointerEvents: 'none', zIndex: 2 }}>
            {polygon.length > 2 && (
              <polygon
                points={polygon.map((p) => { const q = at(p); return `${q.left},${q.top}`; }).join(' ')}
                fill="rgba(174,135,70,.14)" stroke={GOLD} strokeWidth="2" />
            )}
            {polygon.length === 2 && (() => { const a = at(polygon[0]); const b2 = at(polygon[1]); return (
              <line x1={a.left} y1={a.top} x2={b2.left} y2={b2.top} stroke={GOLD} strokeWidth="2" />
            ); })()}
            {polygon.map((p, i) => { const q = at(p); return (
              <circle key={i} cx={q.left} cy={q.top} r="5" fill="#fff" stroke={GOLD} strokeWidth="2" />
            ); })}
          </svg>
        )}

        {view && subjPos && (() => {
          const p = at(subjPos);
          return (
            <div
              title={`Subject${subjPos.estimated ? ' — position worked out from the comparables, not measured' : ''}`}
              style={{
                position: 'absolute', left: p.left - 9, top: p.top - 9, width: 18, height: 18,
                borderRadius: '50%', background: subjPos.estimated ? 'transparent' : SUBJECT,
                border: `3px solid ${SUBJECT}`, boxShadow: '0 0 0 2px #fff', zIndex: 3,
              }}
            />
          );
        })()}

        {view && placed.map(({ c, i, pos }) => {
          const p = at(pos);
          const id = c.id != null ? c.id : i;
          const on = selectedId != null && String(selectedId) === String(id);
          return (
            <button
              type="button"
              key={id}
              onClick={(e) => { e.stopPropagation(); if (onSelect) onSelect(id, c); }}
              onMouseEnter={() => setHover({ i, c, pos })}
              onMouseLeave={() => setHover(null)}
              title={`${i + 1}. ${c.display_address || 'this comparable'}`
                + (pos.estimated ? ' — position worked out from the comparables, not measured' : '')}
              style={{
                position: 'absolute', left: p.left - 11, top: p.top - 11,
                width: 22, height: 22, borderRadius: '50%', cursor: 'pointer',
                background: pos.estimated ? '#fff' : COMP,
                color: pos.estimated ? COMP : '#fff',
                border: `2px solid ${on ? GOLD : COMP}`,
                boxShadow: on ? `0 0 0 3px ${GOLD}55` : '0 0 0 2px #fff',
                font: '700 11px/18px system-ui', padding: 0, zIndex: on ? 4 : 2,
              }}
            >{i + 1}</button>
          );
        })}

        {/* MAP OR SATELLITE — two buttons, top-right, out of the way of the pins. */}
        <div style={{ position: 'absolute', top: 8, right: 8, zIndex: 6, display: 'flex',
          borderRadius: 6, overflow: 'hidden', border: '1px solid #E4DECF', boxShadow: '0 1px 3px #0002' }}>
          {Object.values(BASEMAPS).map((b) => (
            <button key={b.key} type="button"
              onClick={(e) => { e.stopPropagation(); switchBasemap(b.key); }}
              onMouseDown={(e) => e.stopPropagation()}
              title={b.attribution}
              style={{
                border: 'none', cursor: 'pointer', font: '600 12px/1 system-ui', padding: '7px 10px',
                background: basemap === b.key ? '#FBF6EC' : '#FFFFFF',
                color: basemap === b.key ? '#141B22' : '#4B585C',
              }}>{b.label}</button>
          ))}
        </div>

        {hover && (
          <div style={{
            position: 'absolute', left: 8, bottom: 8, right: 8, background: 'rgba(255,255,255,.96)',
            border: '1px solid #E4DECF', borderRadius: 6, padding: '6px 8px', fontSize: 12,
            color: INK, pointerEvents: 'none', zIndex: 5,
          }}>
            <b>{hover.i + 1}. {hover.c.display_address || 'Comparable'}</b>
            {hover.c.last_sale_price ? ` · $${Number(hover.c.last_sale_price).toLocaleString('en-US')}` : ''}
            {hover.pos.estimated && (
              <span style={{ color: GOLD }}> · position worked out from its own comparables, not measured</span>
            )}
          </div>
        )}

        <div style={{
          position: 'absolute', right: 4, bottom: 2, fontSize: 10, color: '#4B585C',
          background: 'rgba(255,255,255,.75)', padding: '0 4px', borderRadius: 3, pointerEvents: 'none',
        }}>{base.attribution}</div>
      </div>

      {tilesBroken && (
        <div style={{ color: '#8A5A00', fontSize: 12.5, marginTop: 6 }}>
          The street picture has not loaded, so this is showing positions on a plain background.
          Everything on it is still in the right place — the pins and the distance ring are worked out
          here, not fetched.
        </div>
      )}

      {/* NOTHING IS SILENTLY MISSING. A comparable with no position is named here
          rather than dropped, because a map that shows 4 of 6 comparables and says
          so is useful, and one that shows 4 and implies 4 is misleading. */}
      {unplaced.length > 0 && (
        <div style={{ color: MUTED, fontSize: 12.5, marginTop: 8 }}>
          Not on the map ({unplaced.length} of {comps.length}) — we hold no position for{' '}
          {unplaced.slice(0, 4).map(({ c, i }) => c.display_address || `comparable ${i + 1}`).join(', ')}
          {unplaced.length > 4 ? ` and ${unplaced.length - 4} more` : ''}. We work a property&apos;s
          position out from the comparables around it, which needs three of them with coordinates and
          a stated distance.
        </div>
      )}
      {placed.some((x) => x.pos.estimated) && (
        <div style={{ color: MUTED, fontSize: 12.5, marginTop: 6 }}>
          A hollow pin is a position we worked out from the comparables around that property rather
          than looked up — typically within about 17 feet, close enough to see the street and not
          close enough to argue about a boundary.
        </div>
      )}
    </div>
  );
}

const panel = {
  background: '#fff', border: '1px solid #E7E1D3', borderRadius: 10, padding: 12, marginBottom: 14,
};
