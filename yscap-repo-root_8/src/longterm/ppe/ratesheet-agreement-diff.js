'use strict';
/**
 * LT PPE — the two PURE comparators for the ≥200-scenario Lender Price AGREEMENT harness (E3 gate,
 * owner HARD RULE 2026-08-17: agree with Lender Price on every LLPA + max/min price, to the penny,
 * BEFORE a rate sheet is built in). Design: docs/longterm/ppe-research/LENDER-PRICE-AGREEMENT-HARNESS.md
 * §3 (max/min) and §4 (itemized per-LLPA). PURE: no DB, no network, no clock.
 *
 * `parity-detectors.detectDifferences` already compares the LLPA STACK TOTAL and the final price. These
 * two go finer, because a total can agree while two cell errors cancel:
 *   • reconcileLlpas — every INDIVIDUAL LLPA must line up one-for-one, by DIMENSION. Our Deephaven grid
 *     folds FICO×CLTV×DSCR into ONE cell, while Lender Price itemizes fico/cltv/dscr/cap separately, so
 *     the crosswalk maps all of those to the single `fico_cltv_dscr` dimension and the PER-DIMENSION SUM
 *     does the aggregation (LP's several items must sum to our one cell). An unknown LP adjType becomes
 *     its own `other:<reason>` key — never silently merged into another dimension.
 *   • boundsProbe — the cap (max price) and floor (min price) fired to the SAME number LP landed on.
 *
 * UNITS + SIGN (the engine's, shared by both sides): points in integer milli; a stored `adjMilli`
 * (ours) and LP's `valueMilli` are both COST-POSITIVE points (a positive value worsens the price), so
 * they compare directly with no sign flip. LT-only. No RTL imports.
 */

// LP adjType / group / reason → our rate-sheet dimension. The FICO×CLTV×DSCR grid is ONE dimension on
// our side, so every leverage/credit/dscr adjType folds into it; the rest map one-to-one. This is a
// CURATED table (never a guess): an unrecognized adjType returns null and the caller keys it as
// `other:<reason>` so it is surfaced, not absorbed.
const ADJTYPE_TO_DIMENSION = {
  ficorateadjustment: 'fico_cltv_dscr',
  fico: 'fico_cltv_dscr',
  cltv: 'fico_cltv_dscr',
  ltv: 'fico_cltv_dscr',
  capadjustment: 'fico_cltv_dscr',
  dscrrateadjustment: 'fico_cltv_dscr',
  dscr: 'fico_cltv_dscr',
  loanamountrateadjustment: 'loan_amount',
  loanamount: 'loan_amount',
  statesrateadjustment: 'state',
  state: 'state',
  states: 'state',
  prepayrateadjustment: 'prepay',
  prepay: 'prepay',
  propertytyperateadjustment: 'property_type',
  propertytype: 'property_type',
  purposerateadjustment: 'purpose',
  purpose: 'purpose',
  loanpurpose: 'purpose',
  unitsrateadjustment: 'units',
  units: 'units',
};

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

// The dimension key for an LP LLPA: its adjType first, then its group, then null (→ other:<reason>).
function lpLlpaDimension(llpa) {
  if (!llpa || typeof llpa !== 'object') return null;
  const byType = ADJTYPE_TO_DIMENSION[norm(llpa.adjType)];
  if (byType) return byType;
  const byGroup = ADJTYPE_TO_DIMENSION[norm(llpa.group)];
  if (byGroup) return byGroup;
  return null;
}

function isNum(x) { return typeof x === 'number' && Number.isFinite(x); }

