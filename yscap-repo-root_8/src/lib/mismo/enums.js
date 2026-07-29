/**
 * MISMO 3.4 enumeration crosswalk — our portal's field vocabulary <-> the
 * MISMO controlled-value lists, in BOTH directions (export maps ours -> MISMO,
 * import maps MISMO -> ours). Kept in one file so the two directions can never
 * drift apart (the same lesson the ClickUp `crosswalk.js` encodes).
 *
 * The portal's ACTUAL stored vocabularies (verified against the app, not guessed):
 *   loan_type      : 'Purchase' | 'Refinance — Rate & Term' | 'Refinance — Cash-Out'
 *                    (em-dash; Ground-Up is a PROGRAM, never a loan_type —
 *                     fields.sanitizeLoanType strips anything starting "ground")
 *   property_type  : 'SFR (1 unit)' | 'Multi 2–4' | 'Multi 5+' | 'Condo' |
 *                    'Townhouse' | 'Mixed use'  (plus legacy 'SFR'/'Multi 2-4')
 *   occupancy      : 'Primary' | 'Investment' | 'Secondary'
 *   citizenship    : 'US Citizen' | 'Permanent Resident' | 'Foreign National'
 *   marital_status : 'Single' | 'Married' | 'Separated' | 'Divorced' | 'Widowed'
 *
 * Where a portal value has no exact MISMO home the mapping picks the closest
 * standard bucket and the ORIGINAL value is additionally preserved verbatim in
 * the lender EXTENSION (see build.js) so nothing is ever silently lost.
 */

// A case-insensitive, whitespace/punctuation/dash-tolerant key. Critically this
// folds every dash variant (hyphen -, en-dash –, em-dash —) to nothing, so
// 'Refinance — Cash-Out', 'Refinance - Cash Out' and 'refinancecashout' all
// normalize identically.
function norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}
function makeReverse(forwardMap, fallback) {
  const rev = {};
  for (const [ours, mismo] of Object.entries(forwardMap)) {
    if (mismo == null) continue;
    // FIRST mapping wins: the map lists the canonical portal value before any
    // legacy alias (e.g. Investment before Investor), so a MISMO value always
    // resolves back to the canonical spelling, never an alias.
    if (rev[norm(mismo)] === undefined) rev[norm(mismo)] = ours;
  }
  return (mismoVal) => {
    if (mismoVal == null || mismoVal === '') return null;
    const hit = rev[norm(mismoVal)];
    return hit != null ? hit : (fallback === undefined ? null : fallback);
  };
}
function makeForward(forwardMap, fallback) {
  const byNorm = {};
  for (const [ours, mismo] of Object.entries(forwardMap)) byNorm[norm(ours)] = mismo;
  return (ourVal) => {
    if (ourVal == null || ourVal === '') return null;
    const hit = byNorm[norm(ourVal)];
    return hit !== undefined ? hit : (fallback === undefined ? null : fallback);
  };
}

// ---- LoanPurposeType ---------------------------------------------------------
const LOAN_PURPOSE = {
  'Purchase': 'Purchase',
  'Refinance — Rate & Term': 'Refinance',
  'Refinance — Cash-Out': 'Refinance',
  // MISMO's LoanPurposeType has no "delayed financing" value. The borrower has
  // ALREADY bought the property (with cash), so the new loan is secured against
  // one they own — which is a Refinance in MISMO terms — and it returns their
  // own purchase funds, so it carries CashOut below. Mapping it is deliberate:
  // an unmapped value exports a NULL loan purpose, which is worse than the
  // standard's closest true value. This is the EXPORT vocabulary only — it does
  // not change how PILOT sizes the loan (see the note in field-registry.js).
  'Delayed Purchase Financing': 'Refinance',
};
// Cash-out vs rate/term is carried separately in MISMO (RefinanceCashOutDetermination-
// Type); remember which refinance flavor produced "Refinance" so import restores it.
const REFI_CASHOUT = {
  'Refinance — Cash-Out': 'CashOut',
  'Refinance — Rate & Term': 'NoCashOut',
  'Delayed Purchase Financing': 'CashOut',
};

// ---- PropertyUsageType (from occupancy) -------------------------------------
const OCCUPANCY = {
  'Primary': 'PrimaryResidence',
  'Investment': 'Investment',
  'Investor': 'Investment',
  'Secondary': 'SecondHome',
  'Second Home': 'SecondHome',
};

