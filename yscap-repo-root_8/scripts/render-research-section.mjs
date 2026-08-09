/* ONE SECTION, SEVERAL PAGES — actually clicked through.
 *
 * The owner asked for the six research links on the left to become ONE section
 * with pages inside it: "the entire section everything is a property research and
 * Resource Center". The requirement that makes it non-trivial is that nothing
 * anyone saved may break — so this drives a real browser and checks BOTH halves:
 *
 *   · the sidebar carries ONE research entry, not seven, and the pages appear
 *     underneath it only while you are inside the section;
 *   · every page of the section still answers on its OWN URL, unchanged, with the
 *     section's tab strip on it and the right tab lit.
 *
 * The URLs are the point. They were never rewritten and there is no redirect
 * catching them — the pages already lived at nested paths, so making them pages
 * of one section needed no new address at all. This asserts that by visiting each
 * one directly, the way a bookmark or a pasted link would.
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/user/yscap/yscap-repo-root_8/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_t3';
process.env.JWT_SECRET = 'render-check-secret';
const db = require('/home/user/yscap/yscap-repo-root_8/src/db');
const C = require('/home/user/yscap/yscap-repo-root_8/src/lib/crypto');
const app = require('/home/user/yscap/yscap-repo-root_8/src/server');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
let server, staffId;
const errors = [];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

// Every page of the section, with the tab that must be lit when you land on it.
const PAGES = [
  ['/internal/research', 'Search properties'],
  ['/internal/research/comps', 'Find comparables'],
  ['/internal/research/market', 'Market conditions'],
  ['/internal/research/adjustments', 'What we charge'],
  ['/internal/research/quick', 'Quick answer'],
  ['/internal/research/areas', 'Market areas'],
  ['/internal/research/appraisers', 'Appraisers'],
];

(async () => {
  let browser;
  try {
    await require('/home/user/yscap/yscap-repo-root_8/src/migrate-boot').ensureSchema();
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Section Check','super_admin',true,false,'x',0) RETURNING id`,
      [`sn${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('ys_portal_token', t); }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_/.test(m.text())) errors.push(m.text()); });

    const sidebar = page.locator('.sb-link');

    // ---- 1. OUTSIDE THE SECTION: ONE ENTRY, NO SUB-PAGES ------------------
    await page.goto(`${base}/portal/#/internal/dashboards`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2400);
    ok(await page.locator('text=Something went wrong').count() === 0, 'the portal renders');
    const outsideResearchLinks = await sidebar.filter({ hasText: 'Property Research' }).count();
    ok(outsideResearchLinks === 1, `the sidebar shows ONE Property Research entry from outside the section (saw ${outsideResearchLinks})`);
    for (const gone of ['Find comparables', 'Market conditions', 'What we charge', 'Quick answer', 'Market areas']) {
      ok(await sidebar.filter({ hasText: gone }).count() === 0,
        `"${gone}" is no longer its own sidebar entry`);
    }

    // ---- 2. INSIDE THE SECTION: THE PAGES APPEAR UNDERNEATH ----------------
    await page.goto(`${base}/portal/#/internal/research/quick`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2200);
    for (const there of ['Find comparables', 'Market conditions', 'What we charge', 'Quick answer', 'Market areas', 'Appraisers']) {
      ok(await sidebar.filter({ hasText: there }).count() >= 1,
        `inside the section the sidebar offers "${there}"`);
    }

    // ---- 3. EVERY PAGE, ON ITS OWN UNCHANGED URL --------------------------
    const nav = page.locator('nav[aria-label="Property Research and Resource Center"]');
    for (const [url, tab] of PAGES) {
      await page.goto(`${base}/portal/#${url}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1700);
      ok(await page.locator('text=Something went wrong').count() === 0, `${url} renders`);
      ok(page.url().endsWith(url), `${url} is still its own address — nothing redirected it`);
      ok(await nav.count() === 1, `${url} carries the section's page strip`);
      // The lit tab is the one you are on. Getting this wrong (a `startsWith`
      // match on the section root) lights the first tab everywhere, which is
      // exactly the "which page am I on?" confusion the section is meant to end.
      const lit = await nav.locator('a[style*="600"]').allInnerTexts();
      ok(lit.length === 1 && lit[0].trim() === tab,
        `${url}: the lit tab is "${tab}" (saw ${JSON.stringify(lit)})`);
    }

    // ---- 4. THE TABS ARE REAL LINKS ----------------------------------------
    // Route-based, not a query parameter — so Back, middle-click and bookmarking
    // all behave the way they look like they should, and the tab can never
    // collide with a screen's own search, which lives in the query string.
    await page.goto(`${base}/portal/#/internal/research/market`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1700);
    await nav.locator('a', { hasText: 'Quick answer' }).click();
    await page.waitForTimeout(900);
    ok(page.url().endsWith('/internal/research/quick'), 'clicking a tab navigates to that page');
    await page.goBack();
    await page.waitForTimeout(900);
    ok(page.url().endsWith('/internal/research/market'), 'and Back returns to the page you came from');

    // A screen's own search survives the section wrapper — the query string is
    // still entirely the screen's.
    await page.goto(`${base}/portal/#/internal/research/quick?city=Trenton&state=NJ`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1900);
    ok(await page.locator('input[placeholder="Trenton"]').inputValue() === 'Trenton',
      'a saved link carrying a search still opens on that search');

    ok(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ') || 'none'})`);
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    if (browser) await browser.close();
    if (server) server.close();
    if (staffId) await db.query('DELETE FROM staff_users WHERE id=$1', [staffId]).catch(() => {});
    await db.pool.end().catch(() => {});
    console.log(failures ? `\n${failures} FAILED` : '\nall passed');
    process.exit(failures ? 1 : 0);
  }
})();
