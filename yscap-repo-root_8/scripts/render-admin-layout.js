/**
 * scripts/render-admin-layout.js — THE TERM SHEET STUDIO'S ADMIN ZONE, MEASURED IN A REAL BROWSER.
 *
 * OWNER-REPORTED 2026-08-26: *"the entire CSS over there on the term sheet studio is broken. All
 * the fields are down. It's messed up."* Two causes, and NEITHER is visible to a source test:
 *
 *   1. A note was added under one field using an undefined `hint` class, so it rendered as
 *      full-size unstyled body text and pushed the whole grid down. The class simply does not
 *      exist in this stylesheet — nothing errors, it just lays out wrong.
 *   2. A label that wraps to two lines pushed its own box down while its neighbour's stayed up,
 *      so the two columns staggered. Fixed structurally by pinning each field's contents to the
 *      BOTTOM of its grid cell, which holds however long a label runs.
 *
 * WHY IT MEASURES RENDERED POSITION RATHER THAN DOM ORDER: several fields are hidden by the JS
 * (the CEMA question appears only on a New York refinance), so pairing children 0/1, 2/3 pairs a
 * visible box with a hidden one and reports a stagger that is not on the screen. Two boxes are on
 * the same line when their vertical ranges genuinely overlap.
 *
 * AND WHY IT REFUSES AN EMPTY MEASUREMENT: the admin panel is behind a password gate and every
 * group is a collapsed <details>. The first cut measured a hidden panel — 0 pairs — and reported
 * ALL GREEN. A layout test that measures nothing is a tautology, so it now asserts it found real
 * boxes before it asserts anything about them.
 *
 * Browser-dependent, and IN `npm test` since 2026-09-04 — it SKIPs cleanly
 * without Playwright. The two source-level causes are additionally pinned by H8a/H8b in
 * `test-lender-fees-pure`, which DOES run in CI.
 */
/* Measures the Term Sheet Studio's admin zone in a REAL browser. The owner's report is visual
   ("the entire CSS is broken, all the fields are down"), and only a render can settle it. */
const path = require('path');
let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) {}
}
if (!chromium) { console.log('SKIP render-admin-layout (no playwright)'); process.exit(0); }
const TOOL = path.join(__dirname, '..', 'web/v2/tools/term-sheet.html');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log('  ok  ' + n); } else { fail++; console.log('  FAIL ' + n); } };

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.goto('file://' + TOOL, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  // Open every collapsed admin section so the fields are laid out for real.
  // The admin panel is behind a password gate and every group is a collapsed <details>. Reveal
  // the real markup rather than a hidden one — a hidden box measures 0 wide and every alignment
  // assertion would pass while measuring nothing (which is exactly what the first cut did).
  await page.evaluate(() => {
    const panel = document.getElementById('tsAdminPanel');
    if (panel) { panel.hidden = false; panel.style.display = ''; }
    const lock = document.getElementById('tsAdminLock'); if (lock) lock.hidden = true;
    document.querySelectorAll('details').forEach((d) => { d.open = true; });
  });
  await page.waitForTimeout(600);

  const r = await page.evaluate(() => {
    const out = { rows: [], overflow: [], grids: 0, hint: document.querySelectorAll('.hint').length };
    /* PAIR BY WHAT IS RENDERED, NOT BY DOM ORDER. Several fields are hidden by the JS (the CEMA
       question only appears on a New York refinance), so counting children 0/1, 2/3 pairs a
       visible box with a hidden one and reports a stagger that is not on the screen. Two boxes
       are "on the same line" if their vertical ranges genuinely overlap; those are the ones whose
       tops must match, and that is exactly the stagger the owner can see. */
    document.querySelectorAll('.ts-admin-grid2').forEach((g) => {
      out.grids++;
      const boxes = [...g.querySelectorAll(':scope > .field')].map((f) => {
        const inp = f.querySelector('.input');
        if (!inp) return null;
        const r = inp.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;   // hidden — not on screen at all
        const lab = f.querySelector('label');
        return { top: r.top, bottom: r.bottom, label: (lab ? lab.textContent : '').trim().slice(0, 34) };
      }).filter(Boolean);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const A = boxes[i], B = boxes[j];
          const overlap = Math.min(A.bottom, B.bottom) - Math.max(A.top, B.top);
          const h = Math.min(A.bottom - A.top, B.bottom - B.top);
          if (overlap > h * 0.3) {           // they visually share a line
            out.rows.push({ a: A.label, b: B.label, dy: Math.round(Math.abs(A.top - B.top)) });
          }
        }
      }
    });
    // Any input whose text is wider than its box (a truncating placeholder shows as overflow).
    document.querySelectorAll('.ts-admin-grid2 .input input').forEach((el) => {
      if (el.scrollWidth > el.clientWidth + 2) {
        out.overflow.push({ id: el.id, ph: el.placeholder, over: el.scrollWidth - el.clientWidth });
      }
    });
    return out;
  });

  console.log(`\n  ${r.grids} admin grid(s), ${r.rows.length} side-by-side field pairs measured\n`);
  const misaligned = r.rows.filter((x) => x.dy > 2);
  ok('the harness actually measured something (never report green on an empty page)', r.rows.length >= 8);
  ok('no leftover undefined `hint` block in the page', r.hint === 0);
  ok('every pair of boxes sits on the SAME line (this is the "fields are down" bug)', misaligned.length === 0);
  if (misaligned.length) misaligned.slice(0, 6).forEach((m) => console.log(`      off by ${m.dy}px: "${m.a}" vs "${m.b}"`));
  ok('no placeholder is cut off inside its box', r.overflow.length === 0);
  if (r.overflow.length) r.overflow.slice(0, 6).forEach((o) => console.log(`      ${o.id}: "${o.ph}" overflows by ${o.over}px`));

  if (process.env.SHOT) {
    // Capture the PANEL ELEMENT, not the viewport: this page scrolls inside its own container,
    // so scrollIntoView + a viewport shot just re-photographs the top of the document.
    const el = await page.$('#tsAdminPanel');
    if (el) await el.screenshot({ path: process.env.SHOT });
    else await page.screenshot({ path: process.env.SHOT });
  }
  await b.close();
  console.log(`\nrender-admin-layout: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
