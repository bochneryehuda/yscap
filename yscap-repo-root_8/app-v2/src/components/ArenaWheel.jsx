import React, { useEffect, useRef, useState } from 'react';
import { rotationAt, spinProgress, sliceColour, prefersReducedMotion, serverNow as serverNowMs } from '../lib/arena.js';

/* THE WHEEL.
 *
 * IT DOES NOT DECIDE ANYTHING, in either of the two ways it can run:
 *
 *   AUTO — the server settled the winner before the wheel moved and sent back
 *          the angle to stop at. This turns the wheel to that angle.
 *   FREE — the wheel turns and keeps turning. When somebody presses stop, the
 *          SERVER works out where it landed from the moment the press reached
 *          it, and sends back the angle. This coasts to that angle.
 *
 * Either way the angle comes from the server and nothing here can change who
 * won, because nothing here knows how a winner is worked out. That is what
 * makes both kinds checkable afterwards.
 *
 * WHY SVG AND NOT CANVAS. Real DOM nodes carry real text, stay crisp on the
 * big screen in the corner of the room, and can be read by a screen reader. A
 * canvas is faster once a wheel has hundreds of slices; a room has thirty
 * people in it. Rotation is a CSS transform on one group, which the browser
 * composites on the GPU without touching layout.
 *
 * WHY requestAnimationFrame AND NOT A CSS TRANSITION. Every screen has to be at
 * the SAME angle at the same instant, including one that opened halfway through
 * the spin. A CSS transition starts when the element is told to start; a frame
 * loop reading `(serverNow - startedAt) / duration` is simply correct at any
 * moment, so joining late needs no special case — it is the same formula.
 *
 * REDUCED MOTION IS HONOURED, NOT DECORATED. A person who has asked their
 * computer for less movement gets the wheel placed straight at its result with
 * no spinning at all. They lose the drama, not the information.
 */

const R = 160;
const CX = 180;
const CY = 180;

function arcPath(startDeg, endDeg) {
  const a0 = ((startDeg - 90) * Math.PI) / 180;
  const a1 = ((endDeg - 90) * Math.PI) / 180;
  const x0 = CX + R * Math.cos(a0);
  const y0 = CY + R * Math.sin(a0);
  const x1 = CX + R * Math.cos(a1);
  const y1 = CY + R * Math.sin(a1);
  const large = endDeg - startDeg > 180 ? 1 : 0;
  return `M ${CX} ${CY} L ${x0.toFixed(3)} ${y0.toFixed(3)} A ${R} ${R} 0 ${large} 1 ${x1.toFixed(3)} ${y1.toFixed(3)} Z`;
}