// REASON-AWARE dimension classifier for the LIVE Deephaven sheet (measured 2026-08-17). The default
// crosswalk keys on adjType alone, which is WRONG for Deephaven because one adjType carries two
// different LLPAs: FicoRateAdjustment is BOTH the FICO×CLTV cell ("DSCR (All)") and cash-out ("Cash
// Out Refinance"), and SimpleRateAdjustment is BOTH the DSCR band ("DSCR Ratio") and the prepay penalty
// ("5 Year Prepay"). And our real grid keeps FICO / DSCR / STATE as SEPARATE dimensions (it does NOT
// fold DSCR into the FICO cell), so the classifier must too. Pass this as reconcileLlpas' opts.dimensionOf.
function deephavenLpDimension(llpa) {
  if (!llpa || typeof llpa !== 'object') return null;
  const t = norm(llpa.adjType);
  const r = String(llpa.reason || '');
  if (t === 'ficorateadjustment') {
    if (/cash\s*out/i.test(r)) return 'cashout';
    return 'fico_cltv_dscr'; // "DSCR (All) - <fico> / CLTV <band>"
  }
  if (t === 'simplerateadjustment') {
    if (/dscr\s*ratio/i.test(r)) return 'dscr';
    if (/prepay/i.test(r)) return 'prepay';
    // the three "Other - …" add-on families measured live 2026-08-17, all SimpleRateAdjustment.
    if (/interest\s*only/i.test(r)) return 'interest_only';
    if (/escrow\s*waiver/i.test(r)) return 'escrow_waiver';   // kept: a SimpleRateAdjustment-shaped one

    if (/non.?warrantable/i.test(r)) return 'non_warrantable';
    // Short-Term Rental — the sheet's "Rental Type" row. The VALUES are the sheet's, but LP's own
    // adjType for this family is UNCONFIRMED (never probed live), so this branch is keyed on the reason
    // and grouped with its measured "Other - …" siblings. If LP turns out to use a different adjType the
    // classifier falls through to `other:<reason>`, which SURFACES as a disagreement rather than being
    // silently merged — the fail-safe this whole reconciliation is built on. See sheet UNMEASURED.
    if (/short.?term\s*rental/i.test(r)) return 'short_term_rental';
    return `other:${norm(r) || 'simple'}`;
  }
  // MEASURED LIVE 2026-08-17: escrow waiver has its OWN adjType, `EscrowWaiverRateAdjustment` — it is
  // NOT a SimpleRateAdjustment, so the reason-keyed branch above never saw it and every escrow line fell
  // through to `other:<reason>`, reporting our line as EXTRA and LP's as MISSING with the SAME value
  // (250) on both sides. That is the classifier's documented fail-safe working exactly as intended: an
  // unknown adjType SURFACES as a disagreement instead of being silently merged. This is that surfaced
  // disagreement being resolved with the real value, not the fail-safe being loosened.
  if (t === 'escrowwaiverrateadjustment') return 'escrow_waiver';
  if (t === 'statesrateadjustment') return 'state';
  if (t === 'loanamountrateadjustment') return 'loan_amount';
  if (/condo/i.test(t)) return 'property_type';
  if (/unit/i.test(t)) return 'units'; // UnitRateAdjustment — "Other - 2-4 Units / CLTV <band>"
  return lpLlpaDimension(llpa); // fall back to the adjType-only crosswalk
}

/**
 * Itemized per-dimension LLPA reconciliation for ONE matched rung pair.
 *   ourAdjustments — ours.ladder[r].adjustments[]  ({ dimension, adjMilli, reason, code })
 *   lpLlpas        — lp.rungs[r].llpas[]           ({ adjType, group, reason, valueMilli })
 *   opts.dimensionOf(llpa) — optional classifier for the LP side (default: lpLlpaDimension, the
 *     adjType-only crosswalk). The live Deephaven harness passes deephavenLpDimension (reason-aware).
 *   opts.ignore — optional Set/array of dimensions to DROP from the LP side before comparing (e.g.
 *     'prepay' while our sheet does not model prepay yet — so a known-unmodelled axis is not counted as
 *     a disagreement, but is still surfaced separately by the caller).
 * Returns { itemized:[{ dimension, ourMilli, lpMilli, deltaMilli, ourReason, lpReason }], agree,
 *           worstDeltaMilli }. `agree` is true only when EVERY row's deltaMilli === 0.
 */
