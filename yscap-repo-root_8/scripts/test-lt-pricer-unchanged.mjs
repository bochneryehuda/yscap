#!/usr/bin/env node
/**
 * THE GENERAL PRICING ENGINE STILL RENDERS EXACTLY WHAT IT RENDERED — the safety net under the
 * un-forking of the Combined Pricing Engine.
 *
 * WHY THIS EXISTS. The owner asked for the combined engine to stop being a 2,900-line COPY of the
 * general one and to SHARE its code instead: *"It will not even be a copy. It should just share the
 * code of the general pricing engine. If we enhance the general pricing engine, this should also
 * enhance it, but it shouldn't touch the general pricing engine."*
 *
 * Sharing means the general engine's own file changes — you cannot share code without both sides
 * pointing at the shared thing. So the standing rule *"Don't touch our current setup that we
 * currently have: our General Pricing Engine"* becomes a property that has to be PROVEN rather than
 * promised: its BEHAVIOUR must not move, whatever the source now looks like.
 *
 * WHAT IT DOES. `scripts/fixtures/lt-pricer-baseline.jsx` is a byte copy of `LtPricer.jsx` as it
 * stood immediately before the un-forking (commit f3ed2a0). This bundles BOTH that baseline and the
 * live screen in one pass, renders each through react-dom/server with IDENTICAL props — driven by
 * the same real captured Lender Price answer the sibling render suite uses — and compares the
 * produced HTML BYTE FOR BYTE.
 *
 * ⛔ IT IS A REFACTOR PROOF, NOT A STANDING GUARD, AND THAT IS DELIBERATE. The baseline is a frozen
 * artifact, so the moment main legitimately changes the general engine this file starts failing for
 * the RIGHT reason and the wrong purpose. It exists to make the un-forking safe to land and is to
 * be DELETED with its fixture once it has, with the measured result recorded in the commit. Do not
 * "fix" a failure here by re-stamping the baseline — that would turn a proof into a rubber stamp.
 * The properties that must hold FOREVER live in scripts/test-lt-pricer-shared.mjs instead.
 *
 * ⛔ AND IT COMPARES A RENDER, NOT A SOURCE. A source fingerprint (which is what the retired fork
 * guard used) cannot tell a refactor from a behaviour change — it fails on both. Rendering is the
 * only comparison that answers the question actually being asked.
 *
 *   node scripts/test-lt-pricer-unchanged.mjs
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
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; };

console.log('The general pricing engine renders exactly what it rendered\n');

let esbuild;
try {
  esbuild = require2('esbuild');
} catch {
  console.log('SKIPPED — esbuild is not installed under app-v2/, so neither screen can be bundled here.');
  console.log('  This is expected on CI: no CI job installs the front end.');
  console.log('  NOT RUN: the whole render-equivalence proof (the first paint and every board');
  console.log('           component, baseline against live, over a real Lender Price answer).');
  console.log('  Run it locally after `npm install` in app-v2/ — it is the gate on the un-forking.');
  process.exit(0);
}

const BASELINE = path.join(repo, 'scripts/fixtures/lt-pricer-baseline.jsx');
if (!fs.existsSync(BASELINE)) {
  ok(false, 'the pinned baseline exists (scripts/fixtures/lt-pricer-baseline.jsx)');
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}

// The baseline has to sit BESIDE the live screen or its own relative imports ('./api.js',
// './LtScenarioFields.jsx', …) resolve against the wrong directory and it would be bundling a
// different program than the one it is standing in for. Written next to it and removed in the
// `finally`; nothing else follows it, because a Vite build only walks the graph from its entry.
const SHADOW = path.join(appv2, 'src/longterm', '__baseline_LtPricer.jsx');

const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const NAMES = ['PriceBuild', 'RateRow', 'IneligibleView', 'CompSwitch', 'ChargeList',
  'buildRateStack', 'toScenario', 'ltvOf', 'InvestorPicker', 'InvestorStripRow', 'SearchStrip'];

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import Live, { ${NAMES.join(', ')} } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtPricer.jsx'))};
import Base, { ${NAMES.map((x) => `${x} as B_${x}`).join(', ')} } from ${JSON.stringify(SHADOW)};
globalThis.__R = React;
globalThis.__render = renderToString;
globalThis.__live = { Screen: Live, ${NAMES.join(', ')} };
globalThis.__base = { Screen: Base, ${NAMES.map((x) => `${x}: B_${x}`).join(', ')} };
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pricer-unchanged-'));
const outfile = path.join(tmp, 'bundle.cjs');
const stubPlugin = {
  name: 'stub-api',
  setup(build) {
    build.onResolve({ filter: /(^|\/)api\.js$/ }, (args) => (
      args.importer.includes(path.join('src', 'longterm')) ? { path: 'lt-api-stub', namespace: 'stub' } : null));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB_API, loader: 'js' }));
  },
};

let built = false;
try {
  fs.copyFileSync(BASELINE, SHADOW);
  await esbuild.build({
    stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
    bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
    logLevel: 'silent', plugins: [stubPlugin], absWorkingDir: appv2,
  });
  built = true;
} catch (e) {
  ok(false, `both screens bundle: ${String(e && e.message).slice(0, 500)}`);
} finally {
  try { fs.unlinkSync(SHADOW); } catch { /* it may never have been written */ }
}
if (!built) { console.log(`\nFAILURES: ${failures}`); process.exit(1); }
ok(true, 'E0 the baseline and the live screen both bundle');

