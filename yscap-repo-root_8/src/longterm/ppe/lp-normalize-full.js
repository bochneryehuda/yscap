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
//
// ⛔ SORTED, BECAUSE THE VENDOR IS NOT DETERMINISTIC ABOUT THIS AND WE ARE (§2.100). Measured live
// 2026-08-18 by pricing ONE scenario TWICE, seconds apart, and diffing the two whole responses:
//
//     2,889 raw adjustment arrays   ->  2,445 identical
//                                       444 the SAME SET in a DIFFERENT ORDER
//                                         0 genuinely different
//
// Through this normalizer that is 222 of 499 rungs, so without a canonical order `normalizeLpFull`
// returns a byte-different answer on every single call while nothing about the pricing has changed.
// The set is never wrong — only its sequence — so sorting LOSES NOTHING and buys determinism for every
// consumer at once.
//
// WHY IT MATTERS EVEN THOUGH NOTHING IS VISIBLY BROKEN TODAY. `rung-digest.theirRungs` already sums
// into a dimension-keyed Map and `finding.findingKey` keys on identity rather than detail, so neither
// churns — both asserted in the suite so they stay that way. What this protects is everything that
// asks "is the vendor's answer the same as last time?": a content hash over an unsorted answer says NO
// every time, which would make a change-detection or capture layer worse than useless — it would
// report a vendor change on every call, forever. It also stops the mirror's adjustment list
// reshuffling between two refreshes of the same search.
//
// THE ORDER IS TOTAL AND DEFINED ON THE CONTENT, never on arrival: reason, then adjType, then group,
// then value. A partial comparator would leave ties in arrival order and reintroduce exactly the
// instability this removes. `String(x)` on each part keeps a null from being compared to a string.
function llpaSortKey(a) {
  return `${String(a.reason)}\u0000${String(a.adjType)}\u0000${String(a.group)}\u0000${String(a.valueMilli)}`;
}
function llpasOf(rows, priceScale) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((a) => a && (a.reason != null || a.value != null))
    .map((a) => ({ reason: a.reason || null, adjType: a.adjType || null, group: a.group || null, valueMilli: milli(a.value, priceScale) }))
    .sort((x, y) => { const kx = llpaSortKey(x), ky = llpaSortKey(y); return kx < ky ? -1 : kx > ky ? 1 : 0; });
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
 * The best-priced RUNG per coupon across every matched program — the whole rich rung, not just its
 * price, because every axis past the ladder (base points, margin, the itemized LLPAs) lives ON the
 * rung and `bestLadder` above deliberately carries only { rate, priceMilli }.
 *
 * This is what a detector-driven comparison consumes, and it lives HERE — beside the normalizer whose
 * output it folds — so the agreement harness and the live shadow façade fold LP's programs the SAME
 * way. Two copies of "which rung wins at this coupon" is exactly how one surface comes to disagree
 * with another about a price neither of them computed.
 */
function bestRungs(lpNorm) {
  const byRate = new Map();
  for (const p of ((lpNorm && lpNorm.programs) || [])) {
    for (const r of (p.rungs || [])) {
      if (!isNum(r.rate) || !isNum(r.priceMilli)) continue;
      const prev = byRate.get(r.rate);
      if (prev == null || r.priceMilli > prev.priceMilli) byRate.set(r.rate, r);
    }
  }
  return Array.from(byRate.values()).sort((a, b) => a.rate - b.rate);
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
        // `group` is the vendor's own name for the adjustment group the reason arrived under, and it
        // is carried rather than dropped because it is the one STRUCTURAL signal separating a real
        // eligibility refusal from a statement about Lender Price's own program partition — measured
        // 2026-08-18, `Eligibility - DSCR (>=1.00) Matrix - WHL/CORR (9.22.25)` versus
        // `Filter - DSCR >= 1.25%` (task #80, see ./lp-container-partition.js).
        reasons: dedupeReasons((item.reasons || []).map((r) => ({ rule: r.rule || null, adjType: r.adjType || null, group: r.group || null }))),
      });
    }
  }
  // ⛔ THE VENDOR REPEATS EACH REFUSAL ONCE PER RUNG (§2.113). MEASURED on the captured live bytes of
  // 2026-08-19: the scoped disqualify tree carried **56 rows describing 2 containers** — each program's
  // identical refusal repeated exactly 28 times, once per coupon on the ladder — and inside a single
  // row the same sentence appeared two and three times over. Twenty-eight copies of one refusal is not
  // twenty-eight refusals, and until now every consumer counted them as such: the per-layer
  // agreement/onlyOurs/onlyAuthority tallies, the container-partition count, and — the one that
  // actually changes an answer — §2.108's same-dimension check, which reads a second row on one axis
  // as a SECOND RULE our sheet failed to state. Twenty-seven phantom `loan_amount` rules per scenario.
  //
  // Collapsed on the FULL identity (program + every reason's rule/adjType/group), so this can only ever
  // remove an exact repeat: a genuinely different second refusal on the same program differs in its
  // reason tuple and survives, which is precisely what §2.108 exists to catch. Nothing is silently
  // dropped — `duplicatesCollapsed` reports how many rows were folded away.
  const byIdentity = new Map();
  let duplicatesCollapsed = 0;
  for (const row of declined) {
    const key = declinedIdentity(row);
    if (byIdentity.has(key)) { duplicatesCollapsed += 1; continue; }
    byIdentity.set(key, row);
  }
  return { ready: true, declined: Array.from(byIdentity.values()), duplicatesCollapsed, rowsSeen: declined.length };
}

// The identity of a refusal: the program it is about and every reason it states. Reasons are compared
// in the order the vendor sent them AFTER their own de-duplication, so two rows differing only by a
// repeated sentence still collapse — which is the shape the live capture actually carries.
function declinedIdentity(row) {
  const r = row || {};
  return JSON.stringify([
    norm(r.program), norm(r.lender), norm(r.investor),
    (r.reasons || []).map((x) => [norm(x.rule), norm(x.adjType), norm(x.group)]),
  ]);
}

// Identical sentences INSIDE one row, which the live capture also carries (the same reason twice and
// three times over on one container). Order is preserved: the first sighting keeps its position, so a
// consumer that pairs by index (§2.108) sees the vendor's own ordering, not a re-sorted one.
function dedupeReasons(list) {
  const seen = new Set();
  const out = [];
  for (const r of (list || [])) {
    const k = JSON.stringify([norm(r.rule), norm(r.adjType), norm(r.group)]);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

module.exports = {
  normalizeLpFull,
  // Exported so the ordering suite can drive the comparator directly rather than re-typing it.
  llpaSortKey,
  normalizeLpDisqualified,
  bestRungs,
  // THE ONE DEFINITION OF "does this Lender Price program fall inside the scope", promoted out of
  // `_internals` because a SECOND copy of it had already drifted. `lp-normalize.js` — the shallow
  // ladder normalizer the /quote comparison and the canary both read — carried its own three-key
  // version (program / product / lender) and silently ignored the other two: an `investor`-only or
  // `programLike`-only scope built no filter at all there, so a comparison that believed it was
  // scoped to one DSCR family was in fact merged across every program Lender Price returned
  // (seventeen on the live Deephaven capture). The scope vocabulary is defined by `lp-scope.js`; a
  // consumer that understands only part of it is a consumer that fails open.
  programMatches: matches,
  programRe,
  _internals: { marginOf, llpasOf, rungOf, matches },
};