function reconcileLlpas(ourAdjustments, lpLlpas, opts = {}) {
  const dimensionOf = typeof opts.dimensionOf === 'function' ? opts.dimensionOf : lpLlpaDimension;
  const ignore = opts.ignore instanceof Set ? opts.ignore : new Set(Array.isArray(opts.ignore) ? opts.ignore : []);
  const ours = new Map();   // dimension -> { milli, reasons:Set }
  const theirs = new Map();
  for (const a of (Array.isArray(ourAdjustments) ? ourAdjustments : [])) {
    if (!a || typeof a !== 'object') continue;
    const dim = a.dimension || 'other:unknown';
    const v = isNum(a.adjMilli) ? a.adjMilli : 0;
    const cur = ours.get(dim) || { milli: 0, reasons: new Set() };
    cur.milli += v; if (a.reason) cur.reasons.add(String(a.reason));
    ours.set(dim, cur);
  }
  for (const l of (Array.isArray(lpLlpas) ? lpLlpas : [])) {
    if (!l || typeof l !== 'object') continue;
    const dim = dimensionOf(l) || `other:${norm(l.reason) || 'unknown'}`;
    if (ignore.has(dim)) continue;
    const v = isNum(l.valueMilli) ? l.valueMilli : 0;
    const cur = theirs.get(dim) || { milli: 0, reasons: new Set() };
    cur.milli += v; if (l.reason) cur.reasons.add(String(l.reason));
    theirs.set(dim, cur);
  }
  const keys = new Set([...ours.keys(), ...theirs.keys()]);
  const itemized = [];
  let worst = 0;
  // ---- THE ITEMIZED AXIS COMPARES MAGNITUDES, BECAUSE LENDER PRICE PUBLISHES NO DIRECTION ---------
  //
  // WHAT WENT WRONG. This compared our SIGNED value against LP's `valueMilli`, and LP's itemized value is
  // an absolute MAGNITUDE — it never carries a sign. Our values are cost-positive, so a CREDIT is
  // negative. Measured over the live 299-scenario battery: 13,244 lines matched, and **8,344 lines were
  // flagged where `ours === -lp` EXACTLY** — that is, every credit in the book, reported as a value
  // disagreement it never was. The remaining 140 were one escrow band the classifier could not key (same
  // value on both sides). Genuine value disagreements: ZERO. The run printed 20.34% agreement.
  //
  // It read as a catastrophic regression and was the opposite: it appeared only AFTER the sheet's signs
  // were CORRECTED (the 2026-08-17 rebuild). Before that, `cost(v) = -v` made every value positive, so
  // credits collided with LP's magnitudes and "matched" — the comparator agreed with a sheet that
  // mispriced every strong-credit loan by twice the cell value.
  //
  // SO WHY IS COMPARING MAGNITUDES NOT THE SAME BLINDNESS AGAIN? Because DIRECTION IS NOT KNOWABLE ON
  // THIS AXIS AT ALL — LP does not publish it, so no comparison here can test it, and pretending
  // otherwise is what produced a confident wrong verdict. Direction is proven where the direction
  // actually lives, and proven harder: `test-lt-ppe-deephaven-dscr-sheet.js` asserts every cell against
  // the Excel's own SIGNED value ON THE COMPOSED PRICE (a credit must improve it, a charge must worsen
  // it) and ties four live Lender Price prices to the penny. This axis answers "are the same adjustments
  // applied, at the same size"; that suite answers "in the right direction". Do NOT re-add a signed
  // comparison here — it can only ever re-flag every credit.
  //
  // Our SIGNED value rides along as `ourSignedMilli` so a human reading a report still sees the
  // direction we applied, and `credits` counts them, so a book that suddenly has no credits at all is
  // visible rather than silent.
  let credits = 0;
  for (const dim of [...keys].sort()) {
    const o = ours.get(dim);
    const t = theirs.get(dim);
    const ourSignedMilli = o ? o.milli : null;
    // LP's side is already a magnitude; ours is normalized to one for the comparison.
    const ourMilli = o ? Math.abs(o.milli) : null;
    const lpMilli = t ? Math.abs(t.milli) : null;
    if (ourSignedMilli != null && ourSignedMilli < 0) credits += 1;
    const deltaMilli = (ourMilli || 0) - (lpMilli || 0);
    if (Math.abs(deltaMilli) > Math.abs(worst)) worst = deltaMilli;
    itemized.push({
      dimension: dim, ourMilli, lpMilli, deltaMilli, ourSignedMilli,
      ourReason: o ? [...o.reasons].join('; ') || null : null,
      lpReason: t ? [...t.reasons].join('; ') || null : null,
      status: deltaMilli === 0 ? 'match' : (ourMilli == null ? 'llpa_missing_ours' : (lpMilli == null ? 'llpa_extra_ours' : 'llpa_mismatch')),
    });
  }
  itemized.credits = credits;
  return { itemized, agree: itemized.every((x) => x.deltaMilli === 0), worstDeltaMilli: worst };
}

