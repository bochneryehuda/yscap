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
const esbuild = require2('esbuild');

const STUB_API = `
export const ltApi = new Proxy({}, { get: () => () => new Promise(() => {}) });
export default ltApi;
`;

const entry = `
import React from 'react';
import { renderToString } from 'react-dom/server';
import LtPricer, { PriceBuild, RateRow, IneligibleView, buildRateStack, toScenario, ltvOf, compRowsOf, labelize } from ${JSON.stringify(path.join(appv2, 'src/longterm/LtPricer.jsx'))};
globalThis.__React = React;
globalThis.__renderToString = renderToString;
globalThis.__LtPricer = LtPricer;
globalThis.__PriceBuild = PriceBuild;
globalThis.__RateRow = RateRow;
globalThis.__IneligibleView = IneligibleView;
globalThis.__buildRateStack = buildRateStack;
globalThis.__toScenario = toScenario;
globalThis.__ltvOf = ltvOf;
globalThis.__compRowsOf = compRowsOf;
globalThis.__labelize = labelize;
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
const buildRateStack = globalThis.__buildRateStack;
const toScenario = globalThis.__toScenario;
const compRowsOf = globalThis.__compRowsOf;
const labelize = globalThis.__labelize;

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
  ok(/value="500000"/.test(html || '') && /value="740"/.test(html || ''),
    'R4a …already filled in, so a staffer can price on arrival without typing plumbing');
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
  const parsed = lp.parseDisqualified({ results: { disqualifiedData: { leafs: [leaf] } } });
  const shaped = router._internals.shapeDisqualified(parsed, {});
  ok(shaped && shaped.disqualified && Array.isArray(shaped.disqualified.lenders),
    'R34 the server\'s own parser + shaper produce the payload the view reads');

  const dq = { status: 'ready', tries: 1, data: shaped, message: null };
  const r = attempt(() => render(React.createElement(IneligibleView, { dq, count: 1, onAsk: () => {} })));
  ok(r.err === null, `R35 the ineligible view renders it${r.err ? ` — ${r.err.message}` : ''}`);
  // The lender is whatever the PARSER read off the leaf, not a name typed here — a hard-coded
  // expectation would be a claim about the fixture rather than about the screen.
  const refusedBy = shaped.disqualified.lenders[0].lender;
  ok(!!refusedBy && (r.html || '').includes(refusedBy), `R36 …naming the lender that refused (${refusedBy})`);

  // THE VENDOR'S SENTENCE, WORD FOR WORD. Re-wording one, or grouping them under a heading of ours,
  // would be a rule — and this engine holds none.
  const firstRule = shaped.disqualified.lenders[0].items[0].reasons[0].rule;
  const escRule = String(firstRule).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  ok((r.html || '').includes(escRule), 'R37 …and printing Lender Price\'s reason exactly as it wrote it');

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
  const idle = attempt(() => render(React.createElement(IneligibleView, {
    dq: { status: 'idle', tries: 0, data: null, message: null }, count: 27, onAsk: () => {},
  })));
  ok(idle.err === null && /27 products/.test(idle.html || '') && /Show me why/.test(idle.html || ''),
    'R40 …and before anybody asks, it says how many and offers to fetch the reasons');

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
  // The pure rule, so the shapes that never occur in one capture are still pinned.
  const rows = compRowsOf({ borrowerPaid: 1234.5, borrowerPaidDetails: [{ description: 'x', amount: 1234.5 }] });
  ok(rows.length === 1 && rows[0].key === 'borrowerPaid' && rows[0].lines.length === 1,
    'R53 a details array is attached to the figure it explains, not listed as its own row');
  const orphan = compRowsOf({ lenderPaidDetails: [{ description: 'y' }] });
  ok(orphan.length === 1 && orphan[0].lines.length === 1,
    'R54 …but a details array with no figure is still shown — never silently dropped');
  const odd = compRowsOf({ someObject: { a: 1 }, missing: null, flag: true, word: 'Tier 2' });
  const byKey = Object.fromEntries(odd.map((r) => [r.key, r.text]));
  ok(byKey.someObject === '—' && byKey.missing === '—',
    'R55 an unreadable value is a dash, never "[object Object]"');
  ok(byKey.flag === 'yes' && byKey.word === 'Tier 2',
    'R56 …a yes/no reads as yes/no, and the vendor\'s own word is kept');
  ok(compRowsOf(null).length === 0 && compRowsOf('nope').length === 0,
    'R57 …and a comp block that is not an object yields nothing rather than throwing');
  ok(labelize('borrowerPaid') === 'Borrower paid' && labelize('totalLenderFees') === 'Total lender fees',
    'R58 a vendor key reads as words — typography only, no meaning invented');
}

console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `FAILURES: ${failures} of ${n}`}`);
process.exit(failures ? 1 : 0);