require2(outfile);
const R = globalThis.__R;
const render = globalThis.__render;
const live = globalThis.__live;
const base = globalThis.__base;

const cap = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/fixtures/lt-pricer-live-capture.json'), 'utf8'));
const programs = cap.programs || (cap.board && cap.board.programs) || [];

/** Render the same element from both builds and compare the markup byte for byte. */
const same = (label, make, props) => {
  let a; let b;
  try { a = render(R.createElement(make(base), props)); } catch (e) { a = `THREW: ${e.message}`; }
  try { b = render(R.createElement(make(live), props)); } catch (e) { b = `THREW: ${e.message}`; }
  const equal = a === b;
  if (!equal) {
    let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
    console.log(`        first difference at character ${i}:`);
    console.log(`          baseline …${a.slice(Math.max(0, i - 60), i + 90)}`);
    console.log(`          live     …${b.slice(Math.max(0, i - 60), i + 90)}`);
  }
  ok(equal, label);
  return equal;
};

// 1) THE FIRST PAINT — the whole screen, which is what a staffer sees before a price comes back.
same('E1 the first paint is byte-identical', (m) => m.Screen, {});

// 2) THE BOARD, over the REAL captured answer. renderToString does not run effects, so the loaded
//    board is reached by rendering its components directly with the same props the screen gives
//    them — which is also how the sibling render suite covers this.
const stackL = live.buildRateStack(programs);
const stackB = base.buildRateStack(programs);
/* ⛔ EVERY FIELD THE BASELINE HAD IS UNCHANGED — a SUPERSET check, not equality, and the reason is
   stated rather than being a convenient loosening. The un-forking adds `stalenessUnknown` to each
   quote, read straight off the option the server built. Lender Price always states whether its
   sheet is expired, so that field is false on every row of the general board and nothing there
   draws differently. Equality would fail on an addition that provably changes nothing; dropping
   the check would miss a changed VALUE. So: every baseline field must still hold its baseline
   value, and the additions must be inert — asserted separately below, on the real answer. */
{
  const seen = (o) => JSON.stringify(o);
  const trimmed = JSON.parse(JSON.stringify(stackL));
  const keysOf = (o) => Object.keys(o || {});
  const prune = (liveObj, baseObj) => {
    for (const k of keysOf(liveObj)) {
      if (!keysOf(baseObj).includes(k)) { delete liveObj[k]; continue; }
      if (liveObj[k] && typeof liveObj[k] === 'object' && baseObj[k] && typeof baseObj[k] === 'object') {
        prune(liveObj[k], baseObj[k]);
      }
    }
  };
  prune(trimmed, stackB);
  ok(seen(trimmed) === seen(stackB),
    `E2 every field the rate stack already had is unchanged (${stackL.rateCount} rates, ${stackL.quoteCount} quotes)`);
  const added = [];
  const collect = (liveObj, baseObj, path) => {
    for (const k of keysOf(liveObj)) {
      if (!keysOf(baseObj).includes(k)) { added.push([`${path}${k}`, liveObj[k]]); continue; }
      if (liveObj[k] && typeof liveObj[k] === 'object' && baseObj[k] && typeof baseObj[k] === 'object') {
        collect(liveObj[k], baseObj[k], `${path}${k}.`);
      }
    }
  };
  collect(JSON.parse(JSON.stringify(stackL)), stackB, '');
  const live_ = added.filter(([, v]) => v !== false && v !== null && v !== undefined);
  ok(live_.length === 0,
    `E2a …and every field it GAINED is inert on a Lender Price answer (${added.length} added, `
    + `${live_.length ? live_.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ') : 'all false/absent'})`);
}

