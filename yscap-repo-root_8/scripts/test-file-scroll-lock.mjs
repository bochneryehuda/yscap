/* Every LAYOUT change on the loan file gives the reader their place back.
 *
 * Owner-reported 2026-08-02: "On any section that we click to open up, we get
 * bounced back up on top like a failure issue. We need to stay. Any button that
 * we click, we should stay in that section."
 *
 * Measured in a real browser before the fix (rooms view, one file, 1280x800):
 * collapsing the File-overview section took the reader from scrollY 2350 to 0,
 * and re-opening it left them at 0; entering full screen took 1674 to 0 and
 * leaving it never came back; a Conditions tab moved them 1895px; a condition
 * group header 1067px.
 *
 * ONE ROOT MECHANISM: a loan-file interaction shrinks the document, the browser
 * clamps scrollTop to the new maximum, and nothing puts the reader back. It only
 * became a jump to the TOP when the file went to one room at a time — the clamp
 * was always there, but a 27-screen page absorbed it and landed the reader
 * mid-page, where the browser's own scroll anchoring carried them back. A room
 * holding one section is barely a screen tall, so the clamp lands at 0, where
 * scroll anchoring has nothing to work with.
 *
 * `app-v2/src/lib/keep-scroll.js` has owned "hold the reader's place" since
 * 2026-07-27 — it was simply only ever wired into the data refresh (`load()`),
 * and into ZERO layout changes. This guard pins the class, not the instances:
 * source-scanning and pure, in the style of test-file-scroll-stability.mjs.
 *
 * The enclosing effect is found by BALANCED PARENS, never by a byte window: a
 * proximity window is a proxy for the real invariant, it goes stale the moment
 * anyone adds a line, and rewriting one of those is exactly what the scroll
 * stability test needed in the first place.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const lineOf = (src, i) => src.slice(0, i).split('\n').length;

let failures = 0;
const ok = (cond, what) => { if (cond) console.log(`  ok  ${what}`); else { failures++; console.error(`  FAIL ${what}`); } };

/* Walk every app-v2 source file rather than a hand-typed list. A hand-typed list
   can only name the overlays somebody remembered on the day — which is how three
   of these were fixed and a fourth was missed for five days. */
const SRC = join(ROOT, 'app-v2/src');
const FILES = readdirSync(SRC, { recursive: true })
  .map(String).filter((f) => /\.jsx?$/.test(f))
  .map((f) => join('app-v2/src', f))
  .sort();

/* Blank out comments so PROSE ABOUT a scroll-lock is never mistaken for one —
   keep-scroll.js's own header describes the exact line it exists to fix, and a
   naive scan flagged the cure as the disease. Length is preserved (comment
   characters become spaces, newlines stay), so indices and line numbers still
   line up with the real file. */
function stripComments(src) {
  let out = '', i = 0;
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  while (i < src.length) {
    const b = src.indexOf('/*', i);
    const l = src.indexOf('//', i);
    const next = (b < 0) ? l : (l < 0 ? b : Math.min(b, l));
    if (next < 0) { out += src.slice(i); break; }
    out += src.slice(i, next);
    if (next === b) {
      const end = src.indexOf('*/', next + 2);
      const stop = end < 0 ? src.length : end + 2;
      out += blank(src.slice(next, stop)); i = stop;
    } else {
      const end = src.indexOf('\n', next);
      const stop = end < 0 ? src.length : end;
      out += blank(src.slice(next, stop)); i = stop;
    }
  }
  return out;
}

/* The balanced source of the call that ENCLOSES index `i` — e.g. the whole
   useEffect(...) a body-scroll-lock sits inside, cleanup included. */
function enclosingCall(src, i, name) {
  const open = src.lastIndexOf(`${name}(`, i);
  if (open < 0) return '';
  let depth = 0;
  for (let p = open + name.length; p < src.length; p++) {
    const c = src[p];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return p > i ? src.slice(open, p + 1) : ''; }
  }
  return '';
}

/* A ROUTE-level screen is deliberately exempt: it is not an overlay over a page
   the reader will come back to — leaving it navigates somewhere else, and
   restoring the offset from before it mounted would fight the new route. Listed
   explicitly with the reason so it reads as a decision, not an oversight. */
