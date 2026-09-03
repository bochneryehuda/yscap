/**
 * ONE READING OF AN ELEMENT, SHARED BY BOTH SIDES OF A DRIVEN SESSION.
 *
 * =============================================================================
 * WHY IT IS ONE FILE
 * =============================================================================
 *
 * The viewer sends `fp` with every addressed input and the guest refuses a
 * mismatch — that is what stops a relayed click landing on a DIFFERENT element
 * after rrweb has re-minted its node ids. The check is only as good as the two
 * sides agreeing on what the string is, and for a while they did not: the same
 * six lines were written out twice, once in `lib/cobrowse.js` and once in
 * `screens/StaffCobrowse.jsx`, which is precisely the shape that drifts.
 *
 * =============================================================================
 * WHAT THE `:`-CLASS RULE IS AND IS NOT FOR
 * =============================================================================
 *
 * The guest reads the element off their REAL page. The viewer reads it off
 * rrweb's REPLAYED copy, and the replayer marks hovered elements with a class
 * literally named `:hover`. For an element with NO class of its own that changed
 * the reading — `BODY||:hover` against `BODY||` — so the guest refused the input.
 *
 * ⛔ IT IS NOT WHY DRIVING WAS BROKEN, and an earlier version of this header said
 * it was. `classList.add` APPENDS, and the old code took the FIRST class token, so
 * any element that has a class of its own read identically on both sides — which
 * includes every element a controller actually aims at. The evidence that was
 * quoted for it (`want=BODY||:hover`) was a keystroke sent AFTER a click had
 * already failed, with focus still on `<body>`: a symptom of the real defect, not
 * its cause. The real one was the guest's banner overhanging its reserved space in
 * the mirror and covering the page — see `screens/StaffCobrowse.jsx`'s
 * `insertStyleRules` note and the co-browse block in CLAUDE.md.
 *
 * So this file is a HARDENING with two real jobs, and it should be read as that:
 * one definition where there were two copies reading from two different DOMs, and
 * a class-less element no longer mis-refused.
 *
 * A class starting with `:` is not impossible in HTML — `<div class=":hover">`
 * parses, and `classList.add(':x')` is legal — so dropping them is in principle a
 * FALSE-ACCEPT channel: an element whose ONLY class is `:x` fingerprints like a
 * class-less one. This app declares no such class (grepped across `app-v2/src` and
 * `web/`), so the exposure is theoretical today; it is written down rather than
 * asserted away. It also does not remove every replay decoration — the replayer
 * adds `rrweb-paused` to the replayed `<html>` — only the ones that reach an
 * element's own class list.
 *
 */

/** The classes a page actually declared — never a replayer's decoration. */
function realClasses(el) {
  const raw = el && el.className;
  // SVG elements have an SVGAnimatedString here, not a string.
  const s = typeof raw === 'string' ? raw : (raw && typeof raw.baseVal === 'string' ? raw.baseVal : '');
  return s.split(/\s+/).filter((c) => c && c[0] !== ':');
}

/**
 * The element's fingerprint: tag, input type, first real class. Never throws.
 *
 * ⛔ AN EMPTY ANSWER DISABLES THE CHECK, IT DOES NOT FAIL IT. `drivable()` reads
 * `if (typeof fp === 'string' && fp && fp !== fingerprint(el)) return null` — an
 * empty `fp` is falsy, so the comparison is skipped and the input is ACCEPTED. An
 * earlier version of this comment claimed the opposite ("the caller refuses the
 * input, which is the safe direction"); it is the permissive direction, and the
 * mirror-id resolution plus the no-drive allowlist are what still stand behind it.
 */
function fingerprintOf(node) {
  try {
    const el = node && node.nodeType === 1 ? node : (node && node.parentElement) || null;
    if (!el) return '';
    const cls = realClasses(el)[0] || '';
    return `${el.tagName || ''}|${el.getAttribute ? (el.getAttribute('type') || '') : ''}|${cls}`.slice(0, 120);
  } catch { return ''; }
}

export { fingerprintOf, realClasses };
