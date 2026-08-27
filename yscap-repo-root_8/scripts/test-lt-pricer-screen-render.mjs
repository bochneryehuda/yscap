#!/usr/bin/env node
/**
 * THE PRICING ENGINE ACTUALLY RENDERS — driven by a REAL Lender Price answer.
 *
 * WHY THIS EXISTS, in this repo's own words: "A green `npm run build` does NOT mean the page
 * renders." esbuild treats an undeclared identifier as a global and emits it verbatim, so a
 * component reading a variable nobody gave it BUILDS CLEANLY and throws at render — which the
 * ErrorBoundary turns into the full-screen "Something went wrong", taking the whole screen down.
 *
 * AND THE OTHER HALF, which is the likelier one here: this screen is a MIRROR. Every panel on it
 * reads a shape the VENDOR chose, not one we designed — a price build, a stack of itemized point
 * LLPAs, a three-way holdback, a comp block, a fee block, a rate sheet with an expiry. A hand-typed
 * fixture would only ever prove the page survives the shape somebody imagined. So this drives it
 * with `scripts/fixtures/lt-pricer-live-capture.json` — a REDUCED but otherwise untouched capture of
 * a real `POST /api/lt/dscr/price {full:true}` answer from the live Lender Price system
 * (2026-08-23; 4 of the 32 programmes that run returned, 3 rungs each, chosen to carry a holdback
 * and a bare option, an expired sheet and a live one).
 *
 * WHAT IS ACTUALLY COVERED, stated exactly — a header claiming more than it checks is worse than a
 * thin test, because somebody later trusts the header:
 *
 *   · the screen and its whole import graph BUNDLE (an unresolved import is caught here);
 *   · the FIRST PAINT renders through react-dom without throwing, and carries the scenario form
 *     with its starting values — the only thing a staffer can do before a price comes back;
 *   · THE RATE STACK, built from the real capture: one row per rate, every investor under it, the
 *     order, and the two ways the grouping can lie (merging two different rates, and dropping a
 *     rung the vendor sent with no rate);
 *   · every rate row and every rung renders, open, through the breakdown panel;
 *   · the vendor's OWN figures reach the markup (price, note rate, each LLPA's reason and value),
 *     which is the one thing a mirror is for;
 *   · the four things the owner asked to see behind a price — base price, LLPAs, margin holdback,
 *     final price — each asserted by name;
 *   · an option stripped down to nothing still renders: that is what a partial vendor answer looks
 *     like and it must degrade to em dashes rather than crash;
 *   · the INELIGIBLE view, rendered from a payload the SERVER'S OWN parser produced over the real
 *     captured refusal leaf, with the vendor's refusal sentence asserted word for word;
 *   · the dark-text rule, on the source of every file this screen owns.
 *
 * NOT covered here: the loaded / refused / empty states of the SCREEN as renders. They arrive
 * through `useState` after a fetch, which `renderToString` does not run. Those are pinned by the
 * source guards in `test-lt-pricer-screen.mjs`.
 *
 *   node scripts/test-lt-pricer-screen-render.mjs
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

console.log('LT Pricing Engine — it renders, against a real Lender Price answer\n');

// The screen imports `./api.js`, which reaches for the browser's fetch at CALL time only — but the
// module is imported at load, so the whole graph still has to bundle. It is stubbed because this
// test is about RENDERING; a real fetch would make it about the network instead.
// ⛔ THIS SUITE CANNOT RUN ON THE BUILD SERVER, AND SAYS SO RATHER THAN PRETENDING.
//
// The screen is JSX, so rendering it means bundling it, and esbuild is installed under
// `app-v2/` — which NO CI job installs (the workflow runs `npm ci` at the project root only,
// and the root's dependencies are express/pg and a handful of document libraries). So on CI
// this file has nothing to render with. It used to require esbuild outright and CRASH there,
// which is how it failed the very first run of this branch.
//
// Skipping is the incumbent pattern here (`test-payoff-studio-prefill.mjs` does the same) and
// it is the only option available, but a QUIET skip is the failure that looks like success:
// dozens of assertions would vanish from CI and the log would read like a pass. So the skip
// is LOUD, it names the count that did not run, it never prints "all passed", and — the part
// that actually matters — the rules whose being wrong would COST money (what a fee or comp
// figure MEANS, and its unit) were moved OUT of the JSX into `priceBuild.js` so that
// `test-lt-pricer-screen.mjs` proves them on every CI run with no bundler in reach.
let esbuild;
try {
  esbuild = require2('esbuild');
} catch {
  console.log('SKIPPED — esbuild is not installed under app-v2/, so the screen cannot be bundled here.');
  console.log('  This is expected on CI: no CI job installs the front end.');
  console.log('  NOT RUN: every assertion in this file (the rendered first paint, the rate stack on a');
  console.log('           real Lender Price answer, the breakdown, and the ineligible view).');
  console.log('  STILL RUN on CI, with no bundler: scripts/test-lt-pricer-screen.mjs — the structural');
  console.log('           guards AND the fee/comp unit rules (PE-41..PE-52), which are the ones that');
  console.log('           cost money when wrong. Run this file locally after `npm install` in app-v2/.');
  process.exit(0);
}

const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import LtPricer, { PriceBuild, RateRow, IneligibleView, DscrCalc, CompSwitch, ChargeList, buildRateStack, toScenario, ltvOf, InvestorPicker, InvestorStripRow } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtPricer.jsx'))};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__LtPricer = LtPricer;
globalThis.__PriceBuild = PriceBuild;
globalThis.__RateRow = RateRow;
globalThis.__IneligibleView = IneligibleView;
globalThis.__DscrCalc = DscrCalc;
globalThis.__CompSwitch = CompSwitch;
globalThis.__ChargeList = ChargeList;
globalThis.__buildRateStack = buildRateStack;
globalThis.__toScenario = toScenario;
globalThis.__ltvOf = ltvOf;
globalThis.__InvestorPicker = InvestorPicker;
globalThis.__InvestorStripRow = InvestorStripRow;
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-pricer-render-'));
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
  ok(false, `the screen bundles at all: ${String(e && e.message).slice(0, 400)}`);
  console.log(`\nFAILURES: ${failures}`);
  process.exit(1);
}
ok(true, 'R0 the screen and everything it imports bundle');

require2(outfile);
const React = globalThis.__React;
const renderToString = globalThis.__renderToString;
const LtPricer = globalThis.__LtPricer;
const PriceBuild = globalThis.__PriceBuild;
const RateRow = globalThis.__RateRow;
const IneligibleView = globalThis.__IneligibleView;
const DscrCalc = globalThis.__DscrCalc;
const CompSwitch = globalThis.__CompSwitch;
const ChargeList = globalThis.__ChargeList;
const buildRateStack = globalThis.__buildRateStack;
const toScenario = globalThis.__toScenario;

const render = (el) => renderToString(el);
const attempt = (fn) => { try { return { html: fn(), err: null }; } catch (e) { return { html: null, err: e }; } };

// ---------------------------------------------------------------------------
// 1) the first paint — what a staffer sees before any price comes back
// ---------------------------------------------------------------------------
{
  const { html, err } = attempt(() => render(React.createElement(LtPricer)));
  ok(err === null, `R1 the first paint renders without throwing${err ? ` — ${err.message}` : ''}`);
  ok(typeof html === 'string' && html.length > 0, 'R2 …and produces markup');
  ok(/Price it/.test(html || ''), 'R3 …carrying the action that starts a search');
  ok(/FICO/i.test(html || '') && /DSCR/i.test(html || ''),
    'R4 …and the scenario fields, so the screen is usable on arrival');
  // THE DEFAULTS ARE THERE AND ARE VISIBLY DEFAULTS. A prefilled scenario nobody can tell is a
  // prefill is how somebody quotes a borrower off a number nobody chose.
  // The money boxes hold GROUPED text now (owner-directed: "as dollars with a dollar sign with
  // commas"), so the prefill reads 500,000. The guard's subject has not moved — it is still "the
  // scenario arrives filled in" — only the spelling the screen fills it in with.
  // EVERY STARTING VALUE THE OWNER HAS SET, not a sample of them: the property value, the FICO and
  // the DSCR. The DSCR was the one default nobody pinned, so it could have been changed by accident
  // and no test anywhere would have noticed — which is the whole reason a guard exists.
  ok(/value="500,000"/.test(html || '') && /value="760"/.test(html || '') && /value="1\.25"/.test(html || ''),
    'R4a …already filled in, so a staffer can price on arrival without typing plumbing');
  ok(/\$<\/span>/.test(html || '') || />\$</.test(html || ''),
    'R4a2 …with the dollar sign DRAWN beside the figure, not typed into it');
  // ⛔ THE ZIP STARTS ON THE OWNER'S CONNECTICUT DEFAULT (owner-directed 2026-08-24: "we should
  // pre-fill the zip code to any Connecticut zip code" — SUPERSEDING 2026-08-23's "should not
  // default to anything", which was aimed at the old Miami 33101). Both halves are pinned: the
  // Miami default may never come back, and the box arrives on 06001 (Avon, Hartford County, CT —
  // a ZIP our own county table resolves, so the hint names the county and the default is VISIBLY
  // a default). The empty-ZIP pre-flight refusal is untouched and pinned in the fields suite.
  ok(!/33101/.test(html || ''), 'R4c the ZIP does not default to Miami');
  ok(/id="pe-zip"[^>]*value="06001"/.test(html || ''),
    'R4d …the ZIP box starts on the owner’s Connecticut default (06001)');
  ok(/First-time homebuyer/.test(html || ''),
    'R4e the first-time-homebuyer flag is on the screen — the same fact Lender Price carries');
  ok(/starting point you can change/.test(html || ''),
    'R4b …and the screen says they are a starting point, not a fact about any loan');
}

// ---------------------------------------------------------------------------
// 2) THE RATE STACK, built from the real answer
// ---------------------------------------------------------------------------
const capture = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/fixtures/lt-pricer-live-capture.json'), 'utf8'));
ok(Array.isArray(capture.programs) && capture.programs.length > 0, 'R5 the captured Lender Price answer loads');
ok(!!capture._capture && !!capture._capture.fullRun,
  'R6 …and says on its face that it is a REDUCED capture, so nobody reads it as the whole run');

const stack = buildRateStack(capture.programs);
{
  ok(stack.rates.length > 0, `R7 the real answer builds a rate stack (${stack.rates.length} rates)`);

  // NOTHING IS LOST. Every rung the vendor sent is either on a rate row or counted as unpriced —
  // a stack that quietly drops part of a paid answer is the failure this engine exists to avoid.
  const onRows = stack.rates.reduce((s, r) => s + r.quotes.length, 0);
  ok(onRows + stack.unpriced.length === stack.quoteCount,
    `R8 every rung is accounted for (${onRows} on the ladder + ${stack.unpriced.length} unpriced = ${stack.quoteCount})`);
  const captureRungs = capture.programs.reduce((s, p) => s + (p.options || []).length, 0);
  ok(stack.quoteCount === captureRungs,
    `R9 …and that is every rung in the capture (${stack.quoteCount} of ${captureRungs})`);

  // ASCENDING, because that is how a rate ladder reads.
  const rates = stack.rates.map((r) => r.rate);
  ok(rates.every((v, i) => i === 0 || rates[i - 1] <= v), 'R10 rates run lowest first');

  // WITHIN a rate, best price first. Higher price is worth more to the borrower — arithmetic, not
  // a judgement of ours, which this engine is not allowed to make.
  const multi = stack.rates.find((r) => r.quotes.filter((q) => q.price != null).length > 1);
  ok(!!multi, 'R11 the capture carries a rate with more than one investor on it — the case the board is for');
  if (multi) {
    const ps = multi.quotes.map((q) => q.price).filter((p) => p != null);
    ok(ps.every((v, i) => i === 0 || ps[i - 1] >= v), 'R12 …and within a rate the best price is first');
    ok(multi.bestPrice === ps[0], 'R13 …and the row states that best price');
  }

  // TWO WAYS THE GROUPING CAN LIE, both built rather than hoped for.
  //
  // (a) 5.99 and 5.990 are the SAME rate and must land together. (b) 5.875 and 5.88 are DIFFERENT
  // rates and must not — rounding to two decimals would merge them and attribute one lender's
  // price to the other's rate.
  const same = buildRateStack([
    { lender: 'A', options: [{ priceBuild: { noteRate: 5.99, price: 99.5 } }] },
    { lender: 'B', options: [{ priceBuild: { noteRate: 5.990, price: 98.2 } }] },
  ]);
  ok(same.rates.length === 1 && same.rates[0].quotes.length === 2,
    'R14 two lenders quoting the same rate written two ways land on ONE row');
  const near = buildRateStack([
    { lender: 'A', options: [{ priceBuild: { noteRate: 5.875, price: 99.5 } }] },
    { lender: 'B', options: [{ priceBuild: { noteRate: 5.88, price: 98.2 } }] },
  ]);
  ok(near.rates.length === 2,
    'R15 …and two lenders quoting genuinely different rates stay on two');

  // A rung with NO rate is not dropped. Silently discarding part of a paid answer is the thing
  // this engine exists not to do, so it is counted and the screen says so.
  const missing = buildRateStack([
    { lender: 'A', options: [{ priceBuild: { noteRate: 6, price: 99 } }, { priceBuild: { price: 98 } }] },
  ]);
  ok(missing.unpriced.length === 1 && missing.rates.length === 1,
    'R16 a rung the vendor sent with no note rate is KEPT and counted, never dropped');

  // A quote with no price sorts LAST rather than being read as zero, which would put it top of a
  // "best price first" list — the worst possible place for a figure we do not have.
  const noPrice = buildRateStack([
    { lender: 'A', options: [{ priceBuild: { noteRate: 6 } }] },
    { lender: 'B', options: [{ priceBuild: { noteRate: 6, price: 97 } }] },
  ]);
  ok(noPrice.rates[0].quotes[0].lender === 'B',
    'R17 a quote with no price sorts last, never as though it were zero');
  ok(buildRateStack(null).rates.length === 0 && buildRateStack(undefined).quoteCount === 0,
    'R18 an absent answer builds an empty stack rather than throwing');
}

// ---------------------------------------------------------------------------
// 3) every rate row renders, open, with its investors and their prices
// ---------------------------------------------------------------------------
{
  let threw = null; let rows = 0; let html = '';
  for (const row of stack.rates) {
    const r = attempt(() => render(React.createElement(RateRow, {
      row, open: true, onToggle: () => {}, openQuote: null, onOpenQuote: () => {},
    })));
    if (r.err) { threw = { row, err: r.err }; break; }
    rows += 1; html += r.html;
  }
  ok(threw === null,
    `R19 every rate row renders open (${rows}/${stack.rates.length})`
    + (threw ? ` — ${threw.row.key}: ${threw.err.message}` : ''));

  const first = stack.rates[0];
  ok(html.includes(first.rate.toFixed(3)), 'R20 the rate is printed to three decimals');
  ok(html.includes(first.quotes[0].lender), 'R21 …and every investor under it is named');
  if (first.quotes[0].price != null) {
    ok(html.includes(first.quotes[0].price.toFixed(3)), 'R22 …with the vendor\'s own price beside them');
  } else { ok(true, 'R22 (first quote carries no price — nothing to assert)'); }

  // The row's own summary must count what is really under it.
  const summarised = stack.rates.every((r) => html.includes(`${r.quotes.length} quote`));
  ok(summarised, 'R23 each row says how many quotes are on it');
}

// ---------------------------------------------------------------------------
// 4) THE BREAKDOWN — the four things the owner asked to see behind a price
// ---------------------------------------------------------------------------
{
  let rungs = 0; let threw = null; let html = '';
  for (const p of capture.programs) {
    for (const o of (p.options || [])) {
      const r = attempt(() => render(React.createElement(PriceBuild, { o })));
      if (r.err) { threw = { p, err: r.err }; break; }
      rungs += 1; html += r.html;
    }
    if (threw) break;
  }
  ok(threw === null, `R24 every rung's breakdown renders (${rungs})`
    + (threw ? ` — ${threw.p.lender}: ${threw.err.message}` : ''));

  // Each of the owner's four, asserted BY NAME. A breakdown missing one of them is the whole
  // reason this panel exists, and "it rendered" would not notice.
  ok(/Base price/.test(html), 'R25 the breakdown shows the BASE PRICE');
  ok(/Final price/.test(html), 'R26 …the FINAL PRICE');
  ok(/Margin &amp; holdback|Margin & holdback/.test(html), 'R27 …the MARGIN &amp; HOLDBACK');

  // The LLPAs, by the vendor's own reason and value — the one thing a mirror is for.
  const withAdj = capture.programs.flatMap((p) => p.options || []).find((o) => (o.adjustments || []).length);
  ok(!!withAdj, 'R28 the capture carries a rung with itemized LLPAs');
  if (withAdj) {
    const one = attempt(() => render(React.createElement(PriceBuild, { o: withAdj })));
    const a = withAdj.adjustments[0];
    // react-dom escapes HTML, so `<=` arrives as `&lt;=`. Asserting the RAW string here would be
    // wrong and would push somebody toward dangerouslySetInnerHTML to make it pass.
    const esc = String(a.reason).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    ok(one.err === null && one.html.includes(esc), 'R29 …and each LLPA is printed with the vendor\'s own reason');
    ok(one.html.includes(Math.abs(a.value).toFixed(3)), 'R30 …and its value');
  }

  // A holdback that IS there is shown; one that is not is SAID to be absent, because "no holdback"
  // and "nobody looked" are different facts and a blank space reads as the second.
  const noHoldback = attempt(() => render(React.createElement(PriceBuild, { o: { priceBuild: { noteRate: 6, price: 99 } } })));
  ok(noHoldback.err === null && /no margin or holdback lines/.test(noHoldback.html || ''),
    'R31 a quote with no holdback says so rather than leaving a blank');

  // A stripped-down option is what a partial vendor answer looks like. It must degrade, not crash.
  const bare = attempt(() => render(React.createElement(PriceBuild, { o: {} })));
  ok(bare.err === null, `R32 an option with nothing in it still renders${bare.err ? ` — ${bare.err.message}` : ''}`);
  ok((bare.html || '').includes('—'), 'R33 …as em dashes, never as 0.000');

  // …and never as "NaN" or "$NaN" either, which is the third way a missing figure can land
  // on screen and the ugliest: it reads as a broken page rather than as an absent value.
  // Worth pinning because the shared money formatters take null/'' but not NaN.
  ok(!/NaN/.test(html) && !/NaN/.test(bare.html || ''),
    'R33a …and no figure anywhere renders as NaN');
}

// ---------------------------------------------------------------------------
// 5) THE INELIGIBLE VIEW — from a payload the SERVER'S OWN parser produced
// ---------------------------------------------------------------------------
{
  const requireRepo = createRequire(path.join(repo, 'package.json'));
  const lp = requireRepo('./src/longterm/lenderprice/client.js');
  const router = requireRepo('./src/longterm/routes/dscr-pricer.js');
  const leaf = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/fixtures/lp-disqualify-leaf.json'), 'utf8'));

  // The leaf is the part of a real disqualify tree that carries the programme name and the vendor's
  // sentence — in the plain-string shape that once made the whole feed unreadable. It is wrapped in
  // the container shape and run through PRODUCTION code rather than typed out, so this test cannot
  // pass on a payload the server would never produce.
  // The wrapper is the SHAPE THE PARSER READS — `results.disqualifiedData`, walked for `leafs`.
  // Getting this wrong is what a hand-typed fixture does: it produced an empty answer and the two
  // assertions below then failed for a reason that had nothing to do with the screen.
  // NESTED UNDER A `RateKey`, because that is how the vendor's tree carries the rate — the leaf
  // itself has none. Wrapping it flat is what the first version of this fixture did, and it proved
  // the parser could read a leaf while proving nothing about the rate the board groups on.
  const parsed = lp.parseDisqualified({ results: { disqualifiedData: { childs: [{ type: 'RateKey', keyLabel: '7.375', leafs: [leaf] }] } } });
  const shaped = router._internals.shapeDisqualified(parsed, {});
  ok(shaped && shaped.disqualified && Array.isArray(shaped.disqualified.lenders),
    'R34 the server\'s own parser + shaper produce the payload the view reads');

  const dq = { status: 'ready', tries: 1, data: shaped, message: null };
  const r = attempt(() => render(React.createElement(IneligibleView, { dq, count: 1, onAsk: () => {} })));
  ok(r.err === null, `R35 the ineligible view renders it${r.err ? ` — ${r.err.message}` : ''}`);

  // ⛔ STEP 1 IS THE RATE, AND IT IS PROVEN BOTH WAYS. Owner-directed 2026-08-23: "You see all the
  // rates. You click on the rate, and you see all the lenders." So the board arrives showing the
  // RATE the parser read off the tree, with the lender and the reason NOT yet on the page — and
  // asserting that absence is what stops the board quietly reverting to the old flat list.
  const itemRate = shaped.disqualified.lenders[0].items[0].rate;
  ok(itemRate === 7.375, `R36pre the rate comes off the RateKey grouping node (${itemRate})`);
  ok((r.html || '').includes('7.375%'), 'R36a the collapsed board shows the rate');

  // The lender is whatever the PARSER read off the leaf, not a name typed here — a hard-coded
  // expectation would be a claim about the fixture rather than about the screen.
  const refusedBy = shaped.disqualified.lenders[0].lender;
  ok(!!refusedBy && !(r.html || '').includes(refusedBy),
    'R36b …and NOT the lender, which is one click in');

  // Now the same board with the three levels opened, which is what a person sees after the clicks.
  const openAll = { rate: '7.375', lenders: ['7.375|Deephaven Mortgage'], item: '7.375|Deephaven Mortgage|0:0' };
  const ro = attempt(() => render(React.createElement(IneligibleView, { dq, count: 1, onAsk: () => {}, initialOpen: openAll })));
  ok(ro.err === null, `R36c the opened board renders${ro.err ? ` — ${ro.err.message}` : ''}`);
  ok(!!refusedBy && (ro.html || '').includes(refusedBy), `R36 …naming the lender that refused (${refusedBy})`);
  ok((ro.html || '').includes('Why it is ineligible'),
    'R36d …and the band the eligible side does not have');

  // THE VENDOR'S SENTENCE, WORD FOR WORD. Re-wording one, or grouping them under a heading of ours,
  // would be a rule — and this engine holds none.
  const firstRule = shaped.disqualified.lenders[0].items[0].reasons[0].rule;
  const escRule = String(firstRule).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  ok((ro.html || '').includes(escRule), 'R37 …and printing Lender Price\'s reason exactly as it wrote it');

  // The three states a reader must never see collapsed: they are three different next steps.
  const waiting = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'waiting', tries: 1, data: null, message: null }, count: 3, onAsk: () => {},
  })));
  ok(waiting.err === null && /still working this side out|Ask again/.test(waiting.html || ''),
    'R38 "still computing" says to ask again');
  const expired = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'error', tries: 1, data: null, message: 'This search has expired at Lender Price. Price the scenario again to ask for its refusals.' },
    count: 3, onAsk: () => {},
  })));
  ok(expired.err === null && /expired at Lender Price/.test(expired.html || ''),
    'R39 …an expired key says to price again, not "that did not work"');
  /* ⛔ R40 USED TO ENFORCE THE DEFECT. It asserted that before anybody asked, the panel "says how
     many" — from a `count` prop fed by the PRICE response's own `disqualifiedCount`. That figure is
     read off the price at price time, and Lender Price has not computed the ineligible side yet
     (the route stamps every price `disqualifyStatus: 'computing'` for exactly that reason), so it
     is ALWAYS zero — and the panel printed "Lender Price reported nothing ruled out on this
     scenario" on every scenario ever priced. That is the screen answering a question it had not
     asked. The guard now holds the opposite: before an answer, NO number. */
  const idle = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'idle', tries: 0, data: null, message: null }, onAsk: () => {},
  })));
  ok(idle.err === null && /Show me why/.test(idle.html || ''),
    'R40 …and before anybody asks, it offers to fetch the reasons');
  ok(!/ruled out \d/.test(idle.html || '') && !/ruled nothing out/.test(idle.html || ''),
    'R40a …and states NO count, because nothing has answered yet');
  ok(/works the ineligible side out AFTER the price/.test(idle.html || ''),
    'R40b …it says WHY there is nothing to show yet, and that this page asks on its own');

  // A READY answer is the only thing that may state a number — in either direction.
  const readyNone = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'ready', tries: 1, message: null, data: { disqualified: { itemCount: 0, lenderCount: 0, reasonCount: 0, lenders: [] } } },
    onAsk: () => {},
  })));
  ok(readyNone.err === null && /ruled nothing out/.test(readyNone.html || ''),
    'R40c a READY answer of zero is the only thing that may say nothing was ruled out');
  const readySome = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'ready', tries: 1, message: null, data: { disqualified: { itemCount: 27, lenderCount: 3, reasonCount: 9, lenders: [] } } },
    onAsk: () => {},
  })));
  ok(readySome.err === null && /ruled out 27 products/.test(readySome.html || ''),
    'R40d …and a READY answer with refusals states how many');

  // A page the server said it TRUNCATED must say so and name the numbers. A silent cap reads as
  // "that was the whole list".
  const cut = JSON.parse(JSON.stringify(shaped));
  cut.disqualified.truncated = true;
  cut.disqualified.lenderCount = 9; cut.disqualified.returnedLenderCount = 1;
  cut.disqualified.itemCount = 40; cut.disqualified.returnedItemCount = 1;
  const cutR = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'ready', tries: 1, data: cut, message: null }, count: 40, onAsk: () => {},
  })));
  ok(cutR.err === null && /1 of 9 lenders/.test(cutR.html || '') && /1 of 40 products/.test(cutR.html || ''),
    'R41 a paged-off remainder is SAID, with both numbers');
}

