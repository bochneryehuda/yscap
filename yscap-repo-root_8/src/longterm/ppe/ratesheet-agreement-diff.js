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
    if (/escrow\s*waiver/i.test(r)) return 'escrow_waiver';
    if (/non.?warrantable/i.test(r)) return 'non_warrantable';
    // Short-Term Rental — the sheet's "Rental Type" row. The VALUES are the sheet's, but LP's own
    // adjType for this family is UNCONFIRMED (never probed live), so this branch is keyed on the reason
    // and grouped with its measured "Other - …" siblings. If LP turns out to use a different adjType the
    // classifier falls through to `other:<reason>`, which SURFACES as a disagreement rather than being
    // silently merged — the fail-safe this whole reconciliation is built on. See sheet UNMEASURED.
    if (/short.?term\s*rental/i.test(r)) return 'short_term_rental';
    return `other:${norm(r) || 'simple'}`;
  }
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
  for (const dim of [...keys].sort()) {
    const o = ours.get(dim);
    const t = theirs.get(dim);
    const ourMilli = o ? o.milli : null;
    const lpMilli = t ? t.milli : null;
    const deltaMilli = (o ? o.milli : 0) - (t ? t.milli : 0);
    if (Math.abs(deltaMilli) > Math.abs(worst)) worst = deltaMilli;
    itemized.push({
      dimension: dim, ourMilli, lpMilli, deltaMilli,
      ourReason: o ? [...o.reasons].join('; ') || null : null,
      lpReason: t ? [...t.reasons].join('; ') || null : null,
      status: deltaMilli === 0 ? 'match' : (ourMilli == null ? 'llpa_missing_ours' : (lpMilli == null ? 'llpa_extra_ours' : 'llpa_mismatch')),
    });
  }
  return { itemized, agree: itemized.every((x) => x.deltaMilli === 0), worstDeltaMilli: worst };
}

/**
 * Max/min price probe for ONE matched rung.
 *   ourRung   — { finalPriceMilli, floorMilli, capMilli, clamped }
 *   lpPriceMilli — LP's post-bound final price (normalizeLpFull rung.priceMilli)
 * Asserts, EXACT (milli):
 *   (1) our final == LP's final (LP bounded it to the same number) — the load-bearing check;
 *   (2) when we clamped, the clamped value equals our stated cap or floor (our bound is faithful).
 * Returns { agree, checks:{samePrice, clampFaithful}, detail }.
 */
function boundsProbe(ourRung, lpPriceMilli) {
  const r = ourRung || {};
  const samePrice = isNum(r.finalPriceMilli) && isNum(lpPriceMilli) && r.finalPriceMilli === lpPriceMilli;
  // clampFaithful is vacuously true when we did not clamp; when we did, the clamped price must equal a
  // stated limit (not a coincidence). A missing cap/floor with clamped=true is a faithfulness failure.
  let clampFaithful = true;
  if (r.clamped === true) {
    clampFaithful = (isNum(r.capMilli) && r.finalPriceMilli === r.capMilli)
                 || (isNum(r.floorMilli) && r.finalPriceMilli === r.floorMilli);
  }
  const agree = samePrice && clampFaithful;
  let detail = null;
  if (!samePrice) detail = `final price ${r.finalPriceMilli} vs LP ${lpPriceMilli}`;
  else if (!clampFaithful) detail = `clamped but final ${r.finalPriceMilli} is neither cap ${r.capMilli} nor floor ${r.floorMilli}`;
  return { agree, checks: { samePrice, clampFaithful }, detail };
}

module.exports = { reconcileLlpas, boundsProbe, lpLlpaDimension, deephavenLpDimension, _internals: { ADJTYPE_TO_DIMENSION, norm } };
