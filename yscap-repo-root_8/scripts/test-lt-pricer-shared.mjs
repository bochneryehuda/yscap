#!/usr/bin/env node
/**
 * ONE PRICING BOARD, DRAWN TWO WAYS — the standing guard over the shared pricer.
 *
 * WHAT THIS REPLACED, AND WHY. The Combined Pricing Engine used to be a 2,900-line COPY of the
 * general screen, watched by a SOURCE FINGERPRINT: a sha256 of `LtPricer.jsx` that failed whenever
 * the general engine moved, so somebody could port the change and re-stamp. That guard did its job
 * — it caught four ports in a fortnight — but it could only ever say "the general engine moved",
 * after the fact, and only if the person re-stamping was honest about having ported the change.
 * The owner ended the arrangement:
 *
 *   "It will not even be a copy. It should just share the code of the general pricing engine. If we
 *    enhance the general pricing engine, this should also enhance it, but it shouldn't touch the
 *    general pricing engine."
 *
 * There is one screen now, so "the copy fell behind" is not a thing that can happen. What CAN still
 * happen is a second copy creeping back, the combined engine reaching into the general one, or the
 * two boards differing somewhere nobody declared. Those are what this holds.
 *
 * ⛔ THE ASSERTION THAT MATTERS MOST IS G1, and it is the one the fingerprint could never make:
 * render the combined screen WITH THE GENERAL ENGINE'S OWN DESCRIPTOR and the two boards come out
 * BYTE-IDENTICAL. That is the whole "it is not a copy" claim, proven rather than promised — every
 * difference between the two boards comes from the descriptor and there is nowhere else for one to
 * hide. A source check cannot express it; a fingerprint least of all.
 *
 *   node scripts/test-lt-pricer-shared.mjs
 *
 * LT-only. No network, no DB, no RTL imports.
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

let bad = 0;
const ok = (cond, label) => { if (cond) console.log(`  ok   ${label}`); else { bad += 1; console.error(`  FAIL ${label}`); } };
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
/** A guard that asserts a phrase is ABSENT must not read the comment explaining its absence. */
const codeOf = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

const general = read('app-v2/src/longterm/LtPricer.jsx');
const combined = read('app-v2/src/longterm/LtCombinedPricer.jsx');
const engine = read('app-v2/src/longterm/pricerEngine.js');
const settings = read('app-v2/src/longterm/LtCombinedSettings.jsx');
const api = read('app-v2/src/longterm/api.js');
const app = read('app-v2/src/App.jsx');
const nav = read('app-v2/src/components/StaffLayout.jsx');

console.log('One pricing board, drawn two ways\n');

console.log('A. there is ONE board, and the combined screen is a mount of it');
{
  const c = codeOf(combined);
  ok(/import \{ PricerScreen \} from '\.\/LtPricer\.jsx'/.test(c)
    && /<PricerScreen/.test(c),
    'A1 the combined screen MOUNTS the shared board rather than declaring one');
  // The whole failure mode this replaced: a second declaration of a shared piece.
  const SHARED = ['PriceBuild', 'RateRow', 'IneligibleView', 'IneligibleBoard', 'SearchStrip',
    'InvestorPicker', 'InvestorStripRow', 'CompSwitch', 'ChargeList', 'buildRateStack', 'ltvOf',
    'toScenario', 'GroupChips', 'InvestorChip', 'MoneyCells', 'Track', 'Row', 'WhiteLabelTag'];
  const redeclared = SHARED.filter((n) => new RegExp(`function ${n}\\s*\\(|const ${n}\\s*=`).test(c));
  ok(redeclared.length === 0,
    `A2 …and re-declares none of the shared board's pieces (${redeclared.length ? `FOUND: ${redeclared.join(', ')}` : `checked ${SHARED.length}`})`);
  // The scenario form is one definition too — this is the defect that sat red for days while the
  // copy carried its own inline form and every `pe-*` id was declared twice.
  ok(!/id="pe-/.test(c),
    'A3 …and declares no scenario field of its own — the shared form owns every `pe-*` id');
  ok(codeOf(combined).split('\n').length < 250,
    `A4 …so the file is a mount and its own two panels, not a board (${codeOf(combined).split('\n').length} code lines)`);
}

