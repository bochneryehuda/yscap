'use strict';
const quoteVerdict = require('./quote-verdict');
/**
 * LT PPE — the SIX difference detectors (Part 3 P3). PURE: no DB, no network. Compares OUR quote (from
 * quote.quoteProgram) against the RICH Lender Price shape (from lp-normalize-full.normalizeLpFull /
 * normalizeLpDisqualified) and reports, categorized, exactly where we are off — the owner's list:
 *
 *   base rate/price   → 'base_price'                 (our base grid vs LP's base points)
 *   final rate        → 'coupon_missing_ours/_lp'    (a coupon one engine offers and the other doesn't)
 *   coupons/price     → 'final_price'                (a matched coupon priced differently)
 *   margin            → 'margin'                     (our margin vs LP's holdback margin)
 *   some rules (LLPA) → 'llpa_total'                 (the LLPA stack total is off; LP's itemized list attached)
 *   missing disqual.  → 'disqualification_missing'   (LP declined a program we would have priced — the
 *                                                     dangerous direction; LP's reasons attached so a
 *                                                     rule can be SUGGESTED, disqualify-analysis P5)
 *                     → 'disqualification_extra'     (we declined a program LP priced)
 *
 * WHY (owner-directed 2026-08-17): "you should be a massive engine that dives into understanding how
 * Lender Price results look and look at what LLPA you are missing — if you are off with base rate,
 * final rate, coupons, margin, some rules, or missing disqualifications." This is that engine's
 * detection core. It DECIDES nothing and WRITES nothing — it reports differences; a human reviews and
 * accepts a suggested rule (P5/P7). Lender Price stays authoritative.
 *
 * TOLERANCES come from settings (validation.*), passed in by the caller: price / rate / margin /
 * base_price. A difference within tolerance is not reported. Rungs are matched by note rate (within the
 * rate tolerance). An UNKNOWN (a side that produced no comparable value) is never scored as agreement —
 * it is reported as its own difference so nothing silently passes.
 *
 * UNITS: everything is canonical integer milli (milli-percent rate, milli-points price/margin/LLPA),
 * matching quote.quoteProgram + lp-normalize-full.
 *
 * LT-only. No RTL imports.
 */

const PAR_MILLI = 100000;

const SEVERITY = { high: 3, medium: 2, low: 1 };

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// Default tolerances from a resolved settings map (settings.resolveAll(...).values), overridable by opts.
function tolerancesOf(opts) {
  const o = opts || {};
  const s = o.settings || {};
  const pick = (k, sk, d) => (isNum(o[k]) ? o[k] : (isNum(s[sk]) ? s[sk] : d));
  return {
    price: pick('priceToleranceMilli', 'validation.price_tolerance_milli', 1),
    rate: pick('rateToleranceMilli', 'validation.rate_tolerance_milli', 0),
    margin: pick('marginToleranceMilli', 'validation.margin_tolerance_milli', 0),
    basePrice: pick('basePriceToleranceMilli', 'validation.base_price_tolerance_milli', 1),
  };
}

// Index a rung list by rate for matching. Within a rate tolerance, the nearest rate wins.
function matchRung(lpRungs, rate, rateTol) {
  let best = null; let bestD = Infinity;
  for (const r of lpRungs) {
    if (!isNum(r.rate)) continue;
    const d = Math.abs(r.rate - rate);
    if (d <= rateTol && d < bestD) { best = r; bestD = d; }
  }
  return best;
}

/**
 * Detect all differences between our quote and Lender Price for ONE program.
 *   input:
 *     ours          — quote.quoteProgram result: { eligible, ladder:[<reconstruction record>], declines[] }
 *     lp            — one normalized LP program: { eligible?, rungs:[<rich rung>] }  (lp-normalize-full)
 *     lpDisqualified— normalizeLpDisqualified result for THIS program/investor: { declined:[{program, reasons[]}] }
 *   opts: { settings, priceToleranceMilli?, rateToleranceMilli?, marginToleranceMilli?, basePriceToleranceMilli? }
 *
 * Returns { verdict:'agree'|'disagree', differences:[{ category, severity, rate?, ourValue, lpValue,
 *          deltaMilli?, detail, lpReasons? }], summary:{ total, byCategory, worstSeverity } }
 */
