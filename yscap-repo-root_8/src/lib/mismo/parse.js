/**
 * MISMO 3.4 import parser — reads a MISMO v3.4 XML file (ours OR another
 * system's) and maps it back onto the portal's field names. Everything is
 * matched on LOCAL element names (namespace-prefix-agnostic) and located by
 * meaning rather than exact position, so a file whose containers sit in a
 * slightly different order — or carries extra containers we don't model — still
 * imports cleanly. Missing data is simply left unset; the parser never throws on
 * a merely-incomplete file (only on XML that isn't well-formed).
 *
 * Returns a normalized object plus a `warnings` list surfacing anything we saw
 * but could not place, so staff always know what the file contained.
 */
const X = require('./xml');
const E = require('./enums');
const { NS_YSCAP } = require('./build');

const numOrNull = (s) => {
  if (s == null || s === '') return null;
  const cleaned = String(s).replace(/[^0-9.\-]/g, '');
  // A value with no digit ("N/A", "TBD", "ten") must become null, NOT 0 — a
  // phantom 0 loan amount / value would mis-price a file.
  if (!/[0-9]/.test(cleaned)) return null;
  const n = Number(cleaned);
  return isFinite(n) ? n : null;
};

// Pull a jsonb-style address out of a MISMO ADDRESS element.
function readAddress(addr) {
  if (!addr) return null;
  const line1 = X.textAt(addr, 'AddressLineText');
  const out = {
    line1: line1 || '',
    line2: X.textAt(addr, 'AddressUnitIdentifier') || '',
    city: X.textAt(addr, 'CityName') || '',
    state: X.textAt(addr, 'StateCode') || '',
    zip: X.textAt(addr, 'PostalCode') || '',
  };
  return (out.line1 || out.city || out.state || out.zip) ? out : null;
}

function readContact(individual) {
  const out = { email: null, phone: null };
  for (const cp of X.kids(X.kid(individual, 'CONTACT_POINTS'), 'CONTACT_POINT')) {
    const email = X.textAt(cp, 'CONTACT_POINT_EMAIL', 'ContactPointEmailValue');
    const phone = X.textAt(cp, 'CONTACT_POINT_TELEPHONE', 'ContactPointTelephoneValue');
    if (email && !out.email) out.email = email;
    if (phone && !out.phone) out.phone = phone;
  }
  return out;
}

function isBorrowerParty(party) {
  // A PARTY is a borrower if any of its ROLEs carries a BORROWER container or a
  // PartyRoleType of Borrower. It is NEVER inferred merely from being an
  // individual — real MISMO files list loan originators, agents and settlement
  // parties as individuals too, and grabbing one of those as the borrower would
  // mis-attribute their identity (and SSN) to the loan.
  for (const role of X.allDeep(X.kid(party, 'ROLES'), 'ROLE')) {
    if (X.kid(role, 'BORROWER')) return true;
    const rt = X.textAt(role, 'ROLE_DETAIL', 'PartyRoleType');
    if (E.norm(rt) === E.norm('Borrower')) return true;
  }
  return false;
}

// A LEGAL_ENTITY party is the borrower's VESTING entity only when it plays a
// borrowing/owning role — never the lender (LoanOriginationCompany), servicer,
// or any other business party a MISMO file routinely carries.
const VESTING_ENTITY_ROLES = ['Borrower', 'TitleHolder', 'PropertyOwner'];
function entityIsVesting(party) {
  for (const role of X.allDeep(X.kid(party, 'ROLES'), 'ROLE')) {
    if (X.kid(role, 'BORROWER')) return true;
    const rt = X.textAt(role, 'ROLE_DETAIL', 'PartyRoleType');
    if (VESTING_ENTITY_ROLES.some((r) => E.norm(r) === E.norm(rt))) return true;
  }
  return false;
}

