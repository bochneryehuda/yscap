/* ──────────────────────────────────────────────────────────────────────────
   LONG-TERM — THE BOARD STAYS WHERE IT IS WHEN YOU OPEN SOMETHING.

   Owner-reported 2026-09-04: *"When you click on details or you click on
   anything else, the screen is bouncing back upwards and downwards. It needs to
   stay where it is. A lot of the time, it's bouncing back. It's not stable.
   Something is wrong."*

   ⛔ WHAT ACTUALLY MOVES THE PAGE, and why fixing the cause one at a time does
   not work. Opening a rate row, a lender inside it, or a Details panel changes
   the height of things ABOVE whatever the officer is reading — the row's own
   body, a sibling that closes at the same time, the confirmation note the
   comparison button raises, the pinned strip re-measuring. Every one of those is
   a legitimate layout change; the screen jumps because the browser keeps the
   SCROLL OFFSET fixed while the content under it grows or shrinks, so the thing
   the person was looking at slides out from under their eyes.

   ⛔ SO THE FIX IS AN ANCHOR, NOT A HUNT. Whatever changed, the element they
   PRESSED should still be where they left it: measure its position in the
   viewport before the state change, measure again after the browser has laid
   the page out, and scroll by the difference. That holds for every cause,
   including one added next year — which is the whole point of doing it here
   rather than chasing each height change.

   ⛔ IT IS THE CLICKED ELEMENT, NOT THE ROW. A button stays in the DOM across the
   toggle it fires; a row can be replaced, re-keyed or unmounted by the very
   change being anchored, and measuring a detached node answers zeroes — which
   would scroll the page to a position nobody asked for. `e.currentTarget` is
   always the control that was pressed.

   ⛔ AND IT NEVER SCROLLS FOR NOTHING. A drift under a pixel is rounding, not
   movement; a control that has left the document has no position to restore; a
   browserless render (a test, a server render) does nothing at all. `behavior:
   'auto'` on purpose — a smooth correction is itself a visible slide, which is
   the thing being removed.

   PURE ESM, no React: it is called imperatively from a click handler, and a
   plain module can be imported by a `.mjs` suite that runs on every push.
   ────────────────────────────────────────────────────────────────────────── */

/** Under this, the page did not move — it rounded. */
export const DRIFT_EPSILON_PX = 1;

/** Is this a node we can still measure and would gain anything from measuring? */
function measurable(el) {
  return !!(el && typeof el.getBoundingClientRect === 'function'
    && (typeof el.isConnected !== 'boolean' || el.isConnected));
}

/**
 * Hold `el` still across whatever is about to change the page's height.
 *
 * Returns the restore function. Call it AFTER the browser has laid the new
 * content out — `requestAnimationFrame` is the honest moment, because a React
 * state change has not touched the DOM yet when the handler returns.
 *
 * Returns a no-op (never null) so a caller can always call it without a guard.
 */
export function holdInPlace(el, win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || typeof w.scrollBy !== 'function' || !measurable(el)) return () => {};
  const before = el.getBoundingClientRect().top;
  if (!Number.isFinite(before)) return () => {};
  return () => {
    if (!measurable(el)) return;
    const after = el.getBoundingClientRect().top;
    if (!Number.isFinite(after)) return;
    const drift = after - before;
    if (Math.abs(drift) < DRIFT_EPSILON_PX) return;
    try { w.scrollBy({ top: drift, left: 0, behavior: 'auto' }); } catch { /* older browser */ }
  };
}

/**
 * The whole thing in one call, for a click handler: hold the pressed control
 * still, run the state change, and put it back where it was on the next frame.
 *
 * `run` is called SYNCHRONOUSLY and its exceptions are never swallowed — a
 * broken toggle must not be silently turned into a scroll adjustment.
 */
export function keepPlaceOnClick(e, run) {
  const el = e && e.currentTarget;
  const restore = holdInPlace(el);
  run();
  const w = typeof window !== 'undefined' ? window : null;
  if (w && typeof w.requestAnimationFrame === 'function') w.requestAnimationFrame(restore);
  else restore();
}

/* ──────────────────────────────────────────────────────────────────────────
   AND WHEN A SEARCH LANDS, THE ANSWER STARTS AT THE TOP.

   Owner-reported 2026-09-04: *"You search this scenario, and the search
   finishes. You right away get to the bottom, to the highest rate, the 11.5
   rate. You need to stay at the top, looks like a bug."*

   ⛔ WHAT ACTUALLY MOVED, because nothing on this screen scrolls the page on a
   search. The Search button sits at the BOTTOM of a long form, so the press
   happens with the page scrolled well down. A successful search then COLLAPSES
   that form (`setFormOpen(false)` — the strip takes over) and opens the cheapest
   rate row. The document loses most of its height ABOVE the board while the
   browser holds the scroll OFFSET where it was, so the same offset now points
   deep into a much shorter page: the officer lands near the end of the board,
   which is the highest rate on it. Exactly the 11.5 in the report.

   ⛔ SO IT IS NOT AN ANCHOR PROBLEM, AND `holdInPlace` IS THE WRONG TOOL. That
   one keeps the thing you PRESSED where it was, which is right for opening a row
   and wrong here: the control pressed was a Search button that is about to be
   folded away, and holding the page still is precisely what lands you at the
   bottom. A new board is a new page — it starts at its top.

   ⛔ INSTANT, NOT SMOOTH. Everything on screen has just been replaced; a
   half-second glide through a board nobody has read yet is a wait, not an
   explanation. (The two `behavior: 'smooth'` calls on this screen are BUTTONS a
   person pressed to go somewhere — there the slide says "you are being moved".)

   ⛔ AND IT NEVER THROWS. Older browsers take only the two-argument form, and a
   test render has no window at all. Returns whether it actually scrolled, so a
   caller — and a test — can tell "did nothing" from "did it".
   ────────────────────────────────────────────────────────────────────────── */
export function backToTop(win) {
  const w = win || (typeof window !== 'undefined' ? window : null);
  if (!w || typeof w.scrollTo !== 'function') return false;
  try {
    w.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    return true;
  } catch {
    try { w.scrollTo(0, 0); return true; } catch { return false; }
  }
}
