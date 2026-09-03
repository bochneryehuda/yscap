/**
 * WHAT WE CALL A RATE SHEET, AND WHY A BREAKDOWN IS MISSING — one definition,
 * one browser mirror, and a sweep that stops a third copy appearing.
 *
 * ── THE TWO DRIFTS THIS CLOSES ─────────────────────────────────────────────
 * 1. THE SOURCE LABEL was written SEVEN ways. `merge.js` answered
 *    `src === 'loannex' ? 'LoanNEX' : 'Lender Price'` — so ANY source that is
 *    not LoanNEX was called Lender Price, a vendor's name over a price that
 *    vendor never quoted — while `investor-routing.js` answered the raw string
 *    for the same input. Four more spellings sat in the front end, two of them
 *    the merge version.
 *
 * 2. WHY THERE IS NO BREAKDOWN: the server has SEVEN reasons and the browser's
 *    fallback carried FOUR, worded differently, missing exactly the two that
 *    describe a sheet that answered badly. A missing code falls through to the
 *    generic "no breakdown could be read", which loses the one fact the reader
 *    opened the panel for.
 *
 * ── WHY A MIRROR AT ALL ────────────────────────────────────────────────────
 * A browser cannot require server code (the `lib/payoff.js` arrangement). So the
 * mirror is legitimate and the guard is the price of it: this runs BOTH over one
 * battery and fails the moment they disagree, or the server grows a reason the
 * browser cannot word.
 *
 * `.mjs` so the browser half can be imported directly, with no bundler in the way.
 */
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const SRV = require(path.join(ROOT, 'src/longterm/pricing/sources.js'));
const BROWSER = await import(path.join(ROOT, 'app-v2/src/longterm/sourceLabel.js'));

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };

console.log('\nA · a source is named, and an unknown one is never guessed');
{
  eq(SRV.sourceLabel('lenderprice'), 'Lender Price', 'A1 the sheet this engine has always priced from');
  eq(SRV.sourceLabel('loannex'), 'LoanNEX', 'A2 …and the second one');
  /* ⛔ THE ONE THAT MATTERS. The old merge spelling answered "Lender Price" here,
     which puts a vendor's name over a price that vendor never quoted. */
  eq(SRV.sourceLabel('acme'), 'acme', 'A3 A SOURCE NOBODY HAS HEARD OF IS NAMED, NOT CALLED LENDER PRICE');
  eq(SRV.sourceLabel(''), '', 'A4 an empty source stays empty rather than becoming a vendor');
  eq(SRV.sourceLabel(null), '', 'A5 …and so does a missing one');
  eq(SRV.isKnownSource('acme'), false, 'A6 and the engine says plainly that it does not price from it');
  eq(SRV.isKnownSource('loannex'), true, 'A6b …while it does from this one');
}

console.log('\nB · the browser says exactly the same thing');
{
  const BATTERY = ['lenderprice', 'loannex', 'acme', '', null, undefined, 'LOANNEX', 'lender price', 0, 'both'];
  const drift = BATTERY.filter((v) => SRV.sourceLabel(v) !== BROWSER.sourceLabel(v));
  eq(drift, [], 'B1 server and browser name every source identically — including the ones neither recognises');
  eq(Object.keys(SRV.SOURCE_LABELS).sort(), Object.keys(BROWSER.SOURCE_LABELS).sort(), 'B2 the same sources are known on both sides');
  for (const k of Object.keys(SRV.SOURCE_LABELS)) {
    eq(BROWSER.SOURCE_LABELS[k], SRV.SOURCE_LABELS[k], `B3 …and ${k} is spelled the same way`);
  }
}

