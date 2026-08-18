'use strict';
/**
 * LT PPE — BEST-EXECUTION ranking across investors (MEGA plan §8.3). PURE: no DB, no network. Given
 * the eligible priced results from several investors/programs for ONE scenario, rank them so the desk
 * can pick the best execution. Two query modes (§8.3):
 *
 *   by RATE  — "at this coupon, who pays the most?" For a target note rate, take each result's price at
 *              that coupon and rank by price DESC (a higher price = more credit to the borrower).
 *   by PRICE — "at/above this price, who offers the lowest rate?" For a target price floor, take each
 *              result's LOWEST coupon whose price still clears the floor and rank by rate ASC.
 *
 * This is unambiguous execution logic (a ranking), NOT a business policy — nothing here is a guessed
 * number. Results that cannot answer the query (no matching coupon / none clears the floor) are
 * EXCLUDED and reported in `excluded`, never silently dropped and never treated as $0 (§10.6 spirit).
 * Ties break deterministically by investor then program so a run is reproducible.
 *
 * Input result shape: { investor, program, rungs:[{ rate, priceMilli }] }.
 *
 * WHERE THAT SHAPE COMES FROM — MEASURED, because this line used to name the wrong two modules.
 * `lp-normalize-full.normalizeLpFull(...).programs[]` produces it whole: each entry carries
 * `investor`, `program` and a `rungs[]` of `{ rate, priceMilli, … }`, so it can be handed to
 * `bestByRate` / `bestByPrice` directly. `parity.normalizeOurQuote` and
 * `lp-normalize.normalizeLpParsed` do NOT: both return `{ eligible, rungs }` and carry no
 * `investor` and no `program` at all, so a caller using either must supply that identity itself.
 * Ranking results that all carry `investor: undefined` is not an error here — they simply all tie,
 * and the tiebreak degenerates — which is exactly the quiet wrong answer the old wording invited.
 *
 * NOTHING IN `src/` REQUIRES THIS MODULE TODAY. It is complete and unit-tested and has no production
 * caller: no route, no quote path and no screen picks a best execution. Do not read a comment
 * elsewhere calling it "the production picker" as evidence that one exists — one such comment was
 * found and corrected; `scripts/test-lt-ppe-claim-drift.js` now fails the build if the wiring and
 * the wording disagree in either direction.
 *
 * LT-only. No RTL imports.
 */

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function tie(a, b) {
  const ia = norm(a.investor); const ib = norm(b.investor);
  if (ia !== ib) return ia < ib ? -1 : 1;
  return norm(a.program) < norm(b.program) ? -1 : norm(a.program) > norm(b.program) ? 1 : 0;
}
function rungsOf(r) { return Array.isArray(r && r.rungs) ? r.rungs : []; }

/**
 * Rank by target RATE: each result's price at `targetRate` (within `rateTol`), best price first.
 * Returns { ranked:[{investor, program, rate, priceMilli}], best, excluded:[{investor, program, reason}] }.
 */
function bestByRate(results = [], targetRate, opts = {}) {
  const rateTol = opts.rateTol == null ? 0 : opts.rateTol;
  const ranked = []; const excluded = [];
  for (const r of results) {
    let match = null;
    for (const g of rungsOf(r)) {
      if (typeof g.rate !== 'number' || typeof g.priceMilli !== 'number') continue;
      if (Math.abs(g.rate - targetRate) <= rateTol) {
        if (!match || Math.abs(g.rate - targetRate) < Math.abs(match.rate - targetRate)) match = g;
      }
    }
    if (!match) { excluded.push({ investor: r.investor, program: r.program, reason: `no coupon at rate ${targetRate}` }); continue; }
    ranked.push({ investor: r.investor, program: r.program, rate: match.rate, priceMilli: match.priceMilli });
  }
  ranked.sort((a, b) => (b.priceMilli - a.priceMilli) || tie(a, b));
  return { ranked, best: ranked[0] || null, excluded };
}

/**
 * Rank by target PRICE floor: each result's LOWEST coupon whose price >= `targetPriceMilli`, lowest
 * rate first. Returns { ranked:[{investor, program, rate, priceMilli}], best, excluded }.
 */
function bestByPrice(results = [], targetPriceMilli, opts = {}) {
  const ranked = []; const excluded = [];
  for (const r of results) {
    let pick = null;
    for (const g of rungsOf(r)) {
      if (typeof g.rate !== 'number' || typeof g.priceMilli !== 'number') continue;
      if (g.priceMilli >= targetPriceMilli) {
        if (!pick || g.rate < pick.rate) pick = g; // the lowest rate that still clears the floor
      }
    }
    if (!pick) { excluded.push({ investor: r.investor, program: r.program, reason: `no coupon at/above price ${targetPriceMilli}` }); continue; }
    ranked.push({ investor: r.investor, program: r.program, rate: pick.rate, priceMilli: pick.priceMilli });
  }
  // lowest rate wins; if two share a rate, the higher price (more credit) wins, then the tiebreak
  ranked.sort((a, b) => (a.rate - b.rate) || (b.priceMilli - a.priceMilli) || tie(a, b));
  return { ranked, best: ranked[0] || null, excluded };
}

/**
 * Dispatch on a query: { mode:'rate', rate, rateTol? } or { mode:'price', priceMilli }.
 */
function bestExecution(results = [], query = {}) {
  if (query.mode === 'rate') return bestByRate(results, query.rate, { rateTol: query.rateTol });
  if (query.mode === 'price') return bestByPrice(results, query.priceMilli);
  throw new Error(`best-execution:unknown_query_mode ${query.mode}`);
}

module.exports = { bestByRate, bestByPrice, bestExecution };
