'use strict';
/**
 * Extraction shapes + instructions for each document type the underwriting engine reads.
 * Each entry gives (a) a strict JSON Schema the AI analyzer is constrained to (Azure
 * structured outputs: additionalProperties:false, EVERY property listed in `required`,
 * nullable via ["string","null"] — NO min/max/length), and (b) the plain instruction
 * telling the model what to pull and — critically — to use null when it cannot read a
 * field confidently rather than guess (the owner's absolute rule: never guess onto the
 * file). New document types are added here as their own entry.
 */

// ---- Government-issued photo ID (driver's license / passport / state ID) ----
const GOVERNMENT_ID = {
  docType: 'government_id',
  instructions:
    "You are reviewing a US government-issued photo ID (driver's license, state ID, or " +
    "passport) for a loan file. Extract the fields exactly as printed on the document. " +
    "Use null for any field that is not present or that you cannot read with confidence — " +
    "do NOT guess or infer. Write all dates as YYYY-MM-DD. Set \"readable\" to false if the " +
    "image is too blurry/cropped to trust the values.",
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      documentType:   { type: 'string' },                     // driver_license | state_id | passport | other
      firstName:      { type: ['string', 'null'] },
      lastName:       { type: ['string', 'null'] },
      fullName:       { type: ['string', 'null'] },
      dateOfBirth:    { type: ['string', 'null'] },            // YYYY-MM-DD
      address: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          line1: { type: ['string', 'null'] },
          city:  { type: ['string', 'null'] },
          state: { type: ['string', 'null'] },
          zip:   { type: ['string', 'null'] },
        },
        required: ['line1', 'city', 'state', 'zip'],
      },
      documentNumber: { type: ['string', 'null'] },
      expirationDate: { type: ['string', 'null'] },            // YYYY-MM-DD
      issueDate:      { type: ['string', 'null'] },            // YYYY-MM-DD
      readable:       { type: 'boolean' },
      notes:          { type: ['string', 'null'] },
    },
    required: [
      'documentType', 'firstName', 'lastName', 'fullName', 'dateOfBirth',
      'address', 'documentNumber', 'expirationDate', 'issueDate', 'readable', 'notes',
    ],
  },
};

// ---- Purchase & sale contract (incl. assignment / wholesale addendum) ----
const PURCHASE_CONTRACT = {
  docType: 'purchase_contract',
  instructions:
    "You are reviewing a real-estate purchase & sale contract (and any assignment or " +
    "wholesale addendum) for a loan file. Extract the fields exactly as written. Use null " +
    "for anything absent or unreadable — do NOT guess. Write dates as YYYY-MM-DD and all " +
    "prices as plain numbers (no $, no commas). List EVERY seller named. Identify the buyer " +
    "exactly as written (usually an LLC). If this is an assignment/wholesale deal (the buyer " +
    "is assigning their contract to a new buyer for a fee), set isAssignment true, capture the " +
    "assignmentFee, and capture underlyingPrice = the seller's ORIGINAL contract price (before " +
    "the fee). Set readable=false if the document is too poor to trust.",
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      propertyAddress: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          line1: { type: ['string', 'null'] },
          city:  { type: ['string', 'null'] },
          state: { type: ['string', 'null'] },
          zip:   { type: ['string', 'null'] },
        },
        required: ['line1', 'city', 'state', 'zip'],
      },
      purchasePrice:   { type: ['number', 'null'] },
      sellerNames:     { type: 'array', items: { type: 'string' } },
      buyerName:       { type: ['string', 'null'] },
      isAssignment:    { type: 'boolean' },
      assignmentFee:   { type: ['number', 'null'] },
      underlyingPrice: { type: ['number', 'null'] },   // seller's original contract price
      closingDate:     { type: ['string', 'null'] },   // YYYY-MM-DD
      earnestMoney:    { type: ['number', 'null'] },
      readable:        { type: 'boolean' },
      notes:           { type: ['string', 'null'] },
    },
    required: [
      'propertyAddress', 'purchasePrice', 'sellerNames', 'buyerName', 'isAssignment',
      'assignmentFee', 'underlyingPrice', 'closingDate', 'earnestMoney', 'readable', 'notes',
    ],
  },
};

