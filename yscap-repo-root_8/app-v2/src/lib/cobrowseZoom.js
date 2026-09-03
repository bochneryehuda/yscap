// The co-browse mirror's SIZE arithmetic — ONE definition, PURE (no imports, no DOM),
// so every rule here is unit-testable and the screen cannot hold a second opinion.
//
// WHY THIS IS ITS OWN MODULE. The readability defect (owner-reported 2026-09-02,
// "extremely unclear") was that the stage scaled the guest's whole screen into its width
// and was CAPPED there: a 1280-wide guest rendered at 0.736 and a 1920-wide guest at
// 0.4906 — half-size body text with no way to lean in. The first fix lived inline in
// the screen, and the pre-merge audit proved by mutation that a SOURCE guard cannot hold
// it: restoring the cap (`const s = f`) or killing the ladder left every regex matching
// and the suite green. Arithmetic that can be reverted invisibly belongs in a function
// somebody can call with real numbers and assert the answer.

// The zoom ladder. It starts at ACTUAL SIZE because that is the useful jump from Fit —
// "show it the size they see it" — and anything BELOW the fit scale is pointless (the
// whole screen is already in view), which is why there are no stops under 1: the floor
// is `fit` itself, not a number.
const ZOOM_STOPS = [1, 1.5, 2, 2.5, 3];
const MAX_ZOOM = 3;

// The scale that shows the guest's whole screen inside the stage. Never above 1 — a
// guest narrower than the stage is shown at actual size, never stretched.
// `hostWidth` is read AFTER any scrollbar, so a zoomed stage does not fight itself.
function fitScaleFor(hostWidth, guestWidth) {
  const hw = Number(hostWidth); const gw = Number(guestWidth);
  if (!(hw > 0) || !(gw > 0)) return 1;
  return Math.min(1, (hw - 8) / gw);
}

// What the stage is actually drawn at. `'fit'` tracks the window; a number is a size the
// person chose and is NEVER capped at the fit scale — leaning in on one figure is the
// whole reason somebody watches a screen. An unusable stored value falls back to fit
// rather than to a nonsense scale.
function appliedScale(zoom, fitScale) {
  const f = Number(fitScale) > 0 ? Number(fitScale) : 1;
  if (zoom === 'fit') return f;
  const n = Number(zoom);
  if (!Number.isFinite(n) || n <= 0) return f;
  return Math.min(MAX_ZOOM, n);
}

// Past the fit scale the picture is bigger than the stage, so the stage SCROLLS rather
// than clipping. At or below it there is nothing to scroll to, and a scrollbar there
// would only steal width and make the next fit smaller.
function stageOverflow(scale, fitScale) {
  return appliedScale(scale, fitScale) > (Number(fitScale) > 0 ? Number(fitScale) : 1) ? 'auto' : 'hidden';
}

// The stage's own height is the FIT height, never the zoomed picture's — otherwise the
// whole page grows a second scrollbar to hold one screen.
function stageHeight(guestHeight, scale, fitScale) {
  const h = Number(guestHeight) > 0 ? Number(guestHeight) : 800;
  const f = Number(fitScale) > 0 ? Number(fitScale) : 1;
  const s = Number(scale) > 0 ? Number(scale) : f;
  return Math.ceil(h * Math.min(s, f)) + 8;
}

// One step up or down the ladder.
//
// TWO RULES THAT ARE THE FIX, not decoration. (a) Stepping DOWN off the bottom returns
// `'fit'`, never the fit NUMBER: the audit found that `−` from Fit resolved to
// `Math.max(fitScale, …)` = the fit scale as a number, which looks like nothing happened
// and silently PINS the mirror — so the next time the window narrows the picture is
// clipped behind scrollbars by a press that appeared to do nothing. (b) The stops are
// absolute, so 100% is always exactly reachable; stepping by ±0.25 from an arbitrary fit
// scale (0.736) never lands on 1, which left the 100% button unable to light up.
function nextZoom(zoom, fitScale, dir) {
  const f = Number(fitScale) > 0 ? Number(fitScale) : 1;
  const cur = appliedScale(zoom, f);
  const up = ZOOM_STOPS.filter((s) => s > f + 1e-9);
  if (dir > 0) {
    const n = up.find((s) => s > cur + 1e-9);
    return n === undefined ? (up.length ? up[up.length - 1] : 'fit') : n;
  }
  const below = up.filter((s) => s < cur - 1e-9);
  return below.length ? below[below.length - 1] : 'fit';
}

// Is this step available? A disabled control says "this is the floor/ceiling" instead of
// letting somebody press a button that does nothing.
function canZoom(zoom, fitScale, dir) {
  const next = nextZoom(zoom, fitScale, dir);
  if (next === 'fit') return zoom !== 'fit';
  return Math.abs(appliedScale(next, fitScale) - appliedScale(zoom, fitScale)) > 1e-9;
}

export { ZOOM_STOPS, MAX_ZOOM, fitScaleFor, appliedScale, stageOverflow, stageHeight, nextZoom, canZoom };
