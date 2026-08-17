'use strict';
/**
 * LT PPE — THE PREPAYMENT-PENALTY STRUCTURE LIBRARY (owner-directed 2026-08-17): "there needs to be a
 * major focus around prepayment penalty types … make a hard rule that for every program/investor you
 * need to add me what kind of prepayment penalty structures they have … all of these structures should
 * be available structures because we're going to reuse most of them."
 *
 * A prepayment penalty is TWO things — a TYPE and a TERM — and every TERM has its own pricing on the
 * rate sheet. This module is the ONE reusable catalog of those structures, encoded as DATA so a new
 * investor reuses them instead of re-describing them. It is PURE: no DB, no network, no clock.
 *
 * THE SHAPE of one structure:
 *   key          — stable id used in a rule/overlay (e.g. '54321', '33321', 'flat3').
 *   label        — human display ('5/4/3/2/1').
 *   termYears    — the TERM in years (1..5), 0 = No-PPP, or null = "any term" (a type offered across
 *                  every term; the term is supplied at pricing time, e.g. flat 3% / 5% fixed).
 *   type         — 'step_down' | 'flat' | 'fixed_percent' | 'interest_6mo'.
 *   schedule     — for step_down: the per-year penalty percents ([5,4,3,2,1]); else omitted.
 *   typeParams   — for flat/fixed_percent: { pct }; for interest_6mo: { basisPct:80, curtailmentPct:20 }.
 *   pricingModel — 'standard' (soft declining) | 'fixed5_promo' (the 5% Fixed LLPA-credit model).
 *   tierSet      — which family it belongs to: 'shared' | 'dh_published' | 'custom_softer' | 'promo'.
 *   lp           — how it maps to the Lender Price request: { prepayTermMonths, planType, smoMonths }.
 *                  planType is a field-registry PREPAY_STRUCTURES token, or NULL when LP cannot express
 *                  the structure. A null-term structure carries null months (resolved at pricing time).
 *   overlayOnly  — true = LP cannot price this; it exists ONLY as our margin-holdback overlay.
 *   marginHoldbackDeltaMilli — extra margin holdback (milli-points) this structure ADDS on top of the
 *                  investor default. 0 for every LP-priced structure; 375 for the two custom softer ones.
 *
 * THE HARD RULE (owner): 33321 / 3321 are OUR custom deal and are NOT expressible in LP — they carry
 * planType:null and MUST NEVER be given an invented LP token (the DSCRRATIO lesson). They ride LP as
 * their nearest priceable TERM only (5yr / 4yr), and their softness is applied entirely by the
 * additional margin holdback (+0.375 → the company 0.250 becomes 0.625). See `deephaven-ppp-custom.js`
 * for the overlay rule that consumes `marginHoldbackDeltaMilli`.
 *
 * LT-only. No RTL imports.
 */

const { PREPAY_STRUCTURES: FR_PREPAY_STRUCTURES } = require('../lenderprice/field-registry');

// The set of REAL Lender Price prepay-structure tokens, derived from field-registry's own map (its ONE
// definition) so the self-check below can never drift from what the request builder actually accepts.
const PREPAY_STRUCTURE_TOKENS = new Set(Object.values(FR_PREPAY_STRUCTURES || {}).filter((v) => typeof v === 'string'));

