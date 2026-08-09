/* =====================================================================
   GOOGLE FONTS, CACHED LOCALLY — so a rendered page uses the REAL faces
   ---------------------------------------------------------------------
   The portal loads Fraunces + Hanken Grotesk + Inter from Google. In this
   environment the browser cannot reach them, so every screen renders in a
   fallback face — and a fallback face has DIFFERENT METRICS. Every width
   an audit measures would then be a width the real site never has: boxes
   that fit here would overflow in production and vice versa, so the whole
   measurement would be about the wrong page.

   Outbound HTTPS works through the agent proxy, so the fonts are fetched
   ONCE with curl (which honours HTTPS_PROXY and the CA bundle — no TLS
   verification is weakened anywhere) and replayed to the browser from
   disk. That also makes every run deterministic and removes the network
   stall that made each screen take twelve seconds.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A real Chrome UA — Google serves woff2 only to a browser it recognises,
// and legacy TTF to anything else (different metrics again).
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const curl = (url, out) => {
  execFileSync('curl', ['-sSL', '--max-time', '45', '-A', UA, '-o', out, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  return fs.readFileSync(out);
};

const safe = (u) => u.replace(/[^a-z0-9]+/gi, '_').slice(-120);

/**
 * Fills `dir` with the stylesheets + font binaries the given CSS URLs need.
 * Returns { css: Map<url, string>, files: Map<url, Buffer> }, or null when the
 * fonts cannot be reached — the caller then renders without them and SAYS SO,
 * rather than quietly reporting measurements of the wrong typeface.
 */
export function buildFontCache(cssUrls, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const css = new Map(), files = new Map();
  try {
    for (const url of cssUrls) {
      const f = path.join(dir, safe(url) + '.css');
      const text = (fs.existsSync(f) && fs.statSync(f).size > 0
        ? fs.readFileSync(f)
        : curl(url, f)).toString('utf8');
      if (!/@font-face/.test(text)) throw new Error(`no @font-face in ${url}`);
      css.set(url, text);

      for (const m of text.matchAll(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g)) {
        const fu = m[1];
        if (files.has(fu)) continue;
        const bf = path.join(dir, safe(fu));
        const buf = fs.existsSync(bf) && fs.statSync(bf).size > 0 ? fs.readFileSync(bf) : curl(fu, bf);
        if (!buf.length) throw new Error(`empty font ${fu}`);
        files.set(fu, buf);
      }
    }
    return { css, files };
  } catch (e) {
    console.log(`font cache unavailable (${String(e.message).slice(0, 80)}) — screens will render in fallback faces`);
    return null;
  }
}

/** Replays the cache into a Playwright context. */
export async function serveFonts(ctx, cache) {
  if (!cache) return false;
  await ctx.route('**://fonts.googleapis.com/**', (route) => {
    const url = route.request().url();
    // Google keys the stylesheet on the exact query, so fall back to any
    // cached sheet rather than answering with nothing.
    const body = cache.css.get(url) || [...cache.css.values()].join('\n');
    return route.fulfill({ status: 200, contentType: 'text/css; charset=utf-8', body });
  });
  await ctx.route('**://fonts.gstatic.com/**', (route) => {
    const buf = cache.files.get(route.request().url());
    return buf
      ? route.fulfill({ status: 200, contentType: 'font/woff2', body: buf })
      : route.abort();
  });
  return true;
}

export const FONT_CSS_URLS = [
  'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Hanken+Grotesk:wght@400;500;600;700;800&display=swap',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
];
