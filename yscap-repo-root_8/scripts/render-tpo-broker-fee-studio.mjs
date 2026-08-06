/* THE BROKER FEE THAT HAS TO REACH THE DOCUSIGNED PDF.
 *
 * A TPO broker prices in the Term Sheet Studio and the studio GENERATES the
 * term-sheet PDF client-side (window.TS.exportPdf) — that exact PDF is stored and
 * DocuSigned. So the broker fee the firm set has to be in the CLIENT calc, not
 * only the server register. This drives the real static tool in a browser and:
 *   1. proves a retail sheet (no broker fee pushed) is UNCHANGED — brokerFee 0,
 *      closing/cash-to-close/liquidity exactly as before (the byte-identical rule);
 *   2. pushes a firm's resolved pricing via window.TS.setPricingDefaults and proves
 *      the broker fee = totalLoan x pct folds into closing, cash-to-close AND the
 *      liquidity to show — but NEVER the note rate or the origination (a fee, not a
 *      markup) — matching the server's pricing.js to the dollar.
 *
 * A green build proves none of this, so it runs the real page. Not in CI (no
 * browser there); a manual check like the other render-*.mjs.
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/user/yscap/yscap-repo-root_8/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres@127.0.0.1:5433/yscap_final';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key-for-local-run-only';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.RUN_SYNC = '0'; process.env.CLICKUP_OUTBOUND_ENABLED = '0'; process.env.SITEWIRE_ENABLED = '0';

const db = require('/home/user/yscap/yscap-repo-root_8/src/db');
const app = require('/home/user/yscap/yscap-repo-root_8/src/server');

let server;
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const near = (a, b, eps = 0.5) => Math.abs(Number(a) - Number(b)) <= eps;

// The resolved-firm settings the /api/tpo pricing route would hand the studio:
// retail company defaults + a broker origination fee of 1.5 points.
const FIRM_SETTINGS = {
  markupStdPct: 0.5, markupGoldPct: 0.5, markupSilverPct: 0.5,
  origStdPct: 1.25, origGoldPct: 1.25, origSilverPct: 1.25,
  lenderFee: 2195, creditFee: 150, appraisalFee: 800,
  titleFee: null, extraFees: [], markupTiers: null,
  brokerFeePct: 1.5,
};

(async () => {
  let browser;
  try {
    await require('/home/user/yscap/yscap-repo-root_8/src/migrate-boot').ensureSchema();
    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto(`${base}/tools/term-sheet.html`, { waitUntil: 'domcontentloaded' });
    // Wait for the tool + its engines to wire up.
    await page.waitForFunction(() => window.TS && window.YS && window.YSP && typeof window.TS._calc === 'function', null, { timeout: 15000 });

    // Fill a plain Standard-eligible fix & flip purchase and let it recompute.
    await page.evaluate(() => {
      const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } };
      set('propState', 'NJ');
      set('fico', '740');
      set('price', '300000');
      set('asIs', '300000');
      set('arv', '460000');
      set('construction', '60000');
      set('tsTerm', '12');
      set('expFlips', '3');
    });
    await page.waitForTimeout(400);

    // 1) RETAIL: nothing pushed → CO.brokerFeePct stays 0 → sheet is unchanged.
    const before = await page.evaluate(() => {
      const d = window.TS._calc();
      return d && { totalLoan: d.totalLoan, brokerFee: d.brokerFee, brokerFeePct: d.brokerFeePct,
        closing: d.closing, cashToClose: d.cashToClose, liquidity: d.liquidity, rate: d.rate, origFee: d.origFee };
    });
    ok(before && before.totalLoan > 0, `the scenario sizes a loan (${before && Math.round(before.totalLoan)})`);
    ok(before && before.brokerFee === 0, `retail: broker fee is 0 (${before && before.brokerFee})`);
    ok(before && before.brokerFeePct === 0, `retail: broker fee pct is 0 (${before && before.brokerFeePct})`);

    // 2) PUSH the firm settings (what ProductStudioPanel does on a TPO file).
    const applied = await page.evaluate((s) => {
      if (!window.TS || typeof window.TS.setPricingDefaults !== 'function') return { has: false };
      window.TS.setPricingDefaults(s);
      const d = window.TS._calc();
      return { has: true, totalLoan: d.totalLoan, brokerFee: d.brokerFee, brokerFeePct: d.brokerFeePct,
        closing: d.closing, cashToClose: d.cashToClose, liquidity: d.liquidity, rate: d.rate, origFee: d.origFee };
    }, FIRM_SETTINGS);

    ok(applied.has, 'window.TS.setPricingDefaults exists');
    // Rate + origination are UNCHANGED (a broker fee is not a markup, and it is a
    // NEW line, not a bigger origination).
    ok(near(applied.rate, before.rate, 0.0001), `note rate unchanged after broker fee (${before.rate} -> ${applied.rate})`);
    ok(near(applied.origFee, before.origFee, 0.5), `origination unchanged (${Math.round(before.origFee)} -> ${Math.round(applied.origFee)})`);
    // The broker fee = totalLoan x 1.5% and is exactly the delta in closing / CTC / liquidity.
    const expected = applied.totalLoan * 0.015;
    ok(near(applied.brokerFee, expected), `broker fee = totalLoan x 1.5% (${Math.round(applied.brokerFee)} ≈ ${Math.round(expected)})`);
    ok(near(applied.brokerFeePct, 1.5, 0.001), `broker fee pct on the result = 1.5 (${applied.brokerFeePct})`);
    ok(near(applied.closing, before.closing + expected), `closing rose by exactly the broker fee (${Math.round(before.closing)} + ${Math.round(expected)} ≈ ${Math.round(applied.closing)})`);
    ok(near(applied.cashToClose, before.cashToClose + expected), `cash-to-close rose by exactly the broker fee`);
    ok(near(applied.liquidity, before.liquidity + expected), `liquidity to show rose by exactly the broker fee`);

    // 3) The visible line renders in the studio panel.
    await page.waitForTimeout(200);
    const rowShown = await page.evaluate(() => {
      const w = document.getElementById('rBrokerWrap');
      const v = document.getElementById('rBroker');
      return { visible: !!(w && w.style.display !== 'none'), text: v ? v.textContent : '' };
    });
    ok(rowShown.visible && /\$/.test(rowShown.text), `the studio shows a "Broker origination fee" line (${rowShown.text})`);

    // 4) Clearing it (broker fee 0) returns to the retail sheet.
    const cleared = await page.evaluate((s) => {
      window.TS.setPricingDefaults({ ...s, brokerFeePct: 0 });
      const d = window.TS._calc();
      const w = document.getElementById('rBrokerWrap');
      return { brokerFee: d.brokerFee, closing: d.closing, hidden: !!(w && w.style.display === 'none') };
    }, FIRM_SETTINGS);
    ok(cleared.brokerFee === 0 && near(cleared.closing, before.closing), 'clearing the broker fee reverts to the retail sheet');
    ok(cleared.hidden, 'and the broker-fee line hides again');

    ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
    await db.pool.end().catch(() => {});
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
})();
