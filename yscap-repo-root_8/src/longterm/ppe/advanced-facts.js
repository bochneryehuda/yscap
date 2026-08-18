'use strict';
/**
 * LT PPE — THE ADVANCED-FACTS REGISTRY (owner-directed 2026-08-17): the BASIC search carries the fields
 * Lender Price already prices on; the ADVANCED section is "a massive, searchable, unlimited set of
 * advanced options … vacant, declining market, first-time home buyer, first-time investor, short-term
 * rental, rural." The key insight: these are an OVERLAY ON TOP OF Lender Price — LP often does not even
 * SEE them (it does not know a property is vacant or rural), so our independent Layer-2 matrix can
 * OVERRIDE LP's verdict — but only WITH A STATED REASON.
 *
 * This module is the ONE data-driven registry of those advanced facts, so the Advanced UI, the
 * scenario contract (SUPPORTED_FIELDS), and the overlay rules all read one list (searchable, extensible
 * — add a fact here and every surface gets it). Each fact records: its engine-fact key, a UI label,
 * its type/enum, the matrix OVERLAY it drives (verbatim from deephaven-matrix's `unverifiable[]`), its
 * default, and the TWO INDEPENDENT flags below.
 *
 * ⚠ TWO QUESTIONS, TWO FLAGS — NEVER ONE (task #82, split 2026-08-17). The registry used to carry a
 * single `lpVisible` boolean, and it was answering two different questions at once:
 *
 *   (1) `overlayOnly` — DOES OUR MATRIX INDEPENDENTLY ENFORCE THIS FACT'S ELIGIBILITY CUTS? This is a
 *       statement about OUR engine and it is what actually drives everything: `overlayOnlyKeys()` →
 *       `overlay.OVERLAY_FACTS` → the D29 stated-reason overrides and the D36 overlay declines.
 *   (2) `lpPrices` — DOES LENDER PRICE ITEMIZE A PRICE ADJUSTMENT FOR THIS FACT? A statement about the
 *       VENDOR, and knowable only by MEASURING it. `true` = a live probe itemized a charge; `null` =
 *       NOT MEASURED. It is never `false` unless a probe actually asked and Lender Price itemized
 *       nothing — "we never asked" and "they do not price it" are different facts, and the old blanket
 *       `lpVisible:false` asserted the second while only ever meaning the first.
 *
 * ⚠ A `false` MUST CARRY ITS RECEIPT — `lpPricesMeasured` (§2.97). The paragraph above forbade a bare
 * `false` for a good reason and, until §2.97, no probe had ever come back empty, so the guards simply
 * banned the value outright. Then `declining_market` was probed live with five candidate tokens and
 * moved nothing at all — a genuine, honest "they do not price it", which is exactly the third state the
 * split was built to make expressible and which the ban made unrepresentable. Rather than relax the ban
 * to prose ("a false is fine when a comment explains it"), the distinction is now MACHINE-READABLE: a
 * fact whose `lpPrices` is not null carries `lpPricesMeasured`, the ISO date the probe ran. So the
 * invariant the guards enforce is the stronger one — `lpPrices !== null` ⟺ a date is recorded — and an
 * UNMEASURED `false`, the thing §2.82 actually existed to prevent, is still structurally impossible.
 *
 * The split was forced by a measurement: `short_term_rental` was flagged `lpVisible:false` while Lender
 * Price was measured itemizing 0.500 for it. Under one flag there was no way to record that without
 * dropping short-term rental out of the overlay set (which would restructure D29 on the strength of a
 * pricing measurement that says nothing about eligibility). Under two, the fact is simply recorded.
 * Answering (2) never moves (1), and vice versa.
 *
 * SOURCE DISCIPLINE: every `effect` string is transcribed VERBATIM from the published Deephaven DSCR
 * matrix (deephaven-matrix.js `unverifiable[]`); a test ties each registry fact to its matrix overlay so
 * the two can NEVER drift. The exact numeric cuts (−5% LTV, 65% cap, DSCR 1.15…) are NOT yet ENFORCED
 * as declines — that is the D29 overlay-enforcement step, gated on confirming each cut from the matrix /
 * Lender Price live (owner D36). This registry is the fact FOUNDATION they build on.
 *
 * PURE: no DB, no network, no clock. LT-only.
 */

