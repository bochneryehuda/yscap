/**
 * PILOT ENGINE — THE RENDER PROOF.
 *
 * `scripts/test-pilot-engine-pure.mjs` proves the WIRING (the routes name the
 * console's own components, the redirect cannot be turned into a phishing link,
 * the sign-in variant keeps the staff panel). None of that is evidence that a
 * browser DRAWS anything: a green Vite build treats an undeclared identifier as
 * a global and emits it verbatim, so the page throws at render and the app's
 * error boundary shows "Something went wrong". This is the half a source guard
 * cannot see.
 *
 * IT DRIVES THE REAL COMMITTED BUNDLE — `web/v2/portal/`, served from a
 * throwaway http server — not a hand-copied mirror of the markup. A mirror
 * proves the two copies agree; only the real bundle proves the shipped thing
 * works.
 *
 * WHAT IT PROVES
 *   · `/portal/#/engine` resolves in the shipped bundle rather than falling
 *     through to the not-found screen;
 *   · `EnginePrivate`'s unauthenticated branch bounces to the STAFF sign-in
 *     (not the borrower one, not a dead end) — the same door, carrying `from`;
 *   · that sign-in draws PILOT ENGINE's own name, and `authVariantFlags` keeps
 *     `staff` true end to end, because the staff-only badge is on the page;
 *   · the console's own door at `/portal/#/internal/login` still says "Internal
 *     console" — one page, two names, neither leaking into the other;
 *   · every word of it is DARK on a LIGHT ground (the `--ink*` trap renders
 *     white on white and a token check cannot see the result);
 *   · and it fits an iPhone 12 with no sideways scroll.
 *
 * WHAT IT DELIBERATELY DOES NOT PROVE, stated rather than implied: the
 * SIGNED-IN engine screens. Those are the identical components already running
 * in the console and they need a server, a session and Long-Term data; standing
 * up a fake one would prove the fake. The render risk that is NEW here is the
 * shell and the sign-in, which is what this drives.
 *
 * ⛔ AND IT IS IN `npm test`. It was written, it passed, and it ran in NO npm
 * script and no CI job — so the half of this feature only a browser can see was
 * guarded by a file nobody executed, which is the "a browser-only harness is
 * unwatched until it is run" trap CLAUDE.md already records. It SKIPs (exit 0)
 * without Chromium, so CI — which has no browser — stays green, and it runs for
 * real on any box that has one.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

let pw = null;
try { pw = require_('/opt/node22/lib/node_modules/playwright'); }
catch { try { pw = require_('playwright'); } catch { pw = null; } }
if (!pw) { console.log('SKIP render-pilot-engine: playwright not available'); process.exit(0); }

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failures++; };
const info = (what) => console.log(`INFO ${what}`);

// --- serve web/v2 exactly as the app does (the SPA lives at /portal/) --------
const WEB = join(ROOT, 'web/v2');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  // Path traversal defence: resolve inside WEB or refuse.
  const raw = decodeURIComponent(String(req.url).split('?')[0]);
  let file = join(WEB, normalize(raw).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403).end('no'); return; }
  if (!existsSync(file) || file.endsWith('/')) file = join(WEB, 'portal/index.html');
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
info(`serving the committed bundle from ${BASE}/portal/`);

const browser = await pw.chromium.launch();

/** Is this colour dark? (relative luminance, WCAG's own formula) */
const lum = (rgb) => {
  const m = String(rgb).match(/(\d+(?:\.\d+)?)/g);
  if (!m || m.length < 3) return null;
  const c = m.slice(0, 3).map((v) => {
    const s = Number(v) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};

const visit = async (page, hash) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.message)));
  await page.goto(`${BASE}/portal/#${hash}`, { waitUntil: 'domcontentloaded' });
  // The SPA mounts asynchronously; wait for it to paint something real.
  await page.waitForFunction(() => document.body && document.body.innerText.trim().length > 20,
    null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  return errors;
};