console.log('\nC · every reason the server can give, the browser can word');
{
  const srv = Object.keys(SRV.NO_BREAKDOWN).sort();
  const brw = Object.keys(BROWSER.NO_BREAKDOWN).sort();
  eq(brw, srv, 'C1 THE BROWSER CARRIES EVERY CODE — a missing one silently becomes the generic sentence');
  for (const k of srv) eq(BROWSER.NO_BREAKDOWN[k], SRV.NO_BREAKDOWN[k], `C2 …and ${k} reads the same on both`);
  ok(srv.includes('vendor_returned_no_evidence') && srv.includes('unrecognised_answer_shape'),
    'C3 the two the browser used to be missing are here — they are the ones an owner reports');
  eq(SRV.noBreakdownReason('a_code_from_the_future'), SRV.NO_BREAKDOWN.unknown,
    'C4 an unrecognised code falls back to the honest generic sentence rather than to nothing');
  eq(BROWSER.noBreakdownReason('a_code_from_the_future'), SRV.NO_BREAKDOWN.unknown, 'C4b …on both sides');
  ok(/not been asked|Nobody has asked/.test(SRV.NO_BREAKDOWN.not_requested),
    'C5 the ONE reason that means we never asked still says so');
  ok(/ours to fix/.test(SRV.NO_BREAKDOWN.quote_incomplete),
    'C6 …and the one that is OUR fault does not read as the rate sheet refusing');
}

console.log('\nD · the engine consults the one definition, and nobody keeps a copy');
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  /* The shape a re-inlined label takes: a ternary on the source key that answers a
     vendor name. Comments are stripped first — this file and both modules necessarily
     QUOTE the old spelling while explaining why it was wrong. */
  const RE = /['"]loannex['"]\s*\?[^\n]*['"]Lender Price['"]|['"]LoanNEX['"]\s*:\s*['"]Lender Price['"]/;
  const hits = [];
  const walk = (dir, skip) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, skip); continue; }
      if (!/\.(js|jsx|mjs)$/.test(e.name) || skip.has(e.name)) continue;
      for (const line of strip(fs.readFileSync(p, 'utf8')).split('\n')) {
        if (RE.test(line)) hits.push(path.relative(ROOT, p) + ': ' + line.trim().slice(0, 80));
      }
    }
  };
  const skip = new Set(['sources.js', 'sourceLabel.js']);
  walk(path.join(ROOT, 'src/longterm'), skip);
  walk(path.join(ROOT, 'app-v2/src/longterm'), skip);
  eq(hits, [], 'D1 NOBODY re-inlines the source label — that is the drift this closed');

  ok(RE.test("  const n = s === 'loannex' ? 'LoanNEX' : 'Lender Price';"), 'D2 the sweep really does recognise the old spelling');
  ok(!RE.test("  label: sourceLabel(row.source),"), 'D2b …and stays quiet on a call to the one definition');

  for (const [f, needle] of [
    ['src/longterm/pricing/merge.js', "require('./sources')"],
    ['src/longterm/pricing/investor-routing.js', "require('./sources')"],
    ['src/longterm/pricing/breakdown.js', "require('./sources')"],
    ['src/longterm/pricing/source-misses.js', "require('./sources')"],
    ['app-v2/src/longterm/LtCombinedSettings.jsx', "from './sourceLabel.js'"],
    ['app-v2/src/longterm/LtInvestorLinks.jsx', "from './sourceLabel.js'"],
    ['app-v2/src/longterm/LtInvestorSources.jsx', "from './sourceLabel.js'"],
    ['app-v2/src/longterm/LtSourceMisses.jsx', "from './sourceLabel.js'"],
  ]) ok(fs.readFileSync(path.join(ROOT, f), 'utf8').includes(needle), `D3 ${f.split('/').pop()} asks the one definition`);

  /* `both` belongs to ONE screen and is deliberately not in the shared list: it is a
     SETTING a person picks, never a sheet that answered, and putting it in the shared
     map would let it be printed as the source of a price. */
  ok(!Object.prototype.hasOwnProperty.call(SRV.SOURCE_LABELS, 'both'),
    'D4 `both` is not a rate sheet — it is a setting, and it stays on the screen that offers it');
  ok(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtCombinedSettings.jsx'), 'utf8')
    .includes("both: 'Both (compare)'"), 'D4b …where it still reads as it always did');
}

console.log(`\n${pass} checks passed`);