// Each advanced fact. `key` is the engine-fact name (what lpScenarioToFacts / the overlay rules read).
// `overlayOnly:true` = OUR matrix independently enforces this fact's eligibility cuts — the class the
// owner wants to override Lender Price on, with a stated reason. `lpPrices` is the SEPARATE, measured
// question (see the header): `true` where a live probe itemized a charge, `null` where nobody has asked.
// Seven of the eight are `null` — the old blanket `lpVisible:false` read as "Lender Price does not price
// this", and that was never probed for any of them; the one fact that WAS probed came back the other way.
const { isForeignNationalScenario } = require('../lenderprice/citizenship');

const ADVANCED_FACTS = [
  {
    key: 'occupancy', label: 'Occupancy', type: 'enum', enumValues: ['leased', 'vacant'], default: 'leased',
    category: 'occupancy', overlayOnly: true, lpPrices: null,
    // owner D27: some programs allow vacant, some do not.
    effect: 'Vacant/Unleased: ineligible for R/T & C/O refi; -5% LTV on refi; 2+unit max 1 vacant',
    matrixMatch: 'Vacant/Unleased',
  },
  {
    key: 'rural_property', label: 'Rural property', type: 'boolean', default: false,
    category: 'property', overlayOnly: true, lpPrices: null,
    effect: 'Rural: Max 65% LTV, DSCR > 1.0x, Long-Term Rent only, <=10 acres no ag/farm use',
    matrixMatch: 'Rural:',
  },
  {
    // ⚠ THE ONE FACT WHOSE PRICING SIDE IS MEASURED — and the reason this registry carries two flags.
    //
    // Live probe 2026-08-17, Deephaven DSCR, the same scenario twice: with `rentalTerm` omitted Lender
    // Price itemizes nothing; with `rentalTerm: 'short'` it itemizes `Short Term Rental - Short Term
    // Rental / CLTV >65.01 % <= 70.0 %` = 0.500 — exactly our own sheet's charge. So Lender Price DOES
    // price on this fact → `lpPrices: true`. search-model derives `rentalTerm` from it (§37.15), which
    // is the half that fixed the real mispricing: a borrower ticking this box is quoted the short-term
    // rental they described instead of a long-term one, 0.5 points too good.
    //
    // `overlayOnly` STAYS TRUE, and the two flags disagreeing here is the point rather than a
    // contradiction. Lender Price PRICING this fact is no evidence that it ENFORCES the matrix's
    // eligibility cuts for it (Min DSCR 1.15, Min FICO 720, 75 % max LTV — unmeasured), and dropping
    // short-term rental out of the overlay set would restructure D29 on the strength of a measurement
    // that says nothing about eligibility. Under the old single flag those two answers fought over one
    // boolean; now each is simply recorded.
    key: 'short_term_rental', label: 'Short-term rental', type: 'boolean', default: false,
    category: 'property', overlayOnly: true, lpPrices: true, lpPricesMeasured: '2026-08-17',
    effect: 'Short-Term Rental: Min DSCR 1.15, Min FICO 720, -5% LTV (75% max), no FTI/2+unit/rural',
    matrixMatch: 'Short-Term Rental',
  },
  {
    key: 'first_time_investor', label: 'First-time investor', type: 'boolean', default: false,
    category: 'borrower', overlayOnly: true, lpPrices: null,
    effect: 'First-Time Investor: Min DSCR 1.00, Min FICO 700, long-term rental only',
    matrixMatch: 'First-Time Investor',
  },
  {
    key: 'first_time_homebuyer', label: 'First-time homebuyer', type: 'boolean', default: false,
    category: 'borrower', overlayOnly: true, lpPrices: null,
    effect: 'First-Time Homebuyer: ineligible unless 2+ borrowers with one non-FTHB',
    matrixMatch: 'First-Time Homebuyer',
  },
  {
    // ⚠ THE SECOND MEASURED FACT, and the most expensive one the field sweep found (§2.97).
    //
    // Live probe 2026-08-18, same scenario twice (NY purchase, 500k/350k, FICO 760, DSCR 1.25, 60-mo
    // PPP), `citizenship: 'US Citizen'` vs `citizenship: 'Foreign National'`:
    //   • PRICED — Lender Price ITEMIZES the fact BY NAME. Deephaven `DSCR 1.00-1.24 - 30 Yr Fixed`
    //     @ 6.125% carries `DSCR (All) - Foreign National / CLTV >65.01 % <= 70.0 %` = 4.000, in
    //     place of the 0.125 FICO row a US citizen gets; the rung prices 100.475 -> 96.350. Across the
    //     six programs present in BOTH answers, 78 of 182 rungs move. So `lpPrices: true`, MEASURED.
    //   • AND ELIGIBILITY-DECISIVE, which the price flag cannot express: 19 programs / 499 rungs
    //     becomes 12 / 267. Thirteen programs vanish and six FOREIGN-NATIONAL products appear.
    //
    // `overlayOnly` STAYS TRUE, for the same reason it does on short_term_rental above: Lender Price
    // swapping the PROGRAM SET is no evidence that it enforces OUR matrix's specific cuts (max loan
    // $1.5M, LTV caps 70/60, DSCR >= 1.00), which remain unmeasured. Two flags, two questions.
    key: 'foreign_national', label: 'Foreign national', type: 'boolean', default: false,
    category: 'borrower', overlayOnly: true, lpPrices: true, lpPricesMeasured: '2026-08-18',
    effect: 'Foreign National: max loan $1.5M, LTV caps 70/60, DSCR >= 1.00 only',
    matrixMatch: 'Foreign National',
  },
  {
    // MEASURED AND INERT (§2.97). `GLOBAL_DECLININGMARKET` is a real dynamic property present in all
    // seven captured frontend requests, and the base body carries it with `value: null`. Probed live
    // 2026-08-18 on the same scenario with five candidate tokens — `'true'`, boolean `true`, `'Yes'`,
    // `'Y'`, `'Declining'` — by patching the built body directly. EVERY ONE was inert: 19 programs,
    // 499 rungs, 499 ladder points, ZERO moved, max delta 0. None was REJECTED either (no program was
    // lost), so this is not the "an unpublished token silently costs a lender program" hazard — the
    // vendor simply does not price or cut on it. So `lpPrices: false` is a MEASUREMENT, not the old
    // "we never asked" null, and there is nothing to bridge a scenario field to until that changes.
    key: 'declining_market', label: 'Declining market', type: 'boolean', default: false,
    category: 'appraisal', overlayOnly: true, lpPrices: false, lpPricesMeasured: '2026-08-18',
    effect: 'Declining market: Max LTV -5%',
    matrixMatch: 'Declining market',
  },
  {
    key: 'renovation', label: 'Renovation cash-out', type: 'boolean', default: false,
    category: 'property', overlayOnly: true, lpPrices: null,
    effect: 'Renovation cash-out: appraised value under 6mo ownership at max 75% LTV',
    matrixMatch: 'Renovation cash-out',
  },
];

