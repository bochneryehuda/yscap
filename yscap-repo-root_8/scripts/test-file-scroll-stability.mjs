/* An action on a loan file must NEVER move the page (owner-reported 2026-07-27:
   "whenever I accept the document or I sign off a condition it automatically
   flies down to the bottom and to the closing section — we need to stay where we
   are always").

   Two halves, both guarded here:

   (A) The LANDINGS fire once per file, never on a refresh. The closer's
       land-on-Closing jump, the #sec- deep link, ?focus=ai-findings, the
       borrower's ?chat= jump and the ?finding= deep link are all keyed on the
       loaded file / finding list — and EVERY action ends in a reload that hands
       back a brand-new object, so without a one-shot ref they re-fire on every
       accept and every sign-off and drag the reader somewhere else.

   (B) lib/keep-scroll.js holds the reader's place across the re-render, so a
       condition collapsing or dropping out of the filter can't shift the page
       under them either.

   Pure — no DB, no browser. The DOM half runs against a stub. */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let failures = 0;
function ok(cond, what) {
  if (cond) return;
  failures++;
  console.error(`  ✗ ${what}`);
}

/* ---------------------------------------------------------------- (A) landings */

const staff = read('app-v2/src/screens/StaffApplication.jsx');

// The reported bug itself: the closer's landing sits in an effect keyed on `app`.
ok(/const landed = useRef\(false\)/.test(staff), 'staff file has a one-shot landing ref');
ok(/landed\.current = false;?\s*\}, \[id\]\)/.test(staff), 'the landing ref resets per file id');
ok(/if \(!app \|\| String\(app\.id\) !== String\(id\) \|\| landed\.current\) return;/.test(staff),
  'the landing is skipped once it has fired, and ignores the previous file');
{
  // The guard must sit in the SAME effect as the sec-closing jump, not merely
  // somewhere in the file.
  const i = staff.indexOf("goToSection('sec-closing')");
  ok(i > 0, 'the closer still lands on the Closing section when the file opens');
  const before = staff.slice(Math.max(0, i - 1400), i);
  ok(/landed\.current = true;/.test(before), 'the sec-closing landing is behind the one-shot guard');
}
{
  const i = staff.indexOf("'ai-findings'");
  ok(i > 0, 'the ?focus=ai-findings landing still exists');
  const around = staff.slice(Math.max(0, i - 800), i + 400);
  ok(/focusedAi\.current/.test(around), 'the ?focus=ai-findings landing is one-shot');
}

// The staff file holds the reader's place on every refresh but the first.
ok(/import \{ captureScrollAnchor, restoreScrollAnchor \} from '\.\.\/lib\/keep-scroll\.js'/.test(staff),
  'the staff file uses the keep-scroll helper');
ok(/const anchor = isFirst \? null : captureScrollAnchor\(\);/.test(staff), 'staff load() captures the anchor');
ok(/restoreScrollAnchor\(anchor\);/.test(staff), 'staff load() restores the anchor');
ok(/firstLoad\.current = true;/.test(staff), 'the first load of a file is exempt');
// The condition rows carry a stable handle so the anchor is the row being worked
// on, not merely the section it lives in.
ok((staff.match(/data-keep-scroll=/g) || []).length >= 6, 'every condition row shape carries a keep-scroll handle');

const borrower = read('app-v2/src/screens/Application.jsx');
ok(/const landedChat = useRef\(false\)/.test(borrower), 'the borrower ?chat= landing is one-shot');
ok(/if \(!wantsChat \|\| !app \|\| String\(app\.id\) !== String\(id\) \|\| landedChat\.current\) return undefined;/.test(borrower),
  'the borrower chat landing is skipped once it has fired, and ignores the previous file');
ok(/const anchor = isFirst \? null : captureScrollAnchor\(\);/.test(borrower), 'borrower load() captures the anchor');
ok(/restoreScrollAnchor\(anchor\);/.test(borrower), 'borrower load() restores the anchor');

