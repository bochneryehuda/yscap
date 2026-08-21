/**
 * A REFRESH KEEPS YOUR PLACE — proven in a real browser, on the real bundle.
 *
 * Owner-reported 2026-08-21: "When you refresh in the middle of the draw center, it loses
 * your place completely and it goes back to the top … this is a major issue … it happens
 * also on the application detail and Campus Thinking [= Encompass]."
 *
 * WHY A BROWSER. Every screen held its open/closed and tab state in a private useState, so
 * a refresh reset it. The fix is one shared hook (lib/useUrlState.js) whose PROPERTIES are
 * unit-tested in test-url-state-pure.mjs — but "does the loan file still render, and does a
 * reload really keep the section open" cannot be answered by a unit test or by a green
 * build. esbuild emits an undeclared identifier verbatim, so a broken render builds
 * cleanly and throws at runtime into the error boundary; this drives the real thing.
 *
 * It boots the real server against a real Postgres, signs in as real staff, and asserts on
 * the DOM and the address bar.
 *
 * Run: DATABASE_URL=... node scripts/test-file-place-render.js
 * SKIPs (exit 0) without Playwright/Chromium or without a database.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-file-place-render (no DATABASE_URL)'); process.exit(0); }
let chromium = null;
for (const m of ['/opt/node22/lib/node_modules/playwright', 'playwright']) {
  try { ({ chromium } = require(m)); break; } catch (_) { /* try the next */ }
}
if (!chromium) { console.log('SKIP test-file-place-render (no playwright)'); process.exit(0); }
process.env.JWT_SECRET = process.env.JWT_SECRET || 'file-place-render-secret';
process.env.SSN_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const R = require('path').join(__dirname, '..');
const db = require(R + '/src/db');

let pass = 0, fail = 0;
const ok = (c, m, extra) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL', m, extra || ''); } };

(async () => {
  await require(R + '/src/migrate-boot').ensureSchema();
  const app = require(R + '/src/server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;

  const TAG = 'rc' + Date.now().toString(36);
  const staffId = crypto.randomUUID(), bId = crypto.randomUUID();
  const C = require(R + '/src/lib/crypto');
  await db.query(`INSERT INTO staff_users (id,email,full_name,role,is_active) VALUES ($1,$2,'Ren Der','admin',true)`,
    [staffId, `rc+${TAG}@ys.com`]);
  await db.query(`INSERT INTO borrowers (id,first_name,last_name,email) VALUES ($1,'Ren','Borrower',$2)`, [bId, `rcb+${TAG}@example.com`]);
  const appId = (await db.query(
    `INSERT INTO applications (ys_loan_number,borrower_id,loan_officer_id,property_address,loan_amount,status)
     VALUES ($1,$2,$3,'{"oneLine":"7 Render Rd, Town, NY 11223"}',350000,'underwriting') RETURNING id`,
    [`YSCAP-${TAG}`, bId, staffId])).rows[0].id;

  const tv = (await db.query(`SELECT COALESCE(token_version,0) tv FROM staff_users WHERE id=$1`, [staffId])).rows[0].tv;
  const token = C.signJwt({ sub: staffId, kind: 'staff', role: 'admin', tv, sid: crypto.randomUUID() });

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  await ctx.addInitScript(([t]) => { try { localStorage.setItem('ys_portal_token', t); } catch (e) {} }, [token]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 200)); });

  const base = `http://127.0.0.1:${port}/portal/#/internal/app/${appId}`;
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);

  const crashed = await page.locator('text=Something went wrong').count();
  ok(crashed === 0, 'the loan file does not hit the error boundary');
  const bodyText = (await page.locator('body').innerText()).slice(0, 4000);
  ok(/Render Rd|File overview|Overview/i.test(bodyText), 'the loan file rendered real content', bodyText.slice(0, 160));
  ok(errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length === 0,
    'no runtime errors on the loan file', errors.slice(0, 3).join(' | '));

  // ---- THE OWNER'S BUG: does a REFRESH keep your place? --------------------
  console.log('\n2. a refresh keeps the sections you opened');
  const inventory = await page.evaluate(() => [...document.querySelectorAll('section.file-section')]
    .map((sec) => {
      const head = sec.querySelector('.sec-head.collapsible');
      return head ? { id: sec.id, open: head.getAttribute('aria-expanded') } : null;
    }).filter(Boolean));
  ok(inventory.length > 0, `the file rendered collapsible sections (${inventory.length}: ${inventory.map((x) => x.id).join(', ')})`);

  const target = inventory[0] && inventory[0].id;
  const wasOpen = inventory[0] && inventory[0].open;
  const before = page.url();
  await page.evaluate((id) => document.getElementById(id).querySelector('.sec-head.collapsible').click(), target);
  await page.waitForTimeout(800);
  const after = page.url();
  const nowOpen = await page.evaluate((id) => document.getElementById(id).querySelector('.sec-head.collapsible').getAttribute('aria-expanded'), target);

  ok(nowOpen !== wasOpen, `clicking ${target} actually toggled it (${wasOpen} -> ${nowOpen})`);
  ok(/[?&]sec=/.test(after), 'the change is recorded in the address', `${before.split('#')[1]} -> ${after.split('#')[1]}`);

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  const afterReload = await page.evaluate((id) => {
    const el = document.getElementById(id);
    return el ? el.querySelector('.sec-head.collapsible').getAttribute('aria-expanded') : 'gone';
  }, target);
  ok(afterReload === nowOpen, 'THE REFRESH KEPT IT — the section is in the same state after a reload',
    `wanted ${nowOpen}, got ${afterReload}`);
  ok(/[?&]sec=/.test(page.url()), '…and the address still carries it, so the place can be shared');

  // Back at its default → the address is clean again (property 2).
  await page.evaluate((id) => document.getElementById(id).querySelector('.sec-head.collapsible').click(), target);
  await page.waitForTimeout(800);
  ok(!/[?&]sec=[^&]/.test(page.url()), 'putting it back leaves a clean address', page.url().split('#')[1]);

  // ---- the two other places the owner named -------------------------------
  console.log('\n3. the Encompass tab and the Draw Center');
  errors.length = 0;
  await page.goto(`${base}?appTab=encompass`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  ok((await page.locator('text=Something went wrong').count()) === 0,
    'a direct link to the Encompass tab renders (no crash)');
  ok(/appTab=encompass/.test(page.url()), '…and the address keeps it through the landing logic');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  ok(/appTab=encompass/.test(page.url()), '…and survives a refresh — the owner\'s "Campus Thinking" case');

  errors.length = 0;
  await page.goto(`${base.replace(/#\/internal\/app\/(.*)$/, '#/internal/app/$1')}/draws`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);
  ok((await page.locator('text=Something went wrong').count()) === 0, 'the Draw Center renders (no crash)');
  ok(errors.filter((e) => !/favicon|Failed to load resource/i.test(e)).length === 0,
    'no runtime errors in the Draw Center', errors.slice(0, 2).join(' | '));

  console.log(`test-file-place-render: ${pass} passed, ${fail} failed`);
  await browser.close();
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]).catch(() => {});
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [bId]).catch(() => {});
  await db.query(`DELETE FROM staff_users WHERE id=$1`, [staffId]).catch(() => {});
  server.close(); await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e.message); process.exit(2); });