/**
 * Max/min price probe for ONE matched rung — the owner's HARD-RULE item "you need to understand max
 * price and min price", per rung.
 *   ourRung   — { finalPriceMilli, floorMilli, capMilli, clamped }
 *   lpPriceMilli — LP's post-bound final price (normalizeLpFull rung.priceMilli)
 *
 * TWO CHECKS, AND THEY ARE INDEPENDENT — which is the whole reason they are reported separately:
 *   (1) `samePrice`     — our final == LP's final. FRAME-DEPENDENT: it only means anything while both
 *                         sides' prices are in the same frame. On the live Deephaven sheet LP's
 *                         displayed price carries an origination/margin our composed price does not
 *                         (task #78), so this check is expected to differ there and is reported rather
 *                         than gated. It is also the same question the coarse `final_price` axis asks.
 *   (2) `clampFaithful` — when WE clamped, the clamped value equals our own stated cap or floor.
 *                         FRAME-FREE: it is entirely about our engine's own arithmetic, and it holds
 *                         whatever frame the price is in. A missing cap/floor with clamped=true is a
 *                         faithfulness failure.
 * A single flag switching BOTH off (the old `skipBounds`) took the frame-free check down with the
 * frame-dependent one, which is how the cap/floor axis came to be neither gated nor reported on every
 * live run. The caller now chooses per check (`ratesheet-agreement.runOne` opts.boundsGate).
 *
 * It also reports what was actually EXERCISED, because an unexercised limit is not a verified one:
 *   capStated / floorStated — did we state a limit at all for this rung;
 *   clamped                 — did a limit actually BIND (a cap no price ever reaches is untested);
 *   boundBy                 — 'cap' | 'floor' | null, which limit the price landed on.
 * Returns { agree, checks:{samePrice, clampFaithful}, capStated, floorStated, clamped, boundBy, detail }.
 */
function boundsProbe(ourRung, lpPriceMilli) {
  const r = ourRung || {};
  const samePrice = isNum(r.finalPriceMilli) && isNum(lpPriceMilli) && r.finalPriceMilli === lpPriceMilli;
  // clampFaithful is vacuously true when we did not clamp; when we did, the clamped price must equal a
  // stated limit (not a coincidence). A missing cap/floor with clamped=true is a faithfulness failure.
  let clampFaithful = true;
  const atCap = isNum(r.capMilli) && r.finalPriceMilli === r.capMilli;
  const atFloor = isNum(r.floorMilli) && r.finalPriceMilli === r.floorMilli;
  if (r.clamped === true) clampFaithful = atCap || atFloor;
  const agree = samePrice && clampFaithful;
  let detail = null;
  if (!samePrice) detail = `final price ${r.finalPriceMilli} vs LP ${lpPriceMilli}`;
  else if (!clampFaithful) detail = `clamped but final ${r.finalPriceMilli} is neither cap ${r.capMilli} nor floor ${r.floorMilli}`;
  return {
    agree,
    checks: { samePrice, clampFaithful },
    capStated: isNum(r.capMilli),
    floorStated: isNum(r.floorMilli),
    clamped: r.clamped === true,
    // Only meaningful when a limit actually bound; the cap is reported first because a tie means the
    // ceiling is what the price landed on either way.
    boundBy: r.clamped === true ? (atCap ? 'cap' : (atFloor ? 'floor' : null)) : null,
    detail,
  };
}

module.exports = { reconcileLlpas, boundsProbe, lpLlpaDimension, deephavenLpDimension, _internals: { ADJTYPE_TO_DIMENSION, norm } };
