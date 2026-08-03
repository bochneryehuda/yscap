import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ATTRIBUTION, MAX_ZOOM, MIN_ZOOM, TILE_SIZE, pixelsPerMile, pointInView,
  tileUrl, tilesFor, unproject, zoomToFit,
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
}) {
  const boxRef = useRef(null);
  const [size, setSize] = useState({ w: 0, h: height });
  const [view, setView] = useState(null);          // {lat, lng, zoom} once we can compute one
  const [drag, setDrag] = useState(null);
  const [tilesBroken, setTilesBroken] = useState(false);
  const [hover, setHover] = useState(null);
  const tilesLoaded = useRef(0);

  const subjPos = useMemo(() => positionOf(subject), [subject]);
  const placed = useMemo(() => comps
    .map((c, i) => ({ c, i, pos: positionOf(c) }))
    .filter((x) => x.pos), [comps]);
  const unplaced = useMemo(() => comps
    .map((c, i) => ({ c, i, pos: positionOf(c) }))
    .filter((x) => !x.pos), [comps]);

  // Measure the box before drawing anything — a zoom fitted to a zero-width
  // viewport is meaningless, and every pin would stack on the left edge.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const measure = () => setSize({ w: el.clientWidth, h: height });
    measure();
    // Read off `window` rather than as a bare global: the panel is also rendered
    // in the print path, and a bare identifier that is missing would throw a
    // ReferenceError at render — the class a green build never catches.
    const RO = window.ResizeObserver;
    if (!RO) {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const ro = new RO(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [height]);

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

  // Drag to pan, in world pixels so it tracks the cursor exactly at any zoom.
  const onDown = (e) => {
    if (!view) return;
    setDrag({ x: e.clientX, y: e.clientY, lat: view.lat, lng: view.lng });
  };
  const onMove = (e) => {
    if (!drag || !view) return;
    const c = pointInView(drag.lat, drag.lng, drag.lat, drag.lng, view.zoom, 0, 0);
    const moved = unproject(
      c.left - (e.clientX - drag.x), c.top - (e.clientY - drag.y), view.zoom);
    setView((v) => ({ ...v, lat: moved.lat, lng: moved.lng }));
  };
  const endDrag = () => setDrag(null);

  const zoomBy = (d) => setView((v) => (v
    ? { ...v, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom + d)) } : v));

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
        ref={boxRef}
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
            key={`${t.z}/${t.x}/${t.y}/${t.left}`}
            src={tileUrl(t)}
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
        }}>{ATTRIBUTION}</div>
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
