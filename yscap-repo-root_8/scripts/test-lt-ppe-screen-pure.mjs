#!/usr/bin/env node
/**
 * The LT Pricing-engine screen (`app-v2/src/longterm/LtPpe.jsx`) — structural guards.
 *
 * A GREEN VITE BUILD DOES NOT MEAN THE PAGE RENDERS. esbuild treats an undeclared
 * identifier as a global and emits it verbatim, so a component reading a variable
 * nobody passed it builds cleanly and throws `ReferenceError` at render — which the
 * ErrorBoundary turns into the full-screen "Something went wrong". This file guards
 * the classes a build cannot catch:
 *
 *   • every API method the screen calls actually EXISTS on the LT client, and every
 *     path it hits starts /api/lt/ (the one rule that keeps the two products apart);
 *   • the screen is REACHABLE — routed and in the nav (an unrouted screen is the
 *     same bug as an unmounted router);
 *   • no `--ink*` token is used as a text colour. Those tokens are LIGHT paper
 *     colours in this palette, so `color: var(--ink)` renders white-on-white. This
 *     has shipped before, on a whole card;
 *   • the browser's own dialogs are never used (the repo's three guards), AND no RTL/shared
 *     module is imported — the separation gate refused the shared dialog helper, which is
 *     why a finding is settled with an inline form rather than a modal;
 *   • the screen does NOT re-sort the findings. The server's review queue owns
 *     severity and ordering; a second ordering here would be a second definition of
 *     "what to work on first", and the two would drift.
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

const SCREEN = 'app-v2/src/longterm/LtPpe.jsx';
const src = read(SCREEN);
const api = read('app-v2/src/longterm/api.js');
const app = read('app-v2/src/App.jsx');
const layout = read('app-v2/src/components/StaffLayout.jsx');

console.log('LT pricing-engine screen — structural guards');

// ---------------------------------------------------------------------------
// 1) every ltApi.* the screen calls exists, and is an LT path
// ---------------------------------------------------------------------------
{
  const called = [...new Set([...src.matchAll(/ltApi\.([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  ok(called.length > 0, `the screen calls the LT client (${called.length} methods)`);
  for (const m of called) {
    ok(new RegExp(`^\\s*${m}[:(]`, 'm').test(api), `API-${m} exists on ltApi (a missing one builds fine and throws at render)`);
  }
  // and every ppe method routes through the /api/lt prefix helper
  const ppeLines = api.split('\n').filter((l) => /^\s*ppe[A-Z]/.test(l) || /ppe[A-Z][a-zA-Z]*\(/.test(l));
  ok(ppeLines.length > 0, 'the client defines the ppe methods');
  const bad = ppeLines.filter((l) => /lt\(/.test(l) === false && /ltGet|ltPost|ltPut|ltPatch|ltDel/.test(l));
  ok(bad.length === 0, `every ppe call goes through the lt() prefix — never a bare path (${bad.length} offenders)`);
  ok(!/\/api\/(?!lt)/.test(api), 'the LT client names no non-LT endpoint');
}

// ---------------------------------------------------------------------------
// 2) the screen is reachable
// ---------------------------------------------------------------------------
ok(/import\s+LtPpe\s+from\s+'\.\/longterm\/LtPpe\.jsx'/.test(app), 'ROUTE-1 App.jsx imports the screen');
ok(/path="\/internal\/lt\/ppe"[^>]*element=\{<StaffPrivate><LtPpe\s*\/><\/StaffPrivate>\}/.test(app),
  'ROUTE-2 …and routes it at /internal/lt/ppe behind StaffPrivate');
ok(/to="\/internal\/lt\/ppe"/.test(layout), 'ROUTE-3 …and the long-term nav links to it (an unlinked screen is unreachable)');
{
  // it must sit in the LONG-TERM nav block, not the RTL one
  const ltBlock = layout.slice(layout.indexOf('<div className="sb-sec">Long-term</div>'), layout.indexOf('<div className="sb-sec">Main</div>'));
  ok(ltBlock.includes('/internal/lt/ppe'), 'ROUTE-4 …inside the long-term nav block specifically');
}

// ---------------------------------------------------------------------------
// 3) THE WHITE-ON-WHITE TRAP: --ink* is a LIGHT paper colour here
// ---------------------------------------------------------------------------
{
  const inkAsText = [...src.matchAll(/color:\s*['"]?var\(--ink[^)]*\)/g)].map((m) => m[0]);
  ok(inkAsText.length === 0, `INK-1 no --ink* token is used as a text colour (${inkAsText.join(', ') || 'none'})`);
  // and the screen states its own dark values rather than inheriting something unknown
  ok(/const INK = '#141B22'/.test(src), 'INK-2 the screen pins an explicit dark ink');
  ok(/#4B585C/.test(src), 'INK-3 …and an explicit dark muted for secondary text');
}

// ---------------------------------------------------------------------------
// 4) SEPARATION + dialogs: Long-Term imports no RTL code, and never the browser's
//    own dialogs either. The shared dialog helper lives in RTL's folders, so the
//    separation gate refuses it — which is why this screen settles a finding with
//    an INLINE form rather than a modal. Both halves are guarded, because the
//    tempting "fix" for the gate is to reach for window.prompt instead.
// ---------------------------------------------------------------------------
{
  const stripped = src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ok(!/\balert\(/.test(stripped), 'DIALOG-1 no window.alert (it stamps the hosting hostname on our own message)');
  ok(!/window\.confirm\(/.test(stripped), 'DIALOG-2 no window.confirm');
  ok(!/window\.prompt\(/.test(stripped), 'DIALOG-3 no window.prompt');
  // no RTL import of ANY kind — the gate says so too, but a screen-level assertion
  // names the file when it regresses instead of pointing at the whole product
  const rtlImports = [...src.matchAll(/from\s+'\.\.\/(?!longterm\/)[^']+'/g)].map((m) => m[0]);
  ok(rtlImports.length === 0,
    `SEP-1 the screen imports no RTL/shared module (${rtlImports.join(', ') || 'none'})`);
  ok(/rowError/.test(src) && /<textarea/.test(src),
    'SEP-2 …and settles a finding with an inline reason form, so it needs no shared dialog');
}

// ---------------------------------------------------------------------------
// 5) the screen does not re-rank what the server ordered
// ---------------------------------------------------------------------------
{
  ok(!/\.sort\(/.test(src), 'ORDER-1 the screen never sorts — the server\'s review queue owns the order');
  ok(/queue\.items/.test(src), 'ORDER-2 …it renders the server\'s own items array');
  ok(/truncated/.test(src), 'ORDER-3 …and surfaces the truncation flag (no silent cap on screen either)');
}

// ---------------------------------------------------------------------------
// 6) honesty: the states the server distinguishes are shown as different things
// ---------------------------------------------------------------------------
{
  ok(/configured === false/.test(src) && /configured === null/.test(src),
    'HONEST-1 "nothing is set up" and "we could not read the database" render differently');
  ok(/canaryAgreementRate == null/.test(src) || /not measured yet/.test(src),
    'HONEST-2 an unmeasured agreement rate says so rather than showing 0%');
  // The modal is gone, so the cancel-vs-empty distinction it needed is gone with
  // it. What replaced it is the per-ROW concern: two findings must never share a
  // half-typed reason or a refusal, or somebody settles one row on another's note.
  ok(/rowError\[it\.key\]/.test(src) && /setRowError/.test(src),
    'HONEST-3 a refusal is held per finding key, so one row\'s refusal never appears on another');
  ok(/settling === it\.key/.test(src),
    'HONEST-3b …and only the row being settled shows the form (one reason box, never two)');
  ok(/e\.message/.test(src), 'HONEST-4 a refusal shows the SERVER\'s wording, which names the rule that was broken');
}

console.log(`\n${failures === 0 ? 'OFFLINE: all passed' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
