'use strict';
/**
 * THE VALUE-ADD DETAILS AND THE NARRATIVE MAY NOT OVERLAP (owner-reported
 * 2026-08-21: "On the Rehab Budget PDF, the value add details, if it's long, and
 * the narrative of the Scope of Work Rehab Budget are overlapping with each
 * other").
 *
 * ROOT CAUSE this pins: the "Value drivers" box computed its own height as
 * `rows * 17` -- ONE line per row -- while each row's VALUE was wrapped by
 * jsPDF's splitTextToSize and could be three or four lines. A long value drew
 * past its own row, past the box, and the NARRATIVE below it was then drawn
 * straight on top. Nothing in that section knew where the page ENDED either, so
 * a long narrative ran off the bottom and the budget table landed over it.
 *
 * WHY THIS IS A BROWSER TEST. The builder is a browser tool that draws through
 * jsPDF, so the only honest way to check a layout is to RUN it and record where
 * every piece of text actually landed. This loads the real page, fills in
 * deliberately long value-add notes and a long narrative through the tool's own
 * `RB.setState`, wraps `jsPDF.API.text` / `.roundedRect` / `.addPage` to record
 * every call with its page, and asserts on the GEOMETRY -- never on a screenshot,
 * and never on the source. jsPDF is vendored locally, so no network is needed.
 *
 * Run: node scripts/test-rehab-budget-pdf-layout.js
 * SKIPs (exit 0) without Playwright/Chromium -- CI has no browser, which is why
 * this is not in the `npm test` chain.
 */
const path = require('path');
const fs = require('fs');

let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('SKIP test-rehab-budget-pdf-layout (no playwright)'); process.exit(0); }