// ── THE LIBRARY ──────────────────────────────────────────────────────────────────────────────────
// Every structure the owner named. Reusable across investors; a program references keys, it does not
// re-describe them.
const PPP_STRUCTURES = [
  // ── STANDARD MODEL · our custom-deal step-down tiers (5/4/3/2/1, 4/3/2/1, 3/2/1, 2/1, 2% Fixed 1yr) ─
  { key: '54321', label: '5/4/3/2/1', termYears: 5, type: 'step_down', schedule: [5, 4, 3, 2, 1],
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 60, planType: '54321', smoMonths: 60 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '4321', label: '4/3/2/1', termYears: 4, type: 'step_down', schedule: [4, 3, 2, 1],
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 48, planType: '4321', smoMonths: 48 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '321', label: '3/2/1', termYears: 3, type: 'step_down', schedule: [3, 2, 1],
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 36, planType: '321', smoMonths: 36 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '21', label: '2/1', termYears: 2, type: 'step_down', schedule: [2, 1],
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 24, planType: '21', smoMonths: 24 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'fixed2_1yr', label: '2% Fixed (1yr)', termYears: 1, type: 'fixed_percent', typeParams: { pct: 2 },
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 12, planType: 'Fixed2', smoMonths: 12 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ── STANDARD MODEL · 6-Months-Interest family (2–5yr, on 80% of principal, 20% annual curtailment) ─
  { key: 'int6_2', label: '6 Mo Interest (2yr)', termYears: 2, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 24, planType: '6MosInt', smoMonths: 24 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'int6_3', label: '6 Mo Interest (3yr)', termYears: 3, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 36, planType: '6MosInt', smoMonths: 36 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'int6_4', label: '6 Mo Interest (4yr)', termYears: 4, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 48, planType: '6MosInt', smoMonths: 48 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'int6_5', label: '6 Mo Interest (5yr)', termYears: 5, type: 'interest_6mo',
    typeParams: { basisPct: 80, curtailmentPct: 20 }, pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 60, planType: '6MosInt', smoMonths: 60 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ── STANDARD MODEL · Flat 3% (all terms; term supplied at pricing time) ────────────────────────────
  { key: 'flat3', label: '3% Fixed', termYears: null, type: 'flat', typeParams: { pct: 3 },
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: null, planType: 'Fixed3', smoMonths: null }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ── DEEPHAVEN'S OWN PUBLISHED STANDARD TIERS (5/4/3/2/1 [= 54321], 5/4/3/2, 5/4/3, 3/3, 3) ──────────
  { key: '5432', label: '5/4/3/2', termYears: 4, type: 'step_down', schedule: [5, 4, 3, 2],
    pricingModel: 'standard', tierSet: 'dh_published',
    lp: { prepayTermMonths: 48, planType: '5432', smoMonths: 48 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: '543', label: '5/4/3', termYears: 3, type: 'step_down', schedule: [5, 4, 3],
    pricingModel: 'standard', tierSet: 'dh_published',
    lp: { prepayTermMonths: 36, planType: '543', smoMonths: 36 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'dh_33', label: '3/3', termYears: 2, type: 'flat', typeParams: { pct: 3 },
    pricingModel: 'standard', tierSet: 'dh_published',
    // [3,3] === flat 3% over 2 years → LP Fixed3 @ 24 months (there is NO '3,3' token in field-registry).
    lp: { prepayTermMonths: 24, planType: 'Fixed3', smoMonths: 24 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
  { key: 'dh_3', label: '3 (flat 1yr)', termYears: 1, type: 'flat', typeParams: { pct: 3 },
    pricingModel: 'standard', tierSet: 'dh_published',
    lp: { prepayTermMonths: 12, planType: 'Fixed3', smoMonths: 12 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ── 5% FIXED PROMOTION (D33: a better-pricing LLPA credit on the rate sheet, NOT a holdback) ────────
  { key: 'fixed5', label: '5% Fixed (promo)', termYears: null, type: 'fixed_percent', typeParams: { pct: 5 },
    pricingModel: 'fixed5_promo', tierSet: 'promo',
    lp: { prepayTermMonths: null, planType: 'Fixed5', smoMonths: null }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },

  // ── DEEPHAVEN CUSTOM SOFTER OVERLAY (D32: overlay-only, +0.375 margin holdback, 5yr & 4yr ONLY) ─────
  { key: '33321', label: '3/3/3/2/1', termYears: 5, type: 'step_down', schedule: [3, 3, 3, 2, 1],
    pricingModel: 'standard', tierSet: 'custom_softer',
    lp: { prepayTermMonths: 60, planType: null, smoMonths: 60 }, overlayOnly: true, marginHoldbackDeltaMilli: 375 },
  { key: '3321', label: '3/3/2/1', termYears: 4, type: 'step_down', schedule: [3, 3, 2, 1],
    pricingModel: 'standard', tierSet: 'custom_softer',
    lp: { prepayTermMonths: 48, planType: null, smoMonths: 48 }, overlayOnly: true, marginHoldbackDeltaMilli: 375 },

  // ── NO PPP (the state matrix in deephaven-ppp-matrix.js decides where a PPP is PROHIBITED) ──────────
  { key: 'none', label: 'No PPP', termYears: 0, type: 'flat', typeParams: { pct: 0 },
    pricingModel: 'standard', tierSet: 'shared',
    lp: { prepayTermMonths: 0, planType: null, smoMonths: 0 }, overlayOnly: false, marginHoldbackDeltaMilli: 0 },
];

const _byKey = new Map(PPP_STRUCTURES.map((s) => [s.key, s]));

// Look up one structure by key. Returns null (never throws) for an unknown key.
function getStructure(key) { return _byKey.get(String(key == null ? '' : key)) || null; }

/**
 * Filter the library. All fields optional:
 *   termYears     — keep structures for this term. A null-term structure ("any term") ALWAYS matches
 *                   (it is offered across every term); 0 matches only the No-PPP structure.
 *   pricingModel  — 'standard' | 'fixed5_promo'.
 *   tierSet       — 'shared' | 'dh_published' | 'custom_softer' | 'promo'.
 *   includeOverlay — default true; false drops overlay-only structures (the LP-priceable set).
 */
function structuresFor(opts = {}) {
  const o = opts || {};
  const wantTerm = o.termYears;
  return PPP_STRUCTURES.filter((s) => {
    if (o.includeOverlay === false && s.overlayOnly) return false;
    if (o.pricingModel != null && s.pricingModel !== o.pricingModel) return false;
    if (o.tierSet != null && s.tierSet !== o.tierSet) return false;
    if (wantTerm != null) {
      // a null-term structure is offered at ANY term; a fixed-term one must match exactly.
      if (s.termYears != null && s.termYears !== Number(wantTerm)) return false;
    }
    return true;
  });
}

/**
 * Resolve the LENDER PRICE mapping for a structure at a given term. For a fixed-term structure the term
 * comes from the structure; for an "any term" structure (termYears:null) the caller supplies termYears.
 * Returns { prepayTermMonths, planType, smoMonths } — with the months computed from the effective term
 * (termYears × 12) when the structure carries null months. planType is passed through VERBATIM: a null
 * planType means "LP cannot express this" and MUST stay null (never an invented token).
 * Returns null (never throws) for an unknown structure, or when a null-term structure is asked for with
 * no term (there is nothing to resolve the months from).
 */
function lpMapping(structureOrKey, termYears) {
  const s = typeof structureOrKey === 'string' ? getStructure(structureOrKey) : structureOrKey;
  if (!s || typeof s !== 'object' || !s.lp) return null;
  // The effective term: the structure's own term, else the caller's.
  const effTerm = s.termYears != null ? s.termYears : (termYears != null ? Number(termYears) : null);
  if (s.termYears == null && (effTerm == null || !Number.isFinite(effTerm))) return null;
  const months = s.lp.prepayTermMonths != null ? s.lp.prepayTermMonths : (effTerm != null ? effTerm * 12 : null);
  const smo = s.lp.smoMonths != null ? s.lp.smoMonths : months;
  return { prepayTermMonths: months, planType: s.lp.planType == null ? null : s.lp.planType, smoMonths: smo };
}

// The extra margin-holdback (milli-points) a structure ADDS on top of the investor default. 0 for
// every LP-priced structure; 375 for the two custom softer ones.
function marginHoldbackDeltaOf(key) { const s = getStructure(key); return s ? (s.marginHoldbackDeltaMilli || 0) : 0; }

// True when LP cannot price the structure (it lives only as our overlay).
function isOverlayOnly(key) { const s = getStructure(key); return !!(s && s.overlayOnly); }

/**
 * SELF-CHECK (the "never invent a vendor token" guard): every structure whose planType is NON-NULL must
 * name a REAL field-registry PREPAY_STRUCTURES token, or LP would be told to price a structure it does
 * not have and would silently narrow the lender set (the DSCRRATIO lesson). Returns the list of
 * offenders — asserted EMPTY by the test. The overlay-only structures (planType null) are exempt BY
 * DESIGN (they are never sent). PURE.
 */
function verifyLpTokens() {
  const bad = [];
  for (const s of PPP_STRUCTURES) {
    const t = s.lp && s.lp.planType;
    if (t == null) continue; // null = deliberately not expressible in LP
    if (!PREPAY_STRUCTURE_TOKENS.has(t)) bad.push({ key: s.key, planType: t });
  }
  return bad;
}

module.exports = {
  PPP_STRUCTURES,
  getStructure,
  structuresFor,
  lpMapping,
  marginHoldbackDeltaOf,
  isOverlayOnly,
  verifyLpTokens,
};
