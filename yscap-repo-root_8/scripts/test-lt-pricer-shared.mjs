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
const general_settings = read('app-v2/src/longterm/LtSettings.jsx');
const roster = read('src/longterm/settings/encompass-settings.js');
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
  ok(!/TermSheetPanel|ComparisonStrip|QuoteTermSheetActions|useTermSheetCart|CompareButton|PickBox/.test(codeOf(combined)),
    'C3 …and the combined screen imports no part of the cart at all');
  ok(/lenderCount: true/.test(gBlock) && /lenderCount: false/.test(cBlock),
    'C4 only a board whose door returns a lender count states one');
  ok(/showChecks: false/.test(gBlock) && /showChecks: true/.test(cBlock),
    'C5 the vendor\'s own eligibility checks are shown only where a vendor publishes them');
  ok(/sheetLabel: 'Lender Price'/.test(gBlock) && !/Lender Price/.test(cBlock),
    'C6 the combined board names no vendor — one system');
  // THE DOOR. The general engine asks Lender Price and nothing else — the whole point of the
  // descriptor is that the second engine cannot reach the first one's request.
  ok(/dscrPrice/.test(gBlock) && !/combinedPrice|combinedInvestors/.test(gBlock),
    'C7 the general engine\'s door in the descriptor is its own and only its own');
  // The general block MAY name the combined engine in exactly one place: the settings group it
  // refuses to show. Stated as "every mention is that one" rather than "no mention", because a
  // guard that just banned the word would have to be loosened the first time it was right.
  const combinedMentions = (gBlock.match(/^.*combined.*$/gim) || []).map((l) => l.trim());
  ok(combinedMentions.every((l) => /^settingsHideGroups: \[COMBINED_SETTINGS_GROUP\],$/.test(l)),
    `C7a …and the only thing it says about the combined engine is which of its settings to keep off the general screen (${combinedMentions.length} mention(s))`);
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
  const links = codeOf(read('app-v2/src/longterm/LtInvestorLinks.jsx'));
  ok(/ltApi\.combinedInvestors\(\)/.test(s) && /ltApi\.combinedSaveInvestors\(/.test(s),
    'E1 it reads the roster from the server and writes the whole map back');
  /* ⛔ DERIVED FROM THE REGISTRY, NEVER HAND-MAINTAINED. This was seven names
     typed into a regex, which covers the seven somebody thought of on the day and
     silently stops covering the investor added next week — the exact failure the
     assertion exists to prevent, committed inside the assertion itself. Every
     recorded spelling is swept instead, so the guard grows with the registry. */
  const registry = createRequire(import.meta.url)('../src/longterm/encompass/investors');
  const spellings = [];
  for (const inv of registry.INVESTORS) {
    for (const spelling of [inv.label].concat(inv.aliases || [])) {
      if (String(spelling).length >= 5) spellings.push(String(spelling));
    }
  }
  const namesIn = (code) => spellings.filter((n) => code.toLowerCase().includes(n.toLowerCase()));
  ok(spellings.length >= 100, `E2a there are ${spellings.length} recorded spellings to keep out of the screens`);
  ok(namesIn(s).length === 0,
    `E2 …and the settings screen names NO investor in its own source (${namesIn(s).join(', ') || 'none'}) — the roster is derived server-side from the one effective roster`);
  ok(namesIn(links).length === 0,
    `E2b …nor does the linking screen, which now also carries the form that ADDS one (${namesIn(links).join(', ') || 'none'})`);
  ok(/ltApi\.combinedCustomInvestors\(\)/.test(s) && /ltApi\.combinedSaveCustomInvestors\(/.test(s),
    'E2c the investors added by hand are read and written through the server as well — the browser keeps no copy of them');
  ok(/whiteLabelMissing/.test(s) && /never (be )?invented|nothing has been made up/i.test(settings),
    'E3 …and an investor with no client-safe name is shown EMPTY and said out loud, never filled with a guess');
}

console.log('\nF. ONE settings screen, drawn twice — and the second engine stays out of the first one\'s');
{
  const c = codeOf(settings);
  const g = codeOf(general_settings);
  ok(/import \{ SettingsScreen \} from '\.\/LtSettings\.jsx'/.test(c) && /<SettingsScreen/.test(c),
    'F1 the combined settings screen MOUNTS the shared settings screen rather than being half a screen');
  ok(!/LtLayout/.test(c),
    'F2 …and declares no page frame of its own — one screen, one frame');
  // "All the settings we currently have" is the SERVER's roster, so the only honest way to carry
  // it is to draw the same screen. A list of keys here would be the copy all over again.
  ok(/data\.groups[\s\S]{0,120}settingsHideGroups[\s\S]{0,40}\.includes\(g\.group\)[\s\S]{0,20}\.map\(/.test(g),
    'F3 the shared screen draws every group the server declares, less the ones this engine hides');
  ok(/settingsHideGroups: \[COMBINED_SETTINGS_GROUP\]/.test(engine),
    'F4 the GENERAL screen hides the combined engine\'s group — main declares none of those settings and that screen must not start showing them');
  ok(/settingsHideGroups: \[\]/.test(engine),
    'F5 …and the COMBINED screen hides nothing: it is every setting we have, plus its own');
  // The two halves of one name. A rename on either side and the general screen silently starts
  // showing the second engine's settings — the exact leak F4 exists to stop.
  const declared = (engine.match(/COMBINED_SETTINGS_GROUP = '([^']+)'/) || [])[1];
  const groups = [...roster.matchAll(/key: 'pricing\.[A-Za-z]+', group: '([^']+)'/g)].map((m) => m[1]);
  ok(!!declared && groups.length > 0 && groups.every((x) => x === declared),
    `F6 the group is ONE name on both sides — the screen's '${declared}' and the server's ${groups.length} declaration(s)`);
  // The slot is the combined engine's own panels, which read their own door. This is the
  // difference between "the roster is slow" and "the investor list is gone".
  ok(/const before = \(\) =>/.test(g)
    && (g.match(/<LtLayout title=\{engine\.settingsTitle\}>\{before\(\)\}/g) || []).length === 2,
    'F7 …and a caller\'s own panels are drawn while the roster loads AND when it fails, not blanked by either');
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
import LtCombinedPricer, { CombinedPanel } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtCombinedPricer.jsx'))};
import BoardExplains, { NearTierFlag, NotOnThisBoard } from ${JSON.stringify(path.join(appv2, 'src/longterm/BoardExplains.jsx'))};
import { GENERAL_ENGINE, COMBINED_ENGINE } from ${JSON.stringify(path.join(appv2, 'src/longterm/pricerEngine.js'))};
globalThis.__x = { React, renderToString, LtPricer, PricerScreen, LtCombinedPricer, BoardExplains, NearTierFlag, NotOnThisBoard, CombinedPanel, GENERAL_ENGINE, COMBINED_ENGINE };
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
    const { React, renderToString, LtPricer, PricerScreen, LtCombinedPricer, BoardExplains, NearTierFlag, NotOnThisBoard, CombinedPanel, GENERAL_ENGINE, COMBINED_ENGINE } = globalThis.__x;
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
       Counted rather than sampled: a sampled check passes while a field quietly goes missing.

       ⛔ RE-POINTED 2026-09-01, NOT LOOSENED. The combined engine now declares one control the
       general one does not offer — `amortizationChoice`, the fixed/ARM picker, which exists on that
       board because it decides what comes back from BOTH programs at once and is deliberately kept
       off the general board ("don't touch our current setup"). So the two field sets are no longer
       identical, and asserting that they are would read as a broken feature.

       What is still worth proving, and what is asserted instead, is that the difference comes
       ENTIRELY from that ONE DECLARED FLAG: turn it off on the combined descriptor and the field set
       must be the general board's again, exactly. The id is never typed here — it is derived by
       flipping the declared behaviour — so a SECOND undeclared field appearing on one board still
       fails, and so does a field quietly going missing from either. */
    const idList = (h) => (h.match(/id="pe-[a-z0-9-]+"/g) || []).sort();
    const ids = (h) => idList(h).join(',');
    ok(ids(a) === ids(b) && ids(a).length > 50,
      `G6 …exactly the same fields once every declared difference is restored, counted (${idList(a).length} on each)`);
    const d = draw(React.createElement(PricerScreen, { engine: { ...COMBINED_ENGINE, amortizationChoice: false } }));
    ok(ids(d) === ids(a),
      'G6a …and turning that ONE declared control off puts the combined board back on the general board\'s exact field set — so nothing else about the form differs, and nothing has quietly gone missing');
    const extra = idList(c).filter((x) => !idList(a).includes(x));
    const missing = idList(a).filter((x) => !idList(c).includes(x));
    ok(missing.length === 0 && extra.length === 1,
      `G6b …so the live combined board is the general form plus exactly one declared control (adds ${extra.join(', ') || 'nothing'}; missing ${missing.join(', ') || 'nothing'})`);

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
    const panel = drew(React.createElement(NotOnThisBoard, {
      hidden: [{ investor: 'Acme', reason: 'switched off in settings' }],
      settings: { problems: [] } }));
    ok(panel.ok && /switched off/.test(panel.h),
      'H4 the accounting names what is OFF the board and why — a short board is never a silent one');
    /* ⛔ AND IT PRINTS OUR OWN NAME FOR AN INVESTOR, never the vendor's spelling: `whiteLabel`
       wins wherever one is set, which is the rule every other surface follows. */
    const wl = drew(React.createElement(NotOnThisBoard, {
      hidden: [{ investor: 'NQM Funding', whiteLabel: 'Ruby', reason: 'the rate sheet did not answer' }],
      settings: null }));
    ok(wl.ok && /Ruby/.test(wl.h) && !/NQM/.test(wl.h),
      'H4a …under OUR white label, never the vendor\'s spelling');
    ok(drew(React.createElement(NotOnThisBoard, { hidden: [], settings: {} })).h === '',
      'H4b …and draws NOTHING when there is nothing to account for, which is most boards');
    /* An unreadable SETTING is its own fact and must be said even on a board with nobody hidden —
       the two halves of this panel are independent. */
    const probs = drew(React.createElement(NotOnThisBoard, {
      hidden: [], settings: { problems: ['acra'] } }));
    ok(probs.ok && /could not be/.test(probs.h),
      'H4c …and an unreadable investor setting is said on its own, with nobody hidden');
    ok(drew(React.createElement(CombinedPanel, {
      revealed: true, busy: false, onReveal() {} })).ok,
      'H5 the combined engine keeps its own card — the one control the general board has no concept of');
    /* THE THREE TOGETHER, off ONE answer, which is what both screens actually mount. */
    const all = drew(React.createElement(BoardExplains, {
      res: {
        completeness: { complete: false, message: 'One of the two rate sheets did not answer.' },
        nearTier: null,
        hidden: [{ investor: 'Acme', reason: 'switched off in settings' }],
        settings: null,
      },
      onUseLoan() {},
    }));
    ok(all.ok && /This board is short/.test(all.h) && /switched off/.test(all.h),
      'H6 the shared explainer draws the short-board warning and the accounting off ONE answer');
    ok(drew(React.createElement(BoardExplains, { res: {}, onUseLoan() {} })).h === '',
      'H6a …and draws NOTHING at all on an ordinary whole board');
    ok(drew(React.createElement(BoardExplains, {})).ok,
      'H6b …and cannot throw on an answer that is not there yet');
  }
}

console.log('\nI. the answer comes back FIRST — only what decides whether the board is safe to read sits above it');
{
  /**
   * OWNER-REPORTED 2026-09-03: *"I don't like the way you put it on the search page right after the
   * search instead of coming back right results."* Four panels sat between pressing Price and the
   * prices, and one of them — the live side-by-side that reconciles two spellings of one investor —
   * is not about the answer at all. It changes how the NEXT board is joined.
   *
   * This is the SAME finding the comparison area got on 2026-09-01, when it was measured at
   * 1440x1000 pushing the first rate row to y=810: an officer saw ONE rate on the screen whose whole
   * job is the board.
   *
   * ⛔ A SOURCE GUARD, AND SAID SO. Proving the order by RENDERING would need a priced board, and
   * this suite deliberately stubs the price door with a never-resolving promise, so the screen it
   * draws has no answer and therefore no slots at all. What is pinned instead is the wiring: which
   * slot each panel is mounted in, and where in the shared screen each slot draws. Both are exact,
   * and moving the panel back is precisely what they catch.
   */
  const g = codeOf(general);
  const c = codeOf(combined);

  const strip = g.indexOf('slots.afterStrip({');
  /* ⛔ THE BOARD'S OWN CONDITIONAL, not the first mention of `view === 'priced'` — that one is the
     TAB BUTTON far above, so anchoring on the bare phrase made I1 compare the slot against a
     button and fail on correct code. Matched on the ternary that opens the board (one occurrence,
     asserted), which is the thing the slots are ordered around. */
  const BOARD_ANCHOR = "view === 'priced' ? (";
  ok(g.split(BOARD_ANCHOR).length - 1 === 1, 'I0a the board opens with exactly one such ternary, so the anchor is the board');
  const board = g.indexOf(BOARD_ANCHOR);
  const after = g.indexOf('slots.afterBoard({');
  ok(strip > 0 && board > 0 && after > 0, 'I0 (located the two slots and the board)');
  ok(strip < board, 'I1 the above-the-board slot draws BEFORE the answer');
  ok(after > board, 'I2 …and the after-the-board slot draws AFTER it — which is the whole fix');

  /* The panel the owner was looking at, in the slot that draws after the answer. Matched on the
     MOUNT rather than on the import, because the file imports it either way. */
  const inStrip = c.slice(c.indexOf('afterStrip:'), c.indexOf('afterBoard:'));
  const inBoard = c.slice(c.indexOf('afterBoard:'));
  ok(!/<LtInvestorLinks/.test(inStrip),
    'I3 the live side-by-side is NOT mounted above the board any more');
  ok(/<LtInvestorLinks/.test(inBoard),
    'I4 …it is mounted below it');

  /* What may STAY above, and why each one earns it — a guard that only banned one panel would let
     the next one land there without a reason.

     THE THREE THE OWNER KEPT ABOVE THE BOARD MOVED OUT OF THIS SLOT ON 2026-09-03 and are drawn by
     the SHARED screen, on both engines, the moment the general route started returning them. So
     the placement rule is asserted where it is now enforced — and it is now enforced ONCE rather
     than in each screen that happens to want it. */
  ok(/<CombinedPanel/.test(inStrip),
    'I6 the combined card — the one control the general board has no concept of — stays above the board');
  const gStrip = g.slice(0, g.indexOf('slots.afterStrip('));
  ok(/<BoardExplains/.test(gStrip),
    'I5 …and the shared explainer draws ABOVE the board too, on BOTH engines');
  ok(g.indexOf('<BoardExplains') < board,
    'I7 …before the answer, because an offer to CHANGE THE SEARCH belongs beside the search and "some of your prices are missing" outranks the prices themselves');
  ok(!/<ShortBoardNotice|<NearTierFlag|hidden=\{res\.hidden\}/.test(c),
    'I8 …and the combined screen keeps no second copy of any of them — one arrangement, or two screens disagree about one short board');
}

console.log(bad ? `\nFAILURES: ${bad}` : '\nOFFLINE: all passed');
process.exit(bad ? 1 : 0);
