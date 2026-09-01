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
 * ── THE BUTTONS AND THE DEFAULTS ARE SHARED, THE ENUMS ARE NOT ────────────
 * Which yes/no the officer toggled, and what an omitted number falls back to,
 * come from `../pricing/scenario-defaults.js` — the SAME module Lender Price
 * reads. That is not tidiness: before it, a scenario carrying `selfEmployed`
 * reached Lender Price and was silently dropped here (this file read
 * `isSelfEmployed`), an omitted prepay took five years there and NOTHING here,
 * and there was no first-time-home-buyer or rural field here at all — so the two
 * programs priced different loans and the difference read as a pricing edge.
 * The vendor ENUMS stay local, because two vendors' tokens that agree today are
 * not one fact.
 *
 * ── A KEY THE OFFICER DID NOT TOUCH IS NOT SENT ────────────────────────────
 * `isFirstTimeHomebuyer` and `isRuralProperty` are ABSENT from the recorded
 * aggregator body and appear only once the vendor's own app has touched that
 * control. We do the same — omit when unstated — which is both what the vendor
 * does and the only choice that asserts nothing nobody said. NOT PROVEN: whether
 * absent, `null` and `false` price identically. The recording changed other
 * fields in the same step every time, so they are treated as distinct.
 *
 * ── INTEREST-ONLY IS NOT AN INPUT HERE ─────────────────────────────────────
 * Measured across all 19 recorded pricing bodies: LoanNEX takes NO interest-only
 * field. IO is a PRODUCT the answer returns (`mortgageProducts[].isInterestOnly`),
 * so it is a filter on results, not a question in the request — exactly as the
 * owner described it. `parse.js` carries the flag; the board layer filters on it.
 *
 * PURE: no network, no database, no RTL import.
 */

const registryOf = require('./field-registry');
const shared = require('../pricing/scenario-defaults');
// ⛔ WHICH WAY EACH FIGURE IS CUT IS NOT THIS FILE'S DECISION. Both connectors read the one rule
// (`pricing/tier-rounding.js`), so the two programs can never be asked a different question about
// one loan — which is exactly what a private copy of "round the LTV up" in each of them would
// eventually produce.
const tierRounding = require('../pricing/tier-rounding');

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
  duplex: 'TwoToFourUnits', triplex: 'TwoToFourUnits', fourplex: 'TwoToFourUnits',
  // `multifamily` USED to map to TwoToFourUnits here while Lender Price's own
  // table documents MultiFamily as FIVE units — one word, two different
  // buildings, and the two programs would have priced different loans and called
  // the difference an execution advantage. It follows Lender Price's stated
  // meaning now; `duplex`/`2-4 units` remain the way to say the smaller one.
  multifamily: 'FivePlusUnits',
  manufacturedhousing: 'ManufacturedHousing', manufactured: 'ManufacturedHousing',
  modular: 'Modular', mixeduse: 'MixedUse', commercial: 'Commercial',
  fiveplusunits: 'FivePlusUnits', fiveplus: 'FivePlusUnits', fiveplusunit: 'FivePlusUnits',
  '5units': 'FivePlusUnits', '5unit': 'FivePlusUnits', '5plusunits': 'FivePlusUnits', '5plusunit': 'FivePlusUnits',
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
  return { value: money(value), loan: money(loan), ltv, ltvString: ltvString(ltv) };
}

/**
 * LoanNEX takes the LTV as a 2dp percentage string.
 *
 * ⛔ IT IS LIFTED, NEVER ROUNDED — owner-directed 2026-08-30, on being shown that the LTV carried
 * the DSCR bug pointing the other way: *"Round this up."*
 *
 * AN LTV SITS IN A BAND AND A HIGHER BAND PRICES WORSE, which is the exact mirror of DSCR. So the
 * dangerous direction here is DOWN: a loan at 80.0002% rounded to nearest is sent as "80.00", which
 * on a sheet whose next tier begins above 80 asks the vendor to price a loan one band better than
 * the one we actually have — and the quote comes back missing the add-on the investor applies at
 * lock. Same failure as the DSCR one, same cost: a borrower shown a price nobody will honour.
 *
 * Lifting can only ever land the loan in the band it has actually earned or a worse one, so the
 * error it can still make is the safe one. An LTV that is exactly on a tier is UNMOVED — that is
 * what `ceil2`'s float guard is for, and it is load-bearing rather than tidy: an ordinary
 * `0.7 * 100` is 70.00000000000001 in floating point, so a bare `Math.ceil` would push a plain 70%
 * loan to 70.01% and quietly price every round-number scenario in the system one tier worse.
 */