// ---------------------------------------------------------------------------
// A. THE ENGINE'S FRONT DOOR, on a desktop.
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await visit(page, '/engine');
  const text = (await page.innerText('body')).replace(/\s+/g, ' ');

  ok(errors.length === 0, `A1 the engine address renders with no page error${errors.length ? ` — ${errors[0]}` : ''}`);
  ok(!/Something went wrong/i.test(text),
    'A2 …and does not fall into the error boundary (which is what a ReferenceError looks like)');
  ok(!/not found|page you are looking for/i.test(text),
    'A3 …and the route exists in the SHIPPED bundle rather than falling through to not-found');

  /* Not signed in, so EnginePrivate must bounce to the STAFF door — carrying
     where we were going, which is what makes the page wear the engine's name. */
  ok(/#\/internal\/login/.test(page.url()), `A4 an unauthenticated visitor is sent to the staff sign-in (${page.url().split('#')[1]})`);
  ok(/Pilot Engine/i.test(text), 'A5 …and that page carries the Pilot Engine name');
  ok(/Sign in to Pilot Engine/i.test(text), 'A6 …in its title');
  ok(/usual PILOT account/i.test(text), 'A7 …and says it is the same account as the console');
  ok(!/borrower & staff platform|Live loan status|Secure document vault/i.test(text),
    'A8 …and is NOT the borrower panel');

  /* THE BADGE IS THE ONE THING ONLY `staff` DRAWS, so it is the only proof that
     the staff flag survived the variant end to end. Asserting on the page TEXT
     is not enough and was measured to be not enough: with `staff` false the
     badge vanishes while the title still reads "Sign in to Pilot Engine", so a
     text search for the name passes over a door that has quietly become the
     borrower panel. Assert the ELEMENT. */
  const badge = (await page.$eval('.auth-brand-badge', (el) => el.textContent.trim()).catch(() => null));
  ok(badge === 'Pilot Engine',
    `A8b …and the staff-only badge reads "Pilot Engine" (got ${JSON.stringify(badge)}) — the only thing that proves staff stayed true`);
  ok(/Every board, side by side/i.test(text) && /Straight to the pricer/i.test(text),
    'A9 …and shows the engine ticks, so authVariantFlags reached the render');

  // Sign-in must actually be usable, not just branded.
  const emailBox = await page.$('input[type="email"], input[name="email"]');
  const pwBox = await page.$('input[type="password"]');
  ok(!!emailBox && !!pwBox, 'A10 the real sign-in form is on the page (email + password)');

  // DARK TEXT ON A LIGHT GROUND — the trap a token check cannot see.
  const contrast = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('h1,h2,p,label,button,span,div')) {
      const t = (el.textContent || '').trim();
      if (!t || t.length < 4 || el.children.length) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 6) continue;
      // Walk up for the painted background.
      let bg = 'rgba(0, 0, 0, 0)', n = el;
      while (n && bg === 'rgba(0, 0, 0, 0)') { bg = getComputedStyle(n).backgroundColor; n = n.parentElement; }
      out.push({ text: t.slice(0, 40), color: cs.color, bg });
    }
    return out.slice(0, 120);
  });
  let unreadable = [];
  for (const c of contrast) {
    const lc = lum(c.color); const lb = lum(c.bg);
    if (lc == null || lb == null) continue;
    const ratio = (Math.max(lc, lb) + 0.05) / (Math.min(lc, lb) + 0.05);
    if (ratio < 2.0) unreadable.push(`${JSON.stringify(c.text)} ${c.color} on ${c.bg}`);
  }
  info(`A11 ${contrast.length} text nodes measured for contrast`);
  ok(unreadable.length === 0,
    `A12 no text is invisible against its own background${unreadable.length ? ` — ${unreadable[0]}` : ''}`);

  await page.close();
}

/**
 * A CONTEXT WITH BOTH TOP BANNERS ACTUALLY UP.
 *
 * ⛔ ONE DEFINITION, because two sections need it and the second one is the whole
 * point: a stack measured at 1440 says nothing about a phone, where these bars
 * wrap to two and three lines. Written out twice, the desktop copy and the phone
 * copy would drift and the one that drifted would be the one measuring the case
 * the incident happened in.
 *
 * A STAFF SESSION, because the shell only renders behind the door — an
 * unauthenticated visitor bounces to the sign-in and a geometry check would
 * measure an empty page and pass for the wrong reason. The client reads its actor
 * straight out of the token's payload (`actorFromToken`), so a token with the
 * right shape is enough; nothing server-side is exercised here, which is the
 * point — this is about geometry.
 *
 * BOTH banners are stubbed up. `/api/health` used to be answered `{}` along with
 * everything else, so `useStaleBuild` never fired and exactly ONE bar rendered —
 * which makes "the banners stack rather than covering each other" a statement
 * about a list of one, true of any code at all. A hash that is not the running
 * bundle's is all it takes. Everything else the shell calls is answered emptily
 * so a pending request cannot hold the paint.
 */
