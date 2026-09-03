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
  // …and the same battery again with the SHEET'S OWN ANSWER attached, in every value it can carry,
  // so the mirror is proven over the marker and not only over absence.
  for (const marker of ['price', 'points', null, undefined, 'PRICE', 'nonsense', 42]) {
    for (const pb of builds.slice()) builds.push({ ...pb, baseStated: marker });
  }

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

console.log('\n\u2500\u2500 D. WHEN BOTH HALVES ARE FILLED, THE SHEET\'S OWN ANSWER DECIDES \u2500\u2500');
{
  /* ⛔ WHY THIS SECTION EXISTS. Section A's rule reads ABSENCE: whichever half is missing was
     derived. That is exact for Lender Price (points, no price) and for a board rung (neither), and
     it is BLIND on the case that actually reaches a reader — a LoanNEX option that has been
     explained, which carries the vendor's price AND the points we worked out from it. Absence says
     "the sheet stated both", so the panel captioned our own arithmetic as the rate sheet's figure
     on every explained LoanNEX row, and the Lender Price row beside it said "Derived" honestly.
     Measured on the recorded captures below, not argued. */
  const bothHalves = { basePrice: 102.375, basePoints: -2.375 };
  ok(baseOf(bothHalves).baseDerived === null,
    'BASE-21 with no marker, two stated halves are still read as two stated halves (the old rule, unchanged)');
  ok(baseOf({ ...bothHalves, baseStated: 'price' }).baseDerived === 'points_from_price',
    'BASE-22 a sheet that says it published the PRICE has its points reported as derived');
  ok(baseOf({ ...bothHalves, baseStated: 'points' }).baseDerived === 'price_from_points',
    'BASE-23 …and one that published the POINTS has its price reported as derived');
  ok(baseOf({ ...bothHalves, baseStated: 'price' }).basePrice === 102.375
    && baseOf({ ...bothHalves, baseStated: 'price' }).basePoints === -2.375,
    'BASE-24 the marker changes only the ACCOUNT — both numbers are still the ones that arrived');
  ok(baseOf({ baseStated: 'price' }).baseDerived === null
    && baseOf({ baseStated: 'points' }).baseDerived === null,
    'BASE-25 a marker with no numbers behind it claims nothing — an empty build is still empty');
  for (const junk of ['PRICE', 'Price', '', 0, 1, true, {}, ['price']]) {
    ok(baseOf({ ...bothHalves, baseStated: junk }).baseDerived === null,
      `BASE-26 an unrecognised marker (${JSON.stringify(junk)}) is ignored rather than believed`);
  }
  ok(BD.priceOf({ priceBuild: { ...bothHalves, baseStated: 'price' } }).baseDerived === 'points_from_price',
    'BASE-27 the server twin reads the marker the same way, so the two panels cannot disagree');

  /* THE REAL MAPPER, on the REAL recorded answer — the only check here that can catch the marker
     being dropped on the way out of the vendor's payload. */
  const quoteShape = require('../src/longterm/pricing/quote-shape.js');
  const nexParse = require('../src/longterm/loannex/parse.js');
  const cap = require('../src/longterm/loannex/capture/evidence.json');
  // The capture holds the raw HTTP answers; `parseEvidence` is the same reader the live route
  // uses, so this runs the real chain — recorded payload → parser → mapper → resolver — rather
  // than a shape hand-built to agree with itself.
  const withEvidence = ((cap && cap.samples) || [])
    .map((x) => nexParse.parseEvidence(x && x.response))
    .filter((ev) => ev && ev.basePrice != null);
  ok(withEvidence.length > 0,
    `BASE-28 the recorded LoanNEX capture really does carry priced evidence to run this against (${withEvidence.length} sample(s))`);
  let checkedRows = 0; let allSaidPrice = true; let allReadDerived = true; let refused = 0;
  for (const ev of withEvidence) {
    // The option the evidence is FOR: `attachEvidence` refuses an evidence whose rate or lock does
    // not match the row, and a refusal that quietly passed this check would prove nothing, so the
    // row is built from the recorded answer's own rate and lock and the refusals are counted.
    const option = quoteShape.emptyOption();
    option.priceBuild.noteRate = ev.rate;
    option.terms = { ...(option.terms || {}), dayLock: ev.lockPeriod };
    const built = quoteShape.attachEvidence(option, ev);
    if (!built.evidence || built.evidence.appliesToThisRate !== true) { refused++; continue; }
    const pb = built.priceBuild;
    checkedRows++;
    if (pb.baseStated !== 'price') allSaidPrice = false;
    if (baseOf(pb).baseDerived !== 'points_from_price') allReadDerived = false;
  }
  ok(refused === 0, `BASE-29a every recorded evidence actually attached to its row — none was refused (${refused} refused)`);
  ok(checkedRows > 0, `BASE-29 …and at least one of them states a base price (${checkedRows} row(s) checked)`);
  ok(checkedRows > 0 && allSaidPrice,
    'BASE-30 every explained LoanNEX row says the SHEET published the price');
  ok(checkedRows > 0 && allReadDerived,
    'BASE-31 …so the panel now reports its base POINTS as derived — the same way round Lender Price reports its base price');

  /* THE COMP OVERLAY MOVES BOTH HALVES OR NEITHER. Shifting the points and leaving a stated price
     behind made the two rows contradict each other by exactly the comp shift — on LoanNEX only,
     because Lender Price has no stated price to leave behind. */
  const { shiftBuild } = await import('../app-v2/src/longterm/compOverlay.js');
  let consistent = 0; let inconsistent = 0;
  for (const shift of [0.25, -0.5, 1, 2.75, -1.125]) {
    for (const bp of [102.375, 98.5, 100, 104.5]) {
      const moved = shiftBuild({ basePrice: bp, basePoints: r3(100 - bp), price: bp, adjustedPoints: r3(100 - bp) }, shift);
      const b = baseOf(moved);
      if (Math.abs(r3(100 - b.basePoints) - b.basePrice) < 1e-9) consistent++; else inconsistent++;
    }
  }
  ok(inconsistent === 0 && consistent === 20,
    `BASE-32 after a comp shift the base price is still 100 minus the base points, on all ${consistent + inconsistent} shapes tried`);
  const lp = shiftBuild({ basePoints: 3.439, price: 98.561, adjustedPoints: 1.439 }, 0.5);
  ok(lp.basePrice === undefined && lp.basePoints === 3.939,
    'BASE-33 …and a Lender Price build, which states no base price, gains no invented one');
}