console.log('\nB. the general engine still knows nothing about the combined one');
{
  const g = codeOf(general);
  ok(!/combined/i.test(g.replace(/COMBINED_ENGINE/g, '')),
    'B1 LtPricer.jsx names the combined engine nowhere in its code — "don\'t touch our current setup" is a property, not a promise');
  ok(!/ltApi\.combined/.test(g),
    'B2 …and never reaches for the combined door');
  ok(/dscrPrice: \(scenario, opts\) => ltPost\(lt\('\/dscr\/price'\)/.test(api),
    'B3 the general engine\'s price door still posts to /dscr/price — the combined engine got new methods rather than a redirect of the old ones');
  ok(/combinedPrice: \(scenario, opts\) => ltPost\(lt\('\/dscr\/combined\/price'\)/.test(api),
    'B4 …and the combined engine has its own');
  // The default everywhere is the general engine, which is what makes "unchanged" the fallback
  // rather than something each call site has to remember.
  ok(/React\.createContext\(GENERAL_ENGINE\)/.test(codeOf(engine)),
    'B5 a component with no engine above it draws the GENERAL one — the safe default');
}

console.log('\nC. every difference between the two boards is DECLARED');
{
  const e = codeOf(engine);
  const gBlock = (e.match(/export const GENERAL_ENGINE = \{[\s\S]*?\n\};/) || [''])[0];
  const cBlock = (e.match(/export const COMBINED_ENGINE = \{[\s\S]*?\n\};/) || [''])[0];
  ok(gBlock.length > 100 && cBlock.length > 100, 'C0 (located both descriptors)');
  // The combined engine is a set of DIFFERENCES, so a general-engine enhancement reaches it by
  // existing rather than by being ported. That is the whole mechanism.
  ok(/\.\.\.GENERAL_ENGINE/.test(cBlock),
    'C1 the combined engine is the general one PLUS its differences — an enhancement reaches it by existing');
  // FORK 7, and it outlives the fork: an engine under audit must not issue a document a borrower reads.
  ok(/cart: true/.test(gBlock) && /cart: false/.test(cBlock),
    'C2 the combined board has NO term-sheet cart, and the general board still does');
  ok(!/TermSheetPanel|ComparisonStrip|QuoteTermSheetActions|useTermSheetCart|PickBox/.test(codeOf(combined)),
    'C3 …and the combined screen imports no part of the cart at all');
  ok(/lenderCount: true/.test(gBlock) && /lenderCount: false/.test(cBlock),
    'C4 only a board whose door returns a lender count states one');
  ok(/showChecks: false/.test(gBlock) && /showChecks: true/.test(cBlock),
    'C5 the vendor\'s own eligibility checks are shown only where a vendor publishes them');
  ok(/sheetLabel: 'Lender Price'/.test(gBlock) && !/Lender Price/.test(cBlock),
    'C6 the combined board names no vendor — one system');
  ok(/dscrPrice/.test(gBlock) && !/combined/i.test(gBlock),
    'C7 the general engine\'s door in the descriptor is its own and only its own');
}

console.log('\nD. both screens are the super admin\'s alone');
{
  for (const [p, what] of [['/internal/lt/combined', 'the engine'], ['/internal/lt/combined-settings', 'its settings']]) {
    // Escape the slashes by SPLITTING rather than with a regex replace — a heredoc-mangled escape
    // once made this line throw, and a test that CRASHES also "fails" and looks like proof while
    // every later assertion goes unrun.
    const esc = p.split('/').join('\\/');
    ok(new RegExp(`role === 'super_admin'[\\s\\S]{0,400}${esc}"`).test(nav),
      `D1 the nav entry for ${what} renders only for a super admin — hidden rather than shown and refused, because the server answers 404 to everybody else`);
  }
  ok(/\/internal\/lt\/combined"[\s\S]{0,120}LtCombinedPricer/.test(app)
    && /\/internal\/lt\/combined-settings"[\s\S]{0,120}LtCombinedSettings/.test(app),
    'D2 …and both routes are wired to their own screens');
  ok(/\/internal\/lt\/pricer"[\s\S]{0,80}LtPricer/.test(app),
    'D3 …with the general engine\'s own route untouched beside them');
}

console.log('\nE. the settings screen keeps no roster of its own');
{
  const s = codeOf(settings);
  ok(/ltApi\.combinedInvestors\(\)/.test(s) && /ltApi\.combinedSaveInvestors\(/.test(s),
    'E1 it reads the roster from the server and writes the whole map back');
  ok(!/deephaven|oaktree|pennymac|acra|nqm|eresi/i.test(s),
    'E2 …and it names NO investor in its own source — the roster is derived server-side from the one registry');
  ok(/whiteLabelMissing/.test(s) && /never (be )?invented|nothing has been made up/i.test(settings),
    'E3 …and an investor with no client-safe name is shown EMPTY and said out loud, never filled with a guess');
}

console.log('\nG. the two boards, RENDERED — and they differ in exactly the declared ways');
let esbuild;
try { esbuild = require2('esbuild'); } catch { esbuild = null; }
if (!esbuild) {
  console.log('  SKIPPED — esbuild is not installed under app-v2/, so neither board can be rendered here.');
  console.log('            This is expected on CI: no CI job installs the front end.');
  console.log('            NOT RUN: G1 (the two boards are byte-identical on one descriptor) and the');
  console.log('            per-flag render checks. Sections A-E above ran and are the CI cover.');
} else {
  const STUB = 'export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });\nexport default ltApi;\n';
  const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import LtPricer, { PricerScreen } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtPricer.jsx'))};
import LtCombinedPricer, { NearTierFlag, CombinedPanel } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtCombinedPricer.jsx'))};
import { GENERAL_ENGINE, COMBINED_ENGINE } from ${JSON.stringify(path.join(appv2, 'src/longterm/pricerEngine.js'))};
globalThis.__x = { React, renderToString, LtPricer, PricerScreen, LtCombinedPricer, NearTierFlag, CombinedPanel, GENERAL_ENGINE, COMBINED_ENGINE };
`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-shared-'));
  const outfile = path.join(tmp, 'bundle.cjs');
  let built = false;
  try {
    await esbuild.build({
      stdin: { contents: entry, resolveDir: appv2, loader: 'jsx' },
      bundle: true, outfile, platform: 'node', format: 'cjs', jsx: 'automatic',
      logLevel: 'silent', absWorkingDir: appv2,
      plugins: [{ name: 'stub', setup(b) {
        b.onResolve({ filter: /(^|\/)api\.js$/ }, (a) => (a.importer.includes(path.join('src', 'longterm')) ? { path: 's', namespace: 'st' } : null));
        b.onLoad({ filter: /.*/, namespace: 'st' }, () => ({ contents: STUB, loader: 'js' }));
      } }],
    });
    built = true;
  } catch (e) { ok(false, `G0 both screens bundle: ${String(e && e.message).slice(0, 300)}`); }
  if (built) {
    require2(outfile);
    const { React, renderToString, LtPricer, PricerScreen, LtCombinedPricer, NearTierFlag, CombinedPanel, GENERAL_ENGINE, COMBINED_ENGINE } = globalThis.__x;
    const draw = (el) => { try { return renderToString(el); } catch (e) { return `THREW: ${e.message}`; } };

    /* ⛔ THE ONE THE FINGERPRINT COULD NEVER MAKE — and it took two goes to write honestly.
       The obvious version renders `<LtPricer/>` beside `<PricerScreen engine={GENERAL_ENGINE}/>`
       and compares them. That is a TAUTOLOGY: LtPricer IS that call, so it compares a thing to
       itself and would pass on any code at all.

       What is actually worth proving is that the COMBINED engine differs from the general one
       ONLY through fields the general one also has — i.e. only through declared differences. So
       take the combined descriptor and spread the general one OVER it. Every declared difference
       is restored to its general value; anything the combined engine carries that the general one
       does NOT have SURVIVES that spread. If the shared board reads such a field anywhere, this
       render differs from the general board's and this fails. There is nowhere for an undeclared
       difference to hide, which is the entire "it is not a copy" claim. */
    const a = draw(React.createElement(LtPricer));
    const asGeneral = { ...COMBINED_ENGINE, ...GENERAL_ENGINE };
    const b = draw(React.createElement(PricerScreen, { engine: asGeneral }));
    if (a !== b) {
      let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
      console.log(`        first difference at character ${i}:\n          general …${a.slice(Math.max(0, i - 50), i + 80)}\n          shared  …${b.slice(Math.max(0, i - 50), i + 80)}`);
    }
    ok(a === b && a.length > 1000,
      'G1 the COMBINED descriptor with every declared difference restored draws the general board BYTE FOR BYTE — so no difference is undeclared');
    /* …and the board may never branch on WHICH engine it is. That is the one escape hatch the
       spread above cannot close: `engine.key` survives it (both descriptors have a key), so a
       screen reading it could hide a difference in plain sight. Named behaviours, never names. */
    ok(!/engine\.key/.test(codeOf(general)),
      'G1a …and the shared board never asks WHICH engine it is — it reads named behaviours, not names');

    const c = draw(React.createElement(LtCombinedPricer));
    ok(!/THREW/.test(c) && c.length > 1000, 'G2 the combined board renders');
    ok(/Combined Pricing Engine/.test(c) && !/Combined Pricing Engine/.test(a),
      'G3 …under its own name');
    ok(/Under audit/.test(c) && !/Under audit/.test(a),
      'G4 …saying what it is before anything else, which the general board never says');
    ok(/id="pe-fico"/.test(c) && /id="pe-fico"/.test(a),
      'G5 …and both ask for the same loan, from the one shared form');
    /* The board itself is shared, so a field on one is a field on the other BY CONSTRUCTION.
       Counted rather than sampled: a sampled check passes while a field quietly goes missing. */
    const ids = (h) => (h.match(/id="pe-[a-z0-9-]+"/g) || []).sort().join(',');
    ok(ids(a) === ids(b) && ids(a) === ids(c) && ids(a).length > 50,
      `G6 …exactly the same fields, counted (${(ids(a).match(/pe-/g) || []).length} on each)`);

    /* ⛔ THE TWO PANELS THE COMBINED BOARD OWNS, RENDERED WITH DATA. G2 above renders the FIRST
       PAINT, which reaches neither of them — they need an answer, and `renderToString` runs no
       effects. So they were the one part of this file a green render proved nothing about, and
       three undeclared identifiers were sitting in them when this was written (`checkRow`,
       `checkBox`, `LINE`) — a clean build, a clean first paint, and a ReferenceError the moment
       anybody priced. Fixtures are the SERVER's own shapes (src/longterm/pricing/near-tier.js),
       not shapes I imagined: a fixture that stages something else tests a different program than
       the one it claims to. */
    const drew = (el) => { const h = draw(el); return { h, ok: !/^THREW/.test(h) }; };
    const nothing = drew(React.createElement(NearTierFlag, { near: null, onUse() {} }));
    ok(nothing.ok && nothing.h === '', 'H1 the near-tier flag draws NOTHING when there is nothing to say');
    const ltvFlag = drew(React.createElement(NearTierFlag, {
      near: { ltv: { field: 'ltv', current: 75.4, tier: 75, gap: 0.4, source: 'sheet', basis: 'ltv',
        cell: '70.01-75.00%', maxLoan: 340000, reduceBy: 10000,
        message: 'This loan is 0.40 of a point over the 75.00% band. Bringing the loan amount down to $340,000.00 — $10,000.00 less — puts it in the better tier.',
        why: "This investor's own rate sheet states the band as 70.01-75.00%." }, dscr: null },
      onUse() {} }));
    ok(ltvFlag.ok && /340,000/.test(ltvFlag.h) && /<button/i.test(ltvFlag.h),
      'H2 …and on a real LTV tier it states the exact money and puts the change one press away');
    const dscrFlag = drew(React.createElement(NearTierFlag, {
      near: { ltv: null, dscr: { field: 'dscr', current: 1.21, tier: 1.25, gap: 0.04, source: 'stated',
        message: 'The ratio is 0.04 under 1.25. Getting it to 1.25 prices in the better tier.',
        why: 'No ratio band was published on this quote, so this uses the standing tiers.' } },
      onUse() {} }));
    ok(dscrFlag.ok && /1\.25/.test(dscrFlag.h), 'H3 …and on a real DSCR tier it states the ratio');
    const panel = drew(React.createElement(CombinedPanel, {
      hidden: [{ investor: 'Acme', reason: 'switched off in settings' }],
      settings: { off: 1 }, revealed: false, busy: false, onReveal() {} }));
    ok(panel.ok && /switched off/.test(panel.h),
      'H4 the combined panel names what is OFF the board and why — a short board is never a silent one');
    ok(drew(React.createElement(CombinedPanel, {
      hidden: [], settings: {}, revealed: true, busy: false, onReveal() {} })).ok,
      'H5 …and renders once an admin has asked where each row came from');
  }
}

console.log(bad ? `\nFAILURES: ${bad}` : '\nOFFLINE: all passed');
process.exit(bad ? 1 : 0);
