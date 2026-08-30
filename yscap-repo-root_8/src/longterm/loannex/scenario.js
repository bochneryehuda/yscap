'use strict';
/**
 * LONG-TERM — the LoanNEX pricing body, built from the canonical LT scenario.
 *
 * ONE SCENARIO, TWO VENDORS. The Pricing Engine speaks one scenario vocabulary
 * (`purpose`, `value`, `loan`, `ltv`, `fico`, `dscr`, `propertyType`, `zip`,
 * `prepayMonths`, …) — the same words the Lender Price route already accepts.
 * Each vendor adapter maps that vocabulary onto its OWN wire form. This module
 * is LoanNEX's half. It deliberately shares no mapping table with Lender Price:
 * two vendors' enums that happen to agree today are not one fact, and a shared
 * table would silently mis-map the day either renames a token.
 *
 * NOTHING HERE IS A GUESS. Every enum this module emits is checked against
 * LoanNEX's OWN live registry (`field-registry.js`) before it goes on the wire,
 * and an unrecognised value is REFUSED by name. The alias table below maps human
 * words to registry keys; the registry decides whether the key is real.
 *
 * THE VENDOR'S TYPO IS REPRODUCED ON PURPOSE. `secondLein` (sic) is the key
 * LoanNEX's own web app sends. Spelling it correctly would drop the field.
 *
 * KEY ORDER IS THE RECORDED ORDER. Not cosmetic: it lets the pure test compare
 * a built body against the verbatim recorded body as text, which is a far
 * stronger proof than field-by-field assertions a typo could slip past.
 *
 * READ-ONLY. This builds a PRICING request. Nothing here locks, registers,
 * books or writes anything at LoanNEX.
 *
 * PURE: no network, no database, no RTL import.
 */

const registryOf = require('./field-registry');

class NexValidationError extends Error {
  constructor(code, field, message) { super(message); this.code = code; this.field = field; this.name = 'NexValidationError'; }
}

// ── Human words → LoanNEX registry keys ──────────────────────────────────────
// The KEY on the right must exist in the live registry; `assertOption` proves it
// on every build, so a vendor rename surfaces as a refusal, never as a silent
// mis-price.
const PURPOSE_ALIASES = {
  purchase: 'Purchase',
  cashout: 'CashOutRefinance', cashoutrefinance: 'CashOutRefinance', cashoutrefi: 'CashOutRefinance', cashoutrefinancing: 'CashOutRefinance',
  refinance: 'NoCashOutRefinance', refi: 'NoCashOutRefinance', rateterm: 'NoCashOutRefinance', rateandterm: 'NoCashOutRefinance',
  ratetermrefinance: 'NoCashOutRefinance', rateandtermrefinance: 'NoCashOutRefinance', ratetermrefi: 'NoCashOutRefinance',
  nocashoutrefinance: 'NoCashOutRefinance',
  cashoutdebtconsolidation: 'CashOutDebtConsolidation', debtconsolidation: 'CashOutDebtConsolidation',
  delayedfinancing: 'DelayedFinancing',
};
const PROPERTY_ALIASES = {
  singlefamily: 'SingleFamily', sfr: 'SingleFamily', sfd: 'SingleFamily', detached: 'SingleFamily',
  townhouse: 'Townhouse', townhome: 'Townhouse',
  pud: 'Pud',
  condominium: 'Condominium', condo: 'Condominium', condowarr: 'Condominium', condononwarr: 'Condominium', condotel: 'Condominium',
  cooperative: 'CoOperative', coop: 'CoOperative',
  // Every natural spelling of "2-4 units" normalizes differently ('2-4 units' →
  // `24units`, '2 to 4 unit' → `2to4unit`), so each is listed rather than guessed
  // at by a pattern — a pattern loose enough to catch them all also catches
  // "24 units", which is a FivePlusUnits property.
  twotofourunits: 'TwoToFourUnits', unit24: 'TwoToFourUnits', units24: 'TwoToFourUnits',
  '24units': 'TwoToFourUnits', '24unit': 'TwoToFourUnits', '2to4units': 'TwoToFourUnits',
  '2to4unit': 'TwoToFourUnits', twotofourunit: 'TwoToFourUnits',
  multifamily: 'TwoToFourUnits', duplex: 'TwoToFourUnits', triplex: 'TwoToFourUnits', fourplex: 'TwoToFourUnits',
  manufacturedhousing: 'ManufacturedHousing', manufactured: 'ManufacturedHousing',
  modular: 'Modular', mixeduse: 'MixedUse', commercial: 'Commercial',
  fiveplusunits: 'FivePlusUnits', fiveplus: 'FivePlusUnits',
};
// The condo flavour rides a SEPARATE field, so "non-warrantable condo" keeps both facts.
const CONDO_TYPE_BY_ALIAS = { condowarr: 'Warrantable', condononwarr: 'NonWarrantable', condotel: 'Condotel' };
const CONDO_TYPE_ALIASES = { warrantable: 'Warrantable', warr: 'Warrantable', nonwarrantable: 'NonWarrantable', nonwarr: 'NonWarrantable', condotel: 'Condotel' };
const CITIZENSHIP_ALIASES = {
  uscitizen: 'UsCitizen', citizen: 'UsCitizen', us: 'UsCitizen',
  permanentresidentalien: 'PermanentResidentAlien', permresident: 'PermanentResidentAlien', greencard: 'PermanentResidentAlien',
  nonpermanentresidentalien: 'NonPermanentResidentAlien', nonpermresident: 'NonPermanentResidentAlien',
  foreignnational: 'ForeignNational', foreign: 'ForeignNational',
};
const ESCROW_ALIASES = { yes: 'Yes', escrowed: 'Yes', waived: 'Waived', waive: 'Waived', taxesonly: 'TaxesOnly', insuranceonly: 'InsuranceOnly' };

function aliasKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function mapAlias(table, raw, fieldName, code) {
  const k = aliasKey(raw);
  const hit = table[k];
  if (!hit) {
    throw new NexValidationError(code, fieldName,
      `Unknown ${fieldName} ${JSON.stringify(raw == null ? null : String(raw))}. The request is refused rather than defaulted — a defaulted ${fieldName} prices a different loan.`);
  }
  return hit;
}

/**
 * The amount triangle, LoanNEX-side. `value`, `loan` and `ltv` are three views of
 * two facts; any two determine the third. Mirrors the rule the Lender Price side
 * already enforces so one scenario means the same thing on both engines — but it
 * is computed here, not imported, because an amount is arithmetic, not a vendor
 * mapping. LTV is accepted as 75 or 0.75 and emitted as the "75.00" string form
 * LoanNEX's own app sends.
 */
function deriveAmounts(sc) {
  const money = (n) => (n == null ? null : Math.round(n * 100) / 100);
  let value = num(sc.value != null ? sc.value : sc.appraisedValue);
  let loan = num(sc.loan);
  let ltvRaw = num(sc.ltv);
  let ltv = ltvRaw == null ? null : (ltvRaw > 1 ? ltvRaw / 100 : ltvRaw);
  const known = [value, loan, ltv].filter((x) => x != null).length;
  if (known < 2) {
    throw new NexValidationError('insufficient_amounts', 'loan',
      'Two of { value, loan, ltv } are required — one alone cannot determine the other two.');
  }
  if (value == null) value = money(loan / ltv);
  else if (loan == null) loan = money(value * ltv);
  else if (ltv == null) ltv = value > 0 ? loan / value : null;
  return { value: money(value), loan: money(loan), ltv, ltvString: ltv == null ? null : (ltv * 100).toFixed(2) };
}

/** LoanNEX takes DSCR as a 2dp string on four fields at once. */
function dscrString(v) { const n = num(v); return n == null ? null : n.toFixed(2); }

/**
 * Build the `nexApp` object — the scenario half of the pricing body.
 *
 * `countyKey` is NOT resolved here: it is a LOOKUP against LoanNEX (see
 * counties.js) and this module stays network-free, so the caller passes the
 * resolved key in. A null key is allowed through — LoanNEX prices without it,
 * less precisely — and the route reports that it was unresolved rather than
 * inventing a number.
 */
