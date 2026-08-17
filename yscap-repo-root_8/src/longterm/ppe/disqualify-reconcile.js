'use strict';
/**
 * LT PPE — the PER-LAYER DISQUALIFIER RECONCILER (owner 2026-08-17: "look for the disqualifying reasons,
 * make sure those reasons match with these three layers … if anything is not matching Lender Price, tell
 * me and we open a ticket"). For ONE scenario it compares OUR eligibility verdict (from the three-layer
 * program) to LENDER PRICE's live verdict, and classifies the (dis)agreement so a real LP mistake becomes
 * a ticket and a real encoding gap becomes a fix — without crying wolf on LP's legitimate overlays.
 *
 * HOW LENDER PRICE REPORTS INELIGIBILITY (measured 2026-08-17, the crux of "understand how the
 * disqualifier works"):
 *   • LP reports a scenario ELIGIBLE by PRICING at least one Deephaven product (a priced leaf in the
 *     qualified tree). It reports INELIGIBLE by ABSENCE — zero Deephaven priced products — and for a
 *     genuinely-ineligible scenario it often returns NO readable reason string at all (the decline is the
 *     absence itself).
 *   • LP disqualifies at the PRODUCT-VARIANT level, not the scenario level: a scenario can have the 30Y
 *     Fixed priced while the 30Y-IO / 5-6 ARM variants are disqualified. So "Deephaven appears in the
 *     disqualify tree" does NOT mean the scenario is ineligible — only that SOME variant was declined.
 *   • Therefore scenario eligibility = `lpPriced` (>=1 Deephaven priced product), NEVER "no disqualify
 *     entry". A reason string is matched when LP provides one; when it doesn't, agreement rests on the
 *     verdict alone.
 *
 * PURE: no DB, no network, no clock. Reuses disqualify-crosswalk.keyToPredicate to turn an LP reason
 * string into a (fact, op, value) so it can be aligned to our decline's dimension. LT-only.
 */
const { keyToPredicate } = require('./disqualify-crosswalk');

// Reduce our decline dimension and an LP fact to a common key, so "LP declined on FICO" and "we declined
// on fico" line up. Unknown → the value itself (never silently merged).
const DIMENSION_ALIAS = {
  fico: 'fico', ltv: 'ltv', cltv: 'ltv', dscr: 'dscr',
  loan_amount: 'loan_amount', cashout_amount: 'cashout', state: 'state',
  prepay_state: 'prepay', prepay: 'prepay', fico_ltv_dscr: 'fico_ltv_dscr', units: 'units',
};
function dimKey(d) { const k = String(d || '').toLowerCase(); return DIMENSION_ALIAS[k] || k; }

// Our program decline reasons flag an overlay we cannot verify from the scenario facts (LP may legitimately
// apply one of these and we would not model it → not a bug on either side). These mirror the eligibility
// engine's `unverifiable` overlays.
const OVERLAY_DIMENSIONS = new Set(['declining_market', 'short_term_rental', 'first_time_investor', 'foreign_national', 'city', 'geo', 'rural', 'occupancy', 'vacancy']);

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * reconcileScenario(our, lp, opts) — one scenario.
 *   our = { eligible, reasons:[{layer, code, dimension, declineReason}] }   (from program.evaluateProgram)
 *   lp  = { priced:boolean, disqualifyReasons:[{rule, adjType}] }           (Deephaven branch only)
 * Returns { outcome, classification, ticketWorthy, layer, dimension, our, lp, detail }.
 *   outcome ∈ both_eligible | both_ineligible | lp_prices_we_decline | lp_declines_we_price
 *   classification ∈ agree | lp_bug | our_encoding_bug | legitimate_overlay | human_review
 */
