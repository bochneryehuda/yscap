'use strict';
/**
 * LT PPE — divergence DIAGNOSIS (§10.1/§10.4): make one shadow disagreement actionable for a human.
 *
 * `parity.compareScenario` says THAT our price disagrees with Lender Price and by how much; `pricing.
 * priceRung` records HOW our number was built (base → itemized LLPA stack → margin/comp/srp → round →
 * clamp — the §5.4 reconstruction record). This module puts the two together: it shows the reviewer our
 * full build-up beside Lender Price's single number and points at the ONE component whose magnitude most
 * closely matches the gap — the first thing to check.
 *
 * HONESTY (the whole reason this is careful): Lender Price returns only a FINAL price, never its own
 * breakdown. So a "suspect" here is a HYPOTHESIS ranked purely by numeric proximity to the gap, labeled
 * as such — never a claim that our number or theirs is wrong. `confidence:'strong'` means a single
 * component EXACTLY equals the gap (it fully accounts for it); `'possible'` means within tolerance;
 * `'none'` means no single component matches, so the gap is spread across several or lives in the base
 * rate sheet. Pure + offline-testable. LT-only; no RTL import.
 */

const PAR_MILLI = 100000;

function isMilli(v) { return typeof v === 'number' && Number.isFinite(v); }
function abs(n) { return Math.abs(n); }

// A component of our reconstruction that could account for a price gap, with a human label.
function componentsOf(rec) {
  const out = [];
  const push = (component, label, magnitudeMilli) => {
    if (isMilli(magnitudeMilli) && magnitudeMilli !== 0) out.push({ component, label, magnitudeMilli: abs(magnitudeMilli) });
  };
  // Each itemized LLPA is its own suspect (the most common real cause of a small gap).
  for (const a of Array.isArray(rec.adjustments) ? rec.adjustments : []) {
    push('adjustment', `LLPA ${a.code || a.category || 'adjustment'}`, a.costMilli);
  }
  push('margin', 'margin', rec.marginMilli);
  push('comp', 'compensation', rec.compMilli);
  push('srp', 'servicing-release premium', rec.srpMilli);
  // Structural effects the pipeline applied — each can be exactly the size of a gap.
  if (rec.adjustmentCapped) push('adjustment_cap', 'cumulative-adjustment cap', rec.adjustmentCostRawMilli - rec.adjustmentCostMilli);
  if (rec.clamped) push('clamp', 'price floor/cap clamp', rec.finalPriceMilli - rec.roundedPriceMilli);
  if (isMilli(rec.rawPriceMilli) && isMilli(rec.roundedPriceMilli) && rec.rawPriceMilli !== rec.roundedPriceMilli) {
    push('rounding', 'rounding', rec.roundedPriceMilli - rec.rawPriceMilli);
  }
  return out;
}

// The one build-up view a reviewer reads (all cost-positive; a cost lowers the price).
function buildUpOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  return {
    basePriceMilli: isMilli(rec.basePriceMilli) ? rec.basePriceMilli : null,
    adjustmentCostMilli: isMilli(rec.adjustmentCostMilli) ? rec.adjustmentCostMilli : null,
    marginMilli: isMilli(rec.marginMilli) ? rec.marginMilli : null,
    compMilli: isMilli(rec.compMilli) ? rec.compMilli : null,
    srpMilli: isMilli(rec.srpMilli) ? rec.srpMilli : null,
    roundingDeltaMilli: (isMilli(rec.roundedPriceMilli) && isMilli(rec.rawPriceMilli)) ? rec.roundedPriceMilli - rec.rawPriceMilli : null,
    clampDeltaMilli: (isMilli(rec.finalPriceMilli) && isMilli(rec.roundedPriceMilli)) ? rec.finalPriceMilli - rec.roundedPriceMilli : null,
    finalPriceMilli: isMilli(rec.finalPriceMilli) ? rec.finalPriceMilli : null,
  };
}

function fmt(milli) { return isMilli(milli) ? (milli / 1000).toFixed(3) : '?'; }

/**
 * Diagnose one PRICE disagreement.
 *   finding — a parity price_mismatch: { kind, rate, ourPriceMilli, theirPriceMilli, deltaMilli }
 *   rec     — OUR pricing.priceRung reconstruction record for that rung (may be null/absent)
 *   opts    — { toleranceMilli = 1 } the "possible" band for matching a component to the gap.
 * Returns { kind, rate, gapMilli, direction, buildUp, candidates[], topSuspect, confidence, summary }.
 */