async function bothBannersUp(opts) {
  const ctx = await browser.newContext(opts);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const FAKE_STAFF = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: '00000000-0000-4000-8000-000000000001', kind: 'staff', role: 'super_admin',
    exp: Math.floor(Date.now() / 1000) + 3600,
  })}.rendercheck`;
  await ctx.addInitScript(([key, tok]) => {
    try { localStorage.setItem(key, tok); } catch { /* private mode */ }
  }, ['ys_portal_token', FAKE_STAFF]);
  await ctx.route('**/api/staff-view/session', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ active: true, viewing: { name: 'Dana Reed' } }),
  }));
  await ctx.route('**/api/health', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ bundle: 'not-the-running-one' }),
  }));
  const STUBBED = ['/staff-view/session', '/api/health'];
  await ctx.route('**/api/**', (route) => (STUBBED.some((u) => route.request().url().includes(u))
    ? route.fallback()
    : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })));
  return ctx;
}

// ---------------------------------------------------------------------------
// A2. THE BANNERS MUST NOT BURY THE ENGINE'S NAVIGATION.
//     This is here because a source check could not see it and a re-audit
//     MEASURED it: both banners were `position: fixed` at the same top, so they
//     sat on top of each other AND over the sticky header — 52 of its 58 pixels
//     behind a z-1001 bar, taking the lockup, the whole tab row and the "Full
//     system" way out with them. The console survives that because it has a
//     sidebar; the engine's header IS its navigation.
//
//     Driven with a staff-view session STUBBED so the banner actually renders —
//     otherwise this checks the easy case and proves nothing.
// ---------------------------------------------------------------------------
{
  const ctx = await bothBannersUp({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await visit(page, '/engine');
  await page.waitForTimeout(900);

  const geo = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('[data-top-banner]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, h: r.height, text: (el.textContent || '').slice(0, 40) };
    });
    const header = document.querySelector('header');
    const hr = header ? header.getBoundingClientRect() : null;
    // What is actually painted at the middle of the header?
    const hit = hr ? document.elementFromPoint(Math.round(hr.left + hr.width / 2), Math.round(hr.top + hr.height / 2)) : null;
    return {
      bars,
      header: hr ? { top: hr.top, bottom: hr.bottom, h: hr.height } : null,
      hitInsideHeader: !!(hit && header && header.contains(hit)),
    };
  });

  info(`A2a banners: ${geo.bars.map((b) => `${Math.round(b.h)}px@${Math.round(b.top)}`).join(', ') || 'none'}; header at ${geo.header ? Math.round(geo.header.top) : '?'}`);
  ok(geo.bars.length >= 2,
    `A2b BOTH banners really render in this shell — the staff-view bar and the stale-build bar, which is the stack the incident happened in (${geo.bars.length} found)`);
  /* ⛔ AND EACH IS THE BAR IT IS SUPPOSED TO BE. Counting two elements says
     nothing about what they SAY: a re-audit made `StaffViewBanner` return null
     unconditionally and every source gate stayed green, because both shells
     still mounted it and neither kept a copy. A super admin standing inside a
     teammate's console then had no notice and no way out, here and in the
     console at once. This is the half only a render can hold. */
  const barText = geo.bars.map((b) => b.text).join(' | ');
  ok(/You are seeing/.test(barText),
    `A2b1 …the staff-view bar SAYS whose screen this is (${JSON.stringify(barText)})`);
  ok(/PILOT was updated/.test(barText),
    'A2b2 …and the stale-build bar says the tab is running an old build');
  const exitBtn = await page.locator('[data-top-banner] button', { hasText: 'Back to my own screen' }).first();
  ok(await exitBtn.isVisible().catch(() => false),
    'A2b3 …and the way out of somebody else\'s session is on screen, in this shell, not only in the console');

  /* THE BANNERS DO NOT OVERLAP EACH OTHER. Two fixed bars pinned to one top hide
     one another entirely — measured, the stale-build notice was invisible. */
  const overlapping = geo.bars.some((a, i) => geo.bars.some((b, j) => j > i && a.top < b.bottom && b.top < a.bottom));
  ok(!overlapping, 'A2c …and the banners stack rather than covering each other');

  /* AND THEY DO NOT COVER THE HEADER. Both halves: the geometry, and what the
     browser says is actually painted there. */
  const lowestBar = geo.bars.reduce((m, b) => Math.max(m, b.bottom), 0);
  ok(!geo.header || geo.header.top >= lowestBar - 1,
    `A2d …and the header starts below them (header top ${geo.header ? Math.round(geo.header.top) : '?'}, banners end ${Math.round(lowestBar)})`);
  ok(geo.hitInsideHeader,
    'A2e …so the tab row and the "Full system" way out are actually clickable, not painted over');

  /* ── AND ONCE THE PAGE HAS BEEN SCROLLED, WHICH IS THE ONLY STATE THAT
        MATTERS FOR A STICKY HEADER ─────────────────────────────────────────
     At scroll 0 the header sits below the banners because the SHELL pads by
     their measured height — so A2d/A2e pass whatever the header's own `top`
     says. It is only after scrolling that a sticky element pins to its `top`,
     and a re-audit set that to 0 and reproduced the whole buried-navigation
     incident at scroll 600 with every check above still green.

     Two measurements, because they fail differently. The COMPUTED top is
     available whatever the page's height and is what the header will pin to;
     the SCROLLED hit test is the real thing and is only meaningful when the
     document is actually taller than the window, so it is reported honestly
     rather than passing vacuously when it is not. */
  const pinned = await page.evaluate(async () => {
    const header = document.querySelector('header');
    if (!header) return { header: false };
    const topCss = getComputedStyle(header).top;
    const bars = [...document.querySelectorAll('[data-top-banner]')];
    const barsBottom = bars.reduce((m, el) => Math.max(m, el.getBoundingClientRect().bottom), 0);
    const scrollable = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, 600);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = header.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return {
      header: true, topCss, barsBottom, scrollable, scrolled: window.scrollY,
      top: r.top, hitInsideHeader: !!(hit && header.contains(hit)),
    };
  });
  const topPx = parseFloat(pinned.topCss);
  ok(pinned.header && Number.isFinite(topPx) && topPx >= pinned.barsBottom - 1,
    `A2f the header's own sticky offset (${pinned.topCss}) clears the banner stack (${Math.round(pinned.barsBottom)}px)`
    + ' — this is what it pins to once the page moves, and a `top: 0` here buries the engine\'s only navigation');
  if (pinned.scrollable > 200) {
    ok(pinned.hitInsideHeader,
      `A2g …and after scrolling to ${Math.round(pinned.scrolled)} the header is still the thing painted at its own middle`);
  } else {
    info(`A2g the page is not tall enough to scroll here (${Math.round(pinned.scrollable)}px of overflow) — A2f is the measurement that holds`);
  }

  /* ── THE NAVIGATION IS ACTUALLY THERE, AND SO IS THE WAY OUT ────────────
     `test-pilot-engine-pure.mjs` reads `ENGINE_TABS` and now also reads the
     JSX; neither can tell you a browser DREW a tab. A re-audit deleted the
     whole `<nav>` and, separately, the "Full system" button — the only route
     back into the console from this shell — and every suite stayed green over
     a pricing engine with no navigation and no exit. That is the trapped
     shortcut the owner's "same everything" ask rules out, so it is measured
     here, on the real bundle, hit-tested rather than merely queried. */
  const navGeo = await page.evaluate(() => {
    const header = document.querySelector('header');
    const links = [...(header ? header.querySelectorAll('a[href*="#/engine"]') : [])];
    const hitOf = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!(hit && (el === hit || el.contains(hit) || hit.contains(el)));
    };
    const exit = [...(header ? header.querySelectorAll('button') : [])]
      .find((b) => /full system/i.test(b.textContent || ''));
    return {
      tabs: links.map((a) => ({ label: (a.textContent || '').trim(), href: a.getAttribute('href'), hit: hitOf(a) })),
      exit: exit ? { hit: hitOf(exit) } : null,
    };
  });
  info(`A2h tabs: ${navGeo.tabs.map((t) => t.label).join(', ') || 'NONE'}`);
  ok(navGeo.tabs.length >= 5,
    `A2h1 the engine's tab row is really drawn (${navGeo.tabs.length} tabs) — a declared array nothing renders is not navigation`);
  ok(navGeo.tabs.length > 0 && navGeo.tabs.every((t) => t.hit),
    `A2h2 …and every tab is the thing painted at its own middle, under both banners${navGeo.tabs.filter((t) => !t.hit).map((t) => ` — ${t.label} is covered`).join('')}`);
  ok(!!navGeo.exit && navGeo.exit.hit,
    'A2h3 …and the "Full system" way back into the console is on screen and clickable — a shortcut that traps you is not a shortcut');

  await ctx.close();
}

