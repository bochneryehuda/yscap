#!/usr/bin/env node
/**
 * THE SAVED-SCENARIOS SCREEN — it renders, and "what moved" is honest.
 *
 * WHY BOTH HALVES. "A green build does NOT mean the page renders": esbuild emits an
 * undeclared identifier verbatim, so a component reading a variable nobody gave it
 * builds cleanly and throws at render, which the ErrorBoundary turns into the
 * full-screen "Something went wrong". That is the FIRST half.
 *
 * The SECOND half is the one that matters more here. This screen's whole reason to
 * exist (D4) is to say what MOVED since a scenario was saved — and every way that
 * sentence can be wrong is a way of telling somebody the market did something it did
 * not do:
 *
 *   · reading the saved figure as a CURRENT one (a saved price, which is the one
 *     thing this feature must never become — PILOT's honest saved price is a term
 *     sheet, stamped and expiring);
 *   · showing a zero, or "nothing has moved", when there is nothing to compare;
 *   · naming a direction without a size, which nobody can act on;
 *   · and comparing two readings of one board rather than two boards.
 *
 * The last is closed structurally rather than by a check: this screen imports the
 * pricing engine's own `buildRateStack` and the save panel's own `boardHeadline`,
 * so today's figure and the saved one are produced by the same two functions.
 * Asserted below as a SOURCE property, because no render can see which function a
 * number came from.
 *
 * NOT covered: the loaded / empty / failed list states, which arrive through
 * `useState` after a fetch that `renderToString` does not run.
 *
 *   node scripts/test-lt-scenarios-screen.mjs
 *
 * LT-only. No DOM, no network, no database.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..');
const appv2 = path.join(repo, 'app-v2');
const require2 = createRequire(path.join(appv2, 'package.json'));

let n = 0; let failures = 0;
const ok = (c, l) => { n += 1; console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures += 1; };

console.log('LT saved scenarios — the screen renders, and "what moved" is honest\n');

// ── the source half runs everywhere, bundler or not ─────────────────────────
const SRC = fs.readFileSync(path.join(appv2, 'src/longterm/LtScenarios.jsx'), 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

{
  ok(/from '\.\/LtScenarioFields\.jsx'/.test(CODE) && /<ScenarioFields\b/.test(CODE)
    && /useScenarioForm\(/.test(CODE),
  'S1 the page mounts the PRICING ENGINE\'S OWN form component — one form, two screens');
  ok(/from '\.\/LtPricer\.jsx'/.test(CODE) && /buildRateStack\(/.test(CODE),
    'S2 …and borrows its flattener rather than reading the vendor payload a second time');
  ok(/from '\.\/LtScenarioSave\.jsx'/.test(CODE) && /boardHeadline\(/.test(CODE),
    'S3 …and the headline it compares against is produced by the function that WROTE it');
  ok(/ltApi\.dscrPrice\(toScenario\(f\)/.test(CODE),
    'S4 a re-run goes through the same door and the same toScenario the engine uses');
  ok(/searchProblem\(f, zip\.status\)/.test(CODE),
    'S5 …behind the same pre-flight, so a scenario that cannot price never costs a vendor call');

  /* ⛔ RESTORING FROM `scenario` INSTEAD OF `form` IS THE SINGLE EASIEST THING TO GET WRONG HERE.
     `toScenario` drops what was not typed — that is what keeps the server the one authority on
     the third figure when somebody types an LTV instead of a loan amount — so restoring from it
     would silently move a person out of LTV mode and re-price a different deal, with every screen
     looking perfectly correct. */
  const openFn = (CODE.match(/const open = \(row\) => \{[\s\S]*?\n  \};/) || [''])[0];
  ok(/row\.form/.test(openFn), 'S6 opening a scenario restores the boxes from what was TYPED');
  ok(!/row\.scenario/.test(openFn),
    'S7 …never from what was SENT — that bag has already dropped the box the person was in');

  ok(!/var\(--ink/.test(SRC),
    'S8 no --ink token is used as a text colour (they are LIGHT paper colours; the names lie)');
}

// ── movementLine + the render need the bundler ──────────────────────────────
let esbuild;
try {
  esbuild = require2('esbuild');
} catch {
  console.log('\nSKIPPED (the rendering half) — esbuild is not installed under app-v2/.');
  console.log('  This is expected on CI: no CI job installs the front end.');
  console.log('  NOT RUN: the first paint, and every `movementLine` case (D4 — what moved).');
  console.log(`  STILL RUN, with no bundler: the ${n} source guards above.`);
  console.log(`\n${failures === 0 ? `OFFLINE: ${n} source guards passed` : `FAILURES: ${failures} of ${n}`}`);
  process.exit(failures ? 1 : 0);
}

