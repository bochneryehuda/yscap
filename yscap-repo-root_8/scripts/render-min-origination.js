'use strict';
/**
 * render-min-origination — THE MINIMUM ORIGINATION FEE, ON THE REAL PAGE.
 *
 * WHY THIS EXISTS, and it is a rule this repo has already been bitten by twice. A mirror-agreement
 * test proves the studio's copy of a rule and the server's copy AGREE; only a RENDER proves either
 * one is wired to the real page. The 2026-08-26 legal-fee rung read `num("purchase")` where the
 * input's id is `price`, so the basis was always 0 and the rung was unreachable in the browser
 * while every unit assertion passed — because the mirror harness STUBS the DOM accessor and
 * answers whatever the test asks for. The same trap is live here: `resolvedMinOrigFee` reads
 * `adminNumRaw("tsMinOrigFee")`, and a wrong id would make the per-file exception box silently do
 * nothing on every file while `test-min-origination-pure` stayed green.
 *
 * So this drives the REAL studio, types into the REAL box, and asserts what the page actually
 * prints and computes:
 *   1. a small loan is charged the $2,500 minimum and the sheet SAYS so;
 *   2. a large loan is charged the percentage and the sheet says nothing at all;
 *   3. the per-file box RAISES the floor, and a typed 0 WAIVES it — proving the id is real;
 *   4. the box is PRE-FILLED, not pre-set: a placeholder, never a painted value (2026-08-20).
 *
 * Run: node scripts/render-min-origination.js
 * SKIPs (exit 0) without Playwright/Chromium — CI has no browser, which is why this is not in the
 * `npm test` chain; `test-min-origination-pure` carries the source guards CI can enforce.
 */
const path = require('path');
const fs = require('fs');

