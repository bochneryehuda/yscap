/* Hold the reader's place across a data refresh (owner-directed 2026-07-27:
   "whenever I accept the document or I sign off a condition it flies down to
   the bottom / the closing section — we need to stay where we are, always").

   Every action on a loan file re-fetches the WHOLE file and re-renders it: rows
   collapse to a one-line header when they're done, an item drops out of the
   "needs my sign-off" filter, a panel grows or shrinks. The browser only
   remembers a pixel offset, so when the content above the reader changes height
   the same offset now shows a DIFFERENT part of the page — and when the page
   gets shorter than that offset the browser clamps to the new bottom, which on
   a loan file is the Closing section.

   The fix is to anchor on an ELEMENT rather than a pixel offset: remember which
   element the reader is looking at and where it sits on screen, then put it back
   in the same place once React has painted the refresh. Anchoring on an element
   is what survives content above the viewport changing height.

   Anchor candidates are elements with a STABLE identity that outlives the
   re-render — every file Section (`.file-section[id]`), plus anything that opts
   in with `data-keep-scroll="<stable key>"` (condition rows do, so the anchor is
   the exact condition being worked on rather than the section it lives in).

   Both calls are defensive no-ops outside a browser, and never throw: holding
   the scroll position is a courtesy, and it must never be able to break the
   action that triggered the refresh. */

const CANDIDATES = '[data-keep-scroll],.file-section[id]';
/* Where "the place I am reading" is measured, in px from the top of the
   viewport — just below the sticky header + identity bar, matching the trigger
   line the section rail uses (FileSections.jsx). */
const LINE = 140;

function keyOf(el) {
  const k = el.getAttribute && el.getAttribute('data-keep-scroll');
  if (k) return 'k:' + k;
  return el.id ? 'i:' + el.id : '';
}

function findByKey(key) {
  if (!key) return null;
  try {
    if (key.startsWith('i:')) return document.getElementById(key.slice(2));
    const v = key.slice(2).replace(/["\\]/g, '\\$&');
    return document.querySelector(`[data-keep-scroll="${v}"]`);
  } catch (_) { return null; }
}

/* Snapshot what the reader is looking at. Call it right BEFORE the state change
   that re-renders the page (not before the network call — the reader may scroll
   while a request is in flight, and yanking them back to where they were a
   second ago is the very thing we're fixing). */
export function captureScrollAnchor() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  try {
    const y = window.scrollY || window.pageYOffset || 0;
    if (y <= 0) return null;                       // already at the top — nothing to hold
    let anchor = null, best = Infinity;
    const els = document.querySelectorAll(CANDIDATES);
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!keyOf(el)) continue;
      const top = el.getBoundingClientRect().top;
      if (top > window.innerHeight) continue;      // below the fold — not what they're reading
      const d = Math.abs(top - LINE);
      if (d < best) { best = d; anchor = el; }
    }
    if (!anchor) return { y, key: '', top: 0 };
    return { y, key: keyOf(anchor), top: anchor.getBoundingClientRect().top };
  } catch (_) { return null; }
}

/* Put it back. Safe to call with null (nothing was captured) and safe to call
   when nothing moved — a delta of zero writes no scroll at all, so an ordinary
   refresh never touches the scroll position. */
export function restoreScrollAnchor(snap) {
  if (!snap || typeof window === 'undefined') return;
  const apply = () => {
    try {
      const el = findByKey(snap.key);
      if (el) {
        const delta = el.getBoundingClientRect().top - snap.top;
        if (Math.abs(delta) > 1) window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + delta), behavior: 'auto' });
        return;
      }
      // The anchor itself is gone — e.g. the condition just signed off left the
      // "needs my sign-off" list. Fall back to the offset the reader was at,
      // which still beats wherever a shortened page dropped them.
      if (Math.abs((window.scrollY || 0) - snap.y) > 1) window.scrollTo({ top: snap.y, behavior: 'auto' });
    } catch (_) { /* never break the refresh over a scroll position */ }
  };
  // Two frames: one for React to commit the new tree, one for the browser to
  // lay it out — measuring before layout would restore against stale geometry.
  try { requestAnimationFrame(() => requestAnimationFrame(apply)); }
  catch (_) { apply(); }
}
