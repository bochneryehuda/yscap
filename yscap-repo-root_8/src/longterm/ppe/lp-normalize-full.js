'use strict';
/**
 * LT PPE — the RICH Lender Price side normalizer (Part 3 P1). PURE: no DB, no network, no LP client
 * import. Where lp-normalize.js consumes the shallow client.parse() (rungs + an LLPA COUNT), this
 * consumes the FULL capture — client.parseFull(raw) + client.parseDisqualified(raw) — and exposes, in
 * our canonical integer units, everything the six difference detectors (P3) need:
 *   • base rate            (priceBuild.baseRate)        → milli-percent
 *   • note/final rate      (priceBuild.noteRate)        → milli-percent
 *   • price / points       (priceBuild.price / adjustedPoints)
 *   • base points          (priceBuild.basePoints)      → milli-points
 *   • the LLPA stack total (priceBuild.adjustmentPoints)→ milli-points
 *   • the itemized LLPAs   (option.adjustments[])       verbatim keys + values (milli-points)
 *   • the MARGIN           (option.holdback → lender+investor tiers) → milli-points
 *   • the DISQUALIFICATIONS (parseDisqualified)         per program, with the failing rule keys
 *
 * WHY (owner-directed 2026-08-17): the shadow comparison must be able to say "you are off on base rate
 * / final rate / coupons / margin / rules / a missing disqualification" — and today it cannot, because
 * the shallow normalizer never sees margin, itemized LLPAs, or decline reasons. This is the feed that
 * makes those detectors possible.
 *
 * UNITS: LP passes its own magnitudes through — a rate as a percent (7.125), a price/points value as
 * points (102.850 / 0.75). Our canonical units are integer milli-percent (7125) and integer
 * milli-points (102850 / 750). Scales are PARAMETERS (default 1000), not baked-in gospel — the standing
 * "verify against a live searchRaw" discipline; pass a different scale if a live capture proves it.
 *
 * LT-only. No RTL imports.
 */

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }
function milli(v, scale) { return isNum(v) ? Math.round(v * scale) : null; }

/**
 * `programLike` — a program-FAMILY pattern, because an exact program name CANNOT express the thing we
 * actually need to scope to.
 *
 * MEASURED LIVE (2026-08-17, one canonical scenario): Lender Price splits ONE Deephaven DSCR rate
 * sheet into THREE separate PROGRAMS by DSCR band — `DSCR < 1.00 - 30 Yr Fixed`,
 * `DSCR  1.00-1.24   -  30 Yr Fixed`, `DSCR  >= 1.25  - 30 Yr Fixed` — and prices whichever band it
 * selects while DECLINING the other two ("DSCR >=1.25%  only eligible on this program"). The same
 * investor also sells Expanded Prime, Non Prime and ITIN, which decline on every DSCR scenario. So
 * scoping by `investor` alone leaves 535 declined items on the table and scoping by an exact
 * `program` name pins us to ONE band that LP may not have chosen — either way the disqualification
 * comparison is meaningless. Our sheet models the whole DSCR family as one program with the band as an
 * additive adjustment, so the LP side must be scoped to that FAMILY.
 *
 * Accepts a RegExp or a string pattern (compiled case-insensitively). A pattern that does not compile
 * THROWS here rather than being ignored — a filter that silently matches everything is exactly the
 * failure this exists to prevent.
 */
function programRe(v) {
  if (v == null) return null;
  if (v instanceof RegExp) return v;
  return new RegExp(String(v), 'i');
}

// A program/investor matches the filter when every provided key matches (case-insensitive, exact —
// except `programLike`, which is a family PATTERN; see above).
function matches(p, filter) {
  if (!filter) return true;
  if (filter.program != null && norm(p.program) !== norm(filter.program)) return false;
  if (filter.product != null && norm(p.product) !== norm(filter.product)) return false;
  if (filter.lender != null && norm(p.lender) !== norm(filter.lender)) return false;
  if (filter.investor != null && norm(p.investor) !== norm(filter.investor)) return false;
  if (filter.programLike != null && !programRe(filter.programLike).test(String(p.program == null ? '' : p.program))) return false;
  return true;
}

// The total MARGIN Lender Price applied on an option, in milli-points. Sums the lender + investor
// holdback tiers (our correspondent flow; the broker tier is TPO/wholesale). Also returns the per-tier
// breakdown so a comparison can point at which tier moved. null holdback → { totalMilli:null }.
function marginOf(option, priceScale) {
  const hb = option && option.holdback;
  if (!hb || typeof hb !== 'object') return { totalMilli: null, byTier: {} };
  const byTier = {};
  let total = 0;
  let any = false;
  for (const tier of ['broker', 'lender', 'investor']) {
    const rows = Array.isArray(hb[tier]) ? hb[tier] : null;
    if (!rows) continue;
    let t = 0; let seen = false;
    for (const r of rows) { if (isNum(r.value)) { t += r.value; seen = true; } }
    if (seen) { byTier[tier] = Math.round(t * priceScale); if (tier !== 'broker') { total += t; any = true; } }
  }
  return { totalMilli: any ? Math.round(total * priceScale) : null, byTier };
}

