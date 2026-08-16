'use strict';
/**
 * Pure offline test for LT PPE best-execution ranking (src/longterm/ppe/best-execution.js).
 *   node scripts/test-lt-ppe-best-execution.js
 */

const assert = require('assert');
const BE = require('../src/longterm/ppe/best-execution');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const results = [
  { investor: 'Acme', program: 'DSCR30', rungs: [{ rate: 7000, priceMilli: 100000 }, { rate: 7250, priceMilli: 101500 }, { rate: 7500, priceMilli: 103000 }] },
  { investor: 'Beta', program: 'DSCR30', rungs: [{ rate: 7000, priceMilli: 100500 }, { rate: 7250, priceMilli: 101250 }, { rate: 7500, priceMilli: 102500 }] },
  { investor: 'Gamma', program: 'DSCR30IO', rungs: [{ rate: 7250, priceMilli: 101900 }, { rate: 7500, priceMilli: 103200 }] },
];

// ---- bestByRate -------------------------------------------------------------
(() => {
  const r = BE.bestByRate(results, 7000);
  eq(r.ranked.length, 2, 'only Acme + Beta price the 7000 coupon');
  eq(r.best.investor, 'Beta', 'Beta pays the most at 7000 (100500 > 100000)');
  eq(r.best.priceMilli, 100500, 'best price carried');
  eq(r.excluded.length, 1, 'Gamma excluded');
  eq(r.excluded[0].investor, 'Gamma', 'Gamma has no 7000 coupon');
  ok(r.excluded[0].reason.includes('7000'), 'exclusion reason names the coupon');
})();

// ---- bestByRate at a coupon everyone has -----------------------------------
(() => {
  const r = BE.bestByRate(results, 7500);
  eq(r.ranked.length, 3, 'all three price 7500');
  eq(r.best.investor, 'Gamma', 'Gamma pays the most at 7500 (103200)');
  // ranked descending by price
  ok(r.ranked[0].priceMilli >= r.ranked[1].priceMilli && r.ranked[1].priceMilli >= r.ranked[2].priceMilli, 'ranked by price DESC');
})();

// ---- bestByRate with a tolerance -------------------------------------------
(() => {
  const r = BE.bestByRate([{ investor: 'X', program: 'P', rungs: [{ rate: 7010, priceMilli: 100000 }] }], 7000, { rateTol: 25 });
  eq(r.ranked.length, 1, 'a coupon within rateTol matches');
  eq(r.ranked[0].rate, 7010, 'the near coupon is used');
  const none = BE.bestByRate([{ investor: 'X', program: 'P', rungs: [{ rate: 7100, priceMilli: 1 }] }], 7000, { rateTol: 25 });
  eq(none.ranked.length, 0, 'a coupon outside rateTol does not match');
})();

// ---- bestByPrice: lowest rate that clears the floor -------------------------
(() => {
  const r = BE.bestByPrice(results, 101000);
  // Acme: lowest rate >=101000 is 7250 (101500). Beta: 7250 (101250). Gamma: 7250 (101900).
  eq(r.ranked.length, 3, 'all three can clear a 101000 floor');
  ok(r.ranked.every((x) => x.priceMilli >= 101000), 'every pick clears the floor');
  eq(r.best.rate, 7250, 'the best is the lowest rate that clears the floor');
  // all three land on 7250; tie broken by higher price then investor -> Gamma (101900) first
  eq(r.best.investor, 'Gamma', 'among equal rates, more credit wins the tie');
})();

// ---- bestByPrice: a high floor excludes some -------------------------------
(() => {
  const r = BE.bestByPrice(results, 103100);
  // only Gamma has a coupon >= 103100 (103200)
  eq(r.ranked.length, 1, 'only Gamma clears a 103100 floor');
  eq(r.best.investor, 'Gamma', 'Gamma is the only execution');
  eq(r.excluded.length, 2, 'Acme + Beta excluded');
  ok(r.excluded.every((x) => x.reason.includes('103100')), 'exclusion reason names the floor');
})();

// ---- bestByPrice: lowest rate wins even if a higher rate pays more ----------
(() => {
  // one investor: 7000@100200, 7500@105000. Floor 100000 -> both clear; lowest rate 7000 wins.
  const r = BE.bestByPrice([{ investor: 'X', program: 'P', rungs: [{ rate: 7000, priceMilli: 100200 }, { rate: 7500, priceMilli: 105000 }] }], 100000);
  eq(r.best.rate, 7000, 'the lowest clearing rate is chosen, not the highest-paying coupon');
})();

// ---- bestExecution dispatch -------------------------------------------------
(() => {
  eq(BE.bestExecution(results, { mode: 'rate', rate: 7500 }).best.investor, 'Gamma', 'dispatch rate mode');
  eq(BE.bestExecution(results, { mode: 'price', priceMilli: 103100 }).best.investor, 'Gamma', 'dispatch price mode');
  let threw = false; try { BE.bestExecution(results, { mode: 'bogus' }); } catch { threw = true; }
  ok(threw, 'unknown query mode is refused');
})();

// ---- determinism + empty ----------------------------------------------------
(() => {
  const a = BE.bestByRate(results, 7500).ranked.map((x) => x.investor);
  const b = BE.bestByRate(results, 7500).ranked.map((x) => x.investor);
  assert.deepStrictEqual(a, b, 'ranking is deterministic'); n += 1;
  const empty = BE.bestByRate([], 7000);
  eq(empty.best, null, 'no results -> no best');
  eq(empty.ranked.length, 0, 'no results -> empty ranking');
})();

// ---- unusable rungs ignored, never $0 --------------------------------------
(() => {
  const r = BE.bestByRate([{ investor: 'X', program: 'P', rungs: [{ rate: 7000, priceMilli: null }, { rate: 7000 }] }], 7000);
  eq(r.ranked.length, 0, 'a rung missing a price is not treated as $0');
  eq(r.excluded.length, 1, 'that investor is excluded');
})();

console.log(`ok - lt ppe best-execution (${n} assertions)`);