// ---------------------------------------------------------------------------
// 6) the scenario the screen sends, and the one number it works out itself
// ---------------------------------------------------------------------------
{
  const sent = toScenario({ purpose: 'Purchase', value: '500000', fico: '', dscr: null, units: '1' });
  ok(sent.value === 500000 && sent.units === 1, 'R42 numbers are sent as numbers');
  ok(!('fico' in sent) && !('dscr' in sent),
    'R43 …and a blank is OMITTED, never sent as "" for the pricer to guess at');
}

// ---------------------------------------------------------------------------
// 7) the dark-text rule, on every file this screen owns
//
// `--ink*` is a LIGHT paper colour in this palette — the names LIE. A text colour taken from one
// renders white on white, which is how a whole staff card went invisible once already.
// ---------------------------------------------------------------------------
for (const f of ['app-v2/src/longterm/LtPricer.jsx', 'app-v2/src/longterm/ppeStyles.js']) {
  const src = fs.readFileSync(path.join(repo, f), 'utf8');
  ok(!/color:\s*['"`]?var\(--ink/.test(src), `R44 ${path.basename(f)} never uses a --ink* token as a text colour`);
}

// ---------------------------------------------------------------------------
// 8) the vendor's own fee and comp blocks — units, itemisation, and never a broken token
//
// ALL THREE OF THESE WERE LIVE ON EVERY QUOTE and were found by rendering the captured
// answer rather than by reading the code:
//
//   Comp
//     borrowerPaid          +5036.500        ← $5,036.50 of compensation, printed as POINTS
//     lenderPaid            +5036.500
//     borrowerPaidDetails   [object Object]  ← the vendor's own itemisation, destroyed
//     lenderPaidDetails     [object Object]
//
// The unit error is the serious one: a money figure wearing the wrong unit is the single
// most expensive thing a pricing screen can print. The "[object Object]" pair threw away
// the only lines that explain where that money comes from. And the block's own "no comp
// lines" reassurance could never appear, because the parser always emits all five keys —
// so an EMPTY comp block would have shown five rows of nothing instead of saying so.
// ---------------------------------------------------------------------------
{
  const opt = capture.programs[0].options[0];
  const raw = opt.comp || {};
  const html = attempt(() => render(React.createElement(PriceBuild, { o: opt }))).html || '';

  // Every option, not just the first: a defect that survives on option 7 is still shipped.
  let objectTokens = 0; let rendered = 0;
  for (const p of capture.programs) {
    for (const o of p.options || []) {
      rendered += 1;
      const h = attempt(() => render(React.createElement(PriceBuild, { o }))).html || '';
      if (/\[object Object\]/.test(h)) objectTokens += 1;
    }
  }
  ok(rendered >= 10, `R45 the breakdown renders for every captured option (${rendered})`);
  ok(objectTokens === 0, 'R46 …and not one of them prints "[object Object]"');

  // The unit. Proven from the capture itself rather than assumed: the figure equals the sum
  // of its own detail lines' dollar amounts, so it is dollars, and it must read as dollars.
  const paid = raw.borrowerPaid;
  const sum = (raw.borrowerPaidDetails || []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  ok(typeof paid === 'number' && Math.abs(paid - sum) < 0.01,
    `R47 the captured comp figure IS the sum of its own detail amounts (${paid})`);
  const asMoney = paid.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
  // ⛔ ASSERT ON THE FIGURE'S OWN CELL, not on the page. The first cut of this guard asked
  // whether the money string appeared ANYWHERE in the breakdown — and it does, on the detail
  // line underneath — so putting the wrong unit back on the figure left it green. Capture the
  // first cell after the label and pin it exactly; nothing else on the page can satisfy it.
  const text = html.replace(/<[^>]+>/g, '|');
  const cell = (text.match(/Borrower paid\|+([^|]+)\|/) || [])[1];
  ok(cell === asMoney, `R48 …so the figure's own cell reads as money (${asMoney}, got ${cell})`);
  ok(!/^[+-]?\d+(\.\d+)?$/.test(String(cell)), 'R49 …and never as a bare/points number, which is what it used to do');

  // The itemisation the vendor gave us, in the vendor's own words.
  const firstLine = (raw.borrowerPaidDetails || [])[0] || {};
  ok(!!firstLine.description && html.includes(String(firstLine.description).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')),
    'R50 …with Lender Price\'s own comp line printed as it wrote it');
}
{
  // A fee the vendor did not quote comes through as null (the parser builds this block with
  // `firstNum`). It must read as an em dash — never as the literal word "null".
  const r = attempt(() => render(React.createElement(PriceBuild, { o: { fees: { totalLenderFees: null } } })));
  const text = (r.html || '').replace(/<[^>]+>/g, '|');
  ok(r.err === null && text.includes('|—|'), 'R51 an unquoted fee is an em dash');
  ok(!/\|null\|/.test(text) && !/\|undefined\|/.test(text),
    'R52 …never the words "null" or "undefined"');
}
{
  // NOTE the pure truth table for `compRowsOf` / `labelize` USED to sit here and has moved to
  // scripts/test-lt-pricer-screen.mjs (PE-41..PE-52). It needs no DOM, and this file cannot run
  // on CI — so keeping it here would have meant the unit rule on a money figure was proven only
  // on a developer's machine. What stays here is what genuinely needs a rendered page.
}


// ---------------------------------------------------------------------------
// 6) THE LOAN TERM AND THE DSCR CALCULATOR (owner-directed 2026-08-23)
// ---------------------------------------------------------------------------
{
  const full = attempt(() => render(React.createElement(LtPricer)));
  const h = full.html || '';
  // The term box is on the form, offering exactly the three the owner named, defaulting to 30.
  ok(/id="pe-term"/.test(h), 'R53 the loan-term box is on the form');
  // `[^>]*` because renderToString writes the SELECTED option's own attribute between `value` and
  // the label (`<option value="30" selected="">30-year</option>`), so a regex that assumes the two
  // are adjacent fails on whichever term happens to be the default — a defect in the test, not the
  // screen. Pin the value and its label on the SAME tag, and let anything sit between them.
  ok(/value="15"[^>]*>15-year</.test(h) && /value="30"[^>]*>30-year</.test(h)
    && /value="40"[^>]*>40-year</.test(h),
    'R54 …offering 15, 30 and 40');
  // `selected` is how renderToString marks a <select>'s chosen option.
  ok(/<option selected="" value="30">30-year<\/option>/.test(h) || /value="30" selected/.test(h),
    'R55 …and 30-year is the one it arrives on');
  // The way IN to the calculator is on the ratio's own field, and the panel is NOT open yet —
  // asserting that absence is what stops the form quietly growing a permanent panel.
  ok(/Calculate<\/button>/.test(h), 'R56 the ratio carries a Calculate control');
  ok(!/Work out the DSCR/.test(h), 'R57 …and the calculator is closed until it is asked for');

  // The panel itself, rendered with what the screen hands it.
  const c = { rent: '3,500', tax: '500', taxBasis: 'monthly', insurance: '1,800', insBasis: 'yearly', hoa: '', rate: '7.375' };
  const r = attempt(() => render(React.createElement(DscrCalc, {
    c, setC: () => {}, loanAmount: 375000, termYears: 30, interestOnly: false, onRatio: () => {},
  })));
  ok(r.err === null, `R58 the calculator renders${r.err ? ` — ${r.err.message}` : ''}`);
  const ch = r.html || '';
  ok(/Monthly rent/.test(ch) && /Property tax/.test(ch) && /Hazard insurance/.test(ch)
    && /Monthly HOA/.test(ch) && /Target rate/.test(ch),
  'R59 …asking for every figure the owner named');
  // The ratio it shows is the one dscrCalc computes — read from the module, never typed here, so
  // this cannot pass against a screen that draws a different number from the one the rule gives.
  const D = await import(new URL('../app-v2/src/longterm/dscrCalc.js', import.meta.url));
  const want = D.dscrFrom({ loanAmount: 375000, ratePct: 7.375, termYears: 30, interestOnly: false,
    rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: D.perMonth(1800, 'yearly') }).dscr;
  ok(want != null && ch.includes(want.toFixed(2)), `R60 …and shows the rule's own ratio (${want})`);
  // A yearly figure states its monthly equivalent, so nobody has to trust the division blind.
  ok(/150 a month/.test(ch), 'R61 …with a yearly figure showing what it is a month');
  // The arithmetic is on screen, not just the answer.
  ok(/P&amp;I/.test(ch) && /tax/.test(ch) && /insurance/.test(ch),
    'R62 …and the parts that made it');

  // Interest-only says so, and says the term stops mattering — the owner's own rule.
  const io = attempt(() => render(React.createElement(DscrCalc, {
    c, setC: () => {}, loanAmount: 375000, termYears: 30, interestOnly: true, onRatio: () => {},
  })));
  ok((io.html || '').includes('interest-only'), 'R63 an interest-only scenario says so on the panel');
  const ioWant = D.dscrFrom({ loanAmount: 375000, ratePct: 7.375, termYears: 30, interestOnly: true,
    rentMonthly: 3500, taxMonthly: 500, insuranceMonthly: D.perMonth(1800, 'yearly') }).dscr;
  ok(ioWant > want && (io.html || '').includes(ioWant.toFixed(2)),
    `R64 …and the ratio follows it (${want} -> ${ioWant})`);

  // NOTHING IS GUESSED: with a figure missing it names what is missing rather than showing a number.
  const bare = attempt(() => render(React.createElement(DscrCalc, {
    c: { rent: '', tax: '', taxBasis: 'monthly', insurance: '', insBasis: 'monthly', hoa: '', rate: '' },
    setC: () => {}, loanAmount: 375000, termYears: 30, interestOnly: false, onRatio: () => {},
  })));
  ok(/Still needed/.test(bare.html || ''), 'R65 an incomplete calculator says what is still needed');
  // R66 USED TO ASSERT THE ABSENCE OF A "Use this ratio" BUTTON. That button no longer exists
  // anywhere in the codebase, so the assertion had become one that CANNOT FAIL — decoration. What
  // is actually worth pinning now is that an incomplete panel makes no claim about a ratio having
  // gone anywhere, since the complete one says exactly that.
  ok(!/in the DSCR box above/.test(bare.html || ''),
    'R66 …and claims no ratio went into the form');

  /* ─────────────────────────────────────────────────────────────────────────────
     R67..R71 — EVERY BOX SAYS WHICH FIGURE IT WANTS (owner-reported 2026-08-23).

     ⛔ THESE PIN A REAL `<label for=…>`, NOT THE TEXT APPEARING SOMEWHERE. That distinction is the
     whole lesson: R59 above asserts "Property tax" and "Hazard insurance" are in the markup and it
     PASSED THROUGHOUT the period when both names were being discarded — because the money inputs
     carry the same words in an `aria-label`. A screen reader was fine; a person looking at it saw
     two unlabelled boxes with a Mo|Yr switch and no way to tell which was which. A guard that
     matches text anywhere in the document cannot tell a visible name from an accessibility
     attribute, so these match the element that draws the name.
     ────────────────────────────────────────────────────────────────────────── */
  const labelled = (html, id, text) => new RegExp(`<label[^>]*for="${id}"[^>]*>${text}</label>`).test(html);
  ok(labelled(ch, 'dc-tax', 'Property tax'), 'R67 the property-tax box says it is the property tax');
  ok(labelled(ch, 'dc-ins', 'Hazard insurance'), 'R68 …and the insurance box says it is the insurance');
  // …and the switch that displaced them is still there. Both, or the fix traded one bug for another.
  ok((ch.match(/aria-pressed=/g) || []).length >= 4,
    'R69 …with both monthly/yearly switches still on those two fields');
  // The same defect hit the ratio's own name on the main form, which is how it was noticed: the
  // field read CLOSE instead of DSCR.
  ok(labelled(h, 'pe-dscr', 'DSCR') && /Calculate<\/button>/.test(h),
    'R70 the ratio keeps its name AND its Calculate control');
  // ⛔ AND THE ONE FIELD THAT DELIBERATELY HAS NO NAME KEEPS NONE. The loan amount's Loan $ / LTV %
  // switch IS its name; a fix that started drawing a label there would be a different regression.
  ok(!/<label[^>]*for="pe-loan"/.test(h) && !/<label[^>]*for="pe-ltv"/.test(h),
    'R71 …while the loan amount, whose switch is its name, still has no separate one');
}

/* ─────────────────────────────────────────────────────────────────────────────
   R72..R81 — THE COMPENSATION OVERLAY (owner-directed 2026-08-23).

   The switch, the fee list and the shifted drill-down are rendered DIRECTLY (the exported
   components), because on the full screen they live behind a fetch renderToString never runs.
   The charge figures come from the engine itself (compOverlay.js, imported plain — no bundler
   needed), so these assertions can only pass when the screen draws what the engine computed.
   ────────────────────────────────────────────────────────────────────────── */
{
  const { quoteCharges } = await import(new URL('../app-v2/src/longterm/compOverlay.js', import.meta.url).href);
  const PLAN = { lenderPaid: 2, borrowerPaid: 2, ysp: 0, applicationFee: 1595, commitmentFee: 500 };

  const swRaw = attempt(() => render(React.createElement(CompSwitch, { mode: 'raw', onMode: () => {}, waive: false, onWaive: () => {} })));
  ok(!swRaw.err
    && /Borrower-paid/.test(swRaw.html) && /Raw pricing/.test(swRaw.html) && /Lender-paid/.test(swRaw.html),
    'R72 the switch offers all three positions by name');
  ok((swRaw.html.match(/aria-pressed="true"/g) || []).length === 1
    && /aria-pressed="true"[^>]*>Raw pricing/.test(swRaw.html.replace(/<!-- -->/g, '')),
    'R73 …with RAW selected by default and nothing else pressed');
  ok(!/Waive lender fees/.test(swRaw.html), 'R74 no waive box outside lender-paid');

  const swLp = attempt(() => render(React.createElement(CompSwitch, { mode: 'lenderPaid', onMode: () => {}, waive: false, onWaive: () => {} })));
  ok(!swLp.err && /Waive lender fees/.test(swLp.html), 'R75 lender-paid offers the waive box');

  const swBad = attempt(() => render(React.createElement(CompSwitch, { mode: 'lenderPaid', onMode: () => {}, waive: true, onWaive: () => {}, planProblem: true })));
  ok(!swBad.err && /showing raw pricing/.test(swBad.html) && !/Waive lender fees/.test(swBad.html),
    'R76 a plan that could not load SAYS the board fell back to raw — and offers no waive');

  // The owner's borrower-paid row: raw 99 → 2 points origination + 1 point buydown + the fees.
  const bp = quoteCharges('borrowerPaid', PLAN, 99, 350000, false);
  const clBp = attempt(() => render(React.createElement(ChargeList, { charges: bp })));
  ok(!clBp.err
    && /Origination/.test(clBp.html) && /Buydown/.test(clBp.html)
    && /Application fee/.test(clBp.html) && /Commitment fee/.test(clBp.html)
    && /12,595\.00/.test(clBp.html),
    'R77 the fee list carries origination, buydown, both lender fees and the honest net');
  ok(!/compensation/i.test(clBp.html) && !/\bYSP\b/i.test(clBp.html),
    'R78 …and never says compensation or YSP — invisible on both sides, as directed');

  // The waive: raw 103 lender-paid → fee lines gone, cash out of the credit.
  const wv = quoteCharges('lenderPaid', PLAN, 103, 350000, true);
  const clWv = attempt(() => render(React.createElement(ChargeList, { charges: wv })));
  ok(!clWv.err
    && !/Application fee/.test(clWv.html) && !/Commitment fee/.test(clWv.html)
    && /Lender fees waived/.test(clWv.html) && /1,405\.00/.test(clWv.html),
    'R79 waived: the two fee lines do not populate and the credit is smaller by the cash');

  // The drill-down shifts the BASE and the FINAL together; the vendor's comp block is withheld.
  const o = { priceBuild: { basePoints: -3, adjustmentPoints: 1, adjustedPoints: -2, price: 102 }, comp: { borrowerPaid: 5036.5 } };
  const shifted = attempt(() => render(React.createElement(PriceBuild, {
    o, comp: { mode: 'lenderPaid', shift: 2, plan: PLAN, waive: false, loanAmount: 350000 },
  })));
  ok(!shifted.err && /100\.000/.test(shifted.html) && /101\.000/.test(shifted.html),
    'R80 in lender-paid the final reads 100.000 and the base 101.000 — both moved by the comp');
  ok(!/>Comp</.test(shifted.html) && /What this quote charges/.test(shifted.html)
    && !/compensation/i.test(shifted.html),
    'R80b …the vendor comp block is withheld and our charge list stands in');
  const plain = attempt(() => render(React.createElement(PriceBuild, { o })));
  ok(!plain.err && /102\.000/.test(plain.html) && />Comp</.test(plain.html)
    && !/What this quote charges/.test(plain.html),
    'R81 with no overlay the build is the vendor verbatim: 102.000, comp block back, no charge list');
}

/* ── R82..R90 — THE INVESTOR FILTER'S TWO SURFACES (owner-directed 2026-08-27) ──
   The rules are run by test-lt-investor-filter-pure.mjs; what is proven HERE is
   that the two components genuinely DRAW them: the picker on the form and the
   switcher on the strip, real names beside white-labels, the display-only
   wording, and a selected-but-absent investor named in a sentence. */
{
  const InvestorPicker = globalThis.__InvestorPicker;
  const InvestorStripRow = globalThis.__InvestorStripRow;
  const roster = [
    { key: 'verus', whiteLabel: 'Pearl', investorLabel: 'Verus Mortgage Capital' },
    { key: 'corrfirst', whiteLabel: 'Prime', investorLabel: 'CorrFirst' },
  ];
  const groups = [{ id: 'g1', name: 'My Three', investors: ['verus'] }];

  const picker = attempt(() => render(React.createElement(InvestorPicker, {
    roster, sel: null, onSel: () => {}, groups, onApplyGroup: () => {}, onDeleteGroup: () => {},
    confirmDeleteId: null, groupName: '', onGroupName: () => {}, onSaveGroup: () => {},
    groupBusy: false, groupNote: null,
  })));
  ok(!picker.err, `R82 the form picker renders (${picker.err ? picker.err.message : 'ok'})`);
  ok(/Pearl/.test(picker.html) && /Verus Mortgage Capital/.test(picker.html),
    'R83 …each chip carries the white-label AND the real name — this is a staff screen');
  ok(/display only/.test(picker.html) && /always asked for everything/.test(picker.html),
    'R84 …and says the filter is display only, in words');
  ok(/My Three/.test(picker.html) && /Save selection as a group/.test(picker.html),
    'R85 …with the saved groups and the save box on it');

  const active = attempt(() => render(React.createElement(InvestorPicker, {
    roster, sel: new Set(['verus']), onSel: () => {}, groups, onApplyGroup: () => {},
    onDeleteGroup: () => {}, confirmDeleteId: null, groupName: '', onGroupName: () => {},
    onSaveGroup: () => {}, groupBusy: false, groupNote: null,
  })));
  ok(!active.err && /aria-pressed="true"/.test(active.html) && /Show all investors/.test(active.html),
    'R86 a ticked picker presses its chip and offers the one-press way back');

  const empty = attempt(() => render(React.createElement(InvestorPicker, {
    roster: [], sel: null, onSel: () => {}, groups: [], onApplyGroup: () => {}, onDeleteGroup: () => {},
    confirmDeleteId: null, groupName: '', onGroupName: () => {}, onSaveGroup: () => {},
    groupBusy: false, groupNote: null,
  })));
  ok(!empty.err && /could not be loaded/.test(empty.html),
    'R87 a roster that failed to load says so — the board simply shows everybody');

  const strip = attempt(() => render(React.createElement(InvestorStripRow, {
    roster: [roster[0]], fullRoster: roster, sel: new Set(['verus', 'corrfirst']), onSel: () => {},
    groups, onApplyGroup: () => {}, hidden: 3,
  })));
  ok(!strip.err, `R88 the strip switcher renders (${strip.err ? strip.err.message : 'ok'})`);
  ok(/Showing 2 investors — display only/.test(strip.html) && /3 programmes hidden/.test(strip.html)
    && /Lender Price was asked for everything/.test(strip.html),
  'R89 …stating the overlay and the un-narrowed search');
  ok(/Nothing populated on this scenario for Prime \(CorrFirst\)/.test(strip.html),
    'R90 …and NAMING the selected investor that returned nothing, white-label and real name both');
}

console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `FAILURES: ${failures} of ${n}`}`);
process.exit(failures ? 1 : 0);
