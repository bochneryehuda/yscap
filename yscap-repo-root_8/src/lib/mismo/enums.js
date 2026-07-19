/**
 * MISMO 3.4 enumeration crosswalk — our portal's field vocabulary <-> the
 * MISMO controlled-value lists, in BOTH directions (export maps ours -> MISMO,
 * import maps MISMO -> ours). Kept in one file so the two directions can never
 * drift apart (the same lesson the ClickUp `crosswalk.js` encodes).
 *
 * Where a portal value has no exact MISMO home the mapping picks the closest
 * standard bucket and the ORIGINAL value is additionally preserved verbatim in
 * the lender EXTENSION block (see build.js) so nothing is ever silently lost.
 *
 * Source of truth for the MISMO enum spellings: the MISMO v3.4 Logical Data
 * Dictionary as surfaced through the Fannie DU / Freddie LPA (ULAD) specs.
 */

// A case-insensitive, whitespace/punctuation-tolerant reverse lookup so an
// inbound value spelled slightly differently ("US citizen", "U.S. Citizen")
// still resolves.
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
// Forward lookup tolerant of legacy casings ("INVESTMENT") stored in old rows.
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
// Our loan_type values (see db/schema.sql + fields.sanitizeLoanType).
const LOAN_PURPOSE = {
  'Purchase': 'Purchase',
  'Refi R&T': 'Refinance',
  'Refi Cash-Out': 'Refinance',
  'Ground up': 'Construction',
  'Ground-up': 'Construction',
  'HELOC': 'Other',
};
// Cash-out vs rate/term is carried separately in MISMO; we remember which of the
// two refinance flavors produced "Refinance" so import can restore the detail.
const REFI_CASHOUT = { 'Refi Cash-Out': 'CashOut', 'Refi R&T': 'NoCashOut' };

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
const MARITAL = {
  'Married': 'Married',
  'Separated': 'Separated',
  'Single': 'Unmarried',
  'Divorced': 'Unmarried',
  'Widowed': 'Unmarried',
};

// ---- MortgageType ------------------------------------------------------------
// Business-purpose / private-money loans have no dedicated MISMO type; the
// broadly-accepted, importer-friendly value is Conventional. Overridable later.
const DEFAULT_MORTGAGE_TYPE = 'Conventional';

// ---- AmortizationType --------------------------------------------------------
const DEFAULT_AMORTIZATION_TYPE = 'Fixed';

// Attachment hint from our dwelling type — best-effort, non-authoritative.
const ATTACHMENT = {
  'SFR': 'Detached',
  'Townhouse': 'Attached',
  'Condo': 'Attached',
  'Multi 2-4': 'Attached',
  'Multi 5+': 'Attached',
  'Mixed Use': 'Attached',
};
// Rough financed-unit-count inference when the application didn't capture units.
const UNITS_HINT = { 'SFR': 1, 'Condo': 1, 'Townhouse': 1, 'Multi 2-4': 2, 'Multi 5+': 5, 'Mixed Use': 1 };

module.exports = {
  norm,
  // forward (ours -> MISMO), used by the exporter
  toMismoLoanPurpose: makeForward(LOAN_PURPOSE, 'Other'),
  toMismoRefiCashOut: makeForward(REFI_CASHOUT),
  toMismoOccupancy: makeForward(OCCUPANCY),
  toMismoCitizenship: makeForward(CITIZENSHIP),
  toMismoMarital: makeForward(MARITAL),
  toMismoAttachment: makeForward(ATTACHMENT),
  unitsHint: (propertyType) => UNITS_HINT[propertyType] || null,
  DEFAULT_MORTGAGE_TYPE,
  DEFAULT_AMORTIZATION_TYPE,
  // reverse (MISMO -> ours), used by the importer
  fromMismoLoanPurpose: (mismoPurpose, cashOut) => {
    // Rebuild our finer loan_type using the cash-out detail when present.
    const base = makeReverse(LOAN_PURPOSE)(mismoPurpose);
    if (base === 'Refinance' || norm(mismoPurpose) === norm('Refinance')) {
      if (norm(cashOut) === norm('CashOut')) return 'Refi Cash-Out';
      if (norm(cashOut) === norm('NoCashOut')) return 'Refi R&T';
      return 'Refi R&T';
    }
    if (norm(mismoPurpose) === norm('Purchase')) return 'Purchase';
    if (norm(mismoPurpose) === norm('Construction') || norm(mismoPurpose) === norm('ConstructionToPermanent')) return 'Ground up';
    return base; // may be null -> caller leaves loan_type unset
  },
  fromMismoOccupancy: makeReverse(OCCUPANCY),
  fromMismoCitizenship: makeReverse(CITIZENSHIP),
  fromMismoMarital: makeReverse(MARITAL),
};
