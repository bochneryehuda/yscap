'use strict';
/**
 * CO-BROWSING — THE TWO-BROWSER PROOF ("test like you fly"). Boots the REAL server
 * (Express + the ws hub) against the REAL local Postgres, serves the REAL built
 * bundle, and drives two Chromium contexts through the whole thing exactly as two
 * people would:
 *
 *   GUEST  (a loan officer)   signs in, is asked, presses Accept, later Allow control,
 *                             then takes control back by moving their own mouse.
 *   VIEWER (a super admin)    asks, watches the mirror fill with the guest's page,
 *                             asks to control, types into the guest's real page
 *                             through the mirror, and is refused once control is
 *                             taken back.
 *
 * Every assertion is about what the OTHER browser shows — never about a return
 * value the same side produced. SKIPs (exit 0) without Playwright or DATABASE_URL.
 */
const path = require('path');
const fs = require('fs');
if (!process.env.DATABASE_URL) { console.log('SKIP render-cobrowse-e2e: DATABASE_URL not set'); process.exit(0); }
let pw = null;
try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (_) { try { pw = require('playwright'); } catch (_2) { pw = null; } }
if (!pw) { console.log('SKIP render-cobrowse-e2e: playwright not available'); process.exit(0); }
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.EMAIL_PROVIDER = 'none';

