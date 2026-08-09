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

/* Which file SECTION is the reader looking at right now — the `.file-section[id]`
   nearest the read line, or null when none is on screen (or we're at the very
   top). Used to REMEMBER a place across a full browser refresh (file-place.js):
   a section id is stable and always re-findable after remount, unlike a pixel
   offset. Section-level on purpose — coarser than captureScrollAnchor's condition
   rows, but it survives a collapsed section and re-opens deterministically. */
export function nearestFileSectionId(line = LINE) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  try {
    const y = window.scrollY || window.pageYOffset || 0;
    if (y <= 0) return null;                        // at the top — nothing to remember
    let id = null, best = Infinity;
    const els = document.querySelectorAll('.file-section[id]');
    for (let i = 0; i < els.length; i++) {
      const el = els[i];
      if (!el.id) continue;
      const top = el.getBoundingClientRect().top;
      if (top > window.innerHeight) continue;        // below the fold
      const d = Math.abs(top - line);
      if (d < best) { best = d; id = el.id; }
    }
    return id;
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

/* ---------------------------------------------------------------------------
   LAYOUT changes, not data refreshes (owner-reported 2026-08-02: "on any section
   that we click to open up, we get bounced back up on top like a failure issue.
   We need to stay. Any button that we click, we should stay in that section").

   Everything above holds the reader's place across a re-FETCH. The same thing
   happens without any network call at all, for the same underlying reason: a
   collapse, a hub tab, or a body scroll-lock takes the page's HEIGHT away, the
   browser clamps scrollTop to the new maximum, and nothing puts the reader back.

   It only became a top-of-page jump when the file went to one room at a time.
   The clamp was always there, but a 27-screen page absorbed it — it landed the
   reader mid-page, where the browser's own scroll anchoring carried them back
   when the content returned. A room holding one section is barely a screen tall,
   so the clamp lands at 0, where scroll anchoring has nothing to work with and
   re-opening leaves them at the top for good.

   Three verbs, because there are three shapes of that one problem. All of them
   are no-ops outside a browser and none of them may ever throw — holding a
   scroll position is a courtesy and must never break the click that caused it.
   --------------------------------------------------------------------------- */

const raf2 = (fn) => {
  try { requestAnimationFrame(() => requestAnimationFrame(fn)); }
  catch (_) { fn(); }
};

/* Scroll to `y` and KEEP ASKING while the page is still growing.
   Two frames are enough for React to commit and the browser to lay out, but not
   for content that measures itself afterwards — re-opening a section remounts
   its children, and a panel that sizes on a later tick means the page is still
   short when we scroll, so the browser clamps us and we land above the mark.
   Measured on the real bundle: re-opening the File overview restored to 2248
   instead of 2350 for exactly this reason.

   Bounded (4 attempts over ~360ms) and self-terminating the moment it lands. It
   stands down immediately if the reader has scrolled since our own last write —
   chasing a target they have moved away from is the very rudeness this module
   exists to prevent. */
function scrollSettling(y) {
  let tries = 0, last = -1;
  const put = () => {
    try {
      const now = window.scrollY || window.pageYOffset || 0;
      if (last >= 0 && Math.abs(now - last) > 2) return;   // the reader took over
      if (Math.abs(now - y) > 1) window.scrollTo({ top: y, behavior: 'auto' });
      last = window.scrollY || window.pageYOffset || 0;
      if (++tries < 4 && Math.abs(last - y) > 2) setTimeout(put, 120);
    } catch (_) { /* courtesy only */ }
  };
  raf2(put);
}

/* (1) A body scroll-LOCK. `document.body.style.overflow='hidden'` drops the
   document to the viewport height, so the browser clamps to 0 immediately;
   unlocking restores the height but never the offset. Pair these two around the
   lock — CreditReport, ToolModal and ProductStudioPanel already do exactly this
   by hand (#108); this is that same step, named. */
export function rememberScroll() {
  if (typeof window === 'undefined') return 0;
  try { return window.scrollY || window.pageYOffset || 0; } catch (_) { return 0; }
}
export function restoreRemembered(y) {
  if (typeof window === 'undefined' || !(y > 0)) return;
  scrollSettling(y);
}

/* (2) A swap of equal-ish standing — a hub tab, a filter. Keep the control the
   reader actually clicked exactly where it is on screen. Same delta algorithm as
   restoreScrollAnchor, anchored on the button instead of a section, so a tab
   whose new panel is shorter can never throw the reader off the page. */
export function keepAnchored(el, mutate) {
  if (typeof window === 'undefined' || !el || !el.getBoundingClientRect) return mutate();
  let before = 0;
  try { before = el.getBoundingClientRect().top; } catch (_) { return mutate(); }
  const out = mutate();
  raf2(() => {
    try {
      const delta = el.getBoundingClientRect().top - before;
      if (Math.abs(delta) > 1) window.scrollTo({ top: Math.max(0, (window.scrollY || 0) + delta), behavior: 'auto' });
    } catch (_) { /* courtesy only */ }
  });
  return out;
}

/* (3) A COLLAPSE and its matching re-open. Anchoring is not enough here: once a
   room's only section is shut the page has nowhere left to scroll, so there is
   no position to hold — the reader genuinely belongs at the top of a one-screen
   page. What they must get back is where they WERE, the moment the content
   returns. So park the offset on the way down and hand it back on the way up.

   `landed` is what makes this safe to do unconditionally. It records where the
   collapse actually dropped the reader; if they have scrolled away since, they
   have chosen a new place to read and unparking would yank them out of it, so
   the restore stands down. Collapsing while already at the top parks nothing —
   there is no place to give back. */
export function parkScroll() {
  if (typeof window === 'undefined') return null;
  let y = 0;
  try { y = window.scrollY || window.pageYOffset || 0; } catch (_) { return null; }
  if (y <= 0) return null;
  const park = { y, landed: y };
  raf2(() => { try { park.landed = window.scrollY || window.pageYOffset || 0; } catch (_) { /* keep the initial guess */ } });
  return park;
}
export function unparkScroll(park) {
  if (!park || typeof window === 'undefined') return;
  raf2(() => {
    try {
      const now = window.scrollY || window.pageYOffset || 0;
      if (Math.abs(now - park.landed) > 2) return;      // they moved on — leave them alone
      scrollSettling(park.y);                           // the page is still growing back
    } catch (_) { /* courtesy only */ }
  });
}

/* (4) A HUB of tabs. Anchoring the tab strip is right only while the page is
   still tall enough to hold a position: swapping to a panel shorter than the
   window leaves the page with nowhere to scroll at all, and no amount of
   anchoring can hold an offset that no longer exists. Measured on the real
   bundle: a 1655px-deep reader landed at 253 because that WAS the new bottom.

   So a hub remembers a place PER TAB and hands it back on return — which is what
   a person expects of tabs anyway, the same way they expect the browser's back
   button to land where they left. `store` is a plain object the caller keeps in
   a ref. The anchor still runs, so a swap between two tall panels never moves
   the strip; the remembered offset is scheduled after it and therefore wins when
   there is one. */
export function keepTabPlace(store, from, to, el, mutate) {
  if (from === to) return mutate();
  if (store && from != null) store[from] = rememberScroll();
  const out = keepAnchored(el, mutate);
  const y = (store && to != null) ? store[to] : 0;
  if (y > 0) restoreRemembered(y);
  return out;
}
