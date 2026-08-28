/**
 * scripts/render-panel-line-wrap.js — A LABEL AND ITS VALUE BELONG ON THE SAME LINE.
 *
 * OWNER-REPORTED 2026-08-26, pointing at the studio's results panel — Eligibility snapshot,
 * Key dates, Additional terms: *"Everything is on the next line. Everything is messed up.
 * It needs to be nicer and better. The CSS over there is messed up."*
 *
 * THE CAUSE, MEASURED RATHER THAN GUESSED. `.ts-grid2` was a hard `1fr 1fr`, so each cell was
 * half of a results panel that is only ~460px wide — and a label plus its value does not fit in
 * ~220px. `.ts-line` wraps, so the value dropped BELOW its own label while the pair beside it
 * stayed put, and because `.v` was `text-align:right` the dropped value sat right-ragged in a
 * half-width cell, reading as though it were floating in the middle of the panel.
 *
 * THE BREAKPOINT WAS MEASURING THE WRONG BOX. A collapse rule already existed — but it keyed off
 * the VIEWPORT (`@media (max-width:520px)`), and this panel is narrow on a 1920px screen too, so
 * on the owner's maximized browser it never fired. The grid now keys off its own CONTAINER.
 *
 * WHAT THIS ASSERTS, and why it is not simply "nothing ever wraps": some values here are
 * SENTENCES, not figures — the two-tier draw fee, the minimum-interest wording, the experience
 * tier. Those cannot share a line with their label at any honest width, and the 2026-07-30 fix
 * deliberately made them WRAP rather than run off the panel and clip mid-word. So the rule is:
 *   · a value that is a FIGURE (≤24 chars: an amount, a date, "Not included") must NEVER split;
 *   · a value that must wrap has to do it CLEANLY — starting at the row's left edge, reading as
 *     a label with its answer underneath;
 *   · and nothing may spill past its row or scroll the page sideways (the 2026-07-30 property).
 *
 * It refuses to pass on a page where it measured nothing — the trap that made three earlier
 * harnesses in this repo report ALL GREEN while comparing zero pairs.
 *
 * Browser-dependent, so NOT in `npm test` (the `render-fee-audit` convention); SKIPs without
 * Playwright. The CSS half is pinned by H8d/H8e in `test-lender-fees-pure`, which runs in CI.
 */
const path = require('path'); let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) { try { ({ chromium } = require(m)); break; } catch (_) {} }
if (!chromium) { console.log('SKIP render-panel-line-wrap (no playwright)'); process.exit(0); }
const TOOL = path.join(__dirname, '..', 'web/v2/tools/term-sheet.html');
let pass = 0, fail = 0;
const ok = (n, c, extra) => { c ? (pass++, console.log('  ok  ' + n)) : (fail++, console.log('  FAIL ' + n + (extra ? '  → ' + extra : ''))); };
const set = async (p, id, v) => p.evaluate(([i, val]) => {
  const e = document.getElementById(i); if (!e) return;
  if (e.tagName === 'SELECT') { const o = [...e.options].find(o => o.value === val || o.textContent.trim() === val); if (o) e.value = o.value; }
  else e.value = val;
  e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
}, [id, v]);

