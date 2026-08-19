#!/usr/bin/env node
/**
 * LT PPE — the rate-sheet console actually RENDERS.
 *
 * WHY THIS EXISTS, in this repo's own words: "A green `npm run build` does NOT mean the page
 * renders." Vite/esbuild treat an undeclared identifier as a global and emit it verbatim, so a
 * component that reads a variable it was never given BUILDS CLEANLY and then throws at render, which
 * the app's ErrorBoundary turns into the full-screen "Something went wrong" — taking the whole
 * screen down, not just the card. eslint `no-undef` catches the undeclared-identifier half; it
 * cannot catch a component that crashes on the SHAPE of what it is handed, which is the other half
 * and the more likely one here (this card reads a rate-sheet payload with several optional parts).
 *
 * WHAT IS ACTUALLY COVERED, stated exactly, because a test header that lists more than it checks is
 * worse than a thin test — somebody later trusts the header:
 *
 *   · the component and its whole import graph BUNDLE (an unresolved import is caught here);
 *   · the FIRST PAINT renders through react-dom without throwing, and carries the controls that were
 *     unreachable before this card existed;
 *   · the dark-text rule, on the source of every file this card owns;
 *   · the card's own promises, asserted on comment-stripped source — they are conditional branches a
 *     single render cannot reach, and they would otherwise be prose nothing checks;
 *   · that the card is MOUNTED, which is the whole point (a component nothing renders is the same
 *     defect one layer up).
 *
 * NOT covered here: the loaded, failed, empty, draft and published states as RENDERS. They arrive
 * through `useEffect` + fetch, which `renderToString` does not run, and seeding them would mean
 * either stubbing `useState` by call order (fragile the moment a hook is added) or reshaping the
 * component to take initial state it does not otherwise need. Their BEHAVIOUR is pinned by the
 * source guards below and end-to-end by `test-lt-ppe-console-db.js`, which drives the real routes.
 *
 *   node scripts/test-lt-ppe-console-render.mjs
 *
 * LT-only.
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
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; };

// The component imports `./api.js`, which reaches for the browser's fetch at call time only — but it
// is imported at module load, so the whole graph has to bundle. esbuild does that here, with the api
// module replaced by a stub: this test is about RENDERING, and a real fetch would make it about the
// network instead.
const esbuild = require2('esbuild');

const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import RateSheetConsole from ${JSON.stringify(path.join(appv2, 'src/longterm/RateSheetConsole.jsx'))};
globalThis.__render = () => renderToString(React.createElement(RateSheetConsole));
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__Console = RateSheetConsole;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ppe-render-'));
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
    logLevel: 'silent', plugins: [stubPlugin],
    absWorkingDir: appv2,
  });
} catch (e) {
  ok(false, `the console bundles at all: ${String(e && e.message).slice(0, 300)}`);
  console.log(`\n${failures} FAILED of ${n}`);
  process.exit(1);
}
ok(true, 'R0 the console and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const Console = globalThis.__Console;

/** The first paint — the state the component is in before any fetch resolves. */
function renderFirstPaint() {
  return renderToString(React.createElement(Console));
}

// ---- 1. the first paint --------------------------------------------------
{
  let html = null; let err = null;
  try { html = renderFirstPaint(); } catch (e) { err = e; }
  ok(err === null, `R1 the first paint renders without throwing${err ? ` — ${err.message}` : ''}`);
  ok(typeof html === 'string' && html.length > 0, 'R2 …and produces markup');
  ok(/Onboard an investor/.test(html || ''), 'R3 …with the card heading');
  ok(/Add investor/.test(html || '') && /Add program/.test(html || ''),
    'R4 …and both onboarding actions, which is what was unreachable before this card existed');
}

// ---- 2. the dark-text rule -----------------------------------------------
// A `--ink*` token is a LIGHT paper colour in this palette; using one for text renders white on
// white. The rule is repo-wide, so it is asserted on the SOURCE of every file this card owns.
{
  const files = ['src/longterm/RateSheetConsole.jsx', 'src/longterm/ppeStyles.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(appv2, f), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(!/color:\s*['"`]?var\(--ink/.test(stripped), `R5 ${path.basename(f)} never uses a --ink* token as a text colour`);
  }
}