console.log('\n\u2500\u2500 E. ONE LOAN, ONE UNIT \u2500\u2500');
{
  /* ⛔ THE SAME THIRTY-YEAR LOAN READ TWO WAYS ON ONE BOARD. Lender Price states a term in YEARS
     and the Terms row drew "30 years"; LoanNEX states it in MONTHS and the row beside it drew
     "360 months". Nothing was wrong with either number — an officer simply had to convert one of
     them in their head before the two rows could be compared, on the panel whose whole job is to
     put them side by side. Measured below on what the REAL builders emit, not on hand-typed
     shapes, so a change to either vendor's terms builder is what fails this. */
  const { termText } = await import('../app-v2/src/longterm/priceBuild.js');
  const quoteShape = require('../src/longterm/pricing/quote-shape.js');

  // The LoanNEX side, straight out of the board builder.
  const nexRows = quoteShape.programsFromLoanNex({ programs: [{
    lender: 'X', investor: 'X', program: 'P', product: '30 Yr Fixed',
    termInMonths: 360, isInterestOnly: false, amortizationType: 'Fixed',
    rungs: [{ rate: 7, price: 101.5, lockDays: 30, priceHashKey: 'h' }],
  }] }, { investorKey: 'x', loanAmount: 375000 });
  // `programsFromLoanNex` answers PROGRAMMES carrying options, the same shape a Lender Price
  // programme has — the panel draws an OPTION, so that is what this reads.
  const nexTerms = (((nexRows[0] || {}).options || [])[0] || {}).terms || {};
  // The Lender Price side, straight out of the recorded live answer.
  const cap = require('../scripts/fixtures/lt-pricer-live-capture.json');
  const findOpt = (o, d = 0) => {
    if (d > 6 || !o || typeof o !== 'object') return null;
    if (Array.isArray(o)) { for (const x of o) { const r = findOpt(x, d + 1); if (r) return r; } return null; }
    if (o.priceBuild && o.terms) return o;
    for (const k of Object.keys(o)) { const r = findOpt(o[k], d + 1); if (r) return r; }
    return null;
  };
  const lpTerms = (findOpt(cap) || {}).terms || {};

  ok(nexTerms.termYears === 30 && nexTerms.termMonths === 360,
    `E-1 the LoanNEX builder really does carry both halves of the term (${nexTerms.termYears}y / ${nexTerms.termMonths}m)`);
  ok(lpTerms.term === 30 && lpTerms.termInMonths === false,
    `E-2 …and the recorded Lender Price answer really does state its term in years (${lpTerms.term}, termInMonths=${lpTerms.termInMonths})`);
  ok(termText(lpTerms) === '30 years',
    `E-3 a Lender Price row reads "30 years" — unchanged, which is the row this had to match (got "${termText(lpTerms)}")`);
  ok(termText(nexTerms) === '30 years',
    `E-4 …and the LoanNEX row beside it now reads the same, not "360 months" (got "${termText(nexTerms)}")`);
  ok(termText(lpTerms) === termText(nexTerms),
    'E-5 …so one loan reads ONE way on one board, which is the whole of this section');

  ok(termText({ term: 342, termInMonths: true, termMonths: 342, termYears: 28.5 }) === '342 months',
    'E-6 a term that is NOT a whole number of years keeps its months — rounding it would invent a fact');
  ok(termText({ term: 15, termInMonths: false }) === '15 years'
    && termText({ term: 180, termInMonths: true, termMonths: 180, termYears: 15 }) === '15 years',
    'E-7 the same holds on a fifteen-year loan, so this is a rule and not a fixture');
  ok(termText({}) === null && termText(null) === null && termText(undefined) === null,
    'E-8 no term stated is NULL, so the panel draws its em dash rather than a made-up one');
  ok(termText({ term: 0, termInMonths: true, termYears: 0 }) === '0 months'
    || termText({ term: 0, termInMonths: true, termYears: 0 }) === null,
    'E-9 a zero term is never dressed up as "0 years"');

  // SOURCE GUARD: no unit test can see whether the PANEL calls this.
  const fs2 = require('fs');
  const path2 = require('path');
  const ROOT2 = path2.join(path2.dirname(new URL(import.meta.url).pathname), '..');
  const jsx = fs2.readFileSync(path2.join(ROOT2, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8');
  ok(/<Row k="Term" v=\{termText\(/.test(jsx),
    'E-10 the Terms row draws the shared formatter, not its own unit');
  ok(!/termInMonths \? 'months' : 'years'/.test(jsx),
    'E-11 …and the old per-vendor unit is gone from the panel entirely');
}

console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