function detectDifferences(input, opts) {
  const ours = (input && input.ours) || {};
  const lp = (input && input.lp) || {};
  const lpDisq = (input && input.lpDisqualified) || null;
  const tol = tolerancesOf(opts);
  const differences = [];
  const add = (category, severity, detail, extra) => differences.push({ category, severity, detail, ...(extra || {}) });

  const ourLadder = Array.isArray(ours.ladder) ? ours.ladder : [];
  const lpRungs = Array.isArray(lp.rungs) ? lp.rungs : [];
  const lpDeclinedThis = !!(lpDisq && Array.isArray(lpDisq.declined) && lpDisq.declined.length);
  const lpEligible = lp.eligible != null ? !!lp.eligible : lpRungs.length > 0;

  // ⛔ A SIDE THAT PRODUCED NO ANSWER IS NOT AGREEMENT — IT IS NOT COMPARABLE (§2.124, and the same
  // §10.6 rule `parity.compareScenario` has enforced since it was written).
  //
  // Suppressing the false "our engine priced it" finding above was only half the fix: with no
  // difference recorded, `finalize` returns `verdict:'agree'` — so a scenario our engine explicitly
  // REFUSED to price would be counted as the two engines agreeing, on the same board, feeding the
  // same agreement rate. Trading a confidently wrong disagreement for a confidently wrong agreement
  // is not a fix. It abstains instead, with the engine's OWN reason, so the scenario is visible as
  // unmeasured rather than folded into either column.
  if (quoteVerdict.couldNotPrice(ours)) {
    return {
      verdict: 'incomparable',
      incomparable: true,
      reason: (ours && (ours.reason || ours.summary)) || 'our engine produced no result to compare',
      differences: [],
      summary: { total: 0, byCategory: {}, worstSeverity: null },
    };
  }

  // --- Axis 1: eligibility vs disqualification -------------------------------
  // ⛔ `ours.eligible` ALONE IS NOT "we priced it" (§2.124). A quote whose price-bearing facts could
  // not be read comes back `eligible:true, priced:false, incomplete:true` — deliberately, because
  // refusing to price is not a decline and inventing one would fabricate a refusal we never made. So
  // this test used to report, at HIGH severity, "Lender Price declined this program; our engine
  // priced it" about a scenario our engine explicitly refused to price. That sentence lands in the
  // findings ledger and in the agreement rate the go-live gate reads. Measured on a scenario Lender
  // Price ITSELF accepts (an LP scenario carrying no `dscr`). `pricedAnswer` is the ONE reading and
  // it answers false for an undetermined quote.
  if (quoteVerdict.pricedAnswer(ours) && lpDeclinedThis) {
    const reasons = [];
    for (const d of lpDisq.declined) for (const r of (d.reasons || [])) reasons.push(r);
    if (lpRungs.length) {
      // LENDER PRICE CONTRADICTS ITSELF ACROSS THE PROGRAM FAMILY — it BOTH priced and declined.
      //
      // MEASURED LIVE 2026-08-17: Lender Price splits ONE Deephaven DSCR rate sheet into THREE
      // PROGRAMS by DSCR band. On a scenario with dscr = 1.25 it PRICES `DSCR 1.00-1.24` and
      // `DSCR < 1.00` (28 options each) while DECLINING `DSCR >= 1.25` with the reason
      // "DSCR >=1.25%  only eligible on this program". Our sheet models that family as ONE program
      // with the band as an additive adjustment, so it emits ONE answer: eligible.
      //
      // Reporting that as `disqualification_missing` is WRONG TWICE. (1) It reads as "we would price a
      // loan Lender Price declines", which is the dangerous direction — and it is not what happened;
      // the loan IS priceable at this investor, LP said so itself on the very same request. (2)
      // parity-review mines rule SUGGESTIONS from this category's `lpReasons`, so it would propose we
      // adopt "DSCR >=1.25% only eligible on this program" as an ELIGIBILITY RULE. That sentence is a
      // statement about LP's own program partitioning, not about the borrower; adopting it would make
      // our engine DECLINE loans Deephaven genuinely prices.
      //
      // It is NOT downgraded to agreement, and that restraint is the point: a family where one band
      // declines and another prices leaves a real open question — WHICH band is authoritative, and is
      // LP's priced answer a "leaked price" from the wrong container (§1a of the live findings)? That
      // is a business question about the investor's own product split, and the standing rule is never
      // to guess one. So it stays a `high` difference and still fails the gate; it is only NAMED
      // honestly, so a human sees "LP contradicts itself across bands" instead of "our engine is
      // dangerous", and the miner leaves it alone.
      add('disqualification_split', 'high',
        'Lender Price both PRICED and DECLINED this program family (it splits one sheet across several programs); which band governs is unresolved',
        { lpReasons: reasons, ourValue: 'eligible', lpValue: 'priced_and_declined',
          lpDeclinedPrograms: lpDisq.declined.map((d) => d.program).filter(Boolean), lpPricedRungs: lpRungs.length });
      return finalize(differences); // still an eligibility disagreement; the price axes are moot
    }
    // The dangerous direction: LP declined EVERYTHING in scope and we would still price it. Attach
    // LP's reasons so a per-investor rule can be suggested (disqualify-analysis / crosswalk).
    add('disqualification_missing', 'high', 'Lender Price declined this program; our engine priced it', { lpReasons: reasons, ourValue: 'eligible', lpValue: 'declined' });
    return finalize(differences); // an eligibility disagreement dominates; the price axes are moot
  }
  if (!ours.eligible && lpEligible && !lpDeclinedThis) {
    add('disqualification_extra', 'high', 'Our engine declined this program; Lender Price priced it', { ourValue: 'declined', lpValue: 'eligible', ourReasons: ours.declines || [] });
    return finalize(differences);
  }
  if (!ours.eligible && !lpEligible) {
    // both decline — agree on the outcome (reason-set comparison is a later refinement)
    return finalize(differences);
  }

  // --- Axes 2–6: both eligible → compare the rungs ---------------------------
  const seenLpRates = new Set();
  for (const our of ourLadder) {
    if (!isNum(our.rate)) continue;
    const lpr = matchRung(lpRungs, our.rate, tol.rate);
    if (!lpr) { add('coupon_missing_lp', 'low', `we price coupon ${our.rate} that Lender Price does not offer`, { rate: our.rate }); continue; }
    seenLpRates.add(lpr.rate);

    // base price: our base grid vs LP's base points (base price = par − base points)
    if (isNum(our.basePriceMilli) && isNum(lpr.basePointsMilli)) {
      const lpBasePrice = PAR_MILLI - lpr.basePointsMilli;
      const d = our.basePriceMilli - lpBasePrice;
      if (Math.abs(d) > tol.basePrice) add('base_price', 'medium', `base price differs at coupon ${our.rate}`, { rate: our.rate, ourValue: our.basePriceMilli, lpValue: lpBasePrice, deltaMilli: d });
    }
    // final price
    if (isNum(our.finalPriceMilli) && isNum(lpr.priceMilli)) {
      const d = our.finalPriceMilli - lpr.priceMilli;
      if (Math.abs(d) > tol.price) add('final_price', 'medium', `final price differs at coupon ${our.rate}`, { rate: our.rate, ourValue: our.finalPriceMilli, lpValue: lpr.priceMilli, deltaMilli: d });
    }
    // margin
    if (isNum(our.marginMilli) && isNum(lpr.marginMilli)) {
      const d = our.marginMilli - lpr.marginMilli;
      if (Math.abs(d) > tol.margin) add('margin', 'medium', `margin differs at coupon ${our.rate}`, { rate: our.rate, ourValue: our.marginMilli, lpValue: lpr.marginMilli, deltaMilli: d });
    } else if (isNum(lpr.marginMilli) && !isNum(our.marginMilli)) {
      add('margin', 'medium', `Lender Price applied a margin we do not`, { rate: our.rate, ourValue: null, lpValue: lpr.marginMilli });
    }
    // LLPA stack total (rules). Our adjustmentCostMilli is cost-positive points, same convention as LP's adjustmentPoints.
    const ourLlpa = isNum(our.adjustmentCostMilli) ? our.adjustmentCostMilli : (isNum(our.adjustmentPointsMilli) ? our.adjustmentPointsMilli : null);
    if (isNum(ourLlpa) && isNum(lpr.adjustmentPointsMilli)) {
      const d = ourLlpa - lpr.adjustmentPointsMilli;
      if (Math.abs(d) > tol.price) add('llpa_total', 'medium', `the LLPA stack total differs at coupon ${our.rate}`, { rate: our.rate, ourValue: ourLlpa, lpValue: lpr.adjustmentPointsMilli, deltaMilli: d, lpLlpas: lpr.llpas || [] });
    }
  }
  // coupons Lender Price offers that we never priced (borrower loses an option) — the high-severity gap
  for (const lpr of lpRungs) {
    if (!isNum(lpr.rate) || seenLpRates.has(lpr.rate)) continue;
    const ourHas = ourLadder.some((o) => isNum(o.rate) && Math.abs(o.rate - lpr.rate) <= tol.rate);
    if (!ourHas) add('coupon_missing_ours', 'high', `Lender Price offers coupon ${lpr.rate} that we do not price`, { rate: lpr.rate, lpValue: lpr.priceMilli });
  }

  return finalize(differences);
}

function finalize(differences) {
  const byCategory = {};
  let worst = 0;
  for (const d of differences) {
    byCategory[d.category] = (byCategory[d.category] || 0) + 1;
    worst = Math.max(worst, SEVERITY[d.severity] || 0);
  }
  const worstSeverity = worst === 3 ? 'high' : worst === 2 ? 'medium' : worst === 1 ? 'low' : null;
  return {
    verdict: differences.length ? 'disagree' : 'agree',
    differences,
    summary: { total: differences.length, byCategory, worstSeverity },
  };
}

module.exports = { detectDifferences, SEVERITY, _internals: { tolerancesOf, matchRung } };
