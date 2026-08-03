/* THE CHIP THAT STOPPED LYING, ACTUALLY RENDERED.
 *
 * The API Health page is where somebody goes to answer one question: is this
 * connector configured? For USPS the answer used to contradict itself — the
 * connector reads its credential under several names (USPS labels the same pair
 * "Client ID" on one portal screen and "Consumer Key" on another), but the
 * environment chips only ever checked the canonical name, so a key set under an
 * accepted alternate rendered a red "required — not set" and the card's own
 * missing-required line named a key that is right there and working.
 *
 * A green build proves none of that, so this drives a real browser with the
 * alternate name set in the environment the server reads, and checks the page:
 *   1. it renders at all (the chip gained a nested span — the class of change that
 *      has crashed this portal before);
 *   2. the chip reads SET, not missing;
 *   3. it names the variable that carried it, and NEVER the value.
 */
import { createRequire } from 'node:module';
const require = createRequire('/home/user/yscap/yscap-repo-root_8/');
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://yscap:yscap@127.0.0.1:5432/yscap_t3';
process.env.JWT_SECRET = 'render-check-secret';
// Set BEFORE the server is required: the chips read process.env when the page asks.
const SECRET_VALUE = 'never_print_me_9f3a';
process.env.USPS_CONSUMER_KEY = SECRET_VALUE;
process.env.USPS_CONSUMER_SECRET = SECRET_VALUE;

const db = require('/home/user/yscap/yscap-repo-root_8/src/db');
const C = require('/home/user/yscap/yscap-repo-root_8/src/lib/crypto');
const app = require('/home/user/yscap/yscap-repo-root_8/src/server');

const sfx = `${process.pid}${Math.floor(Math.random() * 1e5)}`;
let server, staffId;
const errors = [];
let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

(async () => {
  let browser;
  try {
    await require('/home/user/yscap/yscap-repo-root_8/src/migrate-boot').ensureSchema();
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Chip Check','super_admin',true,false,'x',0) RETURNING id`,
      [`ch${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('ys_portal_token', t); }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/net::ERR_|404|Failed to load resource/.test(m.text())) errors.push(m.text());
    });

    await page.goto(`${base}/portal/#/internal/api-health`, { waitUntil: 'domcontentloaded' });
    // The probes are time-boxed at 8s each and run together; networkidle never
    // settles here, so wait past the slowest one.
    await page.waitForTimeout(11000);

    ok(await page.locator('text=Something went wrong').count() === 0, 'the API Health page renders');
    ok(await page.locator('text=USPS').count() >= 1, 'and the USPS connector is on it');

    const chip = page.locator('text=/USPS_CLIENT_ID/').first();
    ok(await chip.count() === 1, 'the USPS_CLIENT_ID chip is there');
    const chipText = (await chip.innerText()).replace(/\s+/g, ' ').trim();
    ok(chipText.startsWith('✓'),
      `it reads SET, not "required — not set", on a connector configured under an accepted name (${chipText})`);
    ok(/as USPS_CONSUMER_KEY/.test(chipText),
      `and names the variable that actually carried it (${chipText})`);

    const body = await page.locator('body').innerText();
    ok(!body.includes(SECRET_VALUE),
      'and the page never contains the credential VALUE — only variable names');
    ok(!/Missing:[^\n]*USPS_CLIENT_ID/.test(body),
      'the card no longer lists USPS_CLIENT_ID as missing');

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