const COMPS = [
  { mode: 'raw', waive: false }, { mode: 'borrower', waive: false },
  { mode: 'lender', waive: false }, { mode: 'lender', waive: true },
];
let rows = 0;
for (const row of stackL.rates) {
  for (const comp of COMPS) {
    for (const open of [false, true]) {
      same(`E3 rate row ${row.key} · ${comp.mode}${comp.waive ? '+waived' : ''}${open ? ' · open' : ''}`,
        (m) => m.RateRow,
        { row, open, onToggle() {}, openQuote: open ? (row.best && row.best.key) : null,
          onOpenQuote() {}, openLenders: new Set(), onToggleLender() {},
          loanAmount: 375000, comp, ts: null, housing: null });
      rows += 1;
    }
  }
}
ok(rows > 0, `E3 …over every rate row on the real answer (${rows} renders)`);

for (const row of stackL.rates) {
  for (const q of (row.quotes || [])) {
    same(`E4 breakdown ${q.key}`, (m) => m.PriceBuild, { o: q.option, comp: COMPS[0], ts: null, quote: q });
  }
}

// 3) A STRIPPED-DOWN OPTION — what a partial vendor answer looks like. It must degrade identically.
same('E5 an empty option degrades identically', (m) => m.PriceBuild, { o: {}, comp: COMPS[0] });
same('E5a a null option degrades identically', (m) => m.PriceBuild, { o: null, comp: COMPS[0] });

// 4) THE PIECES THE SCREEN DRAWS AROUND THE BOARD.
same('E6 the compensation switch', (m) => m.CompSwitch,
  { mode: 'lender', onMode() {}, waive: true, onWaive() {}, planProblem: null });
same('E7 the search strip', (m) => m.SearchStrip,
  { chips: [{ k: 'ZIP', v: '06001' }], counts: '3 rates · 3 quotes', collected: null,
    pricedAt: '10:00:00', stale: false, busy: false, onEdit() {}, onReprice() {},
    view: 'priced', onView() {}, dqLabel: 'Ineligible', compProps: { mode: 'raw' }, invRow: null });
const roster = [{ key: 'a', investor: 'A', whiteLabel: 'Alpha', programCount: 2 },
  { key: 'b', investor: 'B', whiteLabel: null, programCount: 1 }];
same('E8 the investor picker', (m) => m.InvestorPicker,
  { roster, fullRoster: roster, sel: null, onSel() {}, groups: [], onApplyGroup() {}, hidden: 0 });
same('E9 the investor strip row', (m) => m.InvestorStripRow,
  { roster, fullRoster: roster, sel: null, onSel() {}, groups: [], onApplyGroup() {}, hidden: 0 });
same('E10 the ineligible view', (m) => m.IneligibleView,
  { dq: { status: 'idle', data: null }, onAsk() {}, loanAmount: 375000, comp: COMPS[0], invSel: null });

// 5) THE PURE HELPERS the board is ordered and sized by.
const SC = { purpose: 'purchase', value: '500,000', loan: '375,000', ltv: '75', amountMode: 'loan',
  fico: '760', dscr: '1.25', zip: '06001', state: '', county: '', propertyType: 'sfr', units: '1',
  borrowerType: 'entity', termYears: '30', lockDays: '30', io: false, escrowWaive: false,
  fthb: false, nonWarrantable: false, prepayMonths: '60', prepayStructure: 'stepdown' };
ok(JSON.stringify(base.toScenario(SC)) === JSON.stringify(live.toScenario(SC)),
  'E11 the scenario put on the wire is identical');
ok(JSON.stringify(base.ltvOf(SC)) === JSON.stringify(live.ltvOf(SC)),
  'E12 the LTV it derives is identical');

console.log(failures
  ? `\nFAILURES: ${failures} of ${n} — the general engine's render MOVED. Do not re-stamp the baseline; fix the refactor.`
  : `\nOFFLINE: all ${n} passed — the general engine renders exactly what it rendered.`);
process.exit(failures ? 1 : 0);