const measure = async (page, width) => {
  await page.setViewportSize({ width, height: 1080 });
  await page.waitForTimeout(400);
  return page.evaluate(() => {
    const seen = e => !!e && e.offsetParent !== null && e.getBoundingClientRect().width > 0;
    const rows = [];
    document.querySelectorAll('.ts-line').forEach(line => {
      if (!seen(line)) return;
      const k = line.querySelector('.k'), v = line.querySelector('.v');
      if (!seen(k) || !seen(v)) return;
      const kt = k.textContent.trim(), vt = v.textContent.trim();
      if (!kt || !vt) return;
      const lr = line.getBoundingClientRect(), kr = k.getBoundingClientRect(), vr = v.getBoundingClientRect();
      const rg = document.createRange(); rg.selectNodeContents(v);
      const first = rg.getClientRects()[0];
      rows.push({
        k: kt.slice(0, 30), figure: vt.length <= 24,
        sameLine: Math.min(kr.bottom, vr.bottom) - Math.max(kr.top, vr.top) > 0,
        // A wrapped value reads correctly when its FIRST TEXT LINE starts at the row's left edge.
        stackedCleanly: first ? Math.abs(first.left - lr.left) < 4 : false,
        spills: vr.right > lr.right + 1 || kr.right > lr.right + 1,
      });
    });
    const g = document.querySelector('.ts-grid2');
    return {
      rows, gridW: g ? Math.round(g.getBoundingClientRect().width) : 0, viewport: window.innerWidth,
      sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
};

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + TOOL, { waitUntil: 'load' }); await page.waitForTimeout(800);
  for (const [id, v] of [['dealType', 'Ground-up Construction'], ['price', '300000'], ['construction', '400000'],
                         ['arv', '1100000'], ['asIs', '300000'], ['fico', '775'], ['expGround', '5'], ['propState', 'NJ']]) await set(page, id, v);
  await page.waitForTimeout(900);
  // The drill-in is CLOSED by default and the card TOGGLES — open it only when it is shut.
  await page.evaluate(() => { const d = document.getElementById('progDetail');
    if (d && d.offsetParent === null) { const c = document.getElementById('stdCta'); if (c) c.click(); } });
  await page.waitForTimeout(800);

  /* Every width this page actually renders at, including the owner's maximized browser — the one
     the old viewport breakpoint could never help, because the WINDOW was wide and the PANEL was not.
     A PHONE IS HELD TO A DIFFERENT BAR, and deliberately so rather than to make this pass: at 390px
     the panel is 293px, while "Estimated cash to close" + "$121,352.50" is 305px of text before any
     gap at all. No CSS puts 305px on a 293px line. That row is allowed to stack there — but it is
     pinned BY NAME below, so a second row quietly starting to stack on a phone still fails. */
  const DESKTOP = [1920, 1440, 1024, 768];
  const PHONE = 390;
  let measured = 0, figureSplits = [], raggedWraps = [], spills = 0, sideways = 0, phoneStacked = [];
  for (const w of [...DESKTOP, PHONE]) {
    const r = await measure(page, w);
    measured += r.rows.length;
    if (r.sideways) sideways++;
    r.rows.forEach(x => {
      if (x.spills) spills++;
      if (!x.sameLine && !x.stackedCleanly) raggedWraps.push(`${w}px:${x.k}`);
      if (!x.sameLine && x.figure) { (w === PHONE ? phoneStacked : figureSplits).push(w === PHONE ? x.k : `${w}px:${x.k}`); }
    });
    console.log(`    ${String(w).padStart(4)}px window → grid ${String(r.gridW).padStart(4)}px · ${r.rows.length} rows`);
  }

  // THE ANTI-TAUTOLOGY GUARD: a harness that measured nothing must never report green.
  ok('the harness actually measured the panel at every width', measured >= 100, `only ${measured} rows total`);
  ok('on a real screen, a figure never drops below its own label', figureSplits.length === 0, figureSplits.join(', '));
  ok('a value that must wrap reads as a clean stack, not a right-ragged block', raggedWraps.length === 0, raggedWraps.join(', '));
  ok('nothing spills past its row (the 2026-07-30 clipping fix still holds)', spills === 0, `${spills} spills`);
  ok('the page never scrolls sideways at any width', sideways === 0, `${sideways} widths scroll`);
  /* The phone exception, pinned by name and by count — never "phones are allowed to be broken". */
  ok('on a phone the ONLY figure that stacks is the headline cash-to-close row',
     phoneStacked.length === 1 && /Estimated cash to close/.test(phoneStacked[0]),
     phoneStacked.join(', ') || 'none stacked — the exception may no longer be needed');

  await b.close();
  console.log(`\nrender-panel-line-wrap: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
