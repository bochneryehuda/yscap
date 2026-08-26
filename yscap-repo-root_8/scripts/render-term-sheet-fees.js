'use strict';
/**
 * render-term-sheet-fees — EVERY FEE THE DEAL CARRIES IS NAMED ON THE TERM SHEET.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-26: *"There need to be added lines for these fees.
 * Please do the research exactly why it's not populating on the files that we're doing right
 * now."*). The construction feasibility fee shipped on 2026-08-21 folded into `closing` — so it
 * was CHARGED, the cash-to-close total included it — and named on the studio panel and the
 * spreadsheet's Standard column only. The term sheet PDF never mentioned it, so the fees a
 * borrower can read did not add up to the total they were asked to bring, on the one document
 * that goes out for signature.
 *
 * READING THE SOURCE CANNOT PROVE THIS. The PDF is drawn by jsPDF at run time out of a long
 * sequence of row calls, so the only honest check is to RUN the export and record what actually
 * landed on the page. This loads the real studio, drives a battery of deals through the real
 * inputs, wraps `jsPDF.API.text` to capture every string drawn, and asserts that a deal carrying
 * a fee NAMES it — and that a deal carrying none is unchanged.
 *
 * It also re-proves the second defect the same render exposed: a BRIDGE was being charged the
 * $750 project-review fee, because the studio's rehab-scope control is HIDDEN rather than cleared
 * when a deal moves off fix & flip, so it kept `heavy` and fed the fee.
 *
 * Run: node scripts/render-term-sheet-fees.js
 * SKIPs (exit 0) without Playwright/Chromium — CI has no browser, which is why this is not in the
 * `npm test` chain; `test-feasibility-fee-pure` carries the source guards that CI can enforce.
 */
const path = require('path');
const fs = require('fs');

let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('SKIP render-term-sheet-fees (no playwright)'); process.exit(0); }
const TOOL = path.resolve(__dirname, '../web/v2/tools/term-sheet.html');
if (!fs.existsSync(TOOL)) { console.log('SKIP render-term-sheet-fees (studio not found)'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (m, c, extra) => { if (c) { pass++; } else { fail++; console.log('  FAIL - ' + m + (extra ? ' :: ' + extra : '')); } };

/* Each deal, and what the term sheet MUST say about its construction review. */
const DEALS = [
  { name: 'ground-up', expect: 'Ground-up construction feasibility review', amount: '$1,250.00',
    f: { dealType: 'Ground-up Construction', price: '300000', construction: '400000', arv: '1100000', asIs: '300000', fico: '740', expGround: '3', propState: 'NJ' } },
  { name: 'heavy fix & flip', expect: 'Construction feasibility & project review', amount: '$750.00',
    f: { dealType: 'Fix & Flip', price: '300000', construction: '150000', arv: '650000', asIs: '300000', fico: '740', expFlips: '5', propState: 'NJ', rehabScope: 'heavy' } },
  { name: 'light fix & flip', expect: null,
    f: { dealType: 'Fix & Flip', price: '300000', construction: '60000', arv: '520000', asIs: '300000', fico: '740', expFlips: '5', propState: 'NJ', rehabScope: 'light' } },
  /* THE BRIDGE, entered straight after a heavy fix & flip — the exact sequence that produced the
     overcharge, because the rehab-scope control keeps its value when it is hidden. */
  { name: 'bridge (after a heavy rehab deal)', expect: null,
    f: { dealType: 'Bridge / Stabilized', price: '400000', asIs: '400000', fico: '740', expFlips: '3', propState: 'NJ' } },
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' })
    .catch(() => chromium.launch());
  const page = await browser.newPage();
  await page.goto('file://' + TOOL, { waitUntil: 'load' });
  await page.waitForTimeout(900);
  // jsPDF is loaded on demand by the export, so pre-load it or there is nothing to wrap.
  await page.evaluate(() => new Promise((res) => {
    if (window.jspdf && window.jspdf.jsPDF) return res();
    const s = document.createElement('script');
    s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = res;
    document.head.appendChild(s);
  }));

  for (const deal of DEALS) {
    await page.evaluate((f) => {
      ['construction', 'arv', 'asIs', 'price', 'expFlips', 'expBrrrr', 'expGround'].forEach((id) => {
        const e = document.getElementById(id); if (e) e.value = '';
      });
      for (const [k, v] of Object.entries(f)) {
        const e = document.getElementById(k); if (!e) continue;
        e.value = v;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, deal.f);
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
      J.API.save = function () { return this; };      // never actually download
      J.API.output = function () { return ''; };
      let err = null;
      try { await window.TS.exportPdf(); } catch (e) { err = String((e && e.message) || e); }
      await new Promise((z) => setTimeout(z, 1200));
      J.API.text = oT; J.API.save = oS; J.API.output = oO;
      const d = window.TS._calc(window.TS._gather());
      return { err, drawn, feasFee: d && d.feasFee, cashToClose: d && d.cashToClose };
    });

    const all = (r.drawn || []).join('\n');
    ok(`${deal.name}: the term sheet rendered`, !r.err && (r.drawn || []).length > 50, r.err || `${(r.drawn || []).length} strings`);
    if (deal.expect) {
      ok(`${deal.name}: the fee is NAMED on the page`, all.includes(deal.expect));
      ok(`${deal.name}: …with its amount beside it`, all.includes(deal.amount));
      ok(`${deal.name}: …and the deal actually carries it`, Number(r.feasFee) > 0);
    } else {
      /* A deal with no construction to review must not be charged for one, and must not print a
         line for a fee it does not carry. */
      ok(`${deal.name}: carries NO construction review fee`, Number(r.feasFee || 0) === 0, `feasFee=${r.feasFee}`);
      ok(`${deal.name}: …and the page never names one`,
        !/feasibility|project review/i.test(all));
    }
  }

  await browser.close();
  console.log(fail ? `\nrender-term-sheet-fees: ${pass} passed, ${fail} FAILED`
    : `\nrender-term-sheet-fees: all ${pass} checks passed.`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('render-term-sheet-fees threw:', e); process.exit(1); });