function readBorrower(party) {
  const individual = X.kid(party, 'INDIVIDUAL');
  const name = X.kid(individual, 'NAME');
  const contact = readContact(individual);
  const borrower = X.firstDeep(X.kid(party, 'ROLES'), 'BORROWER');
  // Read a borrower data point anywhere within the BORROWER subtree — real iLAD
  // files nest some points (e.g. CitizenshipResidencyType) below BORROWER_DETAIL
  // rather than directly under it, so an exact-path read would miss them.
  const bText = (local) => { const n = X.firstDeep(borrower, local); return n ? n.text : ''; };

  // SSN from TAXPAYER_IDENTIFIERS (type SocialSecurityNumber).
  let ssn = null;
  for (const t of X.allDeep(X.kid(party, 'TAXPAYER_IDENTIFIERS'), 'TAXPAYER_IDENTIFIER')) {
    const type = X.textAt(t, 'TaxpayerIdentifierType');
    const value = X.textAt(t, 'TaxpayerIdentifierValue');
    if (E.norm(type) === E.norm('SocialSecurityNumber') && value) ssn = value.replace(/[^0-9]/g, '');
  }

  // Current / prior residence addresses.
  let currentAddress = null, priorAddress = null, yearsAtResidence = null;
  for (const res of X.allDeep(borrower, 'RESIDENCE')) {
    const type = X.textAt(res, 'RESIDENCE_DETAIL', 'BorrowerResidencyType');
    const addr = readAddress(X.kid(res, 'ADDRESS'));
    if (E.norm(type) === E.norm('Prior')) { priorAddress = priorAddress || addr; }
    else {
      currentAddress = currentAddress || addr;
      const m = numOrNull(X.textAt(res, 'RESIDENCE_DETAIL', 'BorrowerResidencyDurationMonthsCount'));
      if (m != null) yearsAtResidence = Math.round((m / 12) * 10) / 10;
    }
  }

  // Employer (first one).
  const employer = X.textAt(X.firstDeep(borrower, 'EMPLOYER'), 'LEGAL_ENTITY', 'LEGAL_ENTITY_DETAIL', 'FullName') || null;

  return {
    firstName: X.textAt(name, 'FirstName') || null,
    middleName: X.textAt(name, 'MiddleName') || null,
    lastName: X.textAt(name, 'LastName') || null,
    suffix: X.textAt(name, 'SuffixName') || null,
    email: contact.email,
    phone: contact.phone,
    ssn: ssn && ssn.length === 9 ? ssn : null,
    dob: bText('BorrowerBirthDate') || null,
    citizenship: E.fromMismoCitizenship(bText('CitizenshipResidencyType')),
    maritalStatus: E.fromMismoMarital(bText('MaritalStatusType')),
    dependents: numOrNull(bText('DependentCount')),
    currentAddress,
    priorAddress,
    yearsAtResidence,
    employer,
  };
}

function readEntity(party) {
  const le = X.kid(party, 'LEGAL_ENTITY');
  if (!le) return null;
  const name = X.textAt(le, 'LEGAL_ENTITY_DETAIL', 'FullName');
  if (!name) return null;
  let ein = null;
  for (const t of X.allDeep(X.kid(party, 'TAXPAYER_IDENTIFIERS'), 'TAXPAYER_IDENTIFIER')) {
    if (E.norm(X.textAt(t, 'TaxpayerIdentifierType')) === E.norm('EmployerIdentificationNumber')) {
      ein = (X.textAt(t, 'TaxpayerIdentifierValue') || '').replace(/[^0-9]/g, '') || null;
    }
  }
  return { name, ein };
}

// Read our own lender-extension block (YSCAP:* under EXTENSION/OTHER).
function readExtension(deal) {
  const out = {};
  for (const other of X.allDeep(deal, 'OTHER')) {
    for (const ext of other.children) {
      for (const f of ext.children) {
        if (f.text) out[f.local] = f.text;
      }
    }
  }
  return out;
}