const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import LtScenarios, { movementLine } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtScenarios.jsx'))};
import { buildRateStack } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtPricer.jsx'))};
import { boardHeadline } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtScenarioSave.jsx'))};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__LtScenarios = LtScenarios;
globalThis.__movementLine = movementLine;
globalThis.__buildRateStack = buildRateStack;
globalThis.__boardHeadline = boardHeadline;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-scenarios-render-'));
const outfile = path.join(tmp, 'bundle.cjs');
const stubPlugin = {
  name: 'stub-api',
  setup(build) {
    build.onResolve({ filter: /(^|\/)api\.js$/ }, (args) => {
      if (args.importer.includes(path.join('src', 'longterm'))) return { path: 'lt-api-stub', namespace: 'stub' };
      return null;
    });
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_API, loader: 'js' }));
  },
};

try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `S9 the screen bundles at all: ${String(e && e.message).slice(0, 400)}`);
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}
ok(true, 'S9 the screen and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const LtScenarios = globalThis.__LtScenarios;
const movementLine = globalThis.__movementLine;
const buildRateStack = globalThis.__buildRateStack;
const boardHeadline = globalThis.__boardHeadline;

// ── the first paint ─────────────────────────────────────────────────────────
{
  let html = null; let err = null;
  try { html = renderToString(React.createElement(LtScenarios)); } catch (e) { err = e; }
  ok(err === null, `S10 the first paint renders without throwing${err ? ` — ${err.message}` : ''}`);
  ok(typeof html === 'string' && html.length > 0, 'S11 …and produces markup');
  ok(/FICO/i.test(html || '') && /DSCR/i.test(html || ''),
    'S12 …carrying the same scenario fields the pricing engine prices from');
  ok(/Price it today/.test(html || ''), 'S13 …and the re-run, which is what the page is for');
  ok(/not a saved price/i.test(html || ''),
    'S14 …and it says on its face that a scenario is not a saved price');
}

// ── what moved (D4) ─────────────────────────────────────────────────────────
{
  const SAVED = { bestRate: 7.125, programs: 12, lenders: 4, at: '2026-08-01T12:00:00.000Z' };

  ok(movementLine(SAVED, null) === null,
    'S15 with nothing priced today there is no comparison at all — never "unchanged"');

  const none = movementLine(null, { bestRate: 7.0 });
  ok(none && none.tone === 'none' && /nothing to compare/i.test(none.text),
    'S16 a scenario saved without a board says so, rather than showing a change against a zero');

  const down = movementLine(SAVED, { bestRate: 6.875 });
  ok(down && down.tone === 'better' && /down 25\.0 bps/.test(down.text),
    `S17 a fall is named with its SIZE in basis points, not just a direction (${down && down.text})`);
  ok(down && /7\.125%/.test(down.text) && /6\.875%/.test(down.text),
    'S18 …with both figures shown, so nobody has to take the arithmetic on trust');
  ok(down && /since/.test(down.text) && /2026/.test(down.text),
    'S19 …and the DAY the old figure was true — a figure with no "as at" is the saved price this must not become');

  const up = movementLine(SAVED, { bestRate: 7.375 });
  ok(up && up.tone === 'worse' && /up 25\.0 bps/.test(up.text), 'S20 a rise is named the same way');

  const flat = movementLine(SAVED, { bestRate: 7.125 });
  ok(flat && flat.tone === 'flat' && /unchanged/.test(flat.text) && /since/.test(flat.text),
    'S21 an unchanged rate says so, still dated');

  // ⛔ THE TWO READINGS COME FROM ONE PLACE. Proven by running the board through the
  // engine's own flattener and the save panel's own headline — the same two functions
  // this screen imports — so a comparison can never be two readings of one answer.
  const board = buildRateStack([
    { lender: 'A', options: [{ priceBuild: { noteRate: 6.99, price: 99.5 } }] },
    { lender: 'B', options: [{ priceBuild: { noteRate: 7.25, price: 100.1 } }] },
  ]);
  const today = boardHeadline(board);
  const line = movementLine(SAVED, today);
  ok(today && today.bestRate === 6.99 && line && line.tone === 'better' && /13\.5 bps/.test(line.text),
    `S22 a real board compares end to end through the shared functions (${line && line.text})`);
}

console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `FAILURES: ${failures} of ${n}`}`);
process.exit(failures ? 1 : 0);
