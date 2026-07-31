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

/* A SOCIAL NEVER LEAVES THE BROWSER (pre-merge audit, 2026-07-30). The Loan
 * Application's `b1Ssn`..`b4Ssn` are plain id'd inputs, so the shared collector picks
 * them up. The SERVER is the real guarantee — src/lib/suite-scenarios.js scrubs every
 * save and every update through redact.js's own pattern, so a hand-rolled request
 * cannot get one in — but there is no reason for the number to travel at all, so it
 * is dropped here too. Keep this pattern in step with redact.js `SSN_KEY`;
 * scripts/test-suite-scenarios-db.js asserts the two agree on the real field names. */
const SSN_KEY = /(^|_)ssn$|social.?security|(^|b\d)ssn/i;

/* AND IT MUST SAY SO (re-audit 2026-07-30). The first cut reported the strip from
 * the SERVER's `omittedSensitive`, but the client strips first — so by the time the
 * request arrives there is no social left to report, the server always answered
 * false, and the message the staffer was promised ("you'll re-enter those") could
 * only ever appear for a hand-rolled request that has no screen to show it on.
 * Proven in a real browser: a Loan Application with two socials saved with the
 * plain "Saved." note. The side that actually drops the number is the side that
 * has to report it, so the reader hands back a count and the bar ORs the two. */
function stripSocials(v, dropped) {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => stripSocials(x, dropped));
  const out = {};
  for (const k of Object.keys(v)) {
    if (SSN_KEY.test(k)) { dropped.push(k); continue; }
    out[k] = stripSocials(v[k], dropped);
  }
  return out;
}

function ownReader(mod) {
  if (!mod) return null;
  for (const fn of OWN_READERS) if (typeof mod[fn] === 'function') return fn;
  return null;
}

/* ONCE AN OWN-STATE TOOL IS RECOGNISED, THE SHARED COLLECTOR IS NOT A FALLBACK
   (pre-merge audit, 2026-07-30). The first cut caught a throwing reader and fell
   through to `collectState`, which cannot see line items or project rows — so the
   save quietly became a 'suite' blob with the work missing and the screen still said
   "Saved". That is the precise silent-data-loss this module's kind field exists to
   prevent, so a detected-but-unreadable tool now REFUSES: the staffer is told to try
   again, which loses nothing, instead of being handed a hollow scenario. The shared
   collector is still the right answer for the other nine tools, which never publish
   one of these globals at all. */
function ownAccessor(win) {
  for (const key of OWN_GLOBALS) {
    const mod = win[key];
    const fn = ownReader(mod);
    // Only treat it as an own-state tool when it can also be RESTORED — a reader
    // with no setState would save a blob nothing could ever put back.
    if (fn && typeof mod.setState === 'function') return { mod, fn };
  }
  return null;
}

/** Read a tool's state out of its frame.
 *  Returns `{state, kind, omittedSensitive}` or null. `omittedSensitive` is true
 *  when a Social Security number was dropped on the way out of the browser, so the
 *  bar can tell the staffer why the box will be empty when they reopen it. */
export function readToolState(win) {
  if (!win) return null;
  let own = null;
  try { own = ownAccessor(win); } catch (_) { own = null; }
  if (own) {
    try {
      const state = own.mod[own.fn]();
      if (state && typeof state === 'object') {
        const dropped = [];
        return { state: stripSocials(state, dropped), kind: 'own', omittedSensitive: dropped.length > 0 };
      }
    } catch (_) { /* refuse below — never degrade to the flat collector */ }
    return null;
  }
  try {
    if (win.YS && typeof win.YS.collectState === 'function') {
      const state = win.YS.collectState({ includeNoShare: true });
      if (state && typeof state === 'object') {
        const dropped = [];
        return { state: stripSocials(state, dropped), kind: 'suite', omittedSensitive: dropped.length > 0 };
      }
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
  try { return !!(win && ownAccessor(win)); } catch (_) { return false; }
}