/**
 * Parse a MISMO 3.4 XML string into the portal's shape.
 * @param {string} xml
 * @returns {{ ok, loan, property, borrower, coBorrower, llc, extras, warnings }}
 */
function parseMismoXml(xml) {
  const warnings = [];
  let root;
  try {
    root = X.parse(xml);
  } catch (e) {
    const err = new Error(`This does not look like a valid MISMO XML file (${e.message}).`);
    err.userMessage = 'This file could not be read as MISMO XML. Please check it is a MISMO 3.4 file.';
    throw err;
  }
  if (root.local !== 'MESSAGE') {
    warnings.push(`Top element is <${root.local}>, expected <MESSAGE> — reading best-effort.`);
  }

  const deal = X.firstDeep(root, 'DEAL');
  if (!deal) {
    const err = new Error('No DEAL container found in the MISMO file.');
    err.userMessage = 'This MISMO file has no loan (DEAL) section, so there is nothing to import.';
    throw err;
  }

  // --- collateral / subject property ---
  const subject = X.firstDeep(deal, 'SUBJECT_PROPERTY') || X.firstDeep(deal, 'COLLATERAL');
  const propDetail = subject ? X.kid(subject, 'PROPERTY_DETAIL') : null;
  let asIsValue = propDetail ? numOrNull(X.textAt(propDetail, 'PropertyEstimatedValueAmount')) : null;
  if (asIsValue == null && subject) {
    const val = X.firstDeep(subject, 'PropertyValuationAmount');
    if (val) asIsValue = numOrNull(val.text);
  }
  const property = {
    address: subject ? readAddress(X.kid(subject, 'ADDRESS')) : null,
    units: propDetail ? numOrNull(X.textAt(propDetail, 'FinancedUnitCount')) : null,
    occupancy: propDetail ? E.fromMismoOccupancy(X.textAt(propDetail, 'PropertyUsageType')) : null,
    asIsValue,
    purchasePrice: numOrNull((X.firstDeep(subject, 'SalesContractAmount') || {}).text),
    rentalIncome: propDetail ? numOrNull(X.textAt(propDetail, 'RentalEstimatedGrossMonthlyRentAmount')) : null,
  };

  // --- loan ---
  const loanEl = X.firstDeep(deal, 'LOAN');
  const terms = loanEl ? X.kid(loanEl, 'TERMS_OF_LOAN') : null;
  const purpose = terms ? X.textAt(terms, 'LoanPurposeType') : '';
  const cashOut = loanEl ? (X.firstDeep(loanEl, 'RefinanceCashOutDeterminationType') || {}).text : '';
  let loanNumber = null, investorLoanNumber = null;
  for (const id of X.allDeep(loanEl, 'LOAN_IDENTIFIER')) {
    const type = X.textAt(id, 'LoanIdentifierType');
    const value = X.textAt(id, 'LoanIdentifier');
    if (!value) continue;
    if (E.norm(type) === E.norm('InvestorLoan')) investorLoanNumber = value;
    else loanNumber = loanNumber || value;
  }
  const months = numOrNull(
    X.textAt(loanEl, 'AMORTIZATION', 'AMORTIZATION_RULE', 'LoanAmortizationPeriodCount')
    || X.textAt(loanEl, 'MATURITY', 'MATURITY_RULE', 'LoanMaturityPeriodCount')
    || X.textAt(loanEl, 'LOAN_DETAIL', 'LoanMaturityPeriodCount'),
  );
  const loan = {
    loanNumber,
    investorLoanNumber,
    loanAmount: terms ? numOrNull(X.textAt(terms, 'BaseLoanAmount') || X.textAt(terms, 'NoteAmount')) : null,
    rate: terms ? numOrNull(X.textAt(terms, 'NoteRatePercent')) : null,
    loanType: E.fromMismoLoanPurpose(purpose, cashOut),
    term: months != null ? `${months} months` : null,
    occupancy: property.occupancy,
    estimatedClosingDate: (X.firstDeep(loanEl, 'LoanEstimatedClosingDate') || {}).text || null,
  };

  // --- parties (role-based; non-borrower individuals + the lender are skipped) ---
  let borrower = null, coBorrower = null, llc = null;
  for (const party of X.allDeep(X.kid(deal, 'PARTIES'), 'PARTY')) {
    if (X.kid(party, 'LEGAL_ENTITY')) {
      if (entityIsVesting(party)) { const e = readEntity(party); if (e && !llc) llc = e; }
      continue; // lender / originator company / servicer entities are not imported
    }
    if (!isBorrowerParty(party)) continue; // loan originator, agent, settlement, etc.
    const b = readBorrower(party);
    if (!borrower) borrower = b;
    else if (!coBorrower) coBorrower = b;
    else warnings.push(`Extra borrower "${[b.firstName, b.lastName].filter(Boolean).join(' ')}" was found but the portal file holds at most two borrowers — it was not imported.`);
  }
  if (!borrower) warnings.push('No borrower was found in the file.');

  // --- lender extension (RTL extras + values with no exact MISMO home) ---
  const ext = readExtension(deal);
  const extras = {
    program: ext.Program || null,
    arv: numOrNull(ext.AfterRepairValue),
    rehabBudget: numOrNull(ext.RehabBudget),
    rehabType: ext.RehabType || null,
    dscr: numOrNull(ext.DSCR),
    ltv: numOrNull(ext.LTV),
    ppp: ext.PrepaymentPenalty || null,
    fico: numOrNull(ext.FicoScore),
    lender: ext.Lender || null,
    channel: ext.Channel || null,
    propertyType: ext.PropertyType || null,
    sqftPre: numOrNull(ext.SquareFeetPre),
    sqftPost: numOrNull(ext.SquareFeetPost),
    expFlips: numOrNull(ext.RequestedExperienceFlips),
    expHolds: numOrNull(ext.RequestedExperienceHolds),
    expGround: numOrNull(ext.RequestedExperienceGroundUp),
    // RTL / carrying-cost / provider extras preserved verbatim in the extension.
    isAssignment: ext.IsAssignment === 'true' ? true : (ext.IsAssignment === 'false' ? false : null),
    underlyingContractPrice: numOrNull(ext.UnderlyingContractPrice),
    assignmentFee: numOrNull(ext.AssignmentFee),
    interestReserveMonths: numOrNull(ext.InterestReserveMonths),
    interestReserveAmount: numOrNull(ext.InterestReserveAmount),
    appraisedRentalValue: numOrNull(ext.AppraisedRentalValue),
    cdaValue: numOrNull(ext.CDAValue),
    propertyTaxes: numOrNull(ext.PropertyTaxesAnnual),
    propertyInsurance: numOrNull(ext.PropertyInsuranceAnnual),
    propertyHoa: numOrNull(ext.PropertyHOA),
    firstLien: numOrNull(ext.FirstLienAmount),
    secondLien: numOrNull(ext.SecondLienAmount),
    titleCompany: ext.TitleCompany || null,
    insuranceCompany: ext.InsuranceCompany || null,
    appraiserName: ext.AppraiserName || null,
    actualClosingDate: ext.ActualClosingDate || null,
  };
  // Prefer the exact original marital status the extension preserved (MISMO's
  // Unmarried bucket loses Single/Divorced/Widowed) so the round-trip is lossless.
  if (borrower && ext.BorrowerMaritalStatus) borrower.maritalStatus = ext.BorrowerMaritalStatus;
  if (coBorrower && ext.CoBorrowerMaritalStatus) coBorrower.maritalStatus = ext.CoBorrowerMaritalStatus;
  // The portal keeps the dwelling type as its own vocabulary; the extension
  // carries it verbatim so import restores it exactly.
  property.propertyType = extras.propertyType;

  return { ok: true, loan, property, borrower, coBorrower, llc, extras, warnings };
}

module.exports = { parseMismoXml, NS_YSCAP };
