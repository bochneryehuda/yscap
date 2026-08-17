'use strict';
/**
 * LT PPE — the RUNG-DIGEST AUDIT (#49, part 3). PURE: no DB, no network. Produces a COMPACT
 * per-scenario digest of the price "rungs" — the base price plus each stacked adjustment, per coupon —
 * for OUR engine beside the AUTHORITY's (Lender Price), so a human can EYEBALL exactly where the two
 * diverge (which coupon, which dimension of the LLPA stack, base vs adjustments vs margin vs final).
 *
 * This is a READ-ONLY diagnostic — it decides no pass/fail (that is parity.compareScenario's job). It
 * NEVER recomputes a price; it only lines up numbers the two engines already produced, in the SAME
 * milli-point units:
 *   • BASE — points (par − price): ours `basePointsMilli` vs LP `basePointsMilli`.
 *   • ADJUSTMENTS — per DIMENSION (fico / ltv / dscr / loan_amount / state / …), summed on each side:
 *     ours from the reconstruction record's `adjustments[].costMilli`, LP from `rungs[].llpas[].valueMilli`,
 *     each classified by the ONE shared `agreement-dimensions` classifier so the two can never be
 *     bucketed differently. A dimension present on one side only shows the other side as null.
 *   • ADJUSTMENT TOTAL — ours `adjustmentPointsMilli` vs LP `adjustmentPointsMilli`.
 *   • MARGIN — ours `marginMilli` vs LP `marginMilli`.
 *   • FINAL — price (post-bound): ours `finalPriceMilli` vs LP `priceMilli`, plus each side's `clamped`.
 *
 * Rungs are matched by coupon `rate` (optionally within `rateToleranceMilli`); a coupon on one side
 * only is surfaced (`missingOurs` / `missingTheirs`), never dropped. A field absent on a side is null,
 * and its delta is null — the digest reports "cannot compare here" rather than inventing a zero.
 *
 * `deltaMilli = ours − theirs` throughout (positive = our number is higher). `toText()` renders a
 * compact monospace table for a human to scan.
 *
 * LT-only. No RTL imports.
 */

const { dimensionOfOurAdjustment, dimensionOfLpReason } = require('./agreement-dimensions');

function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function delta(a, b) { return isNum(a) && isNum(b) ? a - b : null; }
// A dimension key that never silently merges an unrecognized one (mirrors the crosswalk discipline).
function keyOf(dim, reason, side) { return dim || `other:${side}:${reason || 'unknown'}`; }

// OUR ladder → [{ rate, basePointsMilli, adjByDim:Map, adjTotalMilli, marginMilli, finalPriceMilli, clamped }].
function ourRungs(ours) {
  const ladder = ours && Array.isArray(ours.ladder) ? ours.ladder
    : (Array.isArray(ours) ? ours : (ours && Array.isArray(ours.rungs) ? ours.rungs : []));
  return ladder.map((r) => {
    const adjByDim = new Map();
    for (const a of (Array.isArray(r.adjustments) ? r.adjustments : [])) {
      const dim = dimensionOfOurAdjustment(a);
      const k = keyOf(dim, a && a.reason, 'ours');
      const cur = adjByDim.get(k) || { dimension: dim || null, milli: 0, reasons: [] };
      cur.milli += isNum(a.costMilli) ? a.costMilli : 0;
      if (a && a.reason) cur.reasons.push(a.reason);
      adjByDim.set(k, cur);
    }
    return {
      rate: r.rate,
      basePointsMilli: isNum(r.basePointsMilli) ? r.basePointsMilli : null,
      adjByDim,
      adjTotalMilli: isNum(r.adjustmentPointsMilli) ? r.adjustmentPointsMilli : null,
      marginMilli: isNum(r.marginMilli) ? r.marginMilli : null,
      finalPriceMilli: isNum(r.finalPriceMilli) ? r.finalPriceMilli : null,
      clamped: r.clamped === true,
    };
  });
}

// LP program rungs → the same normalized shape.
function theirRungs(theirs) {
  const rungs = theirs && Array.isArray(theirs.rungs) ? theirs.rungs
    : (Array.isArray(theirs) ? theirs : (theirs && theirs.bestLadder ? theirs.bestLadder : []));
  return rungs.map((r) => {
    const adjByDim = new Map();
    for (const l of (Array.isArray(r.llpas) ? r.llpas : [])) {
      const dim = dimensionOfLpReason(l);
      const k = keyOf(dim, l && l.reason, 'theirs');
      const cur = adjByDim.get(k) || { dimension: dim || null, milli: 0, reasons: [] };
      cur.milli += isNum(l.valueMilli) ? l.valueMilli : 0;
      if (l && l.reason) cur.reasons.push(l.reason);
      adjByDim.set(k, cur);
    }
    return {
      rate: r.rate,
      basePointsMilli: isNum(r.basePointsMilli) ? r.basePointsMilli : null,
      adjByDim,
      adjTotalMilli: isNum(r.adjustmentPointsMilli) ? r.adjustmentPointsMilli : null,
      marginMilli: isNum(r.marginMilli) ? r.marginMilli : null,
      finalPriceMilli: isNum(r.priceMilli) ? r.priceMilli : null,
      clamped: r.clamped === true,
    };
  });
}

function worstOf(row) {
  let worst = 0;
  const push = (d) => { if (isNum(d) && Math.abs(d) > Math.abs(worst)) worst = d; };
  push(row.base.deltaMilli);
  for (const a of row.adjustments) push(a.deltaMilli);
  push(row.adjustmentTotal.deltaMilli);
  push(row.margin.deltaMilli);
  push(row.final.deltaMilli);
  return worst;
}

