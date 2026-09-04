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
 * SKIPs (exit 0) without Chromium, so CI — which has no browser — stays green.
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

await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n${failures ? `FAILURES: ${failures}` : 'Pilot Engine renders'}`);
process.exit(failures ? 1 : 0);
