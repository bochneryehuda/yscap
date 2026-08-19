const quoteVerdict = require('./quote-verdict');
'use strict';
/**
 * LT PPE — the PRICING BREAKDOWN read-model (the "mother interface", owner-directed
 * 2026-08-17): "we can see every single adjustment, every single LLPA, and we should
 * be able to see the base price and the final price — same way everything is visible
 * in Lender Price."
 *
 * This is the read side, and ONLY the read side. It INVENTS NO NUMBER and applies NO
 * pricing rule: it takes an ALREADY-PRICED scenario — either our engine's reconstruction
 * record (`quote.quoteProgram(...)` → `pricing.priceRung` §5.4, the crown jewel that
 * "maps 1:1 onto Lender Price's priceBuild") or Lender Price's own parsed sheet
 * (`lp-normalize-full.normalizeLpFull(...)`) — and re-shapes it into one flat, screen-ready
 * view: the base price at the top, every itemized LLPA/adjustment line with its running
 * effect, the corporate margin / SRP / comp as their OWN lines (never folded silently,
 * per pricing.js §5.4), the round-and-floor as its own reconciling line, and the final
 * price. Plus the eligibility verdict (our engine's decline reasons) and Lender Price's
 * own disqualifications, each in its own panel.
 *
 * PURE. No DB, no network, no clock, no config read — every input is passed in, so the
 * whole thing is offline-testable and a route decides where the numbers come from. This
 * mirrors pricing.js / quote.js / lp-normalize-full.js, which are all pure for the same
 * reason.
 *
 * UNITS (§3, unchanged everywhere in this subsystem): integer MILLI-POINTS, never floats.
 * Par = 100000. `points = 100000 − price`. A POSITIVE point value is COST-POSITIVE: it is
 * a cost the borrower pays, so it LOWERS the price (raises the points). A NEGATIVE value is
 * a credit that raises the price. This is the exact convention pricing.js normalizes to and
 * the one the agreement diff (parity-detectors.js) compares in — so a line here reads the
 * same sign as the finding that would flag it.
 *
 * LT-only. No RTL imports.
 */

const PAR_MILLI = 100000;

// price (milli) → cost-positive points (milli). points = par − price.
function priceToPoints(priceMilli) {
  return Number.isFinite(priceMilli) ? PAR_MILLI - priceMilli : null;
}

function isInt(v) { return typeof v === 'number' && Number.isInteger(v); }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }

// Known acronyms in this domain that must read in caps, not Title Case.
const ACRONYMS = new Set(['fico', 'ltv', 'cltv', 'dscr', 'ltc', 'arv', 'io', 'srp', 'lpc', 'bpc', 'llpa', 'dti', 'io']);

