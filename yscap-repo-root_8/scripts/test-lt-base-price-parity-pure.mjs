#!/usr/bin/env node
/**
 * THE BASE OF A PRICE BUILD IS RESOLVED ONE WAY, ON THE SERVER AND IN THE BROWSER.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR (owner: *"I understand the base price, the adjusted total and the
 * final price, but I don't understand the base points and the adjusted points. Sounds like
 * nonsense. Where are you taking this information, and what is it all about?"*).
 *
 * The Details panel drew "Base price" as `100 − basePoints`, unconditionally, under a tooltip
 * reading "100 minus the base points the rate sheet quotes". That is TRUE of Lender Price, which
 * quotes the base in POINTS. It is BACKWARDS on LoanNEX, which quotes a base PRICE and whose points
 * we derive from it. So on half the board the panel presented our own arithmetic as the vendor's
 * figure, and the vendor's own figure as arithmetic — on the one panel whose entire job is to say
 * where a price came from.
 *
 * ⛔ AND THE HONEST SIZE OF IT, MEASURED rather than asserted: on every base price this integration
 * has actually captured the two routes give the SAME number. They diverge only at the fourth
 * decimal. Nobody was shown a wrong price; they were shown a wrong ACCOUNT of it. Section B pins
 * that measurement so the claim stays true or fails here.
 *
 * A browser cannot require server code, so `priceBuild.baseOf` mirrors `breakdown._internals
 * .priceOf`. This runs BOTH over one battery and fails the moment they disagree — the sanctioned
 * shape for a mirror in this repo, because two copies of one rule drift and the copy that drifts is
 * the one drawing the price somebody quotes.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const BD = require('../src/longterm/pricing/breakdown.js')._internals;
const { baseOf, baseNote, BASE_NOTE } = await import('../app-v2/src/longterm/priceBuild.js');

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const r3 = (n) => Math.round(n * 1000) / 1000;

console.log('\n── A. THE SERVER AND THE BROWSER RESOLVE ONE BASE ──');
{
  /** Every shape a price build can arrive in, including the ones that state neither half. */
  const prices = [101.5, 104.5, 100.948, 98.7655, 100.0005, 103.1235, 99.9996, 100, 0, -0.25];
  const points = [-1.5, -4.5, 0, 1.234, 2, 0.0005, -0.0004];
  const builds = [];
  for (const p of prices) builds.push({ basePrice: p });                    // LoanNEX: price stated
  for (const q of points) builds.push({ basePoints: q });                   // Lender Price: points stated
  for (const p of prices) for (const q of points) builds.push({ basePrice: p, basePoints: q }); // both
  // The states that must NOT be guessed at.
  builds.push({}, { basePrice: null, basePoints: null }, { basePrice: undefined },
    { basePrice: NaN }, { basePoints: Infinity }, { basePrice: '101.5' }, { basePoints: '2' });

  let disagreements = 0;
  for (const pb of builds) {
    const server = BD.priceOf({ priceBuild: pb });
    const browser = baseOf(pb);
    const same = server.basePrice === browser.basePrice
      && server.basePoints === browser.basePoints
      && server.baseDerived === browser.baseDerived;
    if (!same) {
      disagreements++;
      if (disagreements <= 3) {
        console.log(`       build ${JSON.stringify(pb)}`);
        console.log(`         server:  ${JSON.stringify({ p: server.basePrice, q: server.basePoints, d: server.baseDerived })}`);
        console.log(`         browser: ${JSON.stringify({ p: browser.basePrice, q: browser.basePoints, d: browser.baseDerived })}`);
      }
    }
  }
  ok(builds.length >= 90, `BASE-1 the battery is real (${builds.length} price builds, both vendors' shapes and the ones that state nothing)`);
  ok(disagreements === 0, `BASE-2 the browser mirror and the server resolver agree on every one (${disagreements} disagreed)`);

  // A value that is not a finite number is not a base. Guessing one is how a "$0 base price"
  // reaches a panel about a loan that plainly has one.
  // A value that cannot be read as a number is nothing — never 0, which would print a real base on
  // a panel about a quote that stated none. A numeric STRING is a number the vendor spelled
  // differently, and both sides read it the same way (BASE-2 proves that, over the whole battery).
  const junk = baseOf({ basePrice: 'x', basePoints: 'y' });
  ok(junk.basePrice === null && junk.basePoints === null && junk.baseDerived === null,
    'BASE-3 a value that cannot be read as a number resolves to nothing, never to 0');
  const strung = baseOf({ basePrice: '101.5' });
  ok(strung.basePrice === 101.5 && strung.basePoints === -1.5,
    'BASE-3b …while a numeric string is read as the number it spells, exactly as the server reads it');
  const empty = baseOf({});
  ok(empty.basePrice === null && empty.basePoints === null && empty.baseDerived === null,
    'BASE-4 a build that states neither half says so, rather than reporting a base of 100');
}

