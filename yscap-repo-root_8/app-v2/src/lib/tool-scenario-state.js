/* READING AND RESTORING A TOOL'S WORKING STATE (owner-directed 2026-07-30).
 *
 * The Investor Suite tools are the same frozen static pages served at
 * /tools/*.html, hosted same-origin in an iframe. StaticToolFrame hands the host
 * the frame's `window` via onReady, so the portal can ask the tool for its state
 * and give it back later — without any change to the tools' own engines.
 *
 * ONE MECHANISM, ONE DOCUMENTED EXCEPTION.
 *   'suite' — YS.collectState()/YS.applyState() in web/v2/suite.js, which EVERY
 *             tool page loads. It walks every id'd input/select/textarea, the
 *             checkboxes, the radios by name, and repeatable rows through
 *             window.YS_getRows/YS_setRows.
 *   'own'   — two tools hold structured data a flat field-walk cannot see, and
 *             both already expose their own accessor: Rehab Budget
 *             (window.RB.getState/setState — line items, contingency, GC fee) and
 *             Track Record (window.TR). Saving those through the generic collector
 *             would drop the line items and the staffer would reopen a scenario
 *             missing the work.
 *
 * The KIND travels with the blob. Feeding a suite-shaped state into a tool that
 * wants its own shape (or the reverse) restores a blank tool, which reads as data
 * loss rather than as the mismatch it is — so a reopen refuses instead.
 *
 * ADMIN KNOBS ARE KEPT. `collectState()` skips `data-noshare` fields — the admin
 * pricing knobs — because they must never ride in a share LINK. A saved scenario is
 * the staffer's own scratchpad and is never sent anywhere, and dropping their
 * overrides would reopen showing a DIFFERENT number than when they saved. So the
 * save opts in explicitly (`{ includeNoShare: true }`); share links are untouched.
 */

/* THE TWO TOOLS DO NOT NAME THEIR READER THE SAME WAY, and assuming they did was a
   real bug caught by the test: Rehab Budget exposes `getState()` (itself a wrapper
   for `snap()`), while Track Record exposes `snap()` and `_state()` and no
   `getState` at all. Probing only for `getState` made Track Record fall through to
   the shared collector, which cannot see its project rows — so a saved Track Record
   scenario would have reopened with the borrower's projects gone, silently. Probe
   every reader name either tool actually publishes, most explicit first. The WRITER
   is `setState` on both. */
const OWN_READERS = ['getState', 'snap', '_state'];
const OWN_GLOBALS = ['RB', 'TR'];

function ownReader(mod) {
  if (!mod) return null;
  for (const fn of OWN_READERS) if (typeof mod[fn] === 'function') return fn;
  return null;
}

/** Read a tool's state out of its frame. Returns `{state, kind}` or null. */
export function readToolState(win) {
  if (!win) return null;
  try {
    for (const key of OWN_GLOBALS) {
      const mod = win[key];
      const fn = ownReader(mod);
      // Only treat it as an own-state tool when it can also be RESTORED — a reader
      // with no setState would save a blob nothing could ever put back.
      if (fn && typeof mod.setState === 'function') {
        const state = mod[fn]();
        if (state && typeof state === 'object') return { state, kind: 'own' };
      }
    }
  } catch (_) { /* fall through to the shared collector */ }
  try {
    if (win.YS && typeof win.YS.collectState === 'function') {
      const state = win.YS.collectState({ includeNoShare: true });
      if (state && typeof state === 'object') return { state, kind: 'suite' };
    }
  } catch (_) { /* the tool has not booted yet */ }
  return null;
}

/** Put a saved state back. Returns true when the tool accepted it. */
export function writeToolState(win, state, kind) {
  if (!win || !state || typeof state !== 'object') return false;
  try {
    if (kind === 'own') {
      for (const key of OWN_GLOBALS) {
        const mod = win[key];
        if (mod && typeof mod.setState === 'function') { mod.setState(state); return true; }
      }
      return false;                       // saved from a tool that no longer offers it
    }
    if (win.YS && typeof win.YS.applyState === 'function') { win.YS.applyState(state); return true; }
  } catch (_) { /* fall through */ }
  return false;
}

/** Does this tool carry its own accessor? Used only for a friendlier message. */
export function toolHasOwnState(win) {
  try {
    return OWN_GLOBALS.some((k) => win && win[k] && ownReader(win[k]) && typeof win[k].setState === 'function');
  } catch (_) { return false; }
}
