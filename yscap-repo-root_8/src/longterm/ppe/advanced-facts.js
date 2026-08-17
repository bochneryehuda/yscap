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
 * its type/enum, whether Lender Price can SEE it (`lpVisible`), the matrix OVERLAY it drives (verbatim
 * from deephaven-matrix's `unverifiable[]`), and its default.
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
// `lpVisible:false` = Lender Price does NOT price on this fact → it is OVERLAY-ONLY (our matrix knows it,
// LP does not), which is exactly the class the owner wants to override LP on, with a reason.
const ADVANCED_FACTS = [
  {
    key: 'occupancy', label: 'Occupancy', type: 'enum', enumValues: ['leased', 'vacant'], default: 'leased',
    category: 'occupancy', lpVisible: false,
    // owner D27: some programs allow vacant, some do not.
    effect: 'Vacant/Unleased: ineligible for R/T & C/O refi; -5% LTV on refi; 2+unit max 1 vacant',
    matrixMatch: 'Vacant/Unleased',
  },
  {
    key: 'rural_property', label: 'Rural property', type: 'boolean', default: false,
    category: 'property', lpVisible: false,
    effect: 'Rural: Max 65% LTV, DSCR > 1.0x, Long-Term Rent only, <=10 acres no ag/farm use',
    matrixMatch: 'Rural:',
  },
  {
    key: 'short_term_rental', label: 'Short-term rental', type: 'boolean', default: false,
    category: 'property', lpVisible: false,
    effect: 'Short-Term Rental: Min DSCR 1.15, Min FICO 720, -5% LTV (75% max), no FTI/2+unit/rural',
    matrixMatch: 'Short-Term Rental',
  },
  {
    key: 'first_time_investor', label: 'First-time investor', type: 'boolean', default: false,
    category: 'borrower', lpVisible: false,
    effect: 'First-Time Investor: Min DSCR 1.00, Min FICO 700, long-term rental only',
    matrixMatch: 'First-Time Investor',
  },
  {
    key: 'first_time_homebuyer', label: 'First-time homebuyer', type: 'boolean', default: false,
    category: 'borrower', lpVisible: false,
    effect: 'First-Time Homebuyer: ineligible unless 2+ borrowers with one non-FTHB',
    matrixMatch: 'First-Time Homebuyer',
  },
  {
    key: 'foreign_national', label: 'Foreign national', type: 'boolean', default: false,
    category: 'borrower', lpVisible: false,
    effect: 'Foreign National: max loan $1.5M, LTV caps 70/60, DSCR >= 1.00 only',
    matrixMatch: 'Foreign National',
  },
  {
    key: 'declining_market', label: 'Declining market', type: 'boolean', default: false,
    category: 'appraisal', lpVisible: false,
    effect: 'Declining market: Max LTV -5%',
    matrixMatch: 'Declining market',
  },
  {
    key: 'renovation', label: 'Renovation cash-out', type: 'boolean', default: false,
    category: 'property', lpVisible: false,
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
 * Split a fact set into what LP prices on vs what is OVERLAY-ONLY (LP cannot see). Every registry fact
 * is overlay-only today (lpVisible:false); the split is future-proofed for a fact LP later exposes.
 */
function overlayOnlyKeys() { return ADVANCED_FACTS.filter((f) => !f.lpVisible).map((f) => f.key); }

/**
 * The UI-facing shape of the Advanced section: each fact's key/label/type/enum/default/category +
 * the plain-language effect. Data-driven so the Advanced panel renders from this list (searchable,
 * extensible). PURE.
 */
function advancedSection() {
  return ADVANCED_FACTS.map((f) => ({
    key: f.key, label: f.label, type: f.type,
    enumValues: f.enumValues || null, default: f.default,
    category: f.category, lpVisible: f.lpVisible, effect: f.effect,
  }));
}

module.exports = {
  ADVANCED_FACTS,
  getAdvancedFact,
  advancedFactKeys,
  isAdvancedFact,
  overlayOnlyKeys,
  advancedSection,
};