const ROUTE_LEVEL_EXEMPT = new Map([
  ['app-v2/src/screens/TrackRecordScreen.jsx',
    'a whole route: leaving it navigates away, so there is no page to restore onto'],
]);

console.log('1. every body scroll-lock hands back the position it took away');
let locks = 0;
const LOCK = /document\.body\.style\.overflow\s*=\s*(['"])hidden\1/g;
for (const p of FILES) {
  const src = stripComments(read(p));
  for (const m of src.matchAll(LOCK)) {
    locks++;
    const where = `${p}:${lineOf(src, m.index)}`;
    if (ROUTE_LEVEL_EXEMPT.has(p)) { console.log(`  --  ${where} exempt — ${ROUTE_LEVEL_EXEMPT.get(p)}`); continue; }
    const effect = enclosingCall(src, m.index, 'useEffect');
    // Either the named helper pair, or the hand-rolled capture/restore the three
    // pre-existing overlays wrote before the helper existed (#108). Both are the
    // same contract; neither is preferred here.
    //
    // The RESTORE must be in the unlock (that is the whole contract). The CAPTURE
    // is only required to be somewhere in the component: when the overlay is
    // position:fixed, the page has ALREADY collapsed by the time any effect runs,
    // so the offset has to be read in the click that opens it — see section 2.
    const remembers = /rememberScroll\s*\(/.test(src)
      || /window\.scrollY|window\.pageYOffset/.test(src);
    const restores = /restoreRemembered\s*\(/.test(effect)
      || /window\.scrollTo\s*\(/.test(effect);
    ok(effect && remembers && restores,
      `${where} — the lock remembers an offset and restores it on unlock`);
  }
}
ok(locks >= 5, `found the body scroll-locks to check (${locks})`);

console.log('\n2. the Section full-screen overlay specifically');
{
  const fs = stripComments(read('app-v2/src/components/FileSections.jsx'));
  const i = fs.search(/document\.body\.style\.overflow\s*=\s*'hidden'/);
  const effect = enclosingCall(fs, i, 'useEffect');
  /* THE OFFSET MUST BE READ IN THE CLICK, NOT IN THE EFFECT. `.sec-full` is
     position:fixed, so the section leaves the flow in the very commit that sets
     `full` and the browser clamps scrollY to 0 BEFORE any effect runs — reading
     it inside the effect reads 0 and restores nothing. Measured: 1931 -> 0 -> 0. */
  ok(!/rememberScroll\(\)/.test(effect),
    'the effect does NOT read the offset (by then the page has already collapsed to 0)');
  ok(/if \(!full\) \{ fullY\.current = rememberScroll\(\);/.test(fs),
    'the Full screen BUTTON reads it, before the state change');
  ok(/restoreRemembered\(fullY\.current\)/.test(effect),
    'and the cleanup puts the reader back when full screen exits');
  /* A room hop closes full screen too, and restoring then would drag the reader
     to where they stood in the room they just left. This must be read LIVE: a
     latched flag was set by the room hop EVERY section performs at mount (only
     the active room renders), so it was still set when the reader finally left
     full screen and the restore silently did nothing. */
  ok(/useEffect\(\(\) => \{ hiddenRef\.current = hidden; \}\);/.test(fs),
    'whether the section is off-screen is tracked live, with no dependency array');
  ok(/if \(hiddenRef\.current\) return;/.test(effect),
    'and the cleanup reads that live rather than a latched flag');
  ok(!/skipFullRestore/.test(fs), 'the latched flag is gone (it could never un-latch reliably)');
}

console.log('\n3. collapsing a section gives the place back on re-open');
{
  const fs = read('app-v2/src/components/FileSections.jsx');
  const toggle = fs.slice(fs.indexOf('const toggle = (e) =>'), fs.indexOf('// Full screen implies open'));
  ok(/parked\.current = parkScroll\(\);\s*setOpen\(false\)/.test(toggle),
    'collapsing parks the offset (the page may have nowhere left to scroll)');
  ok(/setOpen\(true\);\s*unparkScroll\(p\)/.test(toggle),
    're-opening unparks it — this is the half the browser can never do itself');
}

console.log('\n4. the loan file\'s hub tabs and group headers hold the control clicked');
{
  const sa = read('app-v2/src/screens/StaffApplication.jsx');
  ok(/keepTabPlace\(condTabY\.current, condTab, t\.k, e\.currentTarget, \(\) => setCondTab\(t\.k\)\)/.test(sa),
    'the Conditions tabs go through keepTabPlace (a place remembered per tab)');
  ok(/keepTabPlace\(commTabY\.current, commTab, t\.k, e\.currentTarget, \(\) => setCommTab\(t\.k\)\)/.test(sa),
    'the Communication tabs do too');
  ok(/const condTabY = useRef\(\{\}\)/.test(sa) && /const commTabY = useRef\(\{\}\)/.test(sa),
    'each hub keeps its own per-tab memory in a ref');
  const tg = sa.slice(sa.indexOf('const toggleGroup ='), sa.indexOf('const borrowerItems ='));
  ok(/parkedGroups\.current\[k\] = parkScroll\(\)/.test(tg) && /unparkScroll\(p\)/.test(tg),
    'a condition group parks on collapse and unparks on re-open');
  ok(/keepAnchored\(closing \? el : null/.test(tg),
    'and holds the group header the reader clicked while it collapses');
  ok(/onClick=\{\(e\) => toggleGroup\(g\.key, e\.currentTarget\)\}/.test(sa),
    'the group header passes itself as the anchor');
}

console.log('\n5. no button scrolls to a tag it does not own');
{
  // `document.querySelector('h4')` is the FIRST h4 on the whole page — above the
  // reader — so a button labelled "open the findings panel" reliably threw them
  // upward. Anything that means "go to a place" belongs on revealAnchor, which
  // opens the owning room and section first.
  const BARE_TAG = /document\.querySelector\((['"])(h[1-6]|section|main|div)\1\)/;
  for (const p of FILES) {
    const src = read(p);
    const m = src.match(BARE_TAG);
    ok(!m, `${p} — no scroll target picked by bare tag name${m ? ` (${m[0]})` : ''}`);
  }
  const up = read('app-v2/src/components/UnderwritingPanel.jsx');
  ok(/onClick=\{\(\) => revealAnchor\('ai-findings'\)\}/.test(up),
    'the fraud banner opens the findings panel through revealAnchor');
  ok(/id="ai-findings"/.test(up), 'and that anchor really exists in the panel');
}

console.log('\n6. the primitives are shared, not re-inlined per screen');
{
  const ks = read('app-v2/src/lib/keep-scroll.js');
  for (const fn of ['rememberScroll', 'restoreRemembered', 'keepAnchored', 'parkScroll', 'unparkScroll', 'keepTabPlace']) {
    ok(new RegExp(`export function ${fn}\\b`).test(ks), `keep-scroll exports ${fn}`);
  }
  // Two frames everywhere: one for React to commit, one for the browser to lay
  // out. Measuring before layout restores against stale geometry.
  ok((ks.match(/requestAnimationFrame\(\(\) => requestAnimationFrame\(/g) || []).length >= 2,
    'every restore waits two frames (commit, then layout)');
  ok(/if \(y <= 0\) return null/.test(ks),
    'parking from the top parks nothing — there is no place to give back');
  ok(/Math\.abs\(now - park\.landed\) > 2\) return/.test(ks),
    'unparking stands down if the reader has scrolled somewhere else meanwhile');
  /* Two frames are enough for React to commit and the browser to lay out, but not
     for content that measures itself afterwards — a re-opened section remounts its
     children, so the page is still short when we scroll and we land above the mark
     (measured: restored to 2248 instead of 2350). The restore keeps asking while
     the page grows, bounded, and stops the moment the reader takes over. */
  ok(/function scrollSettling\(y\)/.test(ks), 'a restore keeps asking while the page is still growing');
  ok(/if \(\+\+tries < 4/.test(ks), 'and it is bounded, so it can never loop');
  ok(/if \(last >= 0 && Math\.abs\(now - last\) > 2\) return;/.test(ks),
    'and stands down the moment the reader scrolls themselves');
}

console.log(failures
  ? `\n${failures} FAILURE(S)`
  : '\ntest-file-scroll-lock: ok — every collapse, tab and scroll-lock on the loan file holds the reader\'s place');
process.exit(failures ? 1 : 0);
