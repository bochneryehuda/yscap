#!/usr/bin/env node
/**
 * THE RATIO FILLS ITSELF IN — proven by RUNNING it, not by reading the source.
 *
 * Owner-directed 2026-08-23: *"In order to use the ratio from the calculator, I need to click the
 * button 'Use This Ratio'. I want this to work automatically without a button ... Let's say
 * somebody finished the ratio, and then he clicked interest-only or changed the rate, and then he
 * goes to click the button again. I want to make sure everything works automatically."*
 *
 * ⛔ WHY THIS SUITE EXISTS AT ALL, when `test-lt-dscr-calc.mjs` already proves the arithmetic and
 * `test-lt-pricer-screen-render.mjs` already renders the panel: NEITHER CAN SEE THIS BEHAVIOUR.
 * `renderToString` does not run effects, so the one thing the owner asked for — the answer moving
 * on its own — is invisible to every test in this repo that draws the screen. The only honest way
 * to prove an effect fires is to run it, so this mounts the REAL `DscrCalc` with the REAL
 * `react-dom/client` in a REAL browser and watches what it emits.
 *
 * ⛔ AND WHY IT IS ITS OWN FILE rather than more assertions in the render suite: that suite is
 * built on `renderToString` and needs no browser. Folding a browser into it would make its 84
 * existing checks depend on Chromium being installed, so a machine without one would lose all of
 * them instead of losing these five.
 *
 * SKIPS CLEANLY with no browser (CI has none), the same contract the render suite uses for esbuild.
 * A skip prints what was NOT run, so nobody reads silence as coverage.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const require2 = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appv2 = path.join(ROOT, 'app-v2');

let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; };

console.log('the DSCR ratio fills itself in — run in a real browser\n');

const missing = (what, why) => {
  console.log(`SKIPPED — ${what}`);
  console.log(`  ${why}`);
  console.log('  NOT RUN: that the calculator writes its ratio into the scenario on its own, that it');
  console.log('           re-writes when interest-only or the term moves, that an incomplete');
  console.log('           calculator never clears a ratio, and that it does not write in a loop.');
  process.exit(0);
};

let esbuild; let chromium;
try { esbuild = require2(path.join(appv2, 'node_modules/esbuild')); }
catch { missing('esbuild is not installed under app-v2/', 'This is expected on CI: no CI job installs the front end.'); }
for (const p of ['playwright', '/opt/node22/lib/node_modules/playwright']) {
  try { ({ chromium } = require2(p)); break; } catch { /* try the next */ }
}
if (!chromium) missing('playwright is not available', 'This is expected on CI: no CI job installs a browser.');

/* Bundle the REAL component together with a tiny harness that mounts it, records every ratio it
   emits on `window.__seen`, and exposes a `set()` to change its props — so the test drives the
   same component the screen mounts, not a copy of it. */