function explainPriceDivergence(finding = {}, rec = null, opts = {}) {
  const tol = isMilli(opts.toleranceMilli) ? abs(opts.toleranceMilli) : 1;
  const gapMilli = isMilli(finding.deltaMilli) ? finding.deltaMilli
    : ((isMilli(finding.ourPriceMilli) && isMilli(finding.theirPriceMilli)) ? finding.ourPriceMilli - finding.theirPriceMilli : null);
  const direction = gapMilli == null ? null : (gapMilli > 0 ? 'ours_higher' : (gapMilli < 0 ? 'ours_lower' : 'equal'));

  const buildUp = buildUpOf(rec);
  // Rank our components by how close their magnitude is to the size of the gap.
  let candidates = [];
  if (rec && gapMilli != null) {
    const g = abs(gapMilli);
    candidates = componentsOf(rec)
      .map((c) => ({ ...c, distanceToGap: abs(c.magnitudeMilli - g) }))
      .sort((a, b) => a.distanceToGap - b.distanceToGap || b.magnitudeMilli - a.magnitudeMilli);
  }
  const topSuspect = candidates.length ? candidates[0] : null;
  let confidence = 'none';
  if (topSuspect) {
    if (topSuspect.distanceToGap === 0) confidence = 'strong';
    else if (topSuspect.distanceToGap <= tol) confidence = 'possible';
  }

  let summary;
  if (gapMilli == null) {
    summary = 'No price gap could be measured (a side is missing a number).';
  } else {
    const dirWord = direction === 'ours_higher' ? 'higher' : (direction === 'ours_lower' ? 'lower' : 'the same as');
    summary = `Our price is ${fmt(abs(gapMilli))} pts ${dirWord} than Lender Price (coupon ${finding.rate}).`;
    if (!rec) {
      summary += ' Our reconstruction record is unavailable, so the cause cannot be narrowed.';
    } else if (confidence === 'strong') {
      summary += ` The gap exactly equals our ${topSuspect.label} (${fmt(topSuspect.magnitudeMilli)} pts) — most likely Lender Price treats that one differently; check it first.`;
    } else if (confidence === 'possible') {
      summary += ` The closest single cause is our ${topSuspect.label} (${fmt(topSuspect.magnitudeMilli)} pts, ~${fmt(topSuspect.distanceToGap)} pts off) — a likely place to look.`;
    } else {
      summary += ' No single component of our build-up matches the gap — it is spread across several, or the base rate sheet differs.';
    }
  }

  return { kind: 'price_mismatch', rate: finding.rate, gapMilli, direction, buildUp, candidates, topSuspect, confidence, summary };
}

// A rate disagreement (a coupon priced to a different note rate) or a missing rung — no reconstruction
// math applies, so this is a plain-language framing that keeps the review queue uniform.
function explainSimple(finding = {}) {
  const k = finding.kind;
  if (k === 'rung_missing_ours') {
    return { kind: k, rate: finding.rate, summary: `Lender Price returned coupon ${finding.rate} that our engine did not price — a coverage gap (a missing rung, guideline, or base-sheet row).` };
  }
  if (k === 'rung_missing_theirs') {
    return { kind: k, rate: finding.rate, summary: `We priced coupon ${finding.rate} that Lender Price did not return — check eligibility: we may be offering a rung they exclude.` };
  }
  if (k === 'eligibility_mismatch') {
    return { kind: k, summary: 'Our eligibility decision disagrees with Lender Price — compare the rule trace (rules.evaluateRules) against their reasons.' };
  }
  if (k === 'rate_mismatch') {
    return { kind: k, rate: finding.rate, summary: `The note rate disagrees on coupon ${finding.rate} — check the rate/point ladder derivation.` };
  }
  if (k === 'engine_error') {
    return { kind: k, summary: `Our engine threw while pricing (${finding.side || 'ours'}) — this is our bug to fix, not a Lender Price disagreement: ${finding.detail || ''}`.trim() };
  }
  return { kind: k || 'unknown', summary: 'Unrecognized finding kind — no diagnosis available.' };
}

/**
 * Dispatch a finding to the right explanation.
 *   opts.reconstruction — OUR priceRung record for a price_mismatch (optional).
 */
function diagnose(finding = {}, opts = {}) {
  if (finding.kind === 'price_mismatch') return explainPriceDivergence(finding, opts.reconstruction || null, opts);
  return explainSimple(finding);
}

/**
 * Attach one `explanation` per finding, in place, from our own reconstruction.
 *
 * THE RUNG IS MATCHED BY EXACT COUPON, and abstains otherwise. A near-match would diagnose the gap on
 * a rate the finding is not about — every LLPA and the margin would be read off the wrong rung — and
 * `divergence` would then name a suspect with full confidence. No rung is the honest answer, and the
 * module already words it: "our reconstruction record is unavailable, so the cause cannot be narrowed".
 *
 * IT CAN NEVER BREAK A COMPARISON. A diagnosis is a convenience laid on top of a verdict that has
 * already been reached; if it throws, the finding stands exactly as it was.
 *
 * ⛔ IT LIVES HERE, NOT IN ONE CALLER (§2.78). It was written inside `facade.js` — the LIVE shadow path,
 * which needs vendor credentials — so the CANARY, the owner's daily check that actually runs six times
 * a day and fills the review queue, recorded WHAT disagreed and never WHY. Measured: a canary run with a
 * 250-milli price gap and a 250-milli margin recorded `price_mismatch, deltaMilli -250` with no
 * explanation at all, while this module would have named the margin as exactly accounting for it.
 *
 * The evidence exists for BOTH paths at the same moment and nowhere afterwards — the ledger stores
 * `our_payload` as NULL, so a later screen re-deriving this would have to re-price against whatever the
 * sheet says today and quietly answer a different question. So the attach is one function with two
 * callers rather than a second copy inside the runner.
 */
function attachDiagnosis(cmp, ourQuote, cmpOpts) {
  if (!cmp || !Array.isArray(cmp.findings) || !cmp.findings.length) return;
  const ladder = (ourQuote && Array.isArray(ourQuote.ladder)) ? ourQuote.ladder : [];
  for (const f of cmp.findings) {
    if (!f || typeof f !== 'object') continue;
    try {
      const rung = (f.rate != null) ? ladder.find((r) => r && r.rate === f.rate) : null;
      f.explanation = diagnose(f, {
        reconstruction: rung || null,
        toleranceMilli: cmpOpts && cmpOpts.priceToleranceMilli,
      });
    } catch (_) { /* a diagnosis must never cost a verdict that has already been reached */ }
  }
}

module.exports = {
  PAR_MILLI,
  diagnose, explainPriceDivergence, explainSimple, attachDiagnosis,
  _internals: { componentsOf, buildUpOf },
};
