/* THE SPEED PROGRAM CARD, PROVEN IN A REAL BROWSER (owner-directed 2026-09-03).
 *
 * The Term Sheet Studio composes the Speed Program in the BROWSER from the three engine
 * globals (YSP + SVP → SPP), so a green unit suite proves nothing about the card a person
 * sees. This serves `web/v2/` statically, opens the real `term-sheet.html`, fills a real
 * purchase scenario through the real inputs, and asserts the owner's promise on the page:
 *
 *   (a) the Speed card renders a loan amount and a rate;
 *   (b) its loan is ≤ the Standard card's AND ≤ the Silver card's — "always the lesser";
 *   (c) its rate is ≥ both — "the more expensive rate";
 *   (d) picking it opens the detail with the composition table (all four ceiling rows), and
 *       the exported PDF's derivation page carries the same block;
 *   (e) no page text and no PDF string names a note buyer (Fidelis / EMCAP / Blue Lake);
 *   (f) the program grid never shows three cards across at desktop width (CLAUDE.md 2×2 rule):
 *       at most two distinct x-positions per row, measured off the cards' bounding boxes;
 *   plus: the assignment wording on a Speed sheet reads the 10% share the engine applied.
 *
 * Run: node scripts/test-speed-studio-card.mjs
 * SKIPs (exit 0) without Playwright/Chromium — CI has no browser, which is why this is not in
 * the `npm test` chain; the pure guards for the wiring live in the fee-audit / parses suites.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web', 'v2');
const TOOL = path.join(WEB, 'tools', 'term-sheet.html');

let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('SKIP test-speed-studio-card (no playwright)'); process.exit(0); }
if (!fs.existsSync(TOOL)) { console.log('SKIP test-speed-studio-card (studio not found)'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (m, c, extra) => { if (c) { pass++; console.log('  PASS - ' + m); } else { fail++; console.log('  FAIL - ' + m + (extra ? ' :: ' + extra : '')); } };
const usd = (s) => { const n = Number(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : NaN; };
const pct = (s) => { const n = Number(String(s || '').replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? n : NaN; };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.jpg': 'image/jpeg' };
function serveStatic() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const abs = path.normalize(path.join(WEB, rel));
      if (!abs.startsWith(WEB) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
      fs.createReadStream(abs).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

/* The owner's scenario: NJ fix & flip, FICO 700, 2 flips, seller $200k + $40k assignment fee,
   as-is $250k, rehab $60k, ARV $330k. The 20% fee is over EVERY cap (15% / 10%), which is what
   makes the assignment wording on the Speed sheet observable. */
const SCENARIO = {
  dealPurpose: 'Purchase', dealType: 'Fix & Flip', propState: 'NJ', fico: '700', expFlips: '2',
  origPrice: '200000', price: '240000', asIs: '250000', construction: '60000', arv: '330000',
  rehabScope: 'light', tsTerm: '12',
};

