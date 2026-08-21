/* A FILE DROPPED IN THE WRONG PLACE MUST NOT DESTROY THE PAGE.

   Owner-reported 2026-08-21 (item 6): dropping a document anywhere other than a
   real upload zone "will close your file, explode it".

   THAT IS THE BROWSER'S DEFAULT, not a bug in any one screen. If nothing calls
   preventDefault on a `drop`, the browser NAVIGATES THE TAB TO THE FILE — it
   replaces the whole app with a PDF viewer. Everything unsaved goes with it: a
   half-typed note, an open tool sheet, a condition mid-review. There is no
   confirmation and no way back except the Back button, and the file was not
   uploaded either, so the drop achieved nothing at all.

   Nothing in app-v2 guarded against it: a real upload zone calls preventDefault
   for its own reasons, so the app was safe on the few square inches that happen
   to be a drop target and hostile everywhere else — including the whole margin
   around a card, which is exactly where a hurried drop lands.

   WHY A GLOBAL LISTENER AND NOT A WRAPPER ELEMENT. The dangerous surface is the
   entire document, including the padding outside React's root; a wrapper can only
   cover what it renders. And it must survive every screen, so it is registered
   once at start-up rather than by a component that a route change could unmount.

   IT NEVER STEALS A REAL DROP. Both listeners are on `window` in the BUBBLE phase,
   so any zone that handled the drop has already run and called
   `stopPropagation()` (the shared hook does) or `preventDefault()`. This only ever
   sees the drops nobody wanted, and its whole job is to say so instead of letting
   the tab navigate away.

   It says so out loud, because a drop that silently does nothing teaches people
   the app is broken — and the message names the zones that DO work. */

/* A drag carrying FILES, as opposed to text or a link being dragged inside the
   page. `types` is the only thing readable during a dragover (the items
   themselves are protected until the drop), so this is the test the spec offers. */
function carriesFiles(e) {
  // The WHOLE read is inside the try, `dataTransfer` included: it is a getter, and a
  // getter can throw. Reading it outside let that exception escape the listener — and
  // an exception in the drop handler means preventDefault never runs, so the page
  // navigates after all. Found by the test, not by reading it.
  try {
    const dt = e && e.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.prototype.indexOf.call(dt.types, 'Files') >= 0;
  } catch (_) { return false; }
}

let installed = false;
let notify = null;

/** Install once. Safe to call again — later calls are no-ops. */
export function installStrayDropGuard(onStray) {
  if (typeof window === 'undefined') return () => {};
  notify = typeof onStray === 'function' ? onStray : null;
  if (installed) return () => {};
  installed = true;

  // dragover MUST be prevented as well as drop: a browser only fires `drop` on a
  // target whose dragover was prevented. Without this the drop event never
  // reaches us at all and the tab navigates regardless.
  const over = (e) => { if (carriesFiles(e)) e.preventDefault(); };

  const drop = (e) => {
    if (!carriesFiles(e)) return;
    // Somebody's zone already took it — stay out of the way entirely.
    if (e.defaultPrevented) return;
    e.preventDefault();
    if (notify) { try { notify(e); } catch (_) { /* telling them is best-effort */ } }
  };

  window.addEventListener('dragover', over, false);
  window.addEventListener('drop', drop, false);
  return () => {
    window.removeEventListener('dragover', over, false);
    window.removeEventListener('drop', drop, false);
    installed = false; notify = null;
  };
}

export const _internals = { carriesFiles };