const _byKey = new Map(ADVANCED_FACTS.map((f) => [f.key, f]));

// Look up one advanced fact by its engine-fact key. Returns null (never throws) for an unknown key.
function getAdvancedFact(key) { return _byKey.get(String(key == null ? '' : key)) || null; }

// Every advanced fact key (the OVERLAY facts the Advanced section exposes).
function advancedFactKeys() { return ADVANCED_FACTS.map((f) => f.key); }

// True when a fact key is an ADVANCED (overlay) fact — i.e. NOT part of the basic LP-priced scenario.
function isAdvancedFact(key) { return _byKey.has(String(key == null ? '' : key)); }

/**
 * The OVERLAY-ONLY class: the facts OUR matrix independently enforces eligibility cuts on, which is what
 * `overlay.OVERLAY_FACTS` and the D29/D36 overrides act on. Every registry fact is overlay-only today;
 * the split is future-proofed for a fact whose cuts Lender Price is later measured to enforce itself.
 *
 * This deliberately says NOTHING about whether Lender Price prices the fact — that is `lpPricedKeys()`,
 * and the two are independent (short-term rental is in BOTH). Reading one for the other is the exact
 * conflation task #82 removed.
 */
function overlayOnlyKeys() { return ADVANCED_FACTS.filter((f) => f.overlayOnly).map((f) => f.key); }