// The itemized LLPAs on an option, in milli-points, keys verbatim. adjustments[] rows are
// { group, reason, adjType, type, valueType, value }.
function llpasOf(rows, priceScale) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((a) => a && (a.reason != null || a.value != null))
    .map((a) => ({ reason: a.reason || null, adjType: a.adjType || null, group: a.group || null, valueMilli: milli(a.value, priceScale) }));
}

// One canonical rung from a parseFull option.
function rungOf(option, rateScale, priceScale) {
  const pb = option.priceBuild || {};
  const margin = marginOf(option, priceScale);
  return {
    rate: milli(pb.noteRate, rateScale),                    // note/final rate, milli-percent
    priceMilli: milli(pb.price, priceScale),                // price, milli-points
    baseRateMilli: milli(pb.baseRate, rateScale),           // base rate, milli-percent
    basePointsMilli: milli(pb.basePoints, priceScale),
    adjustmentPointsMilli: milli(pb.adjustmentPoints, priceScale), // LP's LLPA stack total
    marginMilli: margin.totalMilli,
    marginByTier: margin.byTier,
    llpas: llpasOf(option.adjustments, priceScale),         // itemized point LLPAs, verbatim
    rateLlpas: llpasOf(option.rateAdjustments, rateScale),  // itemized rate LLPAs, verbatim
    disqualified: !!(option.flags && option.flags.disqualified),
    interpolated: !!(option.flags && option.flags.interpolated),
    expired: !!(option.flags && option.flags.expired),
  };
}

/**
 * Normalize a parseFull result into the rich per-program comparison shape.
 *   full: client.parseFull(raw) → { programs:[{ lender, investor, program, product, options:[…] }] }
 *   opts: { program, product, lender, investor, rateScale=1000, priceScale=1000 }
 * Returns:
 *   { eligible, programsMatched, programs:[{ lender, investor, program, product, rungs:[<rung>] }],
 *     bestLadder:[{ rate, priceMilli }] }
 * bestLadder is the merged best-(highest-)price-per-coupon ladder across matched programs (compatible
 * with the simple price axis parity.compareScenario already uses).
 */
function normalizeLpFull(full, opts = {}) {
  const rateScale = opts.rateScale == null ? 1000 : opts.rateScale;
  const priceScale = opts.priceScale == null ? 1000 : opts.priceScale;
  const filter = (opts.program != null || opts.product != null || opts.lender != null || opts.investor != null || opts.programLike != null)
    ? { program: opts.program, product: opts.product, lender: opts.lender, investor: opts.investor, programLike: opts.programLike }
    : null;

  const src = (full && Array.isArray(full.programs)) ? full.programs : [];
  const matched = src.filter((p) => matches(p, filter));

  const programs = matched.map((p) => ({
    lender: p.lender || null, investor: p.investor || null, program: p.program || null, product: p.product || null,
    rungs: (Array.isArray(p.options) ? p.options : [])
      .map((o) => rungOf(o, rateScale, priceScale))
      .filter((r) => isNum(r.rate) && isNum(r.priceMilli))
      .sort((a, b) => a.rate - b.rate),
  }));

  // best price per coupon across matched programs
  const byRate = new Map();
  for (const p of programs) for (const r of p.rungs) {
    const prev = byRate.get(r.rate);
    if (prev == null || r.priceMilli > prev) byRate.set(r.rate, r.priceMilli);
  }
  const bestLadder = Array.from(byRate.entries()).map(([rate, priceMilli]) => ({ rate, priceMilli })).sort((a, b) => a.rate - b.rate);

  return { eligible: bestLadder.length > 0, programsMatched: programs.length, programs, bestLadder };
}

/**
 * Normalize a parseDisqualified result into the declined-programs shape, filtered to the scenario's
 * investor/program if given.
 *   disq: client.parseDisqualified(raw) → { ready, lenders:[{ lender, investor, items:[…] }] }
 *   opts: { program, product, lender, investor }
 * Returns { ready, declined:[{ lender, investor, program, reasons:[{ rule, adjType }] }] }.
 */
function normalizeLpDisqualified(disq, opts = {}) {
  const d = disq || {};
  if (!d.ready || !Array.isArray(d.lenders)) return { ready: !!d.ready, declined: [] };
  const declined = [];
  for (const lg of d.lenders) {
    if (opts.investor != null && norm(lg.investor) !== norm(opts.investor) && norm(lg.lender) !== norm(opts.investor)) continue;
    if (opts.lender != null && norm(lg.lender) !== norm(opts.lender)) continue;
    // The disqualify tree's rows carry the PROGRAM on the item, not on the lender group, so the family
    // pattern is applied here — this is what finally makes the disqualify side of the E3 gate usable
    // (see programRe: an investor declines its own other product lines on every DSCR scenario).
    const progRe = programRe(opts.programLike);
    for (const item of (lg.items || [])) {
      if (opts.program != null && norm(item.program) !== norm(opts.program)) continue;
      if (progRe && !progRe.test(String(item.program == null ? '' : item.program))) continue;
      declined.push({
        lender: lg.lender || null, investor: lg.investor || null, program: item.program || null,
        reasons: (item.reasons || []).map((r) => ({ rule: r.rule || null, adjType: r.adjType || null })),
      });
    }
  }
  return { ready: true, declined };
}

module.exports = {
  normalizeLpFull,
  normalizeLpDisqualified,
  _internals: { marginOf, llpasOf, rungOf, matches },
};
