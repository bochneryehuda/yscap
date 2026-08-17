#!/usr/bin/env node
/**
 * The LT scenario-entry screen (`app-v2/src/longterm/LtScenarioEntry.jsx`) — the D28
 * Basic vs Advanced sections. Structural guards, in the style of
 * test-lt-ppe-breakdown-screen.mjs: A GREEN VITE BUILD DOES NOT MEAN THE PAGE RENDERS
 * (esbuild emits an undeclared identifier verbatim, so a screen calling a client method
 * nobody defined builds cleanly and throws `ReferenceError` at render), and no build can
 * see white-on-white text, an unrouted screen, or a hand-kept field list going stale.
 *
 * What this pins:
 *   1. REACHABLE — imported + routed in App.jsx and present in the Long-Term nav, and
 *      every ltApi.* it calls exists on the LT client and hits a /api/lt/ path.
 *   2. MANIFEST-DRIVEN, NOT A HARD-CODED FIELD LIST — the screen source contains NO
 *      field name from the real manifest as a string literal, and it reads all four
 *      manifest sections. This is the guard that matters: a screen that lists the
 *      fields itself compiles, renders, looks right, and silently omits every field
 *      added on the server afterwards.
 *   3. BOTH SECTIONS — Basic draws `core`; Advanced draws `advanced` + `overlay`,
 *      starts COLLAPSED, and has a search box that filters on key and label.
 *   4. NO WHITE-ON-WHITE — no `--ink*` token used as a text colour (those are LIGHT
 *      paper colours in this palette; it has shipped before).
 *   5. NO RTL CROSSING — imports only its own Long-Term siblings.
 *
 * The manifest is read from the SERVER's own builder, never retyped here, so this test
 * cannot drift from the contract it is checking.
 *
 * Pure: reads source + one pure server function. No DOM, no build, no network, no DB.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SCREEN = 'app-v2/src/longterm/LtScenarioEntry.jsx';
const src = read(SCREEN);
const api = read('app-v2/src/longterm/api.js');
const app = read('app-v2/src/App.jsx');
const nav = read('app-v2/src/components/StaffLayout.jsx');

// The real manifest, from the one place it is built.
const dp = require(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'));
const manifest = dp._internals.buildFieldManifest();

console.log('LT scenario entry — Basic vs Advanced (D28) — structural guards\n');

// ---------------------------------------------------------------------------
// 1) reachable, and every client call it makes exists
// ---------------------------------------------------------------------------
{
  ok(/import LtScenarioEntry from '\.\/longterm\/LtScenarioEntry\.jsx'/.test(app), 'the screen is imported in App.jsx');
  ok(/path="\/internal\/lt\/ppe\/scenario"[\s\S]{0,120}?<LtScenarioEntry\b/.test(app), 'the screen is routed at /internal/lt/ppe/scenario');
  ok(/to="\/internal\/lt\/ppe\/scenario"/.test(nav), 'the screen is in the Long-Term nav (an unrouted/unnavigable screen is an unmounted one)');

  const called = [...new Set([...src.matchAll(/ltApi\.([a-zA-Z0-9_]+)\s*\(/g)].map((m) => m[1]))];
  ok(called.length > 0, `the screen calls the LT client (${called.length} method(s))`);
  for (const m of called) {
    ok(new RegExp(`^\\s*${m}[:(]`, 'm').test(api), `ltApi.${m} exists (a missing one builds fine and throws at render)`);
  }
  ok(/dscrFields:\s*\(\)\s*=>\s*ltGet\(lt\('\/dscr\/fields'\)\)/.test(api), 'dscrFields reads the manifest from /api/lt/dscr/fields through the lt() prefix');
}

// ---------------------------------------------------------------------------
// 2) MANIFEST-DRIVEN — the screen carries no field list of its own
// ---------------------------------------------------------------------------
{
  // Strip comments first: the file EXPLAINS the contract in prose, and a guard that
  // read its own explanation would fail on the very design it protects.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const keys = [
    ...manifest.core,
    ...manifest.advanced,
    ...manifest.overlay.map((o) => o.key),
  ];
  ok(keys.length > 20, `the manifest publishes a real field set to check against (${keys.length} fields)`);

  const hardcoded = keys.filter((k) => new RegExp(`(['"\`])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`).test(code));
  ok(hardcoded.length === 0, `no manifest field name appears as a literal in the screen — it is drawn from the manifest, so a server-side addition appears by itself (${hardcoded.join(', ') || 'none'})`);

  // Every published enum value must come from the manifest too — an enum's options
  // hard-coded here would go stale exactly like a field list.
  const enumVals = manifest.overlay.flatMap((o) => (Array.isArray(o.enumValues) ? o.enumValues : []));
  const hardEnum = enumVals.filter((v) => new RegExp(`(['"\`])${String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1`).test(code));
  ok(hardEnum.length === 0, `no published enum value is hard-coded (${hardEnum.join(', ') || 'none'})`);

  // …and it must actually READ each section, or "no literals" would be satisfied by a
  // screen that renders nothing at all.
  ok(/\.core\b/.test(code), 'the screen reads the manifest core section');
  ok(/\.advanced\b/.test(code), 'the screen reads the manifest advanced section');
  ok(/overlay/i.test(code), 'the screen reads the manifest overlay section');
  ok(/\bmeta\b/.test(code), 'the screen reads the manifest meta section (the non-pricing envelope keys, named rather than silently dropped)');

  // The typed controls come from the entry's published metadata, not from the key.
  ok(/enumValues/.test(code), 'enum options are rendered from the entry\'s own published enumValues');
  ok(/\.type\b/.test(code) || /kind/.test(code), 'the control is chosen from the published type');
}

// ---------------------------------------------------------------------------
// 3) the two sections, the collapse, and the search
// ---------------------------------------------------------------------------
{
  ok(/>\s*Basic\s*</.test(src), 'a Basic section is rendered');
  ok(/Advanced \(/.test(src) || />\s*Advanced/.test(src), 'an Advanced section is rendered');

  // Advanced = advanced + overlay, together.
  ok(/\[\s*\.\.\.registry\s*,\s*\.\.\.overlay\s*\]/.test(src), 'Advanced is advanced + overlay (everything that is not core)');

  // Collapsed by default.
  ok(/useState\(false\)[^\n]*collapsed by default/i.test(src) || /openAdvanced[\s\S]{0,80}useState\(false\)/.test(src),
    'the Advanced section starts COLLAPSED');
  ok(/aria-expanded=\{openAdvanced\}/.test(src), 'the Advanced toggle reports its state to assistive tech');

  // A search box that filters on name and label as you type.
  ok(/onChange=\{onSearch\}/.test(src), 'the Advanced section has a search input wired to onChange (filters as you type)');
  ok(/f\.key\.toLowerCase\(\)\.includes\(needle\)/.test(src), 'the filter matches the field NAME');
  ok(/f\.label && f\.label\.toLowerCase\(\)\.includes\(needle\)/.test(src), 'the filter matches the field LABEL');
  ok(/Showing \{filtered\.length\} of \{advanced\.length\}/.test(src), 'the filter says how many of how many are showing (a silent filter hides fields)');

  // Unlimited advanced options: the list scrolls in its OWN container, so the page
  // never scrolls sideways and the section stays usable at any size.
  ok(/overflowY:\s*'auto'/.test(src), 'the advanced list scrolls inside its own container');
  ok(/overflowX:\s*'auto'/.test(src), 'wide content scrolls in its own container, never the page');
}

// ---------------------------------------------------------------------------
// 4) no --ink* token used as a text colour (LIGHT paper colours → white-on-white)
// ---------------------------------------------------------------------------
{
  const bad = [...src.matchAll(/color:\s*['"]?var\(--ink/g)];
  ok(bad.length === 0, `no --ink* token used as a text colour (${bad.length} offender(s))`);
  ok(/#141B22/.test(src) && /#4B585C/.test(src), 'text colours are the explicit PILOT darks');
}

// ---------------------------------------------------------------------------
// 5) no RTL / shared crossing
// ---------------------------------------------------------------------------
{
  const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const nonLocal = imports.filter((p) => p !== 'react' && !p.startsWith('./'));
  ok(nonLocal.length === 0, `no non-local import (${nonLocal.join(', ') || 'none'})`);
  ok(!/from\s+['"]\.\.\//.test(src), 'no import reaches OUT of longterm/ into RTL');
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