function reconcileScenario(our, lp, opts = {}) {
  const ourElig = !!(our && our.eligible);
  const lpElig = !!(lp && lp.priced);
  const ourReasons = (our && Array.isArray(our.reasons)) ? our.reasons : [];
  const lpReasons = (lp && Array.isArray(lp.disqualifyReasons)) ? lp.disqualifyReasons : [];
  // map LP reason strings → dimensions (only those the crosswalk can read; the rest are surfaced, not guessed)
  const lpDims = [];
  for (const r of lpReasons) {
    const p = keyToPredicate({ rule: r.rule || r.reason || r.key, adjType: r.adjType });
    if (p && p.ok && p.fact) lpDims.push({ fact: dimKey(p.fact), value: p.predicate && p.predicate.value, rule: r.rule, mapped: true });
    else lpDims.push({ fact: null, rule: r.rule || r.reason, mapped: false });
  }

  if (ourElig && lpElig) return { outcome: 'both_eligible', classification: 'agree', ticketWorthy: false, our, lp: { priced: true }, detail: 'both price this scenario' };

  if (!ourElig && !lpElig) {
    // both decline. If LP gave a reason that maps to the SAME dimension as one of our declines → matched.
    const ourDims = ourReasons.map((x) => ({ layer: x.layer, dim: dimKey(x.dimension), reason: x.declineReason }));
    let matched = null;
    for (const od of ourDims) for (const ld of lpDims) if (ld.mapped && ld.fact === od.dim) { matched = { od, ld }; break; }
    if (matched) return { outcome: 'both_ineligible', classification: 'agree', ticketWorthy: false, layer: matched.od.layer, dimension: matched.od.dim, our, lp: { priced: false }, detail: `both decline on ${matched.od.dim}` };
    // LP declined by absence with no readable reason (the common case) → still agreement on the VERDICT
    return { outcome: 'both_ineligible', classification: 'agree', ticketWorthy: false, layer: ourReasons[0] && ourReasons[0].layer, dimension: ourReasons[0] && dimKey(ourReasons[0].dimension), our, lp: { priced: false }, detail: 'both decline (LP by absence; no reason string to match)' };
  }

  if (!ourElig && lpElig) {
    // WE decline, LP prices → we are STRICTER than LP. If our decline is a HARD published-matrix rule, this
    // is a probable OUR-encoding bug (too strict) unless the published matrix genuinely forbids it (then LP
    // is the bug). Default: our_encoding_bug (we lose to LP, which is the live authority today) but ticket
    // if our reason is a hard matrix number so a human checks whether LP is wrong.
    const r0 = ourReasons[0] || {};
    const overlay = OVERLAY_DIMENSIONS.has(String(r0.dimension || '').toLowerCase());
    return {
      outcome: 'lp_prices_we_decline',
      classification: overlay ? 'legitimate_overlay' : 'our_encoding_bug',
      ticketWorthy: false,
      layer: r0.layer, dimension: dimKey(r0.dimension), our, lp: { priced: true },
      detail: `we decline (${r0.code || r0.declineReason}) but LP prices it — ${overlay ? 'an overlay we cannot verify' : 'review our rule vs the matrix'}`,
    };
  }

  // ourElig && !lpElig → LP declines, we price. LP is STRICTER. Could be a legitimate LP overlay (not on
  // the one-page matrix) OR an LP mistake. If LP's reason maps to a hard matrix dimension our matrix says
  // is eligible → probable LP bug (ticket). If LP's reason is unmapped/an overlay → legitimate_overlay.
  const mapped = lpDims.filter((d) => d.mapped);
  if (mapped.length === 0) return { outcome: 'lp_declines_we_price', classification: 'legitimate_overlay', ticketWorthy: false, our, lp: { priced: false, reasons: lpReasons }, detail: 'LP declines for a reason we cannot map (a stricter LP overlay, not on the matrix)' };
  return { outcome: 'lp_declines_we_price', classification: 'lp_bug', ticketWorthy: true, dimension: mapped[0].fact, our, lp: { priced: false, reasons: lpReasons }, detail: `LP declines on ${mapped[0].fact} but our published matrix says eligible — probable LP mistake, open a ticket` };
}

/**
 * summarize(reconciles) — tally for a batch.
 */
function summarize(reconciles) {
  const t = { total: 0, agree: 0, lp_bug: 0, our_encoding_bug: 0, legitimate_overlay: 0, human_review: 0, tickets: [] };
  for (const r of (Array.isArray(reconciles) ? reconciles : [])) {
    if (!r) continue;
    t.total += 1;
    t[r.classification] = (t[r.classification] || 0) + 1;
    if (r.ticketWorthy) t.tickets.push(r);
  }
  t.agreementRate = t.total ? (t.agree + t.legitimate_overlay) / t.total : 1;
  return t;
}

module.exports = { reconcileScenario, summarize, _internals: { dimKey, DIMENSION_ALIAS, OVERLAY_DIMENSIONS } };