const STUB_API = `export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;`;
const entry = `
import React, { useState, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { DscrCalc } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtPricer.jsx'))};

window.__seen = [];
function Harness() {
  const [c, setC] = useState({ rent: '4,000', tax: '500', taxBasis: 'monthly',
    insurance: '1,800', insBasis: 'yearly', hoa: '', rate: '7' });
  const [p, setP] = useState({ loanAmount: 375000, termYears: 30, interestOnly: false });
  // An UNRELATED re-render of the parent — what happens on the real screen every time somebody
  // types in any other box on the form. The ratio must not be re-written by one.
  const [tick, setTick] = useState(0);
  window.__setC = (patch) => setC((s) => ({ ...s, ...patch }));
  window.__setP = (patch) => setP((s) => ({ ...s, ...patch }));
  window.__bump = () => setTick((n) => n + 1);
  window.__tick = tick;
  // The SAME shape the screen uses: a stable receiver that drops a write of the value already held.
  const onRatio = useCallback((v) => { window.__seen.push(v); }, []);
  return React.createElement(DscrCalc, { c, setC, ...p, onRatio });
}
createRoot(document.getElementById('root')).render(React.createElement(Harness));
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-dscr-autofill-'));
const bundle = path.join(tmp, 'app.js');
const stubPlugin = {
  name: 'stub-api',
  setup(build) {
    build.onResolve({ filter: /(^|\/)api\.js$/ }, (args) => (
      args.importer.includes(path.join('src', 'longterm')) ? { path: 'lt-api-stub', namespace: 'stub' } : null));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_API, loader: 'js' }));
  },
};
try {
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile: bundle, platform: 'browser', format: 'iife', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
} catch (e) {
  ok(false, `the calculator bundles for the browser: ${String(e && e.message).slice(0, 300)}`);
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}
fs.writeFileSync(path.join(tmp, 'page.html'),
  '<!doctype html><meta charset="utf-8"><body><div id="root"></div><script src="app.js"></script>');

const browser = await chromium.launch();
const page = await browser.newPage();
const settle = () => page.evaluate(() => new Promise((r) => setTimeout(r, 30)));
const seen = () => page.evaluate(() => window.__seen.slice());
try {
  await page.goto(`file://${path.join(tmp, 'page.html')}`);
  await settle();

  // A1 — the whole point. Nothing was clicked; the answer is already on its way up.
  let s = await seen();
  ok(s.length === 1 && s[0] === '1.27',
    `A1 a complete calculator hands its ratio up with NOTHING pressed (got ${JSON.stringify(s)})`);

  // A2 — no loop. A settled panel must not keep writing.
  await settle(); await settle();
  s = await seen();
  ok(s.length === 1, `A2 …and it stops there — it does not write on every render (${s.length} writes)`);

  // THE EXPECTED FIGURES ARE DERIVED, NOT COPIED FROM A RUN. Each was computed by hand from the
  // owner-confirmed formula and then CUT DOWN — the owner's rule of 2026-08-30, "the DSCR should
  // always be rounded down… so we should never see better" — which is what `dscrCalc` applies and
  // what `test-lt-dscr-calc.mjs` proves over 56 ratios against the tenant's own figure.
  // On $375,000 with $4,000 rent, $500 tax and $1,800 a year insurance ($150 a month):
  //   30-year amortising @7%  P&I 2,494.88  ->  4000 / 3144.88 = 1.2719…  -> 1.27
  //   30-year interest-only   P&I 2,187.50  ->  4000 / 2837.50 = 1.4096…  -> 1.40  (rounding
  //     to nearest would say 1.41 — a cent the property does not earn, which is the rule biting)
  //   40-year amortising @7%  P&I 2,330.37  ->  4000 / 2980.37 = 1.3421…  -> 1.34
  // Reading them off a failing run instead would make this test agree with whatever the code did.

  // A3 — the owner's own case: tick interest-only and the ratio follows, unasked.
  await page.evaluate(() => window.__setP({ interestOnly: true }));
  await settle();
  s = await seen();
  ok(s.length === 2 && s[1] === '1.40',
    `A3 ticking interest-only re-writes it on its own (got ${JSON.stringify(s)})`);

  // A4 — and so does the term, on a fully amortising scenario.
  await page.evaluate(() => window.__setP({ interestOnly: false, termYears: 40 }));
  await settle();
  s = await seen();
  ok(s.length === 3 && s[2] === '1.34',
    `A4 …and so does changing the term (got ${JSON.stringify(s)})`);

  // A5 — the rate, which is the other thing the owner named.
  await page.evaluate(() => window.__setC({ rate: '8' }));
  await settle();
  const before = (await seen()).length;
  ok(before === 4, `A5 …and retyping the target rate (${before} writes in all)`);

  // A6 — AN INCOMPLETE CALCULATOR NEVER WRITES. This is what stops the panel wiping a ratio
  // somebody already has the moment it is opened on an empty form.
  await page.evaluate(() => window.__setC({ rent: '' }));
  await settle();
  s = await seen();
  ok(s.length === before, `A6 an incomplete calculator writes NOTHING — it never clears a ratio (${s.length} writes)`);

  // A7 — and the panel says where the answer went, because an invisible write reads as no write.
  const said = await page.evaluate(() => document.body.innerText);
  ok(!/Use this ratio/i.test(said), 'A7 the button is gone');
  ok(/in the DSCR box above/i.test(await page.evaluate(() => {
    window.__setC({ rent: '4,000' }); return new Promise((r) => setTimeout(() => r(document.body.innerText), 40));
  })), 'A8 …and the panel says where the ratio went instead');

  // A9 — THE HAZARD THE dep-array EXISTS FOR. Typing anywhere else on the form re-renders this
  // panel; if the write were not keyed on the FIGURE it would fire again on every one of those
  // renders and stamp the calculator's answer over a ratio somebody had just typed by hand.
  const settled = (await seen()).length;
  await page.evaluate(() => { window.__bump(); window.__bump(); });
  await settle(); await settle();
  const after = await seen();
  ok(after.length === settled,
    `A9 an unrelated re-render writes nothing — it cannot stamp over a hand-typed ratio (${settled} -> ${after.length})`);
} finally {
  await browser.close();
}

console.log(`\n${failures === 0 ? 'all passed' : `FAILURES: ${failures}`}`);
process.exit(failures ? 1 : 0);