/**
 * The facts Lender Price was MEASURED to itemize a price adjustment for. Only a live probe puts a key
 * here (`lpPrices === true`); a fact nobody has probed is absent because it is UNKNOWN, never because it
 * was measured as unpriced — so this list is a floor, not a closed set. Today: short-term rental.
 */
function lpPricedKeys() { return ADVANCED_FACTS.filter((f) => f.lpPrices === true).map((f) => f.key); }

/**
 * The UI-facing shape of the Advanced section: each fact's key/label/type/enum/default/category +
 * the plain-language effect, and BOTH flags — `overlayOnly` (our engine cuts on it) and `lpPrices`
 * (measured: Lender Price itemizes for it; null = not measured). Data-driven so the Advanced panel
 * renders from this list (searchable, extensible). PURE.
 */
function advancedSection() {
  return ADVANCED_FACTS.map((f) => ({
    key: f.key, label: f.label, type: f.type,
    enumValues: f.enumValues || null, default: f.default,
    category: f.category, overlayOnly: !!f.overlayOnly, lpPrices: f.lpPrices === true ? true : null,
    effect: f.effect,
  }));
}

/**
 * Read the advanced facts from a scenario, REGISTRY-DRIVEN, applying each fact's type + default. A
 * boolean fact is coerced (`!!`) and defaults to its registry default when omitted; an enum fact takes
 * the scenario value only if it is a VALID enum member (else the default — an unknown value never
 * sneaks through). A number fact passes through. Add a fact to the registry and it flows here for free.
 * PURE. Used by lpScenarioToFacts so every advanced fact reaches the engine facts (and the overlay).
 */
function advancedFactsFromScenario(sc) {
  const s = sc || {};
  const out = {};
  for (const f of ADVANCED_FACTS) {
    const v = s[f.key];
    if (f.type === 'boolean') out[f.key] = v === undefined || v === null ? !!f.default : !!v;
    else if (f.type === 'enum') out[f.key] = (v != null && f.enumValues.includes(v)) ? v : f.default;
    else out[f.key] = v === undefined || v === null ? f.default : v;
  }
  // §2.97 — THE REVERSE HALF OF THE FOREIGN-NATIONAL BRIDGE, and it is not optional. The vendor's own
  // dropdown is `citizenship`, which is a validated token reaching `dyn.Citizenship`; a caller who
  // uses it has named the borrower plainly. Without this line our OWN matrix reads `foreign_national:
  // false` on exactly those scenarios and quietly skips its Foreign National row (max loan $1.5M, LTV
  // caps 70/60) — the mirror image of the defect the forward bridge fixes, and the same two-leg
  // asymmetry §2.94 left behind. `citizenship.js` owns which tokens count and the measurement.
  if (out.foreign_national !== true && isForeignNationalScenario(s)) out.foreign_national = true;
  return out;
}

module.exports = {
  ADVANCED_FACTS,
  getAdvancedFact,
  advancedFactKeys,
  isAdvancedFact,
  overlayOnlyKeys,
  lpPricedKeys,
  advancedSection,
  advancedFactsFromScenario,
};