// ---- Title report / preliminary title commitment ----
const TITLE = {
  docType: 'title',
  instructions:
    "You are reviewing a title report / preliminary title commitment for a loan file. " +
    "Extract the vested owner(s) of record (the current SELLER for a purchase), the buyer/grantee " +
    "if shown, the property address, the legal description, and every lien/encumbrance listed. Use " +
    "null for anything absent or unreadable — do NOT guess. Prices/amounts as plain numbers. " +
    "Set readable=false if the document is too poor to trust.",
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      propertyAddress: {
        type: ['object', 'null'], additionalProperties: false,
        properties: { line1: { type: ['string', 'null'] }, city: { type: ['string', 'null'] }, state: { type: ['string', 'null'] }, zip: { type: ['string', 'null'] } },
        required: ['line1', 'city', 'state', 'zip'],
      },
      vestedOwners:  { type: 'array', items: { type: 'string' } },   // sellers / owner(s) of record
      buyerNames:    { type: 'array', items: { type: 'string' } },
      legalDescription: { type: ['string', 'null'] },
      liens: {
        type: 'array',
        items: {
          type: 'object', additionalProperties: false,
          properties: { holder: { type: ['string', 'null'] }, amount: { type: ['number', 'null'] }, type: { type: ['string', 'null'] } },
          required: ['holder', 'amount', 'type'],
        },
      },
      effectiveDate: { type: ['string', 'null'] },
      readable:      { type: 'boolean' },
      notes:         { type: ['string', 'null'] },
    },
    required: ['propertyAddress', 'vestedOwners', 'buyerNames', 'legalDescription', 'liens', 'effectiveDate', 'readable', 'notes'],
  },
};

// ---- Bank statement (assets / proof of funds) ----
const BANK_STATEMENT = {
  docType: 'bank_statement',
  instructions:
    "You are reviewing a bank statement for a loan file (assets / proof of funds). Extract the exact " +
    "account-holder name as printed, whether the holder is a person or a business/LLC, the bank name, " +
    "the account number, the statement period, and the opening balance, closing balance, total deposits, " +
    "and total withdrawals as printed. Use null for anything absent/unreadable — do NOT guess or compute " +
    "values that aren't printed. Amounts as plain numbers. Set readable=false if the copy is too poor to trust.",
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      accountHolderName: { type: ['string', 'null'] },
      holderIsBusiness:  { type: ['boolean', 'null'] },   // true if the holder is an LLC/entity
      bankName:          { type: ['string', 'null'] },
      accountNumber:     { type: ['string', 'null'] },     // masked to last-4 on storage
      statementPeriod:   { type: ['string', 'null'] },
      openingBalance:    { type: ['number', 'null'] },
      closingBalance:    { type: ['number', 'null'] },
      totalDeposits:     { type: ['number', 'null'] },
      totalWithdrawals:  { type: ['number', 'null'] },
      readable:          { type: 'boolean' },
      notes:             { type: ['string', 'null'] },
    },
    required: ['accountHolderName', 'holderIsBusiness', 'bankName', 'accountNumber', 'statementPeriod', 'openingBalance', 'closingBalance', 'totalDeposits', 'totalWithdrawals', 'readable', 'notes'],
  },
};

// Shared address sub-schema (nullable object; all parts nullable) for the expanded types.
function addr() {
  return {
    type: ['object', 'null'], additionalProperties: false,
    properties: { line1: { type: ['string', 'null'] }, city: { type: ['string', 'null'] }, state: { type: ['string', 'null'] }, zip: { type: ['string', 'null'] } },
    required: ['line1', 'city', 'state', 'zip'],
  };
}
// Build a strict object schema entry (additionalProperties:false, every prop required).
function obj(props) {
  return { type: 'object', additionalProperties: false, properties: props, required: Object.keys(props) };
}