// ---------------------------------------------------------------------------
// B. THE CONSOLE'S OWN DOOR IS UNCHANGED — one page, two names, no bleed.
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await visit(page, '/internal/login');
  const text = (await page.innerText('body')).replace(/\s+/g, ' ');

  ok(errors.length === 0, 'B1 the console sign-in renders with no page error');
  const cbadge = (await page.$eval('.auth-brand-badge', (el) => el.textContent.trim()).catch(() => null));
  ok(cbadge === 'Internal console', `B2 …and its badge still reads "Internal console" (got ${JSON.stringify(cbadge)})`);
  ok(/Staff sign in/i.test(text), 'B3 …with its own title');
  ok(!/Pilot Engine/i.test(text),
    'B4 …and the engine name does NOT leak onto it — landing here directly is the console, which is what it is');
  await page.close();
}

// ---------------------------------------------------------------------------
// C. A DEEPER ENGINE ADDRESS IS BOOKMARKABLE TOO.
// ---------------------------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = await visit(page, '/engine/scenarios');
  const text = (await page.innerText('body')).replace(/\s+/g, ' ');
  ok(errors.length === 0, 'C1 a deeper engine address renders with no page error');
  ok(!/not found|Something went wrong/i.test(text), 'C2 …and resolves rather than falling through');
  ok(/Pilot Engine/i.test(text), 'C3 …and is branded the engine, so the route test is not just the front page');
  await page.close();
}