(async () => {
  const server = await serveStatic();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' })
      .catch(() => chromium.launch());
  } catch (e) {
    console.log('SKIP test-speed-studio-card (chromium unavailable: ' + (e && e.message) + ')');
    server.close(); process.exit(0);
  }
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    await page.goto(`${base}/tools/term-sheet.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.TS && window.YSP && window.SVP && window.SPP && typeof window.TS._calcSpeed === 'function', null, { timeout: 20000 });
    ok('the studio wires up with the Speed module loaded after Standard + Silver', true);

    // Fill the scenario through the real inputs (select by option value OR text — a <select>
    // silently ignores a value it has no option for).
    const setResult = await page.evaluate((f) => {
      const out = {};
      const fire = (e) => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); };
      for (const [k, v] of Object.entries(f)) {
        const e = document.getElementById(k); if (!e) { out[k] = 'missing'; continue; }
        if (e.tagName === 'SELECT') {
          const opt = [...e.options].find((o) => o.value === v) || [...e.options].find((o) => (o.textContent || '').trim().toLowerCase().startsWith(v.toLowerCase()));
          if (!opt) { out[k] = 'no-option'; continue; }
          e.value = opt.value; fire(e); out[k] = e.value;
        } else { e.value = v; fire(e); out[k] = e.value; }
      }
      const asg = document.getElementById('isAssign');
      if (asg && !asg.checked) { asg.click(); fire(asg); }
      out.isAssign = !!(asg && asg.checked);
      return out;
    }, SCENARIO);
    ok('every scenario field was accepted by the page', Object.values(setResult).every((v) => v !== 'missing' && v !== 'no-option'), JSON.stringify(setResult));
    ok('the assignment toggle is ON', setResult.isAssign === true);
    await page.waitForTimeout(900);

    // ---- (a) the card renders a loan + rate ----
    const cards = await page.evaluate(() => {
      const t = (id) => (document.getElementById(id) || {}).textContent || '';
      const gone = (id) => { const e = document.getElementById(id); return !e || e.classList.contains('pcard-gone'); };
      return {
        std: { loan: t('stdLoanBig'), rate: t('stdRateBig'), badge: t('stdBadge'), gone: gone('pcardStd') },
        silver: { loan: t('silverLoanBig'), rate: t('silverRateBig'), badge: t('silverBadge'), gone: gone('pcardSilver') },
        speed: { loan: t('speedLoanBig'), rate: t('speedRateBig'), badge: t('speedBadge'), sub: t('speedSub'), orig: t('speedOrigBig'), pts: t('speedOrigPts'), gone: gone('pcardSpeed'), off: document.getElementById('pcardSpeed').classList.contains('pcard-off') },
        gold: { gone: gone('pcardGold') },
      };
    });
    console.log('  cards:', JSON.stringify(cards));
    const spLoan = usd(cards.speed.loan), stLoan = usd(cards.std.loan), svLoan = usd(cards.silver.loan);
    const spRate = pct(cards.speed.rate), stRate = pct(cards.std.rate), svRate = pct(cards.silver.rate);
    ok('(a) the Speed card is on the grid and selectable', !cards.speed.gone && !cards.speed.off);
    ok('(a) the Speed card shows a loan amount', spLoan > 0, cards.speed.loan);
    ok('(a) the Speed card shows a note rate', spRate > 0, cards.speed.rate);
    ok('(a) the Speed card names the composition on its sub-line', /Lesser of Standard & Silver/.test(cards.speed.sub) && /\$1,000,000|\$1M/.test(cards.speed.sub) && /10%/.test(cards.speed.sub), cards.speed.sub);
    ok('the Standard and Silver cards both priced this scenario (the comparison means something)', stLoan > 0 && svLoan > 0 && stRate > 0 && svRate > 0, `std ${cards.std.loan}/${cards.std.rate} silver ${cards.silver.loan}/${cards.silver.rate}`);

    // ---- (b) lesser loan, (c) higher rate ----
    ok('(b) Speed loan ≤ Standard loan', spLoan <= stLoan, `${spLoan} vs ${stLoan}`);
    ok('(b) Speed loan ≤ Silver loan', spLoan <= svLoan, `${spLoan} vs ${svLoan}`);
    ok('(c) Speed rate ≥ Standard rate', spRate >= stRate - 1e-9, `${spRate} vs ${stRate}`);
    ok('(c) Speed rate ≥ Silver rate', spRate >= svRate - 1e-9, `${spRate} vs ${svRate}`);

    // The card agrees with the calc it is painted from, and the calc agrees with the module.
    const calc = await page.evaluate(() => {
      const d = window.TS._calcSpeed(), s = window.TS._calcSilver(), st = window.TS._calc();
      const sp = d && d.speedInfo;
      return d && { totalLoan: d.totalLoan, rate: d.rate, origPct: d.origPct, status: d.status, asgMaxPct: d.asg && d.asg.maxPct,
        rateDonor: sp && sp.rateDonor, capDonor: sp && sp.capDonor, stdRate: sp && sp.standard && sp.standard.noteRate, svRate: sp && sp.silver && sp.silver.noteRate,
        silverOrig: s && s.origPct, stdOrig: st && st.origPct, silverAsgMaxPct: s && s.asg && s.asg.maxPct, stdAsgMaxPct: st && st.asg && st.asg.maxPct };
    });
    console.log('  calcSpeed:', JSON.stringify(calc));
    ok('the card prints exactly _calcSpeed().totalLoan', calc && Math.floor(calc.totalLoan) === spLoan, `${calc && calc.totalLoan} vs ${spLoan}`);
    ok('the card rate is the higher of the two parents\' rates at this structure', calc && Math.abs(Math.max(calc.stdRate, calc.svRate) * 100 - calc.rate) < 1e-6, JSON.stringify({ std: calc && calc.stdRate, sv: calc && calc.svRate, speed: calc && calc.rate }));
    ok('Speed origination = the HIGHER of the Standard and Silver origination the studio applies', calc && Math.abs(calc.origPct - Math.max(calc.stdOrig, calc.silverOrig)) < 1e-12, JSON.stringify({ speed: calc && calc.origPct, std: calc && calc.stdOrig, silver: calc && calc.silverOrig }));
    ok('the engine reports a 10% assignment share on Speed and 15% on the parents', calc && calc.asgMaxPct === 0.10 && calc.stdAsgMaxPct === 0.15 && calc.silverAsgMaxPct === 0.15, JSON.stringify({ speed: calc && calc.asgMaxPct, std: calc && calc.stdAsgMaxPct, silver: calc && calc.silverAsgMaxPct }));

    // ---- (f) the grid geometry: never three across ----
    async function gridRows(label) {
      const boxes = await page.evaluate(() => [...document.querySelectorAll('#progCompare .pcard')]
        .filter((c) => !c.classList.contains('pcard-gone') && c.getBoundingClientRect().width > 0)
        .map((c) => { const r = c.getBoundingClientRect(); return { id: c.id, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) }; }));
      const rows = new Map();
      for (const b of boxes) { const k = Math.round(b.y / 8); if (!rows.has(k)) rows.set(k, []); rows.get(k).push(b); }
      const perRow = [...rows.values()].map((r) => ({ y: r[0].y, xs: [...new Set(r.map((b) => b.x))].sort((a, b) => a - b), ids: r.map((b) => b.id) }));
      console.log(`  grid @${label}:`, JSON.stringify(perRow));
      return { boxes, perRow };
    }
    const g1280 = await gridRows('1280');
    ok('(f) @1280: at most TWO distinct x-positions on every card row', g1280.perRow.every((r) => r.xs.length <= 2), JSON.stringify(g1280.perRow));
    ok('(f) @1280: the Speed card is on the grid and every visible card has a real width', g1280.boxes.some((b) => b.id === 'pcardSpeed') && g1280.boxes.every((b) => b.w > 150));
    ok('(f) @1280: the visible cards read Standard + Silver / Speed + Manual when Gold is discontinued, or Standard + Gold / Silver + Speed / Manual when Gold is on',
      (cards.gold.gone
        ? JSON.stringify(g1280.perRow.map((r) => r.ids)) === JSON.stringify([['pcardStd', 'pcardSilver'], ['pcardSpeed', 'pcardManual']])
        : JSON.stringify(g1280.perRow.map((r) => r.ids)) === JSON.stringify([['pcardStd', 'pcardGold'], ['pcardSilver', 'pcardSpeed'], ['pcardManual']])),
      JSON.stringify(g1280.perRow.map((r) => r.ids)));
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.waitForTimeout(250);
    const g1600 = await gridRows('1600');
    ok('(f) @1600: still never three across', g1600.perRow.every((r) => r.xs.length <= 2), JSON.stringify(g1600.perRow));
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);

    // Headline stats stay inside their column (the fitStat ladder) — no visible overflow.
    const overflow = await page.evaluate(() => ['speedLoanBig', 'speedRateBig', 'speedOrigBig'].map((id) => { const e = document.getElementById(id); return { id, over: e ? e.scrollWidth - e.clientWidth : 0 }; }));
    ok('the Speed card\'s headline figures do not overflow their boxes', overflow.every((o) => o.over <= 0), JSON.stringify(overflow));

    // ---- (d) pick it → the detail shows the composition table ----
    await page.click('#pcardSpeed');
    await page.waitForTimeout(700);
    const detail = await page.evaluate(() => {
      const box = document.getElementById('rSpeedComp');
      const rows = box ? [...box.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent.trim())) : [];
      return {
        chosenActive: document.getElementById('pcardSpeed').classList.contains('pcard-active'),
        head: (document.getElementById('progDetailHead') || {}).textContent || '',
        detailShown: (document.getElementById('progDetail') || {}).style ? document.getElementById('progDetail').style.display !== 'none' : false,
        compHidden: !box || box.hidden, rows,
        compText: box ? box.textContent : '',
        levProg: (document.getElementById('rLevProg') || {}).textContent || '',
        levShown: (document.getElementById('rLevWrap') || {}).style ? document.getElementById('rLevWrap').style.display !== 'none' : false,
        pdfBtn: (document.getElementById('tsPdf') || {}).textContent || '',
        asgNote: (document.getElementById('rAssignNote') || {}).textContent || '',
      };
    });
    console.log('  detail:', JSON.stringify({ head: detail.head, rows: detail.rows, levProg: detail.levProg, levShown: detail.levShown, pdfBtn: detail.pdfBtn }));
    ok('(d) clicking the card drills into the Speed Program detail', detail.chosenActive && detail.detailShown && /Speed Program/.test(detail.head), detail.head);
    ok('(d) the composition table is visible with all four ceiling rows', !detail.compHidden && detail.rows.length === 4, JSON.stringify(detail.rows));
    const labels = detail.rows.map((r) => r[0]);
    ok('(d) the rows are max loan / acquisition LTV / after-repair LTV / loan-to-cost', JSON.stringify(labels) === JSON.stringify(['Maximum loan', 'Acquisition LTV', 'After-repair LTV', 'Loan-to-cost']), JSON.stringify(labels));
    ok('(d) every row carries Standard\'s figure, Silver\'s, the enforced one and who set it', detail.rows.every((r) => r.length === 5 && r.slice(1, 4).every((v) => v && v !== '—') && /Standard|Silver|both|Speed/.test(r[4])), JSON.stringify(detail.rows));
    ok('(d) the block states both rates and which one Speed charges', /Standard \d/.test(detail.compText) && /Silver \d/.test(detail.compText) && /charges the higher/.test(detail.compText), detail.compText.slice(0, 200));
    ok('the leverage ladder is drawn for Speed', detail.levShown && /Speed/.test(detail.levProg), detail.levProg);
    ok('the PDF button names the Speed term sheet', /Speed/.test(detail.pdfBtn), detail.pdfBtn);
    ok('the on-screen assignment note reads the 10% share on a Speed sheet — never a literal 15%', /10%/.test(detail.asgNote) && !/15%/.test(detail.asgNote), detail.asgNote.slice(0, 200));

    // ---- (d, PDF) the derivation page carries the block; (e) no buyer name anywhere ----
    await page.evaluate(() => new Promise((res) => {
      if (window.jspdf && window.jspdf.jsPDF) return res();
      const s = document.createElement('script'); s.src = 'vendor/jspdf.umd.min.js'; s.onload = res; s.onerror = res; document.head.appendChild(s);
    }));
    const pdf = await page.evaluate(async () => {
      const J = window.jspdf && window.jspdf.jsPDF; if (!J) return { err: 'jsPDF did not load' };
      const drawn = []; const oT = J.API.text, oS = J.API.save, oO = J.API.output;
      J.API.text = function (t) { try { if (typeof t === 'string') drawn.push(t); else if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && drawn.push(x)); } catch (_) {} try { return oT.apply(this, arguments); } catch (e) { return this; } };
      J.API.save = function () { return this; }; J.API.output = function () { return ''; };
      let err = null; try { await window.TS.exportPdf(); } catch (e) { err = String((e && e.message) || e); }
      await new Promise((z) => setTimeout(z, 1200));
      J.API.text = oT; J.API.save = oS; J.API.output = oO;
      return { err, drawn };
    });
    const all = (pdf.drawn || []).join('\n');
    ok('the Speed term sheet PDF rendered', !pdf.err && (pdf.drawn || []).length > 50, pdf.err || `${(pdf.drawn || []).length} strings`);
    ok('(d, PDF) the derivation page carries "How the Speed Program was composed"', /HOW THE SPEED PROGRAM WAS COMPOSED/i.test(all));
    ok('(d, PDF) …with all four ceiling rows', /Maximum loan/.test(all) && /Acquisition LTV/.test(all) && /After-repair LTV/.test(all) && /Loan-to-cost/.test(all));
    ok('(d, PDF) …the two rates and the one Speed charges', /Standard rate at this structure/.test(all) && /Silver rate at this structure/.test(all) && /Rate the Speed Program charges/.test(all));
    ok('(d, PDF) …the assignment line at 10%', /Assignment fee financeable to/.test(all) && /10%/.test(all));
    ok('(d, PDF) …both programs\' own loan under the combined ceiling', /Standard.s own loan under the combined ceiling/.test(all) && /Silver.s own loan under the combined ceiling/.test(all));
    ok('(PDF) the pricing ladder page prints for Speed', /pricing at every leverage level/.test(all));
    ok('(PDF) no literal "15%" assignment cap on a Speed sheet', !/15%/.test(all), (all.match(/[^\n]*15%[^\n]*/g) || []).join(' | '));
    const buyer = /fidelis|emcap|blue\s*lake/i;
    const pageText = await page.evaluate(() => document.body.innerText || '');
    ok('(e) no note buyer named anywhere on the page', !buyer.test(pageText), (pageText.match(/[^\n]*(fidelis|emcap|blue\s*lake)[^\n]*/i) || [''])[0]);
    ok('(e) no note buyer named anywhere in the PDF', !buyer.test(all), (all.match(/[^\n]*(fidelis|emcap|blue\s*lake)[^\n]*/i) || [''])[0]);

    // The Excel sections carry a fourth program block, keyed and titled.
    const xlsx = await page.evaluate(() => window.TS._xlsxSections().map((s) => ({ title: s.title, n: s.items.length, has: s.items.some((r) => /Composition/.test(r[0])) })));
    const spSec = xlsx.find((s) => s.title === 'Speed Program');
    ok('the Excel export carries a "Speed Program" section with its composition row', !!spSec && spSec.has && spSec.n > 10, JSON.stringify(xlsx));

    // Tap again collapses; the block hides on another program.
    await page.click('#pcardStd'); await page.waitForTimeout(400);
    const afterStd = await page.evaluate(() => ({ hidden: document.getElementById('rSpeedComp').hidden, head: document.getElementById('progDetailHead').textContent }));
    ok('the composition block hides when another program is drilled into', afterStd.hidden && /Standard Program/.test(afterStd.head), JSON.stringify(afterStd));

    ok('no page errors during the run', errors.length === 0, errors.join(' | '));
  } catch (e) {
    fail++; console.log('  FAIL - harness threw :: ' + (e && e.stack || e));
  } finally {
    try { await browser.close(); } catch (_) {}
    server.close();
  }
  console.log(`\ntest-speed-studio-card: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