let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('SKIP render-min-origination (no playwright)'); process.exit(0); }
const TOOL = path.resolve(__dirname, '../web/v2/tools/term-sheet.html');
if (!fs.existsSync(TOOL)) { console.log('SKIP render-min-origination (studio not found)'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (m, c, extra) => { if (c) { pass++; } else { fail++; console.log('  FAIL - ' + m + (extra ? ' :: ' + extra : '')); } };

/* The crossover at the 1.25% default is a $200,000 LOAN, so the deals straddle it by SIZE. Each is
   a real, eligible flip — a fee proven on a deal that does not price proves nothing. */
const DEALS = [
  { name: 'small loan (the floor binds)', bound: true, typed: '',
    f: { dealPurpose: 'Purchase', dealType: 'Fix & Flip', price: '60000', construction: '18000', arv: '96000', asIs: '60000', fico: '740', expFlips: '5', propState: 'TX', rehabScope: 'light' } },
  { name: 'large loan (the floor can never bind)', bound: false, typed: '',
    f: { dealPurpose: 'Purchase', dealType: 'Fix & Flip', price: '600000', construction: '120000', arv: '1000000', asIs: '600000', fico: '740', expFlips: '5', propState: 'TX', rehabScope: 'light' } },
  /* THE BOX ITSELF — the wrong-field-id trap. A typed 5,000 must RAISE the floor on a deal the
     $2,500 minimum would not have reached, and a typed 0 must WAIVE it on one it does. Neither can
     happen if `adminNumRaw` is reading an id that does not exist. */
  { name: 'per-file exception raises the floor to $5,000', bound: true, typed: '5000', want: 5000,
    f: { dealPurpose: 'Purchase', dealType: 'Fix & Flip', price: '250000', construction: '60000', arv: '430000', asIs: '250000', fico: '740', expFlips: '5', propState: 'TX', rehabScope: 'light' } },
  { name: 'per-file waiver (a typed 0) takes the floor off', bound: false, typed: '0',
    f: { dealPurpose: 'Purchase', dealType: 'Fix & Flip', price: '60000', construction: '18000', arv: '96000', asIs: '60000', fico: '740', expFlips: '5', propState: 'TX', rehabScope: 'light' } },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' })
    .catch(() => chromium.launch());
  const page = await browser.newPage();
  await page.goto('file://' + TOOL, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => new Promise((res) => {
    if (window.jspdf && window.jspdf.jsPDF) return res();
    const s = document.createElement('script');
    s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  }));

  /* 4. THE BOX IS PRE-FILLED, NOT PRE-SET. The company number is the PLACEHOLDER; a painted VALUE
     would be an explicit per-file override that freezes onto the file at register and routes every
     later registration to an admin as a discount the day the company number moves. */
  const box = await page.evaluate(() => {
    const e = document.getElementById('tsMinOrigFee');
    return e ? { exists: true, value: e.value, placeholder: e.placeholder, seeded: e.getAttribute('data-ts-seeded') } : { exists: false };
  });
  ok('the per-file minimum box exists on the page', box.exists);
  ok('…and is EMPTY — pre-filled, never pre-set', box.exists && box.value === '', `value=${JSON.stringify(box.value)}`);
  ok('…while showing the company number as its placeholder', box.exists && String(box.placeholder || '') === '2500', `placeholder=${box.placeholder}`);

  for (const deal of DEALS) {
    await page.evaluate(({ f, typed }) => {
      ['construction', 'arv', 'asIs', 'price', 'expFlips', 'expBrrrr', 'expGround'].forEach((id) => {
        const e = document.getElementById(id); if (e) e.value = '';
      });
      for (const [k, v] of Object.entries(f)) {
        const e = document.getElementById(k); if (!e) continue;
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const mb = document.getElementById('tsMinOrigFee');
      if (mb) { mb.value = typed; mb.dispatchEvent(new Event('input', { bubbles: true })); mb.dispatchEvent(new Event('change', { bubbles: true })); }
    }, { f: deal.f, typed: deal.typed });
    await page.waitForTimeout(800);

    const r = await page.evaluate(async () => {
      const J = window.jspdf && window.jspdf.jsPDF;
      if (!J) return { err: 'jsPDF did not load' };
      const drawn = [];
      const oT = J.API.text, oS = J.API.save, oO = J.API.output;
      J.API.text = function (t) {
        try {
          if (typeof t === 'string') drawn.push(t);
          else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && drawn.push(x));
        } catch (_) { /* capture is best-effort */ }
        try { return oT.apply(this, arguments); } catch (e) { return this; }
      };
      J.API.save = function () { return this; };
      J.API.output = function () { return ''; };
      let err = null;
      try { await window.TS.exportPdf(); } catch (e) { err = String((e && e.message) || e); }
      await new Promise((z) => setTimeout(z, 1200));
      J.API.text = oT; J.API.save = oS; J.API.output = oO;
      const d = window.TS._calc(window.TS._gather());
      const lbl = document.getElementById('rOrigLbl');
      return {
        err, drawn,
        origFee: d && d.origFee, totalLoan: d && d.totalLoan,
        origMin: d && d.origMin ? { minimum: d.origMin.minimum, pctAmount: d.origMin.pctAmount } : null,
        panelLabel: lbl ? lbl.textContent : null,
      };
    });

    const all = (r.drawn || []).join('\n');
    ok(`${deal.name}: the term sheet rendered`, !r.err && (r.drawn || []).length > 50, r.err || `${(r.drawn || []).length} strings`);
    ok(`${deal.name}: the deal actually sized`, Number(r.totalLoan) > 0, `totalLoan=${r.totalLoan}`);

    if (deal.bound) {
      const want = deal.want || 2500;
      ok(`${deal.name}: the fee charged IS the minimum`, Math.round(Number(r.origFee)) === want, `origFee=${r.origFee}`);
      ok(`${deal.name}: …and the studio recorded WHY`, !!r.origMin && Number(r.origMin.minimum) === want, JSON.stringify(r.origMin));
      /* The QUALIFIER — the owner asked for wording next to the origination fee, not a new line. */
      ok(`${deal.name}: the panel row says the minimum applied`, /minimum applied/i.test(r.panelLabel || ''), r.panelLabel);
      ok(`${deal.name}: the PDF says it too`, /minimum applied|minimum\)/i.test(all));
      /* THE STATED RATE MUST NOT APPEAR BESIDE THE MINIMUM DOLLARS — that is the contradiction. */
      ok(`${deal.name}: the row does NOT print the stated 1.25% beside the minimum`,
        !/Origination \(1\.25%\)/.test(r.panelLabel || ''), r.panelLabel);
      /* The derivation page shows the arithmetic, and it is the one place the effective rate is
         named — that page exists to be reconciled against. */
      ok(`${deal.name}: the derivation page shows the arithmetic`, /program minimum/i.test(all) && /effective/i.test(all));
      /* NEVER a penalty, and never a note buyer. */
      ok(`${deal.name}: the sheet never calls it a penalty`, !/penalt/i.test(all));
    } else {
      const pctAmt = Math.round(Number(r.totalLoan) * 0.0125 * 100) / 100;
      ok(`${deal.name}: the fee charged is the percentage`, Math.abs(Number(r.origFee) - pctAmt) < 0.02, `origFee=${r.origFee} pct=${pctAmt}`);
      ok(`${deal.name}: …and the studio recorded no minimum at all`, r.origMin === null, JSON.stringify(r.origMin));
      ok(`${deal.name}: the panel prints the ordinary rate`, /Origination \(1\.25%\)/.test(r.panelLabel || ''), r.panelLabel);
      ok(`${deal.name}: the sheet never mentions a minimum origination`,
        !/minimum applied/i.test(all) && !/program minimum/i.test(all));
    }
  }

  await browser.close();
  console.log(`\nrender-min-origination: ${fail ? `${fail} FAILED of ` : 'all '}${pass + fail} checks${fail ? '' : ' passed'}.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