// ---- 3. the promises this card makes, asserted on its source -------------
// These are behaviour a render cannot show (they are conditional branches), and each one is a
// promise in the card's header that would otherwise be prose nothing checks.
{
  const src = fs.readFileSync(path.join(appv2, 'src/longterm/RateSheetConsole.jsx'), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ok(/setInvestors\(null\);\s*setInvestorsError\(/.test(stripped),
    'R6 a FAILED read sets an error rather than an empty list (an empty list reads as "nothing to do")');
  ok(!/ppeRecordAgreement|recordRun/.test(stripped),
    'R7 the card offers NO way to record an agreement run — a typed result would satisfy the gate with nothing compared');
  // PINNED TO THE COMPOSED FORM, not to the name. `grid.problems.length > 0` also appears in the
  // warning line beside the button, so a guard matching the bare expression stayed GREEN when the
  // term was deleted from `disabled` — proven by mutation. The same trap this workstream has now hit
  // three times: a test that matches a NAME is satisfied by any other use of that name.
  ok(/disabled=\{busy \|\| !grid\.rows\.length \|\| grid\.problems\.length > 0\}/.test(stripped),
    'R8 the grid button is DISABLED while any pasted line is unreadable (the composed condition, not just the name)');
  ok(/sheet\.editable/.test(stripped),
    'R9 a published sheet renders read-only rather than offering to rewrite itself');
  ok(/overrideReason\.trim\(\)\.length < 8/.test(stripped),
    'R10 the override needs a real reason before it can be sent');
  ok(/points\(b\.price_milli\)/.test(stripped),
    'R11 milli values are converted before they reach the screen (a raw one prints 101.500 as "101500")');

  // ---- the two checks: both offered, and told apart -----------------------
  // The routes behind these were reachable by code and by nobody. A button is what closes that, and
  // WHICH button is pressed matters: one is free and offline, the other spends a battery at a paid
  // vendor. Pinned to the composed handlers, not to the api method names, which also appear in
  // `api.js`'s own comments.
  ok(/onClick=\{checkCoverage\}/.test(stripped) && /ppeRateSheetCoverage\(sheet\.version\.id\)/.test(stripped),
    'R14 the free cell check is offered, and calls the coverage route');
  ok(/onClick=\{runAgreement\}/.test(stripped) && /ppeRunRateSheetAgreement\(sheet\.version\.id\)/.test(stripped),
    'R15 …and so is the Lender Price measurement, which is what opens the gate without an override');
  ok(/costs a real battery/.test(stripped) || /costs money/.test(stripped),
    'R16 …with the cost of the paid one said out loud beside the free one');
  ok(/await reloadSheet\(sheet\.version\.id\);\s*\}\s*catch \(e\) \{\s*\/\/ A 503/.test(src),
    'R17 a finished run RE-READS the sheet — otherwise the gate line would still say "never measured"');
  ok(/run\.recorded === false/.test(stripped),
    'R18 …and a verdict that did not reach the ledger is shown as such, never as a run that worked');
  ok(/coverage\.scenarios\.errorCount > 0/.test(stripped),
    'R19 a scenario our OWN engine cannot price is surfaced, not inferred from a coverage number');

  // §2.124a — the census. The server has always computed how the generated battery landed and this
  // screen printed only the cell coverage, so an operator could read "every cell reached" off a
  // battery the engine could not decide a single scenario of. All three columns are shown, and the
  // undetermined one is shown SEPARATELY because folding it into either of the others is the exact
  // §2.124 defect one layer up.
  ok(/coverage\.scenarios\.eligible/.test(stripped) && /coverage\.scenarios\.ineligible/.test(stripped),
    'R20 the scenario census is on the screen — how many the sheet priced and how many it declined');
  ok(/coverage\.scenarios\.undetermined/.test(stripped),
    'R21 …including the ones the engine could not decide either way, counted on their own');
  ok(/could not be decided either way/.test(src) || /could not be decided/i.test(src),
    'R22 …named in plain words, so nobody has to know what "undetermined" means to read the number');
  // §2.125 — the screen must not print "reached and applied" either. Reachability is the rule firing;
  // whether the cell moves a price is the smaller number beside it.
  ok(/coverage\.rules\.pricedFired/.test(stripped) && /coverage\.rules\.firedUnpriced/.test(stripped),
    'R24 the screen splits REACHED from SEEN TO MOVE A PRICE — they are two facts and were one number');
  ok(!/reached\s*\n?\s*and applied/.test(src) && !/reached and applied/.test(src),
    'R25 …and it no longer claims the cells were applied, which on the real sheet was true of 41 of 174');
  ok(/still untested/.test(src),
    'R26 …naming the untested ones as untested rather than as a defect in the cell');

  ok(/expected here, not a fault/.test(src),
    'R23 …and worded as NORMAL, because it is: a targeting scenario carries only its own cell\'s facts, '
    + 'so 209 of 261 are undecidable on the real sheet. A true number presented as an alarm is its own defect');
}

// ---- 4. the console is actually MOUNTED on the screen --------------------
// The whole point of this card is that the writers stop being unreachable; a component nothing
// renders would be the same defect one layer up.
{
  const screen = fs.readFileSync(path.join(appv2, 'src/longterm/LtPpe.jsx'), 'utf8');
  ok(/import RateSheetConsole from '\.\/RateSheetConsole\.jsx'/.test(screen), 'R12 LtPpe imports the console');
  // Again the composed form: `{false && <RateSheetConsole />}` matches the bare tag and renders
  // nothing, which is the very defect this assertion exists to catch (proven by mutation). The mount
  // must stand on its own line, unguarded.
  ok(/^\s*<RateSheetConsole\s*\/>\s*$/m.test(screen),
    'R13 …and MOUNTS it UNCONDITIONALLY — a guarded mount renders nothing and the writers stay unreachable');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