const uw = read('app-v2/src/components/UnderwritingPanel.jsx');
ok(/const focusedFinding = useRef\(''\)/.test(uw), 'the ?finding= deep link has a one-shot ref');
ok(/if \(focusedFinding\.current === focusFindingId\) return;/.test(uw),
  'the ?finding= deep link does not re-scroll on a later reload');

/* --------------------------------------------------------------- (B) the helper */

function el(key, top, id) {
  return {
    id: id || '',
    getAttribute: (n) => (n === 'data-keep-scroll' ? (key || null) : null),
    getBoundingClientRect: () => ({ top }),
  };
}
function stubDom({ scrollY, els }) {
  const scrolls = [];
  globalThis.window = {
    scrollY, pageYOffset: scrollY, innerHeight: 900,
    scrollTo: (o) => scrolls.push(typeof o === 'number' ? o : o.top),
  };
  globalThis.document = {
    querySelectorAll: () => els,
    getElementById: (id) => els.find(e => e.id === id) || null,
    querySelector: (sel) => {
      const m = /\[data-keep-scroll="(.*)"\]/.exec(sel);
      return (m && els.find(e => e.getAttribute('data-keep-scroll') === m[1])) || null;
    },
  };
  globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
  return scrolls;
}

const { captureScrollAnchor, restoreScrollAnchor } = await import('../app-v2/src/lib/keep-scroll.js');

// At the top of the page there is nothing to hold.
stubDom({ scrollY: 0, els: [el('cond-1', 140)] });
ok(captureScrollAnchor() === null, 'nothing is captured at the top of the page');

// A refresh that shortens the content ABOVE the reader must not move the page:
// the row they were looking at goes back to where it was on screen.
{
  const rows = [el('cond-a', 900), el('cond-b', 150), el('cond-c', 600)];
  stubDom({ scrollY: 2000, els: rows });
  const snap = captureScrollAnchor();
  ok(snap && snap.key === 'k:cond-b', 'the anchor is the row nearest where the reader is looking');
  // …a condition above collapsed, so everything below it slid up 260px.
  const shifted = [el('cond-a', 640), el('cond-b', -110), el('cond-c', 340)];
  const scrolls = stubDom({ scrollY: 2000, els: shifted });
  restoreScrollAnchor(snap);
  ok(scrolls.length === 1 && scrolls[0] === 1740, `the page is pulled back by the shift (got ${scrolls.join()})`);
}

// An ordinary refresh where nothing moved must not touch the scroll position.
{
  const rows = [el('cond-b', 150)];
  stubDom({ scrollY: 2000, els: rows });
  const snap = captureScrollAnchor();
  const scrolls = stubDom({ scrollY: 2000, els: [el('cond-b', 150)] });
  restoreScrollAnchor(snap);
  ok(scrolls.length === 0, 'a refresh that changes no layout writes no scroll');
}

// The anchor itself can disappear — a condition signed off leaves the "needs my
// sign-off" list. Fall back to the offset they were at, never to the page bottom.
{
  stubDom({ scrollY: 2000, els: [el('cond-b', 150)] });
  const snap = captureScrollAnchor();
  const scrolls = stubDom({ scrollY: 3200, els: [el('cond-z', 150)] });
  restoreScrollAnchor(snap);
  ok(scrolls.length === 1 && scrolls[0] === 2000, `a vanished anchor falls back to the reader's offset (got ${scrolls.join()})`);
}

// Never throws, whatever it is handed.
{
  stubDom({ scrollY: 2000, els: [] });
  restoreScrollAnchor(null);
  restoreScrollAnchor({ key: 'k:nope', top: 10, y: 5 });
  delete globalThis.window; delete globalThis.document;
  ok(captureScrollAnchor() === null, 'capture is a no-op outside a browser');
  restoreScrollAnchor({ key: '', top: 0, y: 0 });
  ok(true, 'restore never throws');
}

if (failures) { console.error(`test-file-scroll-stability: ${failures} failure(s)`); process.exit(1); }
console.log('test-file-scroll-stability: ok — landings fire once per file, and a refresh holds the reader\'s place');