function ltvString(ltv) {
  if (ltv == null) return null;
  return ceil2(ltv * 100).toFixed(2);
}

/**
 * Cut a number DOWN to 2 decimals — never up.
 *
 * ⛔ THE BINARY REPRESENTATION HAS TO BE CLEARED FIRST, or this rounds the wrong
 * way on ordinary values. `1.15 * 100` is `114.99999999999999` in floating point,
 * so a bare `Math.floor` returns 1.14 — a value the user typed exactly, moved by
 * a whole cent, in the very direction this function exists to prevent going
 * unnoticed. So a product within a billionth of a whole number IS that whole
 * number (nothing about a real DSCR or LTV lives at that scale), and only a
 * genuine fraction is cut.
 */
function floor2(n) { return tierRounding.sendAs('dscr', n, 2); }

/** Lift a number UP to 2 decimals — never down. The LTV half of the same one rule. */
function ceil2(n) { return tierRounding.sendAs('ltv', n, 2); }

/**
 * LoanNEX takes DSCR as a 2dp string on four fields at once.
 *
 * ⛔ IT IS CUT DOWN, NEVER ROUNDED — owner-reported 2026-08-30, found auditing
 * American Heritage: *"`toFixed` rounds to nearest. So a DSCR of 0.999 is sent
 * to LoanNEX as 1.00. We need to round down, not round up."*
 *
 * A DSCR sits in a BAND, and a higher band prices better. Rounding to nearest
 * lifts 0.999 over the 1.00 line and 1.249 over the 1.25 line, so we ask the
 * vendor to price a loan that covers its payments when it does not quite — and
 * the quote comes back missing a penalty (1.25 points on the reported file) that
 * the investor will apply at lock. The borrower is shown a price nobody will
 * honour, which is the expensive direction to be wrong in.
 *
 * Cutting down can only ever land the loan in the band it has actually earned or
 * a worse one, so the error it can still make is the safe one.
 */
