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
 * PROGRAM SELECTION: LP returns many programs; our engine prices ONE. The scope vocabulary is
 * `lp-scope.js`'s — { program, product, lender, investor, programLike } — and it is matched by
 * `lp-normalize-full`'s ONE matcher, never a copy here. With no filter at all it MERGES every program
 * and keeps the BEST (highest) price at each coupon; that is a "best execution LP offers at this rate"
 * ladder, NOT a comparison against our one program, which is why every caller that means to compare
 * states a scope and the facade abstains when none is stated.
 *
 * LT-only. No RTL imports.
 */

// The scope matcher is NOT redefined here — see the note on `programMatches` below.
const lpFull = require('./lp-normalize-full');

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// Accept the full parse() output ({programs:[...]}), a bare programs array, or a single program.
function programsOf(parsed) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed.programs)) return parsed.programs;
  if (Array.isArray(parsed.rungs)) return [parsed]; // a single program object
  return [];
}

// A program matches the filter when every provided key matches (case-insensitive, exact — except
// `programLike`, a family PATTERN).
//
// THIS IS A DELEGATION, NOT A COPY, AND THE COPY IT REPLACES HAD DRIFTED. This module used to carry
// its own three-key matcher (program / product / lender) while `lp-normalize-full` — the deep capture
// normalizer reading the SAME stored scope (`lp-scope.js`, db/574) — understood five. So a scope
// stated as `{ programLike: "DSCR .* 30 Yr Fixed" }`, which is the ONLY way to name the Deephaven DSCR
// family (Lender Price splits that one sheet into three programs by DSCR band), built NO filter here
// at all: the ladder was merged across every program in the capture, and the facade's "not scoped, so
// abstain" guard did not fire either because a scope object WAS present. A comparison that reads as
// scoped and is not is worse than an unscoped one that says so.
const programMatches = lpFull.programMatches;

// The scope keys `lp-scope.validateScope` can store. Kept as a list so this and the filter build below
// cannot fall out of step the way the matcher did.
const FILTER_KEYS = ['program', 'product', 'lender', 'investor', 'programLike'];

/**
 * Normalize an LP parsed result into { eligible, rungs, programsMatched }.
 *   opts: { program, product, lender, investor, programLike, rateScale=1000, priceScale=1000 }
 *
 * eligible = at least one matched program has at least one usable rung (both rate AND price present).
 * A parsed result with zero programs (everything disqualified) is ineligible. When several matched
 * rungs share the same converted coupon, the BEST (highest) price wins.
 */
function normalizeLpParsed(parsed, opts = {}) {
  const rateScale = opts.rateScale == null ? 1000 : opts.rateScale;
  const priceScale = opts.priceScale == null ? 1000 : opts.priceScale;
  // EVERY scope key, not three of them (see `programMatches`). A key that is absent stays absent, so
  // a filter is built only when the caller actually stated a scope — `null` still means "not scoped",
  // which is the state the facade abstains on.
  let filter = null;
  for (const k of FILTER_KEYS) {
    if (opts[k] == null) continue;
    if (!filter) filter = {};
    filter[k] = opts[k];
  }

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
