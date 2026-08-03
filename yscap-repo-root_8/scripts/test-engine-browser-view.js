'use strict';
/**
 * The engines expose `constants` to NODE and not to the BROWSER.
 *
 * WHY. Each engine's api carries a `constants` block — markup, origination, and
 * on the Standard engine the whole leverage MATRIX plus the RA rate build-up, on
 * Silver the entire RATE_BLOCKS grid. It was on the browser global, so one line
 * typed into a console on the public term-sheet page dumped the firm's guideline
 * book as tidy JSON:  YSP.constants.MATRIX
 *
 * It could not simply be deleted: it is NOT dead code. `src/lib/pricing.js` reads
 * constants.ORIG_PCT when it normalizes a quote (so the SERVER needs it), and the
 * Silver band / workbook-matrix / address-parse tests and the EMCAP fixture
 * regenerator read the grid. All of those run in Node. So the wrapper hands Node
 * the full api and the browser a narrowed view.
 *
 * This test pins BOTH halves. Dropping the Node half breaks server pricing;
 * restoring the browser half re-opens the dump.
 *
 * Pure — no DB, no network, no browser. The browser path is exercised by
 * evaluating each engine in a fabricated non-Node scope, which is exactly what a
 * <script> tag does.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');
const ROOTS = ['web/v2/tools', 'web/tools'];
const ENGINES = [
  { file: 'standard-program.js', global: 'YSP', mustHave: ['MATRIX', 'RA', 'ORIG_PCT', 'MARKUP'] },
  { file: 'gold-standard.js', global: 'GSP', mustHave: ['ORIG_PCT', 'MARKUP'] },
  { file: 'silver-program.js', global: 'SVP', mustHave: ['RATE_BLOCKS', 'ORIG_PCT'] },
];

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

console.log('A. NODE gets the full api — the server and the Silver tests depend on it');
for (const root of ROOTS) {
  for (const e of ENGINES) {
    const mod = require(path.join(REPO, root, e.file));
    ok(!!mod.constants, `${root}/${e.file}: require() exposes constants`);
    for (const k of e.mustHave) {
      ok(mod.constants && mod.constants[k] !== undefined, `  …constants.${k} present`);
    }
  }
}

console.log('\nB. src/lib/pricing.js still reads what it reads');
{
  const pricing = require(path.join(REPO, 'src/lib/pricing.js'));
  ok(pricing.enginesReady() === true, 'all four engines load server-side');
  const src = fs.readFileSync(path.join(REPO, 'src/lib/pricing.js'), 'utf8');
  ok(/constants\s*&&\s*\w+\.constants\.ORIG_PCT/.test(src), 'pricing.js reads constants.ORIG_PCT (so Node must keep it)');
}

console.log('\nC. the BROWSER view carries every method and NO constants');
for (const root of ROOTS) {
  // One shared sandbox per root: gold/silver read `root.YSP` exactly as they do
  // in a page, so they must be evaluated in order into the same global.
  const sandbox = { self: null, window: null, console };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const e of ENGINES) {
    const code = fs.readFileSync(path.join(REPO, root, e.file), 'utf8');
    vm.runInContext(code, ctx, { filename: `${root}/${e.file}` });
    const api = ctx[e.global];
    ok(!!api, `${root}/${e.file}: defines window.${e.global}`);
    if (!api) continue;
    ok(api.constants === undefined, `  …window.${e.global}.constants is GONE`);
    // And the methods the tools actually call are all still there, callable.
    const nodeApi = require(path.join(REPO, root, e.file));
    const nodeMethods = Object.keys(nodeApi).filter((k) => typeof nodeApi[k] === 'function').sort();
    const browserMethods = Object.keys(api).filter((k) => typeof api[k] === 'function').sort();
    ok(nodeMethods.join(',') === browserMethods.join(','),
      `  …every method Node has, the browser has (${browserMethods.length})`);
    // The browser view is a shallow copy, so its methods must still share the
    // module's own state — otherwise setMarkup() would set a markup that
    // evaluate() never reads. Proven by behaviour, not by object identity:
    // identity cannot be compared across two separate instantiations of the file.
    if (typeof api.setMarkup === 'function' && typeof api.evaluate === 'function') {
      // Deliberately a MID-tier borrower. The Gold engine exempts its top
      // experience tier from the markup entirely (markupFor: tier 1 -> 0), so a
      // 12-flip sponsor would show no rate movement and this probe would report a
      // bug that isn't one.
      const deal = { loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyState: 'NJ',
        purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
        fico: 740, term: 12, irMonths: 6, sqft: 1800, expFlips: 3, expBrrrr: 0, expGround: 0 };
      const base = api.evaluate(deal);
      api.setMarkup(0.05);                       // a markup nobody would miss
      const bumped = api.evaluate(deal);
      api.setMarkup(null);                       // back to the program default
      const restored = api.evaluate(deal);
      const rate = (q) => (q && (q.noteRate != null ? q.noteRate : q.maxNoteRate));
      ok(rate(bumped) !== rate(base), '  …setMarkup() through the browser view reaches evaluate()');
      ok(rate(restored) === rate(base), '  …and resetting it restores the original rate');
    }
  }
  // The dump this whole change exists to stop.
  ok(!(ctx.YSP && ctx.YSP.constants && ctx.YSP.constants.MATRIX), `${root}: YSP.constants.MATRIX is not dumpable in a browser`);
  ok(!(ctx.SVP && ctx.SVP.constants && ctx.SVP.constants.RATE_BLOCKS), `${root}: SVP.constants.RATE_BLOCKS is not dumpable in a browser`);
}

console.log('\nD. the browser view still PRICES, identically to Node');
for (const root of ROOTS) {
  const sandbox = { self: null, window: null, console };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  for (const e of ENGINES) {
    vm.runInContext(fs.readFileSync(path.join(REPO, root, e.file), 'utf8'), ctx, { filename: e.file });
  }
  const deal = {
    loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyState: 'NJ',
    purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000,
    fico: 740, term: 12, irMonths: 6, sqft: 1800, expFlips: 12, expBrrrr: 2, expGround: 0,
  };
  for (const e of ENGINES) {
    const nodeApi = require(path.join(REPO, root, e.file));
    const a = JSON.stringify(ctx[e.global].evaluate(deal));
    const b = JSON.stringify(nodeApi.evaluate(deal));
    ok(a === b, `${root}/${e.file}: browser evaluate() === node evaluate()`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll engine browser-view checks passed');
process.exit(failures ? 1 : 0);