// ---- Assignment of contract (wholesale) ----
const ASSIGNMENT = {
  docType: 'assignment',
  instructions:
    "You are reviewing an ASSIGNMENT OF CONTRACT (a wholesale deal where the original buyer " +
    "assigns the purchase contract to a new buyer for a fee). Extract the assignor (original " +
    "buyer/wholesaler), the assignee (the NEW buyer — usually the borrowing LLC), the seller's " +
    "ORIGINAL purchase price, the assignment fee, and the total price to the assignee if stated. " +
    "Capture the property address and whether both parties signed. Use null for anything absent " +
    "or unreadable — do NOT guess. Prices as plain numbers, dates YYYY-MM-DD. readable=false if poor.",
  schema: obj({
    assignorName: { type: ['string', 'null'] },
    assigneeName: { type: ['string', 'null'] },            // the borrowing entity
    originalPurchasePrice: { type: ['number', 'null'] },   // seller -> assignor
    assignmentFee: { type: ['number', 'null'] },
    totalPriceToAssignee: { type: ['number', 'null'] },
    sellerName: { type: ['string', 'null'] },
    propertyAddress: addr(),
    assignmentDate: { type: ['string', 'null'] },
    assignorSigned: { type: ['boolean', 'null'] },
    assigneeSigned: { type: ['boolean', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- LLC Operating Agreement ----
const OPERATING_AGREEMENT = {
  docType: 'operating_agreement',
  instructions:
    "You are reviewing an LLC OPERATING AGREEMENT for a loan file. Extract the exact entity legal " +
    "name, whether it is member-managed or manager-managed, the managing member / authorized signer, " +
    "every member with their ownership percentage, whether the agreement authorizes the entity to " +
    "borrow money and encumber real property, and whether it is signed. Use null for anything absent " +
    "or unreadable — do NOT guess. Percentages as plain numbers (e.g. 50 for 50%). readable=false if poor.",
  schema: obj({
    entityLegalName: { type: ['string', 'null'] },
    managementType: { type: ['string', 'null'] },          // member_managed | manager_managed
    managingMember: { type: ['string', 'null'] },
    members: {
      type: 'array',
      items: obj({ name: { type: ['string', 'null'] }, ownershipPct: { type: ['number', 'null'] }, isManager: { type: ['boolean', 'null'] } }),
    },
    authorizesBorrowing: { type: ['boolean', 'null'] },     // clause authorizing debt/encumbrance
    signed: { type: ['boolean', 'null'] },
    effectiveDate: { type: ['string', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- EIN / Tax-ID letter (IRS CP-575 / 147C) ----
const EIN_LETTER = {
  docType: 'ein_letter',
  instructions:
    "You are reviewing an IRS EIN assignment letter (CP-575 or 147C) for a loan file. Extract the " +
    "EIN, the exact entity legal name as printed, the entity type, and the assignment date. Use null " +
    "for anything absent or unreadable — do NOT guess. readable=false if the letter is too poor to trust.",
  schema: obj({
    ein: { type: ['string', 'null'] },
    entityLegalName: { type: ['string', 'null'] },
    entityType: { type: ['string', 'null'] },
    assignmentDate: { type: ['string', 'null'] },
    documentType: { type: ['string', 'null'] },             // CP575 | 147C
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Certificate of Good Standing / Existence ----
const GOOD_STANDING = {
  docType: 'good_standing',
  instructions:
    "You are reviewing a state Certificate of Good Standing / Existence for an LLC. Extract the exact " +
    "entity legal name, the state, the state file number, the status (good standing / active / " +
    "delinquent / revoked), and the issue date. Use null for anything absent or unreadable — do NOT " +
    "guess. Dates YYYY-MM-DD. readable=false if poor.",
  schema: obj({
    entityLegalName: { type: ['string', 'null'] },
    state: { type: ['string', 'null'] },
    stateFileNumber: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },                   // good_standing | active | delinquent | revoked
    issueDate: { type: ['string', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- LLC formation (Articles of Organization / Certificate of Formation) ----
const LLC_FORMATION = {
  docType: 'llc_formation',
  instructions:
    "You are reviewing an LLC's Articles of Organization / Certificate of Formation. Extract the exact " +
    "entity legal name, the entity type, the state of formation, the formation/filing date, and the " +
    "state file number. Use null for anything absent or unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    entityLegalName: { type: ['string', 'null'] },
    entityType: { type: ['string', 'null'] },
    stateOfFormation: { type: ['string', 'null'] },
    formationDate: { type: ['string', 'null'] },
    stateFileNumber: { type: ['string', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Hazard / property insurance (ACORD 27/28 evidence or dec page) ----
const INSURANCE = {
  docType: 'insurance',
  instructions:
    "You are reviewing evidence of property/hazard insurance (ACORD 27/28 or a declarations page) for " +
    "a loan file. Extract the named insured EXACTLY as printed, the carrier, the policy number, the " +
    "property address, the dwelling/coverage-A amount, the policy effective and expiration dates, the " +
    "premium, whether the lender's mortgagee clause is present, and whether it is a builders-risk / " +
    "vacant-property policy. Use null for anything absent or unreadable — do NOT guess. Amounts as plain " +
    "numbers, dates YYYY-MM-DD. readable=false if poor.",
  schema: obj({
    namedInsured: { type: ['string', 'null'] },
    carrier: { type: ['string', 'null'] },
    policyNumber: { type: ['string', 'null'] },
    propertyAddress: addr(),
    dwellingCoverage: { type: ['number', 'null'] },
    policyEffective: { type: ['string', 'null'] },
    policyExpiration: { type: ['string', 'null'] },
    premium: { type: ['number', 'null'] },
    mortgageeClausePresent: { type: ['boolean', 'null'] },
    buildersRisk: { type: ['boolean', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Flood determination / flood insurance ----
const FLOOD = {
  docType: 'flood',
  instructions:
    "You are reviewing a FEMA flood determination (SFHDF) and/or flood insurance for a loan file. " +
    "Extract the property address, the flood zone, whether the property is in a Special Flood Hazard " +
    "Area (in_sfha true for any zone starting with A or V), the FIRM panel, and — if a flood policy is " +
    "present — its building coverage and named insured. Use null for anything absent or unreadable — do " +
    "NOT guess. readable=false if poor.",
  schema: obj({
    propertyAddress: addr(),
    floodZone: { type: ['string', 'null'] },
    inSfha: { type: ['boolean', 'null'] },
    firmPanel: { type: ['string', 'null'] },
    determinationDate: { type: ['string', 'null'] },
    policyPresent: { type: ['boolean', 'null'] },
    buildingCoverage: { type: ['number', 'null'] },
    namedInsured: { type: ['string', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Settlement statement / Closing Disclosure / ALTA (HUD-1) ----
const SETTLEMENT = {
  docType: 'settlement',
  instructions:
    "You are reviewing a closing settlement statement (ALTA / Closing Disclosure / HUD-1) for a loan " +
    "file. Extract the buyer and seller names, the property address, the contract sales price, the loan " +
    "amount, the lender name, the earnest-money/deposit credit, seller credits, the borrower's cash to " +
    "close, seller proceeds, any assignment fee line, and the total of all sources and total of all uses " +
    "(so we can check they balance). Also capture any cash paid back TO the borrower at closing. Use null " +
    "for anything absent or unreadable — do NOT guess. Amounts as plain numbers. readable=false if poor.",
  schema: obj({
    buyerName: { type: ['string', 'null'] },
    sellerName: { type: ['string', 'null'] },
    propertyAddress: addr(),
    contractSalesPrice: { type: ['number', 'null'] },
    loanAmount: { type: ['number', 'null'] },
    lenderName: { type: ['string', 'null'] },
    earnestMoney: { type: ['number', 'null'] },
    sellerCredits: { type: ['number', 'null'] },
    cashToClose: { type: ['number', 'null'] },
    sellerProceeds: { type: ['number', 'null'] },
    assignmentFee: { type: ['number', 'null'] },
    cashBackToBorrower: { type: ['number', 'null'] },
    totalSources: { type: ['number', 'null'] },
    totalUses: { type: ['number', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Credit report ----
const CREDIT_REPORT = {
  docType: 'credit_report',
  instructions:
    "You are reviewing a mortgage credit report for a loan file. Extract the subject's name and date of " +
    "birth, the report date, the representative/middle FICO score, the number of open mortgage tradelines, " +
    "whether there are any 30/60/90-day mortgage lates, and whether there are any bankruptcies, " +
    "foreclosures, judgments, or tax liens. Do NOT extract the full SSN. Use null for anything absent or " +
    "unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    subjectName: { type: ['string', 'null'] },
    dob: { type: ['string', 'null'] },
    reportDate: { type: ['string', 'null'] },
    ficoScore: { type: ['number', 'null'] },
    openMortgageCount: { type: ['number', 'null'] },
    mortgageLates: { type: ['boolean', 'null'] },
    hasBankruptcy: { type: ['boolean', 'null'] },
    hasForeclosure: { type: ['boolean', 'null'] },
    hasJudgmentOrLien: { type: ['boolean', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Background / OFAC / fraud report ----
const BACKGROUND_REPORT = {
  docType: 'background_report',
  instructions:
    "You are reviewing a background / OFAC / fraud screening report for a loan file. Extract the subject " +
    "name and (if present) the entity name screened, the screen date, the OFAC/sanctions result " +
    "(clear / potential_match / confirmed_match), whether there is a PEP hit, and whether there are any " +
    "criminal records or fraud flags. Use null for anything absent or unreadable — do NOT guess. " +
    "readable=false if poor.",
  schema: obj({
    subjectName: { type: ['string', 'null'] },
    entityName: { type: ['string', 'null'] },
    screenDate: { type: ['string', 'null'] },
    ofacResult: { type: ['string', 'null'] },               // clear | potential_match | confirmed_match
    pepHit: { type: ['boolean', 'null'] },
    hasCriminalRecord: { type: ['boolean', 'null'] },
    fraudFlags: { type: 'array', items: { type: 'string' } },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Contract amendment / addendum (changes a term of the purchase contract) ----
const CONTRACT_AMENDMENT = {
  docType: 'contract_amendment',
  instructions:
    "You are reviewing an AMENDMENT or ADDENDUM to a real-estate purchase contract. It changes one " +
    "or more terms of the base contract (price, closing date, parties, credits). Extract ONLY the NEW " +
    "values it actually states — leave a field null if the amendment does not change it (do NOT copy " +
    "the base contract's unchanged terms, and NEVER guess). Capture the amendment's own date, whether " +
    "it is fully signed/executed by all parties, and a short description of what it changes. Prices as " +
    "plain numbers, dates YYYY-MM-DD. readable=false if too poor to trust.",
  schema: obj({
    propertyAddress: addr(),
    amendmentDate:   { type: ['string', 'null'] },   // the amendment's own execution/effective date
    newPurchasePrice:{ type: ['number', 'null'] },   // null = price unchanged by this amendment
    newClosingDate:  { type: ['string', 'null'] },   // null = closing date unchanged
    newBuyerName:    { type: ['string', 'null'] },
    newSellerName:   { type: ['string', 'null'] },
    executed:        { type: ['boolean', 'null'] },  // signed by ALL parties (governing) vs draft
    changeSummary:   { type: ['string', 'null'] },
    readable:        { type: 'boolean' },
    notes:           { type: ['string', 'null'] },
  }),
};

module.exports = {
  GOVERNMENT_ID, PURCHASE_CONTRACT, TITLE, BANK_STATEMENT,
  ASSIGNMENT, OPERATING_AGREEMENT, EIN_LETTER, GOOD_STANDING, LLC_FORMATION,
  INSURANCE, FLOOD, SETTLEMENT, CREDIT_REPORT, BACKGROUND_REPORT, CONTRACT_AMENDMENT,
};