export default function ArenaWheel({
  candidates = [],
  angles = [],
  startedAt = null,
  durationMs = 7000,
  targetRotationDeg = 0,
  winnerIndex = null,
  hideLabels = false,
  size = 360,
  onLanded = null,
  // FREE SPIN — the wheel turns and keeps turning until somebody presses stop.
  // `free` while it is running; when the press lands, `targetRotationDeg` and
  // `coastFrom` arrive together and the wheel eases from wherever it is to
  // where the server says it stopped.
  free = false,
  degPerSecond = 900,
  coastFrom = null,
  coastMs = 1600,
}) {
  const [deg, setDeg] = useState(0);
  const raf = useRef(0);
  const landed = useRef(false);
  const reduce = prefersReducedMotion();

  // ── FREE SPIN ───────────────────────────────────────────────────────────
  // Constant speed off the SERVER's clock, so every screen in the room shows
  // the wheel at the same angle. Nothing here decides anything: the landing is
  // worked out on the server from the moment the press arrives there.
  useEffect(() => {
    if (!free || !startedAt || coastFrom) return undefined;
    if (reduce) { setDeg(0); return undefined; }
    const t0 = Date.parse(startedAt);
    const tick = () => {
      setDeg(((serverNowMs() - t0) / 1000) * degPerSecond);
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [free, startedAt, degPerSecond, coastFrom, reduce]);

  // ── THE COAST ───────────────────────────────────────────────────────────
  // Pressed. Ease from where the wheel actually is to the angle the server
  // recorded, over a fixed coast, so every screen comes to rest together.
  useEffect(() => {
    if (!coastFrom) return undefined;
    const from = deg;
    const to = Number(targetRotationDeg) || 0;
    if (reduce) { setDeg(to); if (onLanded) onLanded(); return undefined; }
    const t0 = Date.now();
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / Math.max(200, coastMs));
      setDeg(from + (to - from) * (1 - Math.pow(1 - p, 3)));
      if (p >= 1) { if (!landed.current) { landed.current = true; if (onLanded) onLanded(); } return; }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
    // `deg` is read once as the starting point on purpose — putting it in the
    // deps would restart the coast on every frame it sets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coastFrom, targetRotationDeg, coastMs, reduce]);

  useEffect(() => {
    landed.current = false;
    if (free) return undefined;
    if (!startedAt) { setDeg(0); return undefined; }
    if (reduce) {
      // Straight to the answer. No frame loop at all.
      setDeg(Number(targetRotationDeg) || 0);
      if (onLanded) onLanded();
      return undefined;
    }
    const tick = () => {
      const p = spinProgress(startedAt, durationMs);
      setDeg(rotationAt(startedAt, durationMs, targetRotationDeg));
      if (p >= 1) {
        if (!landed.current) { landed.current = true; if (onLanded) onLanded(); }
        return;                       // stop the loop; the wheel is at rest
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [startedAt, durationMs, targetRotationDeg, reduce, free]);

  // A wheel already finished before this screen opened: place it, do not spin it.
  useEffect(() => {
    if (!startedAt && winnerIndex != null && targetRotationDeg) setDeg(Number(targetRotationDeg));
  }, [startedAt, winnerIndex, targetRotationDeg]);

  const list = candidates || [];
  const slices = angles && angles.length === list.length
    ? angles
    : list.map(() => 360 / Math.max(1, list.length));

  let running = 0;
  const wedges = list.map((c, i) => {
    const start = running;
    const end = running + slices[i];
    running = end;
    const mid = (start + end) / 2;
    const rad = ((mid - 90) * Math.PI) / 180;
    const tx = CX + R * 0.66 * Math.cos(rad);
    const ty = CY + R * 0.66 * Math.sin(rad);
    return {
      key: c.key, label: c.label, weight: c.weight,
      d: arcPath(start, end), tx, ty, mid, span: slices[i], i,
    };
  });

  // Only label a slice wide enough to read. A wheel of 40 names is a wheel with
  // a legend beside it, not a wheel with 40 unreadable slivers on it.
  const labelCut = 14;

  return (
    <div className="arena-wheel-wrap" style={{ width: size, height: size }}>
      <svg
        viewBox="0 0 360 360"
        width={size}
        height={size}
        role="img"
        aria-label={list.length
          ? `A wheel with ${list.length} ${list.length === 1 ? 'name' : 'names'} on it`
          : 'An empty wheel'}
      >
        <defs>
          <radialGradient id="arena-hub" cx="50%" cy="40%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="100%" stopColor="#F0B93F" />
          </radialGradient>
          <linearGradient id="arena-rim" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#24C3CE" />
            <stop offset="50%" stopColor="#F0B93F" />
            <stop offset="100%" stopColor="#6C4BC4" />
          </linearGradient>
          <filter id="arena-shadow" x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="6" stdDeviation="10" floodColor="#141B22" floodOpacity="0.22" />
          </filter>
        </defs>

        <circle cx={CX} cy={CY} r={R + 10} fill="#FFFFFF" stroke="url(#arena-rim)" strokeWidth="7" filter="url(#arena-shadow)" />

        <g
          style={{
            transform: `rotate(${deg}deg)`,
            transformOrigin: `${CX}px ${CY}px`,
            // No CSS transition: the frame loop above owns the angle, and a
            // transition on top of it would fight the loop and drift.
            willChange: 'transform',
          }}
        >
          {wedges.map((w) => (
            <g key={`${w.key}-${w.i}`}>
              <path
                d={w.d}
                fill={sliceColour(w.i, list.length)}
                stroke="#FFFFFF"
                strokeWidth="1.5"
                opacity={w.weight === 0 ? 0.35 : 1}
              />
              {!hideLabels && w.span >= labelCut && (
                <text
                  x={w.tx}
                  y={w.ty}
                  fill="#FFFFFF"
                  fontSize={list.length > 16 ? 8 : list.length > 9 ? 10 : 12}
                  fontWeight="600"
                  textAnchor="middle"
                  dominantBaseline="middle"
                  transform={`rotate(${w.mid} ${w.tx} ${w.ty})`}
                  style={{ pointerEvents: 'none' }}
                >
                  {String(w.label).length > 18 ? `${String(w.label).slice(0, 17)}…` : w.label}
                </text>
              )}
            </g>
          ))}
          {!list.length && <circle cx={CX} cy={CY} r={R} fill="#F4F1EA" />}
        </g>

        <circle cx={CX} cy={CY} r="28" fill="url(#arena-hub)" stroke="#FFFFFF" strokeWidth="4" />
        {/* The pointer. Fixed at the top, which is the convention the server's
            angle maths assumes — the two must never disagree. */}
        <path d={`M ${CX - 15} 4 L ${CX + 15} 4 L ${CX} 44 Z`} fill="#E2564A" stroke="#FFFFFF" strokeWidth="3" />
      </svg>
      {reduce && startedAt && (
        <p className="arena-reduced-note">Motion is turned down on this computer, so the wheel jumps straight to the result.</p>
      )}
      {free && !coastFrom && !reduce && (
        <p className="arena-freenote">Still turning — it stops when the button is pressed.</p>
      )}
    </div>
  );
}