// A human label from a machine code/reason. Never throws; a falsy input degrades to a
// generic word rather than an empty cell (an unlabelled adjustment line reads as a bug).
function humanLabel(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'Adjustment';
  return s
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

// ---------------------------------------------------------------------------
// adapters — turn a REAL producer's rung into the one normalized shape the
// assembler consumes. Neither adapter computes a price; each only re-labels what
// its producer already computed.
// ---------------------------------------------------------------------------

/**
 * From ONE reconstruction record (a rung of `quote.quoteProgram(...).ladder`, i.e. the
 * output of `pricing.priceRung`). Every field it reads is one priceRung already produced.
 */
function normRungFromOurRecord(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const adjustments = (Array.isArray(rec.adjustments) ? rec.adjustments : []).map((a) => ({
    dimension: a.dimension || a.category || 'other',
    code: a.code || null,
    label: humanLabel(a.reason || a.code || a.category),
    // costMilli is the normalized COST-POSITIVE effect on points; sourceMilli is
    // the sheet's own published value, kept verbatim (never inferred).
    pointsMilli: isInt(a.costMilli) ? a.costMilli : null,
    sourceMilli: isInt(a.sourceMilli) ? a.sourceMilli : null,
  }));
  // Layers 3–5, each its OWN line (pricing.js: "never folded silently"). Sign is
  // cost-positive on points: margin + comp are costs (+, lower price); srp is a
  // credit (−, raises price).
  const components = [];
  if (isInt(rec.marginMilli) && rec.marginMilli !== 0) components.push({ kind: 'margin', label: 'Corporate margin', pointsMilli: rec.marginMilli });
  if (isInt(rec.compMilli) && rec.compMilli !== 0) components.push({ kind: 'comp', label: 'Loan-officer comp (LPC)', pointsMilli: rec.compMilli });
  if (isInt(rec.srpMilli) && rec.srpMilli !== 0) components.push({ kind: 'srp', label: 'Servicing value (SRP)', pointsMilli: -rec.srpMilli });
  return {
    source: 'ours',
    rate: rec.rate == null ? null : rec.rate,
    basePriceMilli: isInt(rec.basePriceMilli) ? rec.basePriceMilli : null,
    adjustments,
    components,
    rawPriceMilli: isInt(rec.rawPriceMilli) ? rec.rawPriceMilli : null,
    finalPriceMilli: isInt(rec.finalPriceMilli) ? rec.finalPriceMilli : null,
    rounding: {
      mode: rec.roundingMode || null,
      incrementMilli: isInt(rec.roundingIncrementMilli) ? rec.roundingIncrementMilli : null,
      floorMilli: isInt(rec.floorMilli) ? rec.floorMilli : null,
      capMilli: isInt(rec.capMilli) ? rec.capMilli : null,
      clamped: !!rec.clamped,
    },
  };
}

/**
 * From ONE Lender-Price rung (a rung of `normalizeLpFull(...).programs[].rungs`). LP does
 * not publish a raw-vs-rounded split, so `rawPriceMilli` is left null and the assembler
 * reconciles the visible lines straight to the published `finalPriceMilli`.
 */
function normRungFromLpRung(rung) {
  if (!rung || typeof rung !== 'object') return null;
  // LP gives base POINTS and a final PRICE, both milli. base price = par − base points.
  const basePriceMilli = isInt(rung.basePointsMilli) ? PAR_MILLI - rung.basePointsMilli : null;
  const adjustments = (Array.isArray(rung.llpas) ? rung.llpas : []).map((a) => ({
    dimension: a.group || 'other',
    code: a.adjType || null,
    label: humanLabel(a.reason || a.adjType || a.group),
    // LP publishes the LLPA as a cost-positive POINT add-on already, so value IS the cost.
    pointsMilli: isInt(a.valueMilli) ? a.valueMilli : null,
    sourceMilli: isInt(a.valueMilli) ? a.valueMilli : null,
  }));
  const components = [];
  if (isInt(rung.marginMilli) && rung.marginMilli !== 0) components.push({ kind: 'margin', label: 'Corporate margin', pointsMilli: rung.marginMilli });
  return {
    source: 'lp',
    rate: isNum(rung.rate) ? rung.rate : null,
    basePriceMilli,
    adjustments,
    components,
    rawPriceMilli: null,
    finalPriceMilli: isInt(rung.priceMilli) ? rung.priceMilli : null,
    rounding: null,
  };
}

// ---------------------------------------------------------------------------
// featured-rung selection — the ONE coupon whose full stack is shown at the top.
// Default: the rung whose FINAL price is nearest par (the "at par" coupon), ties
// broken toward the lower rate. A caller may name an explicit rate.
// ---------------------------------------------------------------------------

function pickRung(rungs, wantRate) {
  const list = Array.isArray(rungs) ? rungs.filter(Boolean) : [];
  if (!list.length) return null;
  if (wantRate != null) {
    const exact = list.find((r) => r.rate != null && Number(r.rate) === Number(wantRate));
    if (exact) return exact;
  }
  // nearest-to-par by final price; tie → lower rate
  let best = null;
  let bestDist = Infinity;
  for (const r of list) {
    const fp = isInt(r.finalPriceMilli) ? r.finalPriceMilli : null;
    const dist = fp == null ? Infinity : Math.abs(fp - PAR_MILLI);
    if (dist < bestDist || (dist === bestDist && best && r.rate != null && best.rate != null && Number(r.rate) < Number(best.rate))) {
      best = r; bestDist = dist;
    }
  }
  return best || list[0];
}

// ---------------------------------------------------------------------------
// the assembler — walk the normalized rung base → final, recording the running
// effect after each line, and return the flat view object.
// ---------------------------------------------------------------------------

function buildLines(rung) {
  const base = rung.basePriceMilli;
  const lines = [];
  // running PRICE as we subtract each cost-positive point effect.
  let running = isInt(base) ? base : null;
  const step = (pointsMilli) => {
    if (running != null && isInt(pointsMilli)) running -= pointsMilli; // cost lowers price
    return running;
  };

  for (const a of rung.adjustments) {
    const runPrice = step(a.pointsMilli);
    lines.push({
      kind: 'llpa',
      dimension: a.dimension,
      code: a.code,
      label: a.label,
      points_milli: a.pointsMilli,
      source_milli: a.sourceMilli,
      cost_positive: isInt(a.pointsMilli) ? a.pointsMilli >= 0 : null,
      running_price_milli: runPrice,
      running_points_milli: priceToPoints(runPrice),
    });
  }
  for (const c of rung.components) {
    const runPrice = step(c.pointsMilli);
    lines.push({
      kind: c.kind,
      dimension: c.kind,
      code: null,
      label: c.label,
      points_milli: c.pointsMilli,
      source_milli: null,
      cost_positive: isInt(c.pointsMilli) ? c.pointsMilli >= 0 : null,
      running_price_milli: runPrice,
      running_points_milli: priceToPoints(runPrice),
    });
  }

  // ROUND + FLOOR/CEILING is the last word (§5.2). If the visible lines land above
  // the published final price, add ONE reconciling line so the table sums EXACTLY to
  // the final — a breakdown that does not foot is worse than none.
  const finalPrice = rung.finalPriceMilli;
  if (running != null && isInt(finalPrice) && running !== finalPrice) {
    const deltaPoints = finalPrice - running; // add to price → a CREDIT in points terms
    lines.push({
      kind: 'rounding',
      dimension: 'rounding',
      code: null,
      label: rung.rounding && rung.rounding.clamped ? 'Rounding & price floor/ceiling' : 'Rounding',
      // expressed cost-positive on points, like every other line
      points_milli: -deltaPoints,
      source_milli: null,
      cost_positive: -deltaPoints >= 0,
      running_price_milli: finalPrice,
      running_points_milli: priceToPoints(finalPrice),
    });
  }
  return lines;
}

/**
 * Assemble the pricing breakdown view for one already-priced scenario.
 *
 * input:
 *   quote         — our engine's `quote.quoteProgram(...)` result. Owns ELIGIBILITY:
 *                   `{ eligible, declines[], ladder[] , ... }`. Required for eligibility;
 *                   its ladder is the default price source.
 *   lpFull        — optional `normalizeLpFull(...)` result. When present AND `source:'lp'`
 *                   (or no `quote` ladder), the price breakdown is built from Lender
 *                   Price's own sheet instead of our reconstruction.
 *   lpDisqualified— optional `normalizeLpDisqualified(...)` result (or a bare array of
 *                   `{ program, reasons:[{rule}] }`). Feeds `disqualify_reasons`.
 *   rate          — optional coupon to feature; default is the at-par rung.
 *   source        — optional 'ours' | 'lp' preference for the PRICE breakdown.
 *
 * Returns the flat view (see the module header). NEVER throws on shape — a missing piece
 * is reported (null / empty / a `note`), never guessed.
 */
function buildPricingBreakdown(input = {}) {
  const quote = input.quote || null;
  const lpFull = input.lpFull || null;
  const wantRate = input.rate == null ? null : Number(input.rate);
  const prefer = input.source === 'lp' || input.source === 'ours' ? input.source : null;

  // --- eligibility: our engine is the authority on decline reasons ------------
  // A quote that could not be priced is NOT eligible-as-far-as-we-know (§2.124) — it is undetermined,
  // and rendering it as eligible tells a reader we would do a loan we never assessed.
  const verdict = quote ? quoteVerdict.verdictOf(quote) : null;
  const eligible = verdict == null ? null : (verdict === 'undetermined' ? null : verdict === 'priced');
  const reasons = [];
  if (quote && quote.eligible === false && Array.isArray(quote.declines)) {
    for (const d of quote.declines) {
      const r = d && (d.reason || d.declineReason || d.code);
      if (r) reasons.push(String(r));
    }
  }

  // --- Lender Price's own disqualifications (its own decline panel) ------------
  const disqualifyReasons = [];
  const dq = input.lpDisqualified;
  const declinedList = Array.isArray(dq) ? dq : (dq && Array.isArray(dq.declined) ? dq.declined : []);
  for (const item of declinedList) {
    const rs = Array.isArray(item && item.reasons) ? item.reasons : [];
    for (const r of rs) {
      const rule = r && (r.rule || r.reason);
      if (!rule) continue;
      disqualifyReasons.push({
        program: (item && item.program) || null,
        investor: (item && item.investor) || null,
        lender: (item && item.lender) || null,
        rule: String(rule),
        label: humanLabel(rule),
      });
    }
  }

  // --- the price breakdown: choose a source, pick a rung, walk it -------------
  // LP is used for the breakdown when the caller prefers it or when our engine gave
  // us no priced ladder to reconstruct.
  const ourRungs = quote && Array.isArray(quote.ladder) ? quote.ladder.map(normRungFromOurRecord) : [];
  const lpProgram = lpFull && Array.isArray(lpFull.programs) && lpFull.programs.length ? lpFull.programs[0] : null;
  const lpRungs = lpProgram && Array.isArray(lpProgram.rungs) ? lpProgram.rungs.map(normRungFromLpRung) : [];

  let source = null;
  let normRungs = [];
  if (prefer === 'lp' && lpRungs.length) { source = 'lp'; normRungs = lpRungs; }
  else if (prefer === 'ours' && ourRungs.length) { source = 'ours'; normRungs = ourRungs; }
  else if (ourRungs.length) { source = 'ours'; normRungs = ourRungs; }
  else if (lpRungs.length) { source = 'lp'; normRungs = lpRungs; }

  const rung = pickRung(normRungs, wantRate);

  let breakdown = null;
  if (rung) {
    const lines = buildLines(rung);
    breakdown = {
      source,
      rate: rung.rate,
      base_price: rung.basePriceMilli,
      base_points: priceToPoints(rung.basePriceMilli),
      adjustments: lines,
      final_price: rung.finalPriceMilli,
      final_points: priceToPoints(rung.finalPriceMilli),
      rounding: rung.rounding || null,
    };
  }

  // the whole coupon ladder, compact — the LP-style rate/price grid beside the featured rung
  const ladder = normRungs
    .map((r) => ({
      rate: r.rate,
      base_price: r.basePriceMilli,
      final_price: r.finalPriceMilli,
      final_points: priceToPoints(r.finalPriceMilli),
      featured: rung != null && r === rung,
    }))
    .sort((a, b) => (a.rate == null ? 0 : a.rate) - (b.rate == null ? 0 : b.rate));

  return {
    source,
    eligible,
    program: (quote && quote.program) || (lpProgram
      ? { code: lpProgram.program || null, name: lpProgram.product || null, investorCode: lpProgram.investor || null }
      : null),
    // the featured rung's headline numbers, hoisted to the top level for the LP-style
    // "base price at top, final price prominent" layout. null when there is no priced rung
    // (an ineligible scenario, or no source) — a dash on screen, never a fabricated 0.
    base_price: breakdown ? breakdown.base_price : null,
    base_points: breakdown ? breakdown.base_points : null,
    adjustments: breakdown ? breakdown.adjustments : [],
    final_price: breakdown ? breakdown.final_price : null,
    final_points: breakdown ? breakdown.final_points : null,
    rate: breakdown ? breakdown.rate : null,
    rounding: breakdown ? breakdown.rounding : null,
    ladder,
    eligibility: { eligible, reasons },
    disqualify_reasons: disqualifyReasons,
    note: breakdown ? null : (eligible === false
      ? 'This scenario is ineligible — see the reasons; there is no price to break down.'
      : 'No priced rate-sheet was available to break down.'),
  };
}

module.exports = {
  PAR_MILLI,
  buildPricingBreakdown,
  humanLabel,
  priceToPoints,
  _internals: { normRungFromOurRecord, normRungFromLpRung, pickRung, buildLines },
};