function buildNexApp(sc, registry, opts = {}) {
  const s = sc || {};
  const reg = registry || registryOf.capturedRegistry();
  const A = (fieldName, key, label) => (key == null ? null : registryOf.assertOption(reg, fieldName, key, label));

  const amounts = deriveAmounts(s);
  const purpose = A('Purpose', mapAlias(PURPOSE_ALIASES, s.purpose, 'purpose', 'unknown_loan_purpose'), 'purpose');
  const propAlias = aliasKey(s.propertyType);
  const propertyType = A('PropertyType', mapAlias(PROPERTY_ALIASES, s.propertyType, 'propertyType', 'unknown_property_type'), 'property_type');

  // Condo flavour: explicit `nonWarrantable`/`condoType` wins; otherwise inferred
  // from the property alias itself ("CondoNonWarr"), and null for non-condos.
  let condoType = null;
  if (propertyType === 'Condominium') {
    if (s.condoType != null && s.condoType !== '') condoType = A('CondoType', mapAlias(CONDO_TYPE_ALIASES, s.condoType, 'condoType', 'unknown_condo_type'), 'condo_type');
    else if (s.nonWarrantable === true) condoType = 'NonWarrantable';
    else if (CONDO_TYPE_BY_ALIAS[propAlias]) condoType = CONDO_TYPE_BY_ALIAS[propAlias];
  }

  // Prepay is a STRING on the wire and the registry lists exactly which terms exist.
  const prepay = s.prepayMonths == null ? null : A('PrepaymentPenalty', String(num(s.prepayMonths)), 'prepay_months');
  const citizenship = A('Citizenship', s.borrowerType == null && s.citizenship == null ? 'UsCitizen'
    : mapAlias(CITIZENSHIP_ALIASES, s.citizenship != null ? s.citizenship : s.borrowerType, 'citizenship', 'unknown_citizenship'), 'citizenship');
  const escrow = A('Escrows', s.escrow != null ? mapAlias(ESCROW_ALIASES, s.escrow, 'escrow', 'unknown_escrow')
    : (s.escrowWaive === true ? 'Waived' : 'Yes'), 'escrow');
  const state = s.state == null ? null : A('State', String(s.state).trim().toUpperCase(), 'state');

  const dscr = dscrString(s.dscr);
  const reserves = num(s.reservesMonths);
  const mr = reserves == null ? 24 : reserves;

  // Units: only meaningful for the multi-unit types; a stale unit count on a
  // single-family scenario contradicts itself and disqualifies real programs.
  const units = propertyType === 'TwoToFourUnits' || propertyType === 'FivePlusUnits' ? num(s.units) : null;

  const purchasePrice = purpose === 'Purchase' ? amounts.value : (num(s.purchasePrice) != null ? num(s.purchasePrice) : null);
  const isCashOut = purpose === 'CashOutRefinance' || purpose === 'CashOutDebtConsolidation';
  const cashOutAmount = isCashOut ? num(s.cashoutAmount != null ? s.cashoutAmount : s.cashOutAmount) : null;

  // KEY ORDER IS THE RECORDED ORDER — see the header note.
  return {
    overrides: { qualifiedMr: mr, qualifiedDscr: dscr, actualDscr: dscr, actualMr: mr },
    creditEvent: {
      mortgageLatePayment: A('MortgageLatePayments', s.mortgageLatePayment || 'NoOccurrences24Mo', 'mortgage_late_payment'),
      bankruptcy: A('Bankruptcy', s.bankruptcy || 'None', 'bankruptcy'),
      foreclosure: A('Foreclosure', s.foreclosure || 'None', 'foreclosure'),
      deedInLieu: A('DeedInLieu', s.deedInLieu || 'None', 'deed_in_lieu'),
      shortSalePreForeclosure: A('ShortSaleOrPreForeclosure', s.shortSalePreForeclosure || 'None', 'short_sale'),
    },
    financingType: A('FinancingType', s.financingType || 'FirstLien', 'financing_type'),
    hasIndividualTaxpayerIdNumber: s.hasItin == null ? null : !!s.hasItin,
    citizenship,
    isSelfEmployed: s.isSelfEmployed == null ? false : !!s.isSelfEmployed,
    secondLein: num(s.subordinateLoanAmount), // (sic) — the vendor's own spelling
    helocDrawnAmount: num(s.helocDrawnAmount),
    helocLineAmount: num(s.helocLineAmount),
    combinedLoanAmount: num(s.combinedLoanAmount),
    cltv: num(s.cltv),
    hcltv: num(s.hcltv),
    bankruptcyType: s.bankruptcyType == null ? null : A('BankruptcyType', s.bankruptcyType, 'bankruptcy_type'),
    escrow,
    buydownType: A('BuydownType', s.buydownType || 'None', 'buydown_type'),
    fico: num(s.fico),
    incomeDocumentation: A('IncomeDocumentation', s.incomeDocType || 'DebtServiceCoverageRatio', 'income_doc_type'),
    purpose,
    occupancy: A('Occupancy', s.occupancy || 'Investment', 'occupancy'),
    prePaymentPenaltyTermInMonths: prepay,
    isFirstTimeInvestor: s.isFirstTimeInvestor == null ? false : !!s.isFirstTimeInvestor,
    isShortTermRental: s.isShortTermRental == null ? false : !!s.isShortTermRental,
    propertyType,
    numberOfUnits: units,
    condoType,
    appraisedValue: amounts.value,
    purchasePrice,
    loanAmount: amounts.loan,
    loanToValue: amounts.ltvString,
    cashOutAmount,
    cashInHand: num(s.cashInHand),
    secondaryFinancingType: A('SecondaryFinancingType', s.secondaryFinancingType || 'None', 'secondary_financing_type'),
    state,
    countyKey: opts.countyKey == null ? null : Number(opts.countyKey),
    qualifiedMr: mr,
    qualifiedDscr: dscr,
  };
}

/** The full pricing request envelope. `transactionId` is a client-chosen GUID. */
function buildQuickPriceBody(sc, registry, opts = {}) {
  return { data: { nexApp: buildNexApp(sc, registry, opts), nexTransactionGuid: '', transactionId: String(opts.transactionId || '') } };
}

module.exports = {
  buildNexApp, buildQuickPriceBody, deriveAmounts, dscrString, NexValidationError,
  _internals: { PURPOSE_ALIASES, PROPERTY_ALIASES, CONDO_TYPE_ALIASES, CITIZENSHIP_ALIASES, ESCROW_ALIASES, aliasKey, mapAlias, num },
};