function dscrString(v) {
  const n = num(v);
  if (n == null) return null;
  const cut = floor2(n);
  // ⛔ A DSCR THAT EXISTS IS NEVER SENT AS "NO DSCR". Cutting down is right at
  // every band edge and wrong at exactly one place: a positive DSCR below 0.01
  // floors to "0.00", and 0.00 does not mean "a very weak ratio" to either
  // program — it means the loan HAS no ratio, which is a different product.
  // (Lender Price's own `dscrBand` reads `<= 0` as NoDSCR and anything above it
  // as the lowest ratio band.) So a real ratio under a cent is sent as 0.01: the
  // smallest figure that still says one exists. It is the one value this
  // function moves UP, and it cannot change a price — the next band edge is
  // 0.75, so 0.01 and 0.0066 are the same band either way. Saying a ratio is
  // absent when it is merely dreadful is the misstatement worth avoiding.
  return (cut === 0 && n > 0 ? 0.01 : cut).toFixed(2);
}

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

  // The shared DSCR profile — the SAME numbers Lender Price applies — and the
  // buttons read under any of their accepted spellings.
  const prof = shared.profileFor(s);
  const flags = shared.readFlags(s);

  const amounts = deriveAmounts(s);
  const purpose = A('Purpose', mapAlias(PURPOSE_ALIASES, s.purpose, 'purpose', 'unknown_loan_purpose'), 'purpose');
  const propAlias = aliasKey(prof.propertyType);
  const propertyType = A('PropertyType', mapAlias(PROPERTY_ALIASES, prof.propertyType, 'propertyType', 'unknown_property_type'), 'property_type');

  // Condo flavour: explicit `nonWarrantable`/`condoType` wins; otherwise inferred
  // from the property alias itself ("CondoNonWarr"), and null for non-condos.
  let condoType = null;
  if (propertyType === 'Condominium') {
    if (s.condoType != null && s.condoType !== '') condoType = A('CondoType', mapAlias(CONDO_TYPE_ALIASES, s.condoType, 'condoType', 'unknown_condo_type'), 'condo_type');
    else if (s.nonWarrantable === true) condoType = 'NonWarrantable';
    else if (CONDO_TYPE_BY_ALIAS[propAlias]) condoType = CONDO_TYPE_BY_ALIAS[propAlias];
  }

  // Prepay is a STRING on the wire and the registry lists exactly which terms
  // exist. An omitted term takes the shared five-year default rather than going
  // out empty — an empty prepay is a DIFFERENT loan from the one Lender Price
  // was asked about, which is the whole reason the default is shared.
  const prepay = A('PrepaymentPenalty', String(num(prof.prepayMonths)), 'prepay_months');
  // CITIZENSHIP IS READ FROM `citizenship` AND FROM NOTHING ELSE. It USED to fall
  // back to `borrowerType`, and that was a category error with a live cost: in this
  // scenario vocabulary `borrowerType` is the VESTING (entity) type — Lender Price's
  // own registry keeps BORROWER_TYPES (Individual / Corporation / Partnership / Trust
  // / Non-Profit / LLC) and CITIZENSHIP as two separate sets, its validator calls the
  // first one "borrower (vesting) type", and the board DEFAULTS it to 'LLC'. "LLC" is
  // in no citizenship table, so `mapAlias` refused the request (`unknown_citizenship`)
  // and EVERY LoanNEX quote on an entity-vested loan was refused before the wire —
  // which is the normal case here, the board's own footer being "business-purpose
  // loans, made to an entity for an investment property". Routing every investor to
  // LoanNEX therefore produced an empty board rather than a priced one.
  //
  // An unstated citizenship takes the SHARED default — the same module the prepay term,
  // the DSCR and the reserves come from, so the two programs cannot be asked a different
  // question about one loan. It resolves to 'US Citizen', which this alias table renders
  // as the vendor's `UsCitizen`: byte-for-byte what this connector sent when the answer
  // was an inline literal here, and what the recorded live body carries.
  //
  // A blank reads as unstated HERE, through the shared `withDefault` — the convention
  // `condoType` and `escrow` use below. Stated precisely, because the first version of
  // this comment overclaimed and an audit caught it: that is true of THIS BUILDER and
  // not of the combined route, which runs the scenario through Lender Price's registry
  // first and answers a blank with a 422 naming the field before either vendor is
  // called. So a blank cannot reach here from the board (its `toScenario` drops empty
  // strings anyway) — only an API caller can send one, and they are told which field
  // is wrong rather than having it guessed at.
  const citizenship = A('Citizenship',
    mapAlias(CITIZENSHIP_ALIASES, prof.citizenship, 'citizenship', 'unknown_citizenship'), 'citizenship');
  // WAIVE ESCROW. An explicit `escrow` value (Yes / Waived / TaxesOnly /
  // InsuranceOnly) is richer than the button and wins; otherwise the shared
  // `escrowWaive` flag decides, under any spelling.
  const escrow = A('Escrows', s.escrow != null && s.escrow !== '' ? mapAlias(ESCROW_ALIASES, s.escrow, 'escrow', 'unknown_escrow')
    : (flags.escrowWaive === true ? 'Waived' : 'Yes'), 'escrow');
  const state = s.state == null ? null : A('State', String(s.state).trim().toUpperCase(), 'state');

  const dscr = dscrString(prof.dscr);
  const mr = num(prof.reservesMonths);

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
    isSelfEmployed: flags.selfEmployed === undefined ? false : flags.selfEmployed,
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
    // Position 18 in the vendor's own body, between incomeDocumentation and
    // purpose. Present only when the officer actually answered it.
    ...(flags.fthb === undefined ? {} : { isFirstTimeHomebuyer: flags.fthb }),
    purpose,
    occupancy: A('Occupancy', s.occupancy || 'Investment', 'occupancy'),
    prePaymentPenaltyTermInMonths: prepay,
    isFirstTimeInvestor: flags.firstTimeInvestor === undefined ? false : flags.firstTimeInvestor,
    isShortTermRental: flags.shortTermRental === undefined ? false : flags.shortTermRental,
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
    // Position 35 in the vendor's own body, between state and countyKey.
    ...(flags.rural === undefined ? {} : { isRuralProperty: flags.rural }),
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
  buildNexApp, buildQuickPriceBody, deriveAmounts, dscrString, floor2, ceil2, ltvString, NexValidationError,
  _internals: { PURPOSE_ALIASES, PROPERTY_ALIASES, CONDO_TYPE_ALIASES, CITIZENSHIP_ALIASES, ESCROW_ALIASES, aliasKey, mapAlias, num, shared },
};
