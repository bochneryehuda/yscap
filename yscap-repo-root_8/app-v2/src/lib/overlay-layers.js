/* THE REACT BINDING over `overlay-layers-store.js` — three hooks and nothing
   else. The rule itself (which layers are open, and the counting that makes two
   previews safe) lives in the store, which is pure and therefore testable; this
   file only connects it to React, the same split as gate.js / gate-disposition.js.

   Read the store's header for WHY this exists — in one line: a document preview
   used to paint a black sheet over the file-overview tab, so the overview could
   neither be seen nor clicked while a PDF was open. */
import { useEffect, useSyncExternalStore } from 'react';
import { subscribe, getSnapshot, getServerSnapshot, acquire } from './overlay-layers-store.js';

/** Read-only: `{ preview, overview, tool }` — is a layer of each kind open anywhere? */
export function useOverlayLayers() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/* Hold a layer open for exactly as long as `open` is true, and ALWAYS give it
   back — the cleanup runs on unmount too, which is how a preview closed by
   navigating away releases its count. */
function useLayer(kind, open) {
  useEffect(() => {
    if (!open) return undefined;
    return acquire(kind);
  }, [kind, open]);
}

/** Registers an open document preview. Returns the live layer state. */
export function useDocPreviewLayer(open = true) {
  useLayer('preview', open);
  return useOverlayLayers();
}

/** Registers an open FULL-SCREEN TOOL SHEET (Scope of Work, track record, the
    Products & Pricing studio, the generated terms). Returns the live layer state. */
export function useToolSheetLayer(open = true) {
  useLayer('tool', open);
  return useOverlayLayers();
}

/** Registers an open file-overview panel. Returns the live layer state. */
export function useFileOverviewLayer(open) {
  useLayer('overview', !!open);
  return useOverlayLayers();
}