/**
 * buildRungDigest(ours, theirs, opts) → digest (see file header). `ours` = quote.quoteProgram result
 * (or a ladder array); `theirs` = a lp-normalize-full program ({ rungs[] }) or bestLadder.
 * opts: { rateToleranceMilli=0 }.
 */
function buildRungDigest(ours, theirs, opts = {}) {
  const rateTol = opts.rateToleranceMilli == null ? 0 : opts.rateToleranceMilli;
  const A = ourRungs(ours);
  const B = theirRungs(theirs);
  const eligibleOurs = ours && typeof ours.eligible === 'boolean' ? ours.eligible : (A.length > 0);
  const eligibleTheirs = theirs && typeof theirs.eligible === 'boolean' ? theirs.eligible : (B.length > 0);

  const usedB = new Set();
  const rungs = [];
  const missingTheirs = [];
  let worstDeltaMilli = 0;

  for (const a of A) {
    let match = null; let mi = -1;
    for (let i = 0; i < B.length; i += 1) {
      if (usedB.has(i)) continue;
      if (Math.abs((B[i].rate || 0) - (a.rate || 0)) <= rateTol) { match = B[i]; mi = i; break; }
    }
    if (!match) { missingTheirs.push(a.rate); }
    else usedB.add(mi);

    const dims = new Set([...a.adjByDim.keys(), ...(match ? match.adjByDim.keys() : [])]);
    const adjustments = [...dims].sort().map((k) => {
      const o = a.adjByDim.get(k) || null;
      const t = match ? (match.adjByDim.get(k) || null) : null;
      return {
        dimension: (o && o.dimension) || (t && t.dimension) || null,
        oursMilli: o ? o.milli : null,
        theirsMilli: t ? t.milli : null,
        deltaMilli: delta(o ? o.milli : null, t ? t.milli : null),
        oursReasons: o ? o.reasons : [],
        theirsReasons: t ? t.reasons : [],
      };
    });

    const row = {
      rate: a.rate,
      matched: !!match,
      base: { oursPointsMilli: a.basePointsMilli, theirsPointsMilli: match ? match.basePointsMilli : null, deltaMilli: delta(a.basePointsMilli, match ? match.basePointsMilli : null) },
      adjustments,
      adjustmentTotal: { oursMilli: a.adjTotalMilli, theirsMilli: match ? match.adjTotalMilli : null, deltaMilli: delta(a.adjTotalMilli, match ? match.adjTotalMilli : null) },
      margin: { oursMilli: a.marginMilli, theirsMilli: match ? match.marginMilli : null, deltaMilli: delta(a.marginMilli, match ? match.marginMilli : null) },
      final: { oursPriceMilli: a.finalPriceMilli, theirsPriceMilli: match ? match.finalPriceMilli : null, deltaMilli: delta(a.finalPriceMilli, match ? match.finalPriceMilli : null) },
      clamped: { ours: a.clamped, theirs: match ? match.clamped : null },
    };
    row.worstDeltaMilli = worstOf(row);
    if (Math.abs(row.worstDeltaMilli) > Math.abs(worstDeltaMilli)) worstDeltaMilli = row.worstDeltaMilli;
    rungs.push(row);
  }

  const missingOurs = B.filter((_, i) => !usedB.has(i)).map((b) => b.rate);

  const digest = {
    eligibleOurs,
    eligibleTheirs,
    rungs,
    missingOurs,
    missingTheirs,
    worstDeltaMilli,
  };
  digest.toText = () => renderText(digest);
  return digest;
}

// A compact monospace table a human can scan. One block per coupon; deltas only where comparable.
function renderText(d) {
  const lines = [];
  const m = (v) => (isNum(v) ? String(v) : '—');
  lines.push(`elig ours=${d.eligibleOurs} theirs=${d.eligibleTheirs}  worstΔ=${d.worstDeltaMilli}`);
  for (const r of d.rungs) {
    lines.push(`coupon ${r.rate}${r.matched ? '' : ' (no LP match)'}  finalΔ=${m(r.final.deltaMilli)} worstΔ=${r.worstDeltaMilli}`);
    lines.push(`  base   ours=${m(r.base.oursPointsMilli)} lp=${m(r.base.theirsPointsMilli)} Δ=${m(r.base.deltaMilli)}`);
    for (const a of r.adjustments) {
      lines.push(`  ${(a.dimension || '?').padEnd(12)} ours=${m(a.oursMilli)} lp=${m(a.theirsMilli)} Δ=${m(a.deltaMilli)}`);
    }
    lines.push(`  adjTot ours=${m(r.adjustmentTotal.oursMilli)} lp=${m(r.adjustmentTotal.theirsMilli)} Δ=${m(r.adjustmentTotal.deltaMilli)}`);
    lines.push(`  margin ours=${m(r.margin.oursMilli)} lp=${m(r.margin.theirsMilli)} Δ=${m(r.margin.deltaMilli)}`);
    lines.push(`  final  ours=${m(r.final.oursPriceMilli)} lp=${m(r.final.theirsPriceMilli)} Δ=${m(r.final.deltaMilli)} clamped(ours=${r.clamped.ours},lp=${r.clamped.theirs})`);
  }
  if (d.missingOurs.length) lines.push(`LP-only coupons we did not price: ${d.missingOurs.join(', ')}`);
  if (d.missingTheirs.length) lines.push(`our coupons LP did not return: ${d.missingTheirs.join(', ')}`);
  return lines.join('\n');
}

module.exports = {
  buildRungDigest,
  _internals: { ourRungs, theirRungs, renderText, worstOf },
};
