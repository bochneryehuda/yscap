#!/usr/bin/env node
/**
 * The LT Pricing-transparency screen (`app-v2/src/longterm/LtPricingBreakdown.jsx`) —
 * structural guards. A GREEN VITE BUILD DOES NOT MEAN THE PAGE RENDERS: esbuild emits an
 * undeclared identifier verbatim, so a screen calling a client method nobody defined builds
 * cleanly and throws `ReferenceError` at render. This guards the classes a build can't catch:
 *
 *   • every API method the screen calls EXISTS on the LT client and hits a /api/lt/ path;
 *   • the screen is REACHABLE — routed in App.jsx and present in the nav;
 *   • no `--ink*` token is used as a text COLOUR (those are LIGHT paper colours in this
 *     palette, so `color: var(--ink)` renders white-on-white — it has shipped before);
 *   • no RTL / shared module is imported (the separation gate forbids it — Long-Term
 *     starts at zero and imports only its own siblings).
 *
 * Pure: reads source. No DOM, no build, no network.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCREEN = 'app-v2/src/longterm/LtPricingBreakdown.jsx';
const src = read(SCREEN);
const api = read('app-v2/src/longterm/api.js');
const app = read('app-v2/src/App.jsx');
const nav = read('app-v2/src/components/StaffLayout.jsx');

console.log('LT pricing-transparency screen — structural guards\n');

// 1) every ltApi.* it calls exists on the client
{
  const called = [...new Set([...src.matchAll(/ltApi\.([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  ok(called.length > 0, `the screen calls the LT client (${called.length} methods)`);
  for (const m of called) {
    ok(new RegExp(`^\\s*${m}[:(]`, 'm').test(api), `ltApi.${m} exists (a missing one builds fine and throws at render)`);
  }
  ok(/ppeBreakdown:\s*\(body\)\s*=>\s*ltPost\(lt\('\/ppe\/breakdown'\)/.test(api), 'ppeBreakdown posts to /api/lt/ppe/breakdown through the lt() prefix');
}

// 2) reachable — routed + navigable
{
  ok(/LtPricingBreakdown/.test(app) && /path="\/internal\/lt\/ppe\/breakdown"/.test(app), 'the screen is routed at /internal/lt/ppe/breakdown');
  ok(/import LtPricingBreakdown from '\.\/longterm\/LtPricingBreakdown\.jsx'/.test(app), 'the screen is imported in App.jsx');
  ok(/to="\/internal\/lt\/ppe\/breakdown"/.test(nav), 'the screen is in the Long-Term nav (an unrouted/unnavigable screen is an unmounted one)');
}

// 3) no --ink* token used as a text colour (LIGHT paper colours; would render white-on-white)
{
  const bad = [...src.matchAll(/color:\s*['"]?var\(--ink/g)];
  ok(bad.length === 0, `no --ink* token used as a text colour (${bad.length} offenders)`);
}

// 4) imports only its own Long-Term siblings — no RTL / shared crossing
{
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const nonLocal = imports.filter((p) => p !== 'react' && !p.startsWith('./'));
  ok(nonLocal.length === 0, `no non-local import (${nonLocal.join(', ') || 'none'})`);
  ok(!/\.\.\/(?!\.)/.test(src) || !/from\s+['"]\.\.\//.test(src.replace(/from\s+['"]\.\.\/longterm/g, '')), 'no import reaches OUT of longterm/ into RTL');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
