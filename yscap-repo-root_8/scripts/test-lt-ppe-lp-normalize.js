'use strict';
/**
 * Pure offline test for the LP-side normalizer (src/longterm/ppe/lp-normalize.js).
 * Feeds it lp.parse()-shaped objects; no DB, no network, no LP client.
 *   node scripts/test-lt-ppe-lp-normalize.js
 */

const assert = require('assert');
const N = require('../src/longterm/ppe/lp-normalize');
const parity = require('../src/longterm/ppe/parity');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const dq = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// A realistic lp.parse() output: percent rates, point prices.
const parsed = {
  programs: [
    { lender: 'Acme', program: 'DSCR 30yr', product: 'Fixed', rungs: [
      { rate: 7.125, price: 102.850 }, { rate: 7.375, price: 101.500 },
    ] },
    { lender: 'Beta', program: 'DSCR 30yr IO', product: 'IO', rungs: [
      { rate: 7.125, price: 103.000 }, // higher price at the same coupon
      { rate: 7.250, price: 100.000 },
      { rate: 7.500, price: null },    // unusable rung — dropped, not $0
    ] },
  ],
};

// ---- default: merge across programs, best price per coupon, milli units -----
(() => {
  const q = N.normalizeLpParsed(parsed);
  eq(q.eligible, true, 'eligible when rungs exist');
  eq(q.programsMatched, 2, 'both programs matched with no filter');
  // rates: 7125, 7250, 7375 (7.500 dropped as unusable)
  dq(q.rungs.map((r) => r.rate), [7125, 7250, 7375], 'rates converted to milli-percent, sorted, unusable dropped');
  const r7125 = q.rungs.find((r) => r.rate === 7125);
  eq(r7125.priceMilli, 103000, 'best (highest) price wins at a shared coupon');
  const r7375 = q.rungs.find((r) => r.rate === 7375);
  eq(r7375.priceMilli, 101500, 'price converted to milli-points');
})();

// ---- program filter selects exactly one program -----------------------------
(() => {
  const q = N.normalizeLpParsed(parsed, { program: 'DSCR 30yr', product: 'Fixed' });
  eq(q.programsMatched, 1, 'filter narrows to one program');
  dq(q.rungs.map((r) => r.rate), [7125, 7375], 'only that program rungs');
  eq(q.rungs.find((r) => r.rate === 7125).priceMilli, 102850, 'that program own price (not the higher Beta one)');
})();

// ---- filter is case-insensitive ---------------------------------------------
(() => {
  const q = N.normalizeLpParsed(parsed, { program: 'dscr 30yr io' });
  eq(q.programsMatched, 1, 'case-insensitive program match');
  ok(q.rungs.some((r) => r.rate === 7250), 'IO program rung present');
})();

// ---- a filter matching nothing -> ineligible --------------------------------
(() => {
  const q = N.normalizeLpParsed(parsed, { program: 'no such program' });
  eq(q.eligible, false, 'no matched program -> ineligible');
  eq(q.rungs.length, 0, 'no rungs');
})();

// ---- zero programs (all disqualified) -> ineligible -------------------------
(() => {
  const q = N.normalizeLpParsed({ programs: [] });
  eq(q.eligible, false, 'empty parse -> ineligible');
})();

// ---- shape tolerance: bare array, single program, null ----------------------
(() => {
  eq(N.normalizeLpParsed(parsed.programs).programsMatched, 2, 'accepts a bare programs array');
  const single = N.normalizeLpParsed({ program: 'X', rungs: [{ rate: 8, price: 99 }] });
  eq(single.eligible, true, 'accepts a single program object');
  eq(single.rungs[0].rate, 8000, 'single program rung converted');
  eq(N.normalizeLpParsed(null).eligible, false, 'null safe');
})();

// ---- custom scale factors ---------------------------------------------------
(() => {
  const q = N.normalizeLpParsed({ programs: [{ program: 'X', rungs: [{ rate: 7000, price: 102850 }] }] },
    { rateScale: 1, priceScale: 1 });
  eq(q.rungs[0].rate, 7000, 'rateScale 1 leaves an already-milli rate');
  eq(q.rungs[0].priceMilli, 102850, 'priceScale 1 leaves an already-milli price');
})();

// ---- feeds straight into parity.compareScenario -----------------------------
(() => {
  const lp = N.normalizeLpParsed(parsed, { program: 'DSCR 30yr', product: 'Fixed' });
  const ours = { eligible: true, ladder: [
    { rate: 7125, finalPriceMilli: 102850 }, { rate: 7375, finalPriceMilli: 101500 },
  ] };
  const r = parity.compareScenario(ours, lp, { priceToleranceMilli: 0 });
  eq(r.agree, true, 'normalized LP ladder agrees with a matching engine ladder through parity');
})();

console.log(`ok - lt ppe lp-normalize (${n} assertions)`);
