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
 * THE rrweb REPLAY ARTEFACT, which is why this is a bug fix and not a tidy-up
 * =============================================================================
 *
 * The guest reads the element off their REAL page. The viewer reads it off
 * rrweb's REPLAYED copy — and the replayer simulates hover by adding a class
 * literally named `:hover` to elements under the pointer. So the viewer computed
 * `BODY||:hover` where the guest computed `BODY||`, the guest refused the input,
 * and the controller's clicks and keystrokes silently did nothing.
 *
 * That is the owner's own report a second time over ("when I ask for control,
 * even if they approve it, I'm not getting it") — the first cause was the
 * take-back drift threshold, and this is the other one: control IS granted, and
 * then nothing you do lands. It was recorded in CLAUDE.md for weeks as a FLAKY
 * TEST with a guessed cause ("the mirror rebuilds mid-click"), and the guess is
 * what stopped anybody looking: the two-browser drive fails on it about five runs
 * in six, and every one of those was the product telling the truth.
 *
 * A class beginning with `:` cannot be written in an HTML `class` attribute by
 * any ordinary means, so dropping them costs nothing real and removes the whole
 * family of replay decorations rather than the one name we happened to hit.
 */

/** The classes a page actually declared — never a replayer's decoration. */
function realClasses(el) {
  const raw = el && el.className;
  // SVG elements have an SVGAnimatedString here, not a string.
  const s = typeof raw === 'string' ? raw : (raw && typeof raw.baseVal === 'string' ? raw.baseVal : '');
  return s.split(/\s+/).filter((c) => c && c[0] !== ':');
}

/**
 * The element's fingerprint: tag, input type, first real class. Never throws —
 * an unreadable element answers '' and the caller refuses the input, which is
 * the safe direction.
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
