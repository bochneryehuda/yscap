/* CO-BROWSING — the MASK, as one pure definition (no imports, no DOM access at
   module load), so the browser recorder and the Playwright redaction harness
   (scripts/render-cobrowse-redaction.js) read the SAME rules. A second copy is
   how one screen ends up masked in the app and unmasked in the proof. */

/** Elements never mirrored at all — replaced by a same-size grey box. */
export const BLOCK_SELECTOR = '[data-cobrowse-block], input[type="password"], input[autocomplete="one-time-code"], .cobrowse-block';
/** Routes on which nothing is recorded at all — the screen IS the secret. */
export const NO_RECORD_ROUTES = /^\/(login|internal\/login|tpo\/login|verify|forgot|internal\/forgot|reset|accept|accept-terms|assistant\/(login|accept)|tpo\/accept|esign\/done)(\/|$)/;
/** Fixed-length mask: the viewer must not learn how long a hidden value was. */
export const MASK = '••••••';

/** Elements the CONTROLLER may never drive (Phase B) — beyond the blocked ones. */
export const NO_DRIVE_SELECTOR = [
  BLOCK_SELECTOR,
  'input[type="file"]',
  '[data-cobrowse-nodrive]',
  'a[download]', 'a[target="_blank"]',
  'iframe', '.esign-frame', '[data-esign]',
  'button[data-signout]', 'a[href="#/logout"]',
].join(', ');
/** Routes where control has no effect: the driver ignores every input there. */
export const NO_DRIVE_ROUTES = /^\/(esign|internal\/borrower-view|internal\/tpo-view|assistant)(\/|$)/;

/** The rrweb record() options — one place. `emit` is supplied by the caller. */
export function recordOptions(emit) {
  return {
    emit,
    maskAllInputs: true,
    maskTextSelector: BLOCK_SELECTOR,
    blockSelector: BLOCK_SELECTOR,
    maskTextFn: () => MASK,
    maskInputFn: () => MASK,
    maskInputOptions: { password: true },
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    sampling: { input: 'last', mousemove: 50, scroll: 100, media: 800 },
    slimDOMOptions: { script: true, comment: true },
  };
}