// ---- CitizenshipResidencyType -----------------------------------------------
const CITIZENSHIP = {
  'US Citizen': 'USCitizen',
  'Permanent Resident': 'PermanentResidentAlien',
  'Foreign National': 'NonPermanentResidentAlien',
};

// ---- MaritalStatusType -------------------------------------------------------
// MISMO only has Married / Separated / Unmarried. Single/Divorced/Widowed all
// collapse to Unmarried — so the exact original is ALSO written to the lender
// EXTENSION (build.js) and preferred on import, keeping the round-trip lossless.
const MARITAL = {
  'Married': 'Married',
  'Separated': 'Separated',
  'Single': 'Unmarried',
  'Divorced': 'Unmarried',
  'Widowed': 'Unmarried',
};

const DEFAULT_MORTGAGE_TYPE = 'Conventional';
const DEFAULT_AMORTIZATION_TYPE = 'Fixed';

// Dwelling-type inference by pattern (tolerant of the unit-annotated and
// dash-variant spellings the app actually stores). Returns null when unknown.
function unitsHint(propertyType) {
  const s = norm(propertyType);
  if (!s) return null;
  if (s.startsWith('sfr') || s.includes('singlefamily')) return 1;
  if (s.includes('multi54') || s.includes('multi5')) return 5;
  if (s.includes('multi24') || s.includes('multi2')) return 2;
  if (s.includes('condo')) return 1;
  if (s.includes('town')) return 1;
  if (s.includes('mixed')) return 1;
  return null;
}
// The UNIT-COUNT RANGE a portal property_type implies. Our property_type is a CATEGORY
// (SFR = 1 unit, Multi 2–4, Multi 5+, Condo = 1, …), NOT a specific unit count — while an
// appraisal reports a SPECIFIC count. So a check must judge the appraisal's real unit
// count AGAINST this range, never string-compare our range category to the appraisal's
// specific type (that false-"disagrees" on every multi-family file — owner-reported
// 2026-07-24: 'Multi 2–4' vs an appraisal's 2-unit). Returns {min,max} (max may be
// Infinity) or null when the type is unknown OR unbounded (mixed-use) — callers MUST
// treat null as "no unit constraint" and never guess.
function propertyTypeUnitRange(propertyType) {
  const s = norm(propertyType);
  if (!s) return null;
  if (s.startsWith('sfr') || s.includes('singlefamily')) return { min: 1, max: 1 };
  if (s.includes('condo')) return { min: 1, max: 1 };
  if (s.includes('town')) return { min: 1, max: 1 };
  if (s.includes('multi54') || s.includes('multi5')) return { min: 5, max: Infinity };
  if (s.includes('multi24') || s.includes('multi2')) return { min: 2, max: 4 };
  if (s.includes('mixed')) return null;   // mixed-use: no unit-count constraint — never guess
  return null;
}
function toMismoAttachment(propertyType) {
  const s = norm(propertyType);
  if (!s) return null;
  if (s.startsWith('sfr') || s.includes('singlefamily')) return 'Detached';
  if (s.includes('condo') || s.includes('town') || s.includes('multi') || s.includes('mixed')) return 'Attached';
  return null;
}

module.exports = {
  norm,
  // forward (ours -> MISMO), used by the exporter
  toMismoLoanPurpose: makeForward(LOAN_PURPOSE), // null when unknown (never a wrong 'Other')
  toMismoRefiCashOut: makeForward(REFI_CASHOUT),
  toMismoOccupancy: makeForward(OCCUPANCY),
  toMismoCitizenship: makeForward(CITIZENSHIP),
  toMismoMarital: makeForward(MARITAL),
  toMismoAttachment,
  unitsHint,
  propertyTypeUnitRange,
  DEFAULT_MORTGAGE_TYPE,
  DEFAULT_AMORTIZATION_TYPE,
  // reverse (MISMO -> ours), used by the importer
  fromMismoLoanPurpose: (mismoPurpose, cashOut) => {
    const n = norm(mismoPurpose);
    if (n === norm('Purchase')) return 'Purchase';
    if (n === norm('Refinance')) {
      return norm(cashOut) === norm('CashOut') ? 'Refinance — Cash-Out' : 'Refinance — Rate & Term';
    }
    // Construction/ConstructionToPermanent/Other/unknown: not a portal loan_type
    // (Ground-Up is a program), so leave loan_type unset rather than invent one.
    return null;
  },
  fromMismoOccupancy: makeReverse(OCCUPANCY),
  fromMismoCitizenship: makeReverse(CITIZENSHIP),
  fromMismoMarital: makeReverse(MARITAL),
};