const TOOL = path.resolve(__dirname, '../web/v2/tools/rehab-budget.html');
if (!fs.existsSync(TOOL)) { console.log('SKIP test-rehab-budget-pdf-layout (tool page not found)'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL:', name, extra == null ? '' : `\n        ${extra}`);
};

// Deliberately long -- this is the shape that produced the reported overlap.
const LONG_OTHER = 'Full gut of the rear extension including a new structural beam, '
  + 'relocating the kitchen to the front of the house, opening the wall between the '
  + 'dining room and the living room, new central air throughout, and rebuilding the '
  + 'rear deck with composite decking and a new railing to code.';
const LONG_BASEMENT = 'Underpinning the basement to gain ceiling height, waterproofing '
  + 'the perimeter, adding an egress window, and finishing it as a legal recreation room '
  + 'with a full bathroom and a wet bar.';
const LONG_NARRATIVE = ('The property is a tired 1920s two-family that has not been updated since the '
  + 'late 1980s. The plan is a complete interior renovation of both units plus a full exterior '
  + 'refresh. ').repeat(9);

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
    await page.goto('file://' + TOOL, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.RB && window.RB.exportPdf && window.RB.setState), null, { timeout: 15000 });

    const rec = await page.evaluate(async ({ LONG_OTHER, LONG_BASEMENT, LONG_NARRATIVE }) => {
      const RB = window.RB;
      // 1. One export first, purely to make the tool load its vendored jsPDF --
      //    the hooks below can only be installed once the library exists.
      await RB.exportPdf(null, { returnFile: true });
      const { jsPDF } = window.jspdf;

      // 2. Record every draw, with the page it landed on.
      //    The hook goes on the INSTANCE, not on jsPDF.API: in jsPDF 2.x the
      //    static API object is copied onto each document at construction, so
      //    patching it afterwards reaches nothing (measured — it recorded one
      //    call out of hundreds). The tool re-reads `window.jspdf.jsPDF` inside
      //    exportPdf on every call, so swapping the constructor is enough.
      const texts = [], rects = [];
      let pageNo = 1, pageH = 0;
      const RealPDF = jsPDF;
      function Recording(...args) {
        const d = new RealPDF(...args);
        const rt = d.text.bind(d), rr = d.roundedRect.bind(d), ra = d.addPage.bind(d);
        pageH = d.internal.pageSize.getHeight();
        d.text = function (t, x, yy) {
          const arr = Array.isArray(t) ? t : [t];
          // jsPDF paints an array of lines at its own leading; record each
          // line's real baseline the same way it is drawn.
          let lead = 0;
          try { lead = d.getLineHeight(); } catch (_) { lead = d.internal.getFontSize() * 1.15; }
          const size = d.internal.getFontSize();
          arr.forEach((s, i) => texts.push({ page: pageNo, s: String(s), x, y: yy + i * lead, size }));
          return rt.apply(d, arguments);
        };
        d.roundedRect = function (x, yy, w, h) { rects.push({ page: pageNo, x, y: yy, w, h }); return rr.apply(d, arguments); };
        d.addPage = function () { pageNo++; return ra.apply(d, arguments); };
        return d;
      }
      Recording.API = RealPDF.API;
      window.jspdf.jsPDF = Recording;

      // 3. The long content, through the tool's own state door.
      const cur = RB.getState();
      RB.setState(Object.assign({}, cur, {
        address: '1420 Grand Concourse, Bronx, NY 10456',
        projType: 'heavy',
        months: '9',
        narrative: LONG_NARRATIVE,
        vd: Object.assign({}, cur.vd, {
          expand: true, sqftNow: '1800', sqftAfter: '2600',
          beds: true, bedsNow: '3', bedsAfter: '5',
          baths: true, bathsNow: '1', bathsAfter: '3',
          basement: true, basementNotes: LONG_BASEMENT,
          layout: true, layoutNotes: 'Reconfiguring the entire ground floor to an open plan.',
          curb: true, curbNotes: 'New siding, roof, windows, walkway, landscaping and a rebuilt front porch.',
          other: LONG_OTHER,
        }),
      }));

      try { await RB.exportPdf(null, { returnFile: true }); }
      finally { window.jspdf.jsPDF = RealPDF; }
      return { texts, rects, pages: pageNo, pageH };
    }, { LONG_OTHER, LONG_BASEMENT, LONG_NARRATIVE });

    ok('the page raised no script errors while building the PDF', errors.length === 0, errors.join(' | '));

    const { texts, rects, pageH } = rec;
    ok('the PDF drew text at all', texts.length > 20, `drew ${texts.length}`);

    // ---- 1. NOTHING IS DRAWN BELOW THE PAGE ---------------------------------
    const overflow = texts.filter((t) => t.y > pageH - 6);
    ok('no line is drawn past the bottom of its page', overflow.length === 0,
      overflow.slice(0, 3).map((t) => `p${t.page} y=${Math.round(t.y)} (page ${Math.round(pageH)}) "${t.s.slice(0, 44)}"`).join(' ; '));

    // ---- 2. THE VALUE-DRIVERS BOX CONTAINS ITS OWN CONTENT -------------------
    const title = texts.find((t) => /VALUE DRIVERS/.test(t.s));
    ok('the value-drivers box is drawn', !!title);
    let box = null;
    if (title) {
      box = rects
        .filter((r) => r.page === title.page && r.y <= title.y && r.y + r.h > title.y)
        .sort((a, b) => b.h - a.h)[0];
      ok('the value-drivers box has a measurable frame', !!box);
    }
    if (box) {
      const longLines = texts.filter((t) => t.page === box.page
        && /rear extension|Underpinning|composite decking|egress window|central air/i.test(t.s));
      ok('the long value-add text was actually drawn', longLines.length >= 2, `found ${longLines.length}`);
      const spill = longLines.filter((t) => t.y > box.y + box.h - 2);
      ok('NO value-add line spills out of the bottom of its box', spill.length === 0,
        spill.slice(0, 3).map((t) => `y=${Math.round(t.y)} vs box bottom ${Math.round(box.y + box.h)} "${t.s.slice(0, 40)}"`).join(' ; '));
    }

    // ---- 3. THE NARRATIVE STARTS CLEAR OF THE BOX ----------------------------
    const narrIdx0 = texts.findIndex((t) => t.s === 'NARRATIVE');
    const narrHead = texts.find((t) => t.s === 'NARRATIVE');
    ok('the narrative heading is drawn', !!narrHead);
    if (narrHead && box) {
      ok('the narrative begins clear of the value-drivers box — THE REPORTED OVERLAP',
        narrHead.page !== box.page || narrHead.y > box.y + box.h,
        `narrative p${narrHead.page} y=${Math.round(narrHead.y)} vs box p${box.page} bottom ${Math.round(box.y + box.h)}`);
    }

    // ---- 3b. THE OWNER'S OWN WORDS, AS GEOMETRY -----------------------------
    // "the value add details ... and the narrative ... are overlapping with each
    // other". Two lines overlap when they sit on the same page within a line's
    // height of one another. Asserted directly rather than inferred from the box,
    // because the box is our own construct and the collision is what a reader sees.
    if (narrIdx0 >= 0) {
      const vaLines = texts.filter((t) => /rear extension|Underpinning|composite decking|egress window|central air|structural beam/i.test(t.s));
      const nrLines = texts.slice(narrIdx0).filter((t) => /tired 1920s|complete interior renovation|full exterior|NARRATIVE/.test(t.s));
      const hits = [];
      for (const a of vaLines) for (const b of nrLines) {
        if (a.page === b.page && Math.abs(a.y - b.y) < 11) hits.push(`p${a.page} y=${Math.round(a.y)} "${a.s.slice(0, 30)}" / "${b.s.slice(0, 30)}"`);
      }
      ok('a value-add line and a narrative line never share the same place on the page',
        hits.length === 0, hits.slice(0, 3).join(' ; '));
    }

    // ---- 4. THE NARRATIVE'S OWN LINES NEVER COLLIDE -------------------------
    const narrIdx = texts.findIndex((t) => t.s === 'NARRATIVE');
    if (narrIdx >= 0) {
      const body = texts.slice(narrIdx + 1).filter((t) => /tired 1920s|complete interior renovation|full exterior/i.test(t.s));
      ok('the long narrative was actually drawn', body.length >= 3, `found ${body.length}`);
      let collision = null;
      for (let i = 1; i < body.length; i++) {
        if (body[i].page === body[i - 1].page && body[i].y <= body[i - 1].y) { collision = i; break; }
      }
      ok('every narrative line sits below the one before it on the same page', collision === null,
        collision === null ? '' : `line ${collision} y=${Math.round(body[collision].y)} <= ${Math.round(body[collision - 1].y)}`);

      // ---- 5. A HEADING IS NEVER STRANDED AT THE FOOT OF A PAGE -------------
      if (body.length) {
        ok('the narrative heading keeps its first line with it',
          body[0].page === texts[narrIdx].page,
          `heading p${texts[narrIdx].page}, first line p${body[0].page}`);
      }
    }

    console.log(`test-rehab-budget-pdf-layout: ${pass} passed, ${fail} failed (${rec.pages} page(s) rendered)`);
    await browser.close();
    process.exit(fail ? 1 : 0);
  } catch (e) {
    await browser.close().catch(() => {});
    console.error(e);
    process.exit(1);
  }
})();