// ---------------------------------------------------------------------------
// D. AN IPHONE 12. A single pixel of horizontal overflow switches the phone
//    breakpoints OFF and the whole page renders zoomed-out and tiny.
// ---------------------------------------------------------------------------
{
  const iPhone = pw.devices['iPhone 12'];
  const ctx = await browser.newContext({ ...iPhone });
  const page = await ctx.newPage();
  const errors = await visit(page, '/engine');
  const m = await page.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  ok(errors.length === 0, 'D1 the engine door renders on a phone with no page error');
  ok(m.inner === 390, `D2 the layout viewport is the device width (innerWidth ${m.inner}, must be 390)`);
  ok(m.scroll - m.client <= 1, `D3 no sideways scroll (${m.scroll} vs ${m.client})`);

  // The form has to be usable: iOS zooms the page on focus of anything under 16px.
  const small = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll('input, select, textarea')) {
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size && size < 16) bad.push(`${el.type || el.tagName} ${size}px`);
    }
    return bad;
  });
  ok(small.length === 0, `D4 no form control is under 16px, so iOS does not zoom on focus${small.length ? ` — ${small.join(', ')}` : ''}`);
  await ctx.close();
}

// ---------------------------------------------------------------------------
// E. THE SAME STACK, ON A PHONE — the case the wrap was added for, and the one
//    nothing measured.
//
//    A pre-merge audit named this: section A2 measures the banner stack at
//    1440, where neither bar wraps, so the whole reason `flexWrap` is on the
//    engine's in-flow bar — that at 390 its contents would otherwise run off the
//    side, and that the stack is then two and three lines tall rather than one —
//    was asserted by nothing at all. Section D visits the phone with no banners
//    up, which is the easy case. This is both at once: an iPhone 12, both bars
//    rendered, and the engine's only navigation still on screen underneath them.
// ---------------------------------------------------------------------------
{
  const iPhone = pw.devices['iPhone 12'];
  const ctx = await bothBannersUp({ ...iPhone });
  const page = await ctx.newPage();
  const errors = await visit(page, '/engine');
  await page.waitForTimeout(900);

  const geo = await page.evaluate(() => {
    const hitOf = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!(hit && (el === hit || el.contains(hit) || hit.contains(el)));
    };
    const bars = [...document.querySelectorAll('[data-top-banner="1"]')];
    const header = document.querySelector('header');
    const links = [...(header ? header.querySelectorAll('a[href*="#/engine"]') : [])];
    const exit = [...(header ? header.querySelectorAll('button') : [])]
      .find((b) => /full system/i.test(b.textContent || ''));
    /* THE STAFF-VIEW BAR'S OWN BUTTON — the thing `flexWrap` exists for. Without
       the wrap the sentence and the button share one line on a 390px bar and the
       button is pushed past the right edge, which is the way out of somebody
       else's session. */
    const svBar = bars.find((b) => /back to my own screen/i.test(b.textContent || '')) || null;
    const backBtn = svBar ? [...svBar.querySelectorAll('button')]
      .find((x) => /back to my own screen/i.test(x.textContent || '')) : null;
    const svText = svBar ? svBar.querySelector('span') : null;
    const stack = bars.length
      ? { top: Math.min(...bars.map((b) => b.getBoundingClientRect().top)),
        bottom: Math.max(...bars.map((b) => b.getBoundingClientRect().bottom)) }
      : null;
    return {
      inner: window.innerWidth,
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      bars: bars.length,
      stackHeight: stack ? Math.round(stack.bottom - stack.top) : 0,
      headerTop: header ? Math.round(header.getBoundingClientRect().top) : null,
      tabs: links.map((a) => ({ label: (a.textContent || '').trim(), hit: hitOf(a) })),
      exitHit: exit ? hitOf(exit) : null,
      backBtn: backBtn
        ? {
          right: Math.round(backBtn.getBoundingClientRect().right),
          top: Math.round(backBtn.getBoundingClientRect().top),
          hit: hitOf(backBtn),
        }
        : null,
      svTextBottom: svText ? Math.round(svText.getBoundingClientRect().bottom) : null,
    };
  });

  ok(errors.length === 0, 'E1 the engine renders on a phone with both banners up and no page error');
  ok(geo.inner === 390, `E2 the layout viewport is the device width (innerWidth ${geo.inner}, must be 390)`);
  ok(geo.scroll - geo.client <= 1,
    `E3 …with no sideways scroll, banners and all (${geo.scroll} vs ${geo.client})`);
  ok(geo.bars >= 2, `E4 both bars really rendered (${geo.bars}) — one bar makes "they stack" true of any code at all`);
  /* THE STACK IS TALLER THAN TWO SINGLE LINES on a phone, which is the fact the
     shell MEASURES rather than assumes — a constant offset would bury the header
     by ~100px here. It is not, and must not be read as, proof that `flexWrap` is
     doing anything: MEASURED with the wrap removed, the stack is 149px instead of
     168 and this still passes, because the flex items shrink and their text wraps
     internally. E9 is the assertion that bites on the wrap. */
  ok(geo.stackHeight > 80,
    `E5 …and the stack is genuinely two-and-three lines tall here, which is why it is measured (${geo.stackHeight}px; two single lines would be ~74)`);
  ok(geo.headerTop != null && Math.abs(geo.headerTop - geo.stackHeight) <= 2,
    `E6 …and the sticky header starts exactly below the MEASURED stack (header top ${geo.headerTop}, stack ${geo.stackHeight})`);
  ok(geo.tabs.length >= 5 && geo.tabs.every((t) => t.hit),
    `E7 …and every tab is still the thing painted at its own middle${geo.tabs.filter((t) => !t.hit).map((t) => ` — ${t.label} is covered`).join('')}`);
  ok(geo.exitHit === true, 'E8 …and the "Full system" way out is on screen and clickable on a phone');
  /* ⛔ THE WRAP, MEASURED AS THE THING IT ACTUALLY DOES. Not "the button is inside
     the screen" — MEASURED with `flexWrap` removed from the engine's in-flow bar,
     it still is (right edge 376 of 390, squeezed against the sentence). What the
     wrap does is put the way OUT of somebody else's session on its own line
     instead of shrinking it beside the text, which is a property with no magic
     number in it: the button's top sits BELOW the sentence's bottom. That is the
     one assertion here that fails when the wrap goes. */
  ok(!!geo.backBtn && geo.backBtn.hit && geo.backBtn.right <= geo.inner,
    `E9 …and the staff-view bar's "Back to my own screen" is on screen and clickable (right ${geo.backBtn ? geo.backBtn.right : 'MISSING'} of ${geo.inner})`);
  ok(!!geo.backBtn && geo.svTextBottom != null && geo.backBtn.top >= geo.svTextBottom - 1,
    `E10 …on its OWN line under the sentence, which is what the in-flow bar's wrap is for (button top ${geo.backBtn ? geo.backBtn.top : '?'}, sentence bottom ${geo.svTextBottom})`);
  await ctx.close();
}

await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n${failures ? `FAILURES: ${failures}` : 'Pilot Engine renders'}`);
process.exit(failures ? 1 : 0);