console.log('\n── B. WHICH HALF THE SHEET QUOTED, AND HOW BIG THE DIFFERENCE EVER WAS ──');
{
  const lp = baseOf({ basePoints: 1.5 });
  ok(lp.baseDerived === 'price_from_points' && lp.basePrice === 98.5,
    `BASE-5 a sheet that quotes POINTS has its price derived (${lp.basePrice}, ${lp.baseDerived})`);
  const nx = baseOf({ basePrice: 101.5 });
  ok(nx.baseDerived === 'points_from_price' && nx.basePoints === -1.5,
    `BASE-6 a sheet that quotes a PRICE has its points derived (${nx.basePoints}, ${nx.baseDerived})`);
  const both = baseOf({ basePrice: 101.5, basePoints: -1.5 });
  ok(both.baseDerived === null,
    'BASE-7 a sheet that states BOTH is reported as deriving neither — the panel must not claim we computed a figure the vendor sent');

  // ⛔ THE STATED-VALUE RULE, and it is the whole point: what the vendor SENT wins, and we never
  // quietly replace it with our own round-trip of it.
  const odd = baseOf({ basePrice: 98.7655 });
  ok(odd.basePrice === 98.7655,
    `BASE-8 the vendor's own base price rides through untouched (${odd.basePrice}) — never re-derived from points we rounded`);

  // The measurement the header claims. The panel's OLD rule was `100 − basePoints`, where
  // basePoints is `round3(100 − basePrice)` — so the drift is entirely that one rounding.
  const captured = [101.5, 104.5];
  const spread = [101.5, 104.5, 100.948, 98.7655, 100.0005, 103.1235, 99.9996];
  const driftOf = (bp) => Math.round(Math.abs(r3(100 - r3(100 - bp)) - bp) * 1e6) / 1e6;
  const capturedWorst = Math.max(...captured.map(driftOf));
  const spreadWorst = Math.max(...spread.map(driftOf));
  ok(capturedWorst === 0,
    `BASE-9 on every base price this integration has captured the old rule gave the SAME number (worst drift ${capturedWorst}) — nobody was shown a wrong price`);
  ok(spreadWorst > 0 && spreadWorst <= 0.0005,
    `BASE-10 …and across a wider spread it drifts only at the fourth decimal (worst ${spreadWorst}) — the account was wrong, not the arithmetic`);
}

console.log('\n── C. THE PANEL SAYS WHICH FIGURE IS THE SHEET\'S AND WHICH IS OURS ──');
{
  ok(/Derived/.test(baseNote('price_from_points', 'price')) && !/Derived/.test(baseNote('price_from_points', 'points')),
    'BASE-11 on a points sheet the PRICE row is marked derived and the points row is not');
  ok(/Derived/.test(baseNote('points_from_price', 'points')) && !/Derived/.test(baseNote('points_from_price', 'price')),
    'BASE-12 on a price sheet it is the other way round — the exact reading the panel used to get backwards');
  ok(!/Derived/.test(baseNote(null, 'price')) && !/Derived/.test(baseNote(null, 'points')),
    'BASE-13 a sheet that stated both is not told either figure was computed');
  ok(baseNote('something_unknown', 'price') === BASE_NOTE.both.price,
    'BASE-14 an unrecognised verdict falls back to the plain wording rather than reading "undefined" on the panel');

  // SOURCE GUARD: no unit test can see whether the PANEL actually reads the resolver, and drawing
  // `100 − basePoints` again is a one-line regression that every assertion above would survive.
  const fs = require('fs');
  const path = require('path');
  const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
  const src = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(/const base = baseOf\(b\);/.test(src),
    'BASE-15 the panel resolves the base ONCE through the shared resolver');
  ok(/<Row k="Base price" v=\{price\(base\.basePrice\)\}/.test(src),
    'BASE-16 …and draws the resolved price, not its own 100 − points');
  ok(/<Row k="Base points" v=\{pts\(base\.basePoints\)\}/.test(src),
    'BASE-17 …and the resolved points, so a price-quoting sheet stops showing an empty points row');
  ok(/title=\{baseNote\(base\.baseDerived, 'price'\)\}/.test(src) && /title=\{baseNote\(base\.baseDerived, 'points'\)\}/.test(src),
    'BASE-18 …each under wording that says which of the two the rate sheet actually quoted');
  ok(!/100 - b\.basePoints/.test(src),
    'BASE-19 the old unconditional derivation is gone from the panel entirely');
  ok(/let run = nn\(base\.basePoints\)/.test(src),
    'BASE-20 the running total starts from the RESOLVED base points, so a price-quoting sheet stacks its adjustments from a real starting point');
}

console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