const http = require('http');
const crypto = require('crypto');
const db = require('../src/db');
const C = require('../src/lib/crypto');
const app = require('../src/server');
const hub = require('../src/lib/cobrowse/hub');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const tag = Date.now().toString(36);
const uid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await require('../src/migrate-boot').ensureSchema();
  const bundle = fs.readdirSync(path.join(__dirname, '../web/v2/portal/assets')).filter((f) => /^index-.*\.js$/.test(f));
  ok(bundle.length === 1, `one built bundle is present (${bundle.join(', ')})`);

  await db.query(`DELETE FROM staff_users WHERE email LIKE 'e2e-%@example.test'`).catch(() => {});
  const server = http.createServer(app);
  hub.attach(server);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (role, name) => (await db.query(
    `INSERT INTO staff_users (email, full_name, role, password_hash, is_active, is_external, token_version)
     VALUES ($1,$2,$3,'x',true,false,3) RETURNING id, role, token_version, full_name`,
    [`e2e-${tag}-${name}@example.test`, `${name} ${tag}`, role])).rows[0];
  const sa = await mk('super_admin', 'Viewer');
  const lo = await mk('loan_officer', 'Guest');
  const tok = (u) => C.signJwt({ sub: String(u.id), kind: 'staff', role: u.role, tv: u.token_version || 0, sid: uid() }, 3600);
  const saTok = tok(sa), loTok = tok(lo);
  const api = async (method, p, body, token) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, data };
  };

  const browser = await pw.chromium.launch({ headless: true });
  const errors = { guest: [], viewer: [] };
  const open = async (label, token, hash) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    await ctx.addInitScript((t) => { try { localStorage.setItem('ys_portal_token', t); } catch (_) { /* fine */ } }, token);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors[label].push(String(e && e.message)));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors[label].push(m.text()); });
    // A resource that failed to load is judged by its URL: the live streams (SSE, ws)
    // are reset by every navigation and by the test's own teardown — not a defect.
    // Only a failure on the app's OWN origin is the app's: this sandbox has no route
    // to fonts.googleapis.com, and a blocked third-party font is a fact about the
    // network, not about the page.
    page.on('requestfailed', (rq) => { const u = rq.url(); if (u.startsWith(base) && !/\/api\/events|\/ws\/cobrowse|favicon|manifest/.test(u)) errors[label].push(`${u} → ${(rq.failure() || {}).errorText}`); });
    await page.goto(`${base}/portal/#${hash}`);
    return { ctx, page };
  };

  let guest, viewer;
  try {
    // ── the guest is on the Team screen (a non-admin: the read-only roster) ──
    guest = await open('guest', loTok, '/internal/team');
    await guest.page.waitForSelector('text=Everybody on the YS Capital desk', { timeout: 20000 });
    ok(true, 'the guest (a loan officer) is signed in and on the Team screen');

    // ── the viewer asks ──
    let r = await api('POST', '/api/cobrowse/request', { kind: 'staff', id: lo.id }, saTok);
    ok(r.status === 200, `the viewer asks to co-browse (got ${r.status})`);
    const sid = r.data.session.id;

    // ── the consent prompt appears LIVE on the guest, with the viewer's name; they accept ──
    await guest.page.waitForSelector('text=wants to see your screen', { timeout: 15000 });
    ok(await guest.page.locator('text=wants to see your screen').count() > 0, 'the guest sees "X from YS Capital wants to see your screen" live (SSE)');
    ok(await guest.page.locator(`text=${sa.full_name}`).count() > 0, 'the prompt names the viewer');
    ok(await guest.page.locator('text=it never records the screen itself').count() > 0, 'the prompt states what is kept');
    await guest.page.click('button:has-text("Accept")');
    await guest.page.waitForSelector('text=is watching your screen', { timeout: 10000 });
    ok(true, 'after Accept the red banner says who is watching');
    r = await api('GET', `/api/cobrowse/${sid}`, null, saTok);
    ok(r.data.session.status === 'active', 'the register reads active');

    // ── the viewer opens the mirror and sees the guest's page ──
    viewer = await open('viewer', saTok, `/internal/cobrowse/${sid}`);
    await viewer.page.waitForSelector('text=Watching', { timeout: 20000 });
    const mirrorHas = async (text, ms = 20000) => viewer.page.waitForFunction((t) => {
      const f = document.querySelector('.cobrowse-stage iframe'); const d = f && f.contentDocument;
      return !!(d && d.body && d.body.innerText.includes(t));
    }, text, { timeout: ms }).then(() => true).catch(() => false);
    ok(await mirrorHas('Everybody on the YS Capital desk'), 'the mirror shows the guest\'s Team screen (rrweb snapshot relayed and replayed)');
    ok(await viewer.page.locator('text=Watch-only').count() > 0, 'the viewer is told it is watch-only');

    // ── the guest navigates; the mirror follows ──
    await guest.page.goto(`${base}/portal/#/internal`);
    await guest.page.waitForTimeout(1500);
    const guestText = await guest.page.evaluate(() => document.body.innerText.slice(0, 4000));
    const probe = (guestText.match(/Pipeline|Files|Dashboard/) || [])[0];
    ok(!!probe && await mirrorHas(probe), `after the guest navigates the mirror follows (saw "${probe}")`);

    // ── THE GUEST CAN STILL DO EVERYTHING WHILE WATCHED (the owner's own question) ──
    //    Co-browsing is an observer on top of the app, never a cage: while merely watched,
    //    nothing about the guest's own use may change except the banner. Every action below
    //    is a REAL trusted interaction (Playwright's own keyboard/mouse), not a dispatched
    //    event, so it proves what a person would experience.
    const ownBox = await guest.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).find((i) => i.offsetParent && !i.disabled && !i.readOnly);
      if (!el) return null; el.setAttribute('data-e2e-own', '1'); return true;
    });
    ok(!!ownBox, 'the guest has a text box of their own to work in');
    await guest.page.click('[data-e2e-own="1"]');
    await guest.page.keyboard.type('lakewood');
    ok(await guest.page.evaluate(() => document.querySelector('[data-e2e-own="1"]').value) === 'lakewood',
      'WATCHED: the guest types with their own keyboard and their own text lands (the recorder never intercepts it)');
    ok(await guest.page.evaluate(() => document.activeElement === document.querySelector('[data-e2e-own="1"]')),
      'WATCHED: focus stays where the guest put it — nothing steals it');
    // Nothing may be pinned, frozen or made unclickable while watching.
    const free = await guest.page.evaluate(() => {
      const cs = getComputedStyle(document.body); const hs = getComputedStyle(document.documentElement);
      return { pe: cs.pointerEvents, sel: cs.userSelect || cs.webkitUserSelect, bodyOv: cs.overflow, htmlOv: hs.overflow, controlled: document.documentElement.classList.contains('cobrowse-controlled') };
    });
    ok(free.pe !== 'none' && free.sel !== 'none' && !/hidden/.test(free.bodyOv) && !/hidden/.test(free.htmlOv) && !free.controlled,
      `WATCHED: the page is not locked (pointer-events ${free.pe}, select ${free.sel}, overflow ${free.bodyOv}/${free.htmlOv})`);
    // The banner must not cover a control. Every visible nav link is hit-tested at its centre.
    const covered = await guest.page.evaluate(() => {
      const out = [];
      for (const a of document.querySelectorAll('nav a, header a, .nav a')) {
        const r = a.getBoundingClientRect();
        if (!r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight) continue;
        const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!el || !(el === a || a.contains(el) || el.contains(a))) out.push((a.textContent || '').trim().slice(0, 24));
      }
      return out;
    });
    ok(covered.length === 0, `WATCHED: the banner covers no navigation control (${covered.length ? covered.join(', ') : 'all reachable'})`);
    // A real click on a real link still navigates.
    const navText = await guest.page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('nav a, .nav a')).find((x) => x.offsetParent && /#\//.test(x.getAttribute('href') || '') && !/\/internal$/.test(x.getAttribute('href') || ''));
      if (!a) return null; a.setAttribute('data-e2e-nav', '1'); return (a.textContent || '').trim();
    });
    if (navText) {
      const before = guest.page.url();
      await guest.page.click('[data-e2e-nav="1"]');
      await guest.page.waitForTimeout(1200);
      ok(guest.page.url() !== before, `WATCHED: a real click on "${navText}" navigates the guest's own app`);
    } else ok(true, 'WATCHED: (no second nav link on this screen to click — skipped)');
    // Scrolling is the guest's own.
    await guest.page.evaluate(() => { document.body.style.minHeight = '3000px'; });
    await guest.page.mouse.wheel(0, 600);
    await guest.page.waitForTimeout(300);
    ok(await guest.page.evaluate(() => window.scrollY) > 0, 'WATCHED: the guest can scroll their own page');
    await guest.page.evaluate(() => { window.scrollTo(0, 0); document.body.style.minHeight = ''; });
    // And the session is still live after all of it.
    r = await api('GET', `/api/cobrowse/${sid}`, null, saTok);
    ok(r.data.session.status === 'active', 'WATCHED: the session is still live after the guest worked normally');
    await guest.page.goto(`${base}/portal/#/internal/team`);
    await guest.page.waitForSelector('text=Everybody on the YS Capital desk', { timeout: 20000 });

    // ── the viewer asks for control; the guest sees the second prompt and allows ──
    await viewer.page.click('button:has-text("Ask to control")');
    await guest.page.waitForSelector('text=asks to control your screen', { timeout: 15000 });
    ok(true, 'the guest sees the second consent prompt');
    ok(await guest.page.locator('text=Move your mouse or press Stop').count() > 0, 'it says how to take control back');
    await guest.page.click('button:has-text("Allow control")');
    await viewer.page.waitForSelector('text=You are in control', { timeout: 15000 });
    ok(true, 'the viewer is told they are in control');
    await guest.page.waitForSelector('text=is controlling your screen', { timeout: 10000 });
    ok(await guest.page.evaluate(() => document.documentElement.classList.contains('cobrowse-controlled')), 'the guest page carries the red controlled frame');

    // ── the viewer types into the guest's REAL page through the mirror ──
    const target = await guest.page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('input[type="text"], input[type="search"], input:not([type])')).find((i) => i.offsetParent && !i.disabled && !i.readOnly);
      if (!el) return null;
      el.setAttribute('data-e2e-target', '1');
      return { placeholder: el.placeholder || '', id: el.id || '' };
    });
    ok(!!target, `the guest's page has a drivable text box (${target && (target.placeholder || target.id || 'unnamed')})`);
    // Start from empty: a hash navigation does not reload a HashRouter app, so this is the
    // same box the guest typed their own search into a moment ago.
    await guest.page.evaluate(() => {
      const el = document.querySelector('[data-e2e-target="1"]');
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await guest.page.waitForTimeout(400);
    // Wait for the attribute to reach the mirror, then find the same element there.
    ok(await viewer.page.waitForFunction(() => {
      const f = document.querySelector('.cobrowse-stage iframe'); const d = f && f.contentDocument;
      return !!(d && d.querySelector('[data-e2e-target="1"]'));
    }, null, { timeout: 15000 }).then(() => true).catch(() => false), 'the mirror carries the same box');
    // A REAL mouse and a REAL keyboard on the viewer — the capture relays only trusted
    // events (a dispatched one is the replayer painting the mirror, and echoing those back
    // wipes the guest's own box), so a person's own hands are what this must be driven by.
    const box = await viewer.page.evaluate(() => {
      // The replayer SCALES the mirror to fit the stage, so a point inside the replayed
      // document is not a point on this screen until it is multiplied by that scale. Reading
      // the two rects and adding them (the obvious version) aims at a different element
      // entirely — this drive clicked the page header and reported typing as broken.
      const f = document.querySelector('.cobrowse-stage iframe');
      const fr = f.getBoundingClientRect();
      const scale = f.offsetWidth ? fr.width / f.offsetWidth : 1;
      const d = f.contentDocument;
      const el = d.querySelector('[data-e2e-target="1"]'); const r = el.getBoundingClientRect();
      return { x: fr.left + (r.left + r.width / 2) * scale, y: fr.top + (r.top + r.height / 2) * scale, scale };
    });
    await viewer.page.mouse.click(box.x, box.y);
    await viewer.page.waitForTimeout(200);
    await viewer.page.keyboard.type('hello', { delay: 40 });
    ok(true, 'the viewer clicked and typed on the mirror with a real mouse and keyboard');
    const landed = await guest.page.waitForFunction(() => { const el = document.querySelector('[data-e2e-target="1"]'); return el && el.value === 'hello'; }, null, { timeout: 10000 }).then(() => true).catch(() => false);
    ok(landed, 'the guest\'s REAL box now reads "hello" — typed by the viewer through the mirror');
    ok(await guest.page.evaluate(() => !!document.querySelector('[data-cobrowse-block="pointer"]')), 'the controller\'s pointer is drawn on the guest\'s page');

    // ── the guest moves their own mouse: control is taken back ──
    await guest.page.mouse.move(300, 300); await guest.page.mouse.move(320, 330);
    await guest.page.waitForSelector('text=is watching your screen', { timeout: 10000 });
    ok(await guest.page.evaluate(() => !document.documentElement.classList.contains('cobrowse-controlled')), 'a real mouse move on the guest takes control back (frame gone)');
    await viewer.page.waitForSelector('text=Watch-only', { timeout: 10000 });
    ok(true, 'the viewer is back to watch-only');
    r = await api('GET', `/api/cobrowse/${sid}`, null, saTok);
    ok(r.data.session.control.status === 'released' && r.data.session.control.releaseReason === 'guest_moved', `the register says released by guest_moved (got ${r.data.session.control.status}/${r.data.session.control.releaseReason})`);
    // typing again changes nothing
    await viewer.page.keyboard.type('XYZ', { delay: 20 });
    await sleep(800);
    ok(await guest.page.evaluate(() => document.querySelector('[data-e2e-target="1"]').value) === 'hello', 'after take-back the viewer\'s typing no longer reaches the guest');
    // The driver left NOTHING behind: the guest types into that very box with their own
    // keyboard and it works exactly as it did before anybody took control.
    await guest.page.click('[data-e2e-target="1"]');
    await guest.page.keyboard.type('!');
    ok(await guest.page.evaluate(() => document.querySelector('[data-e2e-target="1"]').value) === 'hello!',
      'AFTER TAKE-BACK: the guest types in the same box with their own keyboard and it lands');
    ok(await guest.page.evaluate(() => !document.documentElement.classList.contains('cobrowse-controlled') && getComputedStyle(document.body).pointerEvents !== 'none'),
      'AFTER TAKE-BACK: the red frame is gone and the page is not locked');

    // ── the guest presses Stop: both sides end ──
    await guest.page.click('button:has-text("Stop")');
    await viewer.page.waitForSelector('text=stopped sharing', { timeout: 10000 });
    ok(true, 'the viewer is told the guest stopped sharing');
    ok(await guest.page.locator('text=is watching your screen').count() === 0, 'the guest\'s banner is gone');
    // AFTER STOP the page is exactly the page again — nothing of co-browse is left on it.
    const clean = await guest.page.evaluate(() => ({
      cursor: document.querySelectorAll('[data-cobrowse-block="pointer"]').length,
      controlled: document.documentElement.classList.contains('cobrowse-controlled'),
      pe: getComputedStyle(document.body).pointerEvents,
    }));
    ok(clean.cursor === 0 && !clean.controlled && clean.pe !== 'none',
      `AFTER STOP: no controller pointer, no red frame, page not locked (cursor ${clean.cursor})`);
    await guest.page.click('[data-e2e-target="1"]');
    await guest.page.keyboard.type('?');
    ok(await guest.page.evaluate(() => document.querySelector('[data-e2e-target="1"]').value).then((v) => /\?$/.test(v)),
      'AFTER STOP: the guest carries on working normally');
    r = await api('GET', `/api/cobrowse/${sid}`, null, saTok);
    ok(r.data.session.status === 'ended' && r.data.session.endReason === 'stopped_by_guest' && r.data.session.control.grants === 1 && r.data.session.control.events >= 1,
      `the register: ended by the guest, control given once, ${r.data.session.control.events} input event(s) counted`);

    // ── PHONE WIDTH + LAYERING: the prompt and the banner on an iPhone-12-wide screen, with
    //    a higher overlay open. A request nobody sees expires in 90 s, so the prompt must sit
    //    above every other overlay (a report backdrop is 3000, the address-verification modal
    //    10000) and be tappable at 390px with no sideways scroll. ──
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    await phone.addInitScript((t) => { try { localStorage.setItem('ys_portal_token', t); } catch (_) { /* fine */ } }, loTok);
    const pp = await phone.newPage();
    await pp.goto(`${base}/portal/#/internal/team`);
    await pp.waitForSelector('text=Everybody on the YS Capital desk', { timeout: 20000 });
    ok(await pp.evaluate(() => window.innerWidth) === 390, 'the phone renders at the device width (innerWidth 390)');
    // an overlay the way a report or the address-verification modal draws one
    await pp.evaluate(() => { const d = document.createElement('div'); d.id = 'e2e-overlay'; d.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(20,27,34,.55)'; document.body.appendChild(d); });
    r = await api('POST', '/api/cobrowse/request', { kind: 'staff', id: lo.id }, saTok);
    ok(r.status === 200, `a second request while a 10000-z overlay is open (got ${r.status})`);
    const sid2 = r.data.session.id;
    await pp.waitForSelector('button:has-text("Accept")', { timeout: 15000 });
    // The sheet SLIDES up (.26 s); geometry is read once it has settled, or the button is
    // measured mid-animation, 20px below the screen — a fact about the timing, not the page.
    await pp.waitForFunction(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /^Accept$/.test(x.textContent.trim())); const r0 = b && b.getBoundingClientRect(); return !!r0 && r0.bottom <= window.innerHeight; }, null, { timeout: 3000 }).catch(() => {});
    const hit = await pp.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /^Accept$/.test(x.textContent.trim()));
      const r0 = b.getBoundingClientRect(); const el = document.elementFromPoint(r0.left + r0.width / 2, r0.top + r0.height / 2);
      const card = b.closest('.cv-modal'); const c = card ? card.getBoundingClientRect() : r0;
      return { onButton: !!el && (el === b || b.contains(el)), rect: [r0.left, r0.top, r0.right, r0.bottom].map(Math.round), card: [c.left, c.top, c.right, c.bottom].map(Math.round), inView: r0.left >= 0 && r0.right <= window.innerWidth && r0.top >= 0 && r0.bottom <= window.innerHeight, over: document.documentElement.scrollWidth - window.innerWidth };
    });
    ok(hit.onButton, 'the Accept button is the element at its own centre — the prompt sits ABOVE a 10000-z overlay');
    ok(hit.inView && hit.over <= 0, `the prompt fits the phone (button ${hit.rect.join(',')}, card ${hit.card.join(',')} in 390×844; sideways overflow ${hit.over}px)`);
    await pp.tap('button:has-text("Accept")');
    await pp.waitForSelector('text=is watching your screen', { timeout: 10000 });
    const stop = await pp.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => /^Stop$/.test(x.textContent.trim()));
      if (!b) return { found: false };
      const r0 = b.getBoundingClientRect(); const el = document.elementFromPoint(r0.left + r0.width / 2, r0.top + r0.height / 2);
      return { found: true, onButton: !!el && (el === b || b.contains(el)), over: document.documentElement.scrollWidth - window.innerWidth };
    });
    ok(stop.found && stop.onButton && stop.over <= 0, 'the watching banner\'s Stop is tappable above the overlay on the phone, no sideways scroll');
    await pp.tap('button:has-text("Stop")');
    r = await api('GET', `/api/cobrowse/${sid2}`, null, saTok);
    ok(r.data.session.status === 'ended', 'the phone session ends on Stop');
    await phone.close();

    const bad = (l) => errors[l].filter((e) => !/favicon|manifest|ResizeObserver|net::ERR_ABORTED|events\?token|EventSource/.test(e));
    ok(bad('guest').length === 0, `no page errors on the guest (${bad('guest').slice(0, 2).join(' | ')})`);
    ok(bad('viewer').length === 0, `no page errors on the viewer (${bad('viewer').slice(0, 2).join(' | ')})`);
  } catch (e) {
    // A thrown Playwright timeout is a FAILURE OF THIS SUITE, reported like one — it used
    // to jump the summary line entirely, so a run that died mid-way printed a stack and
    // nothing else, and read as "the harness produced no output".
    fail++; console.log('FAIL the drive threw:', (e && e.message ? e.message : String(e)).split('\n')[0]);
    if (e && e.stack) console.error(e.stack);
  } finally {
    // Every teardown step is guarded on its own: one that throws must not swallow the rest,
    // and none of them may take the summary down with it.
    for (const step of [
      async () => { guest && await guest.ctx.close(); },
      async () => { viewer && await viewer.ctx.close(); },
      async () => browser.close(),
      async () => db.query(`DELETE FROM cobrowse_sessions WHERE viewer_staff_id=$1 OR watched_staff_id=$2`, [sa.id, lo.id]),
      async () => db.query(`DELETE FROM staff_users WHERE email LIKE $1`, [`e2e-${tag}-%`]),
      async () => server.close(),
    ]) { try { await step(); } catch (_) { /* fine */ } }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
// A hung browser or socket must never stall CI silently: say so and exit non-zero.
const watchdog = setTimeout(() => { console.log('\nFAIL render-cobrowse-e2e: the drive did not finish within 8 minutes'); process.exit(1); }, 8 * 60 * 1000);
main().then(() => clearTimeout(watchdog)).catch((e) => { console.error(e); console.log('\n0 passed, 1 failed'); process.exit(1); });
