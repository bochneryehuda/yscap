'use strict';
/**
 * LT PPE — the LENDER PRICE side normalizer for the shadow harness (MEGA plan §10). PURE: no DB, no
 * network, no LP client import. It consumes the ALREADY-PARSED result from the LP client's verified
 * parser (`client.parse(raw)` → { programs:[{ program, product, rungs:[{rate, price, ...}], ... }] })
 * and turns it into the canonical ladder parity.compareScenario expects:
 *   { eligible, rungs:[{ rate, priceMilli }] }   sorted by rate.
 *
 * UNITS: the LP parser passes LP's own numbers through unchanged — a note rate as a percent (7.125)
 * and a price as points (102.850). Our engine's canonical ladder is INTEGER milli-percent rate and
 * INTEGER milli-points price (7125 / 102850), so this multiplies by `rateScale`/`priceScale`
 * (default 1000) and rounds. The multipliers are parameters, NOT baked-in gospel: verify LP's actual
 * magnitudes against a live searchRaw sample and pass the right scale if it differs — the code's
 * standing "VERIFY the exact body against a live searchRaw" discipline.
 *
 * PROGRAM SELECTION: LP returns many programs; our engine prices ONE. Pass { program, product } to
 * compare against exactly that program; with no filter it MERGES every program and keeps the BEST
 * (highest) price at each coupon — a defensible "best execution LP offers at this rate" ladder.
 *
 * LT-only. No RTL imports.
 */

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// Accept the full parse() output ({programs:[...]}), a bare programs array, or a single program.
function programsOf(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.programs)) return parsed.programs;
  if (Array.isArray(parsed.rungs)) return [parsed]; // a single program object
  return [];
}

// A program matches the filter when every provided key matches (case-insensitive, exact).
function programMatches(p, filter) {
  if (!filter) return true;
  if (filter.program != null && norm(p.program) !== norm(filter.program)) return false;
  if (filter.product != null && norm(p.product) !== norm(filter.product)) return false;
  if (filter.lender != null && norm(p.lender) !== norm(filter.lender)) return false;
  return true;
}

/**
 * Normalize an LP parsed result into { eligible, rungs, programsMatched }.
 *   opts: { program, product, lender, rateScale=1000, priceScale=1000 }
 *
 * eligible = at least one matched program has at least one usable rung (both rate AND price present).
 * A parsed result with zero programs (everything disqualified) is ineligible. When several matched
 * rungs share the same converted coupon, the BEST (highest) price wins.
 */
function normalizeLpParsed(parsed, opts = {}) {
  const rateScale = opts.rateScale == null ? 1000 : opts.rateScale;
  const priceScale = opts.priceScale == null ? 1000 : opts.priceScale;
  const filter = (opts.program != null || opts.product != null || opts.lender != null)
    ? { program: opts.program, product: opts.product, lender: opts.lender }
    : null;

  const programs = programsOf(parsed).filter((p) => programMatches(p, filter));

  // best price per converted coupon across every matched program
  const byRate = new Map();
  for (const p of programs) {
    const rungs = Array.isArray(p.rungs) ? p.rungs : [];
    for (const r of rungs) {
      if (!isNum(r.rate) || !isNum(r.price)) continue; // a rung missing a number is unusable, not $0
      const rate = Math.round(r.rate * rateScale);
      const priceMilli = Math.round(r.price * priceScale);
      const prev = byRate.get(rate);
      if (prev == null || priceMilli > prev) byRate.set(rate, priceMilli);
    }
  }

  const rungs = Array.from(byRate.entries())
    .map(([rate, priceMilli]) => ({ rate, priceMilli }))
    .sort((a, b) => a.rate - b.rate);

  return { eligible: rungs.length > 0, rungs, programsMatched: programs.length };
}

module.exports = { normalizeLpParsed, _internals: { programsOf, programMatches } };
