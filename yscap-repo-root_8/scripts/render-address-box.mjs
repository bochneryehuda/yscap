/* THE ADDRESS BOX, ACTUALLY TYPED INTO.
 *
 * A green Vite build proves nothing (an undeclared identifier compiles fine and
 * throws at render), and neither does a passing server test — the whole point of
 * this change is what happens between a keystroke and a search, which only a real
 * browser can show. So this drives the real screen: type, pick a suggestion, and
 * assert the three things the owner asked for actually happen.
 *
 *   1. The town, state and ZIP fill themselves in from the picked address.
 *   2. The pick carries a POSITION, and the field SAYS so — which is what makes a
 *      "within half a mile" search answerable from a typed address at all.
 *   3. Searching sends that position, so the server measures from the right point
 *      instead of refusing (or, before the fix, answering with nine states).
 *
 * And the failure case, which matters just as much: an address nobody can place
 * says so in plain words and sends NO position, so the search refuses honestly
 * rather than silently widening.
 *
 * The address providers are intercepted in the browser, so this never touches
 * Nominatim or the Census geocoder and gives the same answer every run.
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

// What the address provider answers. One address it can place, one it cannot.
const PLACED = {
  provider: 'osm',
  suggestions: [{
    id: 'osm:1', label: '26 S 10th St, Brooklyn, NY 11249',
    address: { line1: '26 S 10th St', unit: '', city: 'Brooklyn', state: 'NY', zip: '11249', country: 'US' },
    position: { lat: 40.7142, lng: -73.9614, source: 'osm', precision: 'address' },
  }],
};
const UNPLACEABLE = {
  provider: 'osm',
  suggestions: [{
    id: 'osm:2', label: '9 Nowhere Rd, Nowheresville, NJ',
    address: { line1: '9 Nowhere Rd', unit: '', city: 'Nowheresville', state: 'NJ', zip: '', country: 'US' },
  }],
};

(async () => {
  let browser;
  try {
    staffId = (await db.query(
      `INSERT INTO staff_users (email,full_name,role,is_active,mfa_enabled,password_hash,token_version)
       VALUES ($1,'Address Box Check','super_admin',true,false,'x',0) RETURNING id`,
      [`ab${sfx}@t.test`])).rows[0].id;
    const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'super_admin', tv: 0 });

    // The schema this database is meant to have. Without it a stale test database
    // 500s on a screen whose code is perfectly fine, which reads as a failure of
    // the thing being checked. (`ensureSchema` never throws — the signal is the
    // absence of FAILED in its log, not the exit.)
    await require('/home/user/yscap/yscap-repo-root_8/src/migrate-boot').ensureSchema();

    server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { localStorage.setItem('ys_portal_token', t); }, token);

    // The provider answers, and a record of what the SEARCH was asked. The
    // position lookup is intercepted too: a pick whose suggestion already carries
    // a position must not need it, which is worth proving rather than assuming.
    let suggestReply = PLACED;
    let positionCalls = 0, compsCalls = [];
    await ctx.route('**/api/address/suggest*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(suggestReply) }));
    await ctx.route('**/api/address/position*', (route) => {
      positionCalls++;
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ lat: null, lng: null, source: null, why: 'we could not place that address on the map' }) });
    });
    // USPS is not configured here; answer it explicitly so the pick is not left
    // waiting on a real call.
    await ctx.route('**/api/address/verify*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ configured: false, status: 'not_configured', address: null }) }));
    await ctx.route('**/api/research/comps*', (route) => {
      compsCalls.push(new URL(route.request().url()));
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ rows: [], subject: null, ladder: [], coverage: { properties: 0, where: 'Brooklyn, NY' } }) });
    });

    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    // A REAL page error is a JS exception or a message the app logged. A transport
    // failure ("net::ERR_CONNECTION_RESET") is this harness closing its own server
    // out from under a poll that was already in flight — counting it would make the
    // check flaky about something that is not the page.
    page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_/.test(m.text())) errors.push(m.text()); });

    // ---- 1. THE SCREEN RENDERS AND THE BOX IS THERE -----------------------
    await page.goto(`${base}/portal/#/internal/research/comps`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2600);
    const crashed = await page.locator('text=Something went wrong').count();
    ok(crashed === 0, 'the Find-comparables screen renders (no ErrorBoundary crash)');

    const addrInput = page.locator('input[placeholder="26 S 10th St"]');
    ok(await addrInput.count() === 1, 'the address box is on the screen, with its own placeholder');
    ok(await page.locator('text=/the town, state and ZIP fill themselves in/i').count() > 0,
      'and it tells the officer that picking fills the rest in');

    // ---- 2. A PICK FILLS EVERYTHING AND CARRIES A POSITION ----------------
    await addrInput.fill('26 S 10th');
    await page.waitForTimeout(500);                      // the 250ms debounce
    const item = page.locator('.addr-item').first();
    ok(await item.count() === 1, 'a suggestion appears as you type');
    await item.click();
    await page.waitForTimeout(400);

    const val = (ph) => page.locator(`input[placeholder="${ph}"]`).inputValue();
    ok(await val('Piscataway') === 'Brooklyn', 'picking filled the TOWN in');
    ok(await val('NJ') === 'NY', 'picking filled the STATE in');
    ok(await val('08854') === '11249', 'picking filled the ZIP in');
    ok(positionCalls === 0,
      'no position lookup was needed — the suggestion already carried one, so the pick costs nothing extra');
    ok(await page.locator('text=/distance searches can run from here/i').count() > 0,
      'and the field says the property was found on the map');

    // ---- 3. THE SEARCH SENDS THE POSITION ---------------------------------
    compsCalls = [];
    await page.locator('button:has-text("Search")').first().click();
    await page.waitForTimeout(800);
    const asked = compsCalls[compsCalls.length - 1];
    ok(!!asked, 'searching asked the server for comparables');
    ok(asked && Math.abs(Number(asked.searchParams.get('lat')) - 40.7142) < 1e-6
      && Math.abs(Number(asked.searchParams.get('lng')) + 73.9614) < 1e-6,
      `and it sent the position (lat=${asked && asked.searchParams.get('lat')}, lng=${asked && asked.searchParams.get('lng')})`);
    ok(asked && asked.searchParams.get('radius_miles'),
      'alongside the distance being asked for — which is now a question that can be answered');
    ok(page.url().includes('lat=40.7142'),
      'the position is in the URL too, so the search is still a link a colleague can open');

    // ---- 4. AN ADDRESS NOBODY CAN PLACE SAYS SO, AND SENDS NOTHING --------
    suggestReply = UNPLACEABLE;
    positionCalls = 0;
    await addrInput.fill('9 Nowhere');
    await page.waitForTimeout(500);
    await page.locator('.addr-item').first().click();
    await page.waitForTimeout(500);
    ok(positionCalls === 1,
      'a suggestion with no position of its own triggers exactly one lookup');
    ok(await page.locator('text=/could not place that address/i').count() > 0,
      'and when that comes back empty the field says so, in words');
    ok(await page.locator('text=/a distance search cannot be answered/i').count() > 0,
      'naming the consequence — not just that something failed');
    ok(await val('Piscataway') === 'Nowheresville' && await val('NJ') === 'NJ',
      'the town and state still filled in — an unplaceable address is still a usable town search');

    compsCalls = [];
    await page.locator('button:has-text("Search")').first().click();
    await page.waitForTimeout(800);
    const asked2 = compsCalls[compsCalls.length - 1];
    ok(asked2 && !asked2.searchParams.get('lat') && !asked2.searchParams.get('lng'),
      'and the search carries NO position — a half mile from an unknown point is not a half mile');

    // ---- 5. TYPING OVER THE TOP DROPS THE POSITION -------------------------
    // The coordinate belongs to the address it was looked up for. Carrying it onto
    // a different address typed over the top measures from the wrong house, which
    // is worse than measuring from nothing.
    suggestReply = PLACED;
    await addrInput.fill('26 S 10th');
    await page.waitForTimeout(500);
    await page.locator('.addr-item').first().click();
    await page.waitForTimeout(400);
    ok(await page.locator('text=/distance searches can run from here/i').count() > 0, 'placed again');
    await addrInput.fill('771 Somewhere Else Blvd');
    await page.waitForTimeout(300);
    ok(await page.locator('text=/distance searches can run from here/i').count() === 0,
      'typing a different address drops the position rather than keeping the old house');
    compsCalls = [];
    await page.locator('button:has-text("Search")').first().click();
    await page.waitForTimeout(800);
    const asked3 = compsCalls[compsCalls.length - 1];
    ok(asked3 && !asked3.searchParams.get('lat'),
      'and the search that follows measures from nothing rather than from the previous property');

    // ---- 6. EVERY RESEARCH SCREEN HAS ONE ---------------------------------
    // The owner's words were "anywhere the address is automatically populate".
    // These four search a TOWN rather than a house, and the person working the
    // deal has the property's address in front of them — not its town spelled the
    // way our reports spell it. So each carries the same box, and picking fills
    // the town and state in for them.
    for (const [hash, name, townPh, statePh] of [
      ['/internal/research/market', 'Market conditions', 'Piscataway', 'NJ'],
      ['/internal/research/adjustments', 'What we charge', 'Town (optional)', 'State'],
      ['/internal/research/quick', 'Quick answer', 'Trenton', 'NJ'],
      ['/internal/research/areas', 'Market areas', 'Trenton', 'NJ'],
      ['/internal/research', 'Property Research', 'Any town', null],
    ]) {
      await page.goto(`${base}/portal/#${hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1800);
      ok(await page.locator('text=Something went wrong').count() === 0, `${name} renders`);
      const box = page.locator('input[placeholder="Start typing a property address…"]');
      ok(await box.count() === 1, `${name} has the address box`);
      await box.fill('26 S 10th');
      await page.waitForTimeout(500);
      await page.locator('.addr-item').first().click();
      await page.waitForTimeout(400);
      ok(await page.locator(`input[placeholder="${townPh}"]`).inputValue() === 'Brooklyn',
        `${name}: picking an address filled the town in`);
      // The main research screen's State box carries no placeholder of its own,
      // and its label is a SIBLING rather than a wrapper — so it is found the way
      // the markup actually is, by the label the person reads.
      const stateVal = statePh
        ? await page.locator(`input[placeholder="${statePh}"]`).inputValue()
        : await page.locator('xpath=//label[normalize-space(text())="State"]/following-sibling::input[1]').first().inputValue();
      ok(stateVal === 'NY', `${name}: and the state`);
    }

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
