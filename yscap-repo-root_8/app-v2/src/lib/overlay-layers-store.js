/* WHICH FULL-SCREEN LAYERS ARE OPEN RIGHT NOW — the one place that knows, so two
   of them can be on screen TOGETHER instead of one blacking the other out.

   THE BUG THIS EXISTS FOR (owner-reported 2026-08-20): "when you're previewing a
   document, a PDF, or anything else … the entire screen in the back gets black.
   You can't click on the overview to preview the PDF, and the overview is also
   not available. We need to have the overview available while we're previewing …
   so you can compare maybe the PDF to the file overview to see the details."

   The document preview painted a full-viewport dim at z 200 over EVERYTHING,
   including the file-overview tab (z 120) and its panel (z 135). The tab was
   still there — it just had an opaque sheet of black in front of it, so it could
   not be seen and could not be clicked.

   WHY A STORE AND NOT A PROP. <DocPreview> is opened from sixteen different
   places and <FileOverviewSlideOver> is mounted once per file screen; they are
   never siblings and never share an owner, so there is no prop to thread and no
   provider that reliably wraps both. A module-level store read through
   `useSyncExternalStore` needs no provider at all, which means no screen can
   forget to wire it and quietly lose the behaviour.

   NOT A BODY CLASS. The same coordination could be done by stamping <body>, and
   that is exactly the shape this codebase treats as cheap: state living in the
   DOM where React cannot see it, no cleanup guarantee on unmount, and a second
   writer able to clobber it silently. The components read this and set their own
   class names, so the state has one owner and React owns the paint.

   PURE — no React, no DOM, no imports. The React binding is the thin
   `overlay-layers.js` beside it (the gate.js / gate-disposition.js split), which
   is what lets the whole rule below be EXECUTED by a test rather than grepped. */

/* Layer kinds. A COUNT, not a flag: two previews open at once (a compare view)
   must still resolve correctly when the first of them closes.

   `tool` is a FULL-SCREEN TOOL SHEET — the Scope of Work, the track record, the
   Products & Pricing studio, the generated terms (owner-reported 2026-08-21: "the
   nice overview button on the right side … is not available in the full screens
   that are populated, including the terms you generated / products and pricing /
   track record full screen / scope of work for full screen. This should always be
   available"). It is the SAME defect as the preview one above, one layer along:
   those sheets render on `.cv-modal-back`, which sits at z 200 with the app's
   confirm dialogs, so they painted over the tab at 120. */
const counts = { preview: 0, overview: 0, tool: 0 };
const subscribers = new Set();

/* The snapshot object is REPLACED only when a boolean actually flips.
   `useSyncExternalStore` compares snapshots by identity and will loop forever if
   `getSnapshot` mints a new object on every call — so this reference has to be
   stable across reads that changed nothing. */
export const EMPTY = Object.freeze({ preview: false, overview: false, tool: false });
let snapshot = EMPTY;

function publish() {
  const next = { preview: counts.preview > 0, overview: counts.overview > 0, tool: counts.tool > 0 };
  if (next.preview === snapshot.preview && next.overview === snapshot.overview
      && next.tool === snapshot.tool) return;
  snapshot = Object.freeze(next);
  // Copy first: a subscriber is free to unsubscribe while we are notifying, and
  // a listener that throws must never stop the rest from hearing about it.
  for (const fn of Array.from(subscribers)) { try { fn(); } catch (_) { /* a bad listener is not this module's problem */ } }
}

export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

export const getSnapshot = () => snapshot;
/* SSR: the counts start at zero and this returns the SAME frozen object, so a
   server render can never disagree with the first client render. */
export const getServerSnapshot = () => EMPTY;

/** Open a layer. Returns the matching `release`, which is safe to call twice. */
export function acquire(kind) {
  if (!Object.prototype.hasOwnProperty.call(counts, kind)) return () => {};
  counts[kind] += 1;
  publish();
  let released = false;
  return () => {
    if (released) return;          // a double-release must never free somebody else's hold
    released = true;
    // Clamped at zero as well: React 18 StrictMode mounts effects twice in
    // development, and a negative count would strand the app in "a preview is
    // open" forever.
    counts[kind] = Math.max(0, counts[kind] - 1);
    publish();
  };
}

/* Test seam ONLY — never called by the app. */
export const _internals = { counts, publish, subscribers };
