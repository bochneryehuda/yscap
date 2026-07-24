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
    "if shown, the property address, the legal description, and every lien/encumbrance listed. If the " +
    "report shows how/when the current owner acquired the property (a vesting deed in Schedule B or a " +
    "chain-of-title / prior-transfer entry), capture the current owner's ACQUISITION date (YYYY-MM-DD) " +
    "and the prior sale price if stated. Also capture the SCHEDULE B EXCEPTIONS/EXCLUSIONS from title " +
    "(the special exceptions list — e.g. easements, encroachments, lis pendens, notice of default, " +
    "bankruptcy, unpaid taxes, mechanic's liens) as an array of short strings, each the exception text " +
    "as printed. For each LIEN also capture its type (e.g. 'property tax', 'federal tax', 'mortgage', " +
    "'deed of trust', 'judgment', 'mechanic', 'HOA') and amount. From SCHEDULE A also capture the LOAN " +
    "NUMBER, the policy/insured LIABILITY AMOUNT (a plain number), and the LENDER MORTGAGEE CLAUSE / " +
    "proposed-insured text verbatim. Capture any ENDORSEMENTS called for or attached (e.g. 'ALTA 9', " +
    "'condominium', 'PUD', 'contiguity', 'survey') as an array of short strings, and the number of " +
    "PARCELS in the insured legal description if stated. Use null/[] for anything absent or " +
    "unreadable — do NOT guess. Prices/amounts as plain numbers. Set readable=false if too poor to trust.",
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
      exceptions:    { type: 'array', items: { type: 'string' } },   // Schedule B special exceptions/exclusions
      endorsements:  { type: 'array', items: { type: 'string' } },   // endorsements attached/called for (Schedule A/B)
      loanNumber:    { type: ['string', 'null'] },           // the loan number shown on Schedule A
      insuredAmount: { type: ['number', 'null'] },           // the policy liability amount (Schedule A)
      mortgageeClause: { type: ['string', 'null'] },         // the lender vesting / mortgagee clause text on Schedule A
      parcelCount:   { type: ['number', 'null'] },           // number of parcels in the insured legal description
      effectiveDate: { type: ['string', 'null'] },
      ownerAcquisitionDate:  { type: ['string', 'null'] },   // when the current owner/seller acquired it (YYYY-MM-DD)
      ownerAcquisitionPrice: { type: ['number', 'null'] },   // the prior sale price, if the report states it
      readable:      { type: 'boolean' },
      notes:         { type: ['string', 'null'] },
    },
    required: ['propertyAddress', 'vestedOwners', 'buyerNames', 'legalDescription', 'liens', 'exceptions', 'endorsements', 'loanNumber', 'insuredAmount', 'mortgageeClause', 'parcelCount', 'effectiveDate', 'ownerAcquisitionDate', 'ownerAcquisitionPrice', 'readable', 'notes'],
  },
};

// ---- Bank statement (assets / proof of funds) ----
const BANK_STATEMENT = {
  docType: 'bank_statement',
  instructions:
    "You are reviewing a bank statement for a loan file (assets / proof of funds). Extract the exact " +
    "account-holder name as printed (the FIRST/primary name if several are shown), whether the holder is a " +
    "person or a business/LLC, the bank name, the account number, the statement period, and the opening " +
    "balance, closing balance, total deposits, and total withdrawals as printed. If the account is held " +
    "JOINTLY by more than one named person (e.g. \"John Smith and Jane Smith\", \"John Smith OR Jane Doe\"), " +
    "list every ADDITIONAL account holder beyond the primary in additionalHolders (an empty array if the " +
    "account has a single holder). Also capture the SINGLE LARGEST individual deposit/credit in the " +
    "period (the amount) if the transaction detail is shown. Use null for anything absent/unreadable — do " +
    "NOT guess or compute values that aren't printed. Amounts as plain numbers. Set readable=false if poor.",
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      accountHolderName: { type: ['string', 'null'] },
      holderIsBusiness:  { type: ['boolean', 'null'] },   // true if the holder is an LLC/entity
      additionalHolders: { type: ['array', 'null'], items: { type: 'string' } }, // co-owners beyond the primary (joint accounts)
      bankName:          { type: ['string', 'null'] },
      accountNumber:     { type: ['string', 'null'] },     // masked to last-4 on storage
      statementPeriod:   { type: ['string', 'null'] },
      openingBalance:    { type: ['number', 'null'] },
      closingBalance:    { type: ['number', 'null'] },
      totalDeposits:     { type: ['number', 'null'] },
      totalWithdrawals:  { type: ['number', 'null'] },
      largestDeposit:    { type: ['number', 'null'] },     // the single biggest deposit/credit in the period
      readable:          { type: 'boolean' },
      notes:             { type: ['string', 'null'] },
    },
    required: ['accountHolderName', 'holderIsBusiness', 'additionalHolders', 'bankName', 'accountNumber', 'statementPeriod', 'openingBalance', 'closingBalance', 'totalDeposits', 'totalWithdrawals', 'largestDeposit', 'readable', 'notes'],
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
    "Capture the property address and whether both parties signed. Also note if the assignee is named " +
    "as a person 'OR an LLC to be formed' / 'or assignee's nominee' (assigneeIsEntityToBeFormed=true) " +
    "— i.e. the final vesting entity does not exist yet. Use null for anything absent or unreadable — " +
    "do NOT guess. Prices as plain numbers, dates YYYY-MM-DD. readable=false if poor.",
  schema: obj({
    assignorName: { type: ['string', 'null'] },
    assigneeName: { type: ['string', 'null'] },            // the borrowing entity
    assigneeIsEntityToBeFormed: { type: ['boolean', 'null'] }, // "X or an LLC to be formed"
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
    "every member with their ownership percentage AND whether that member is a natural PERSON, another " +
    "ENTITY (an LLC/corp), or a TRUST (member type: individual | entity | trust), whether the agreement " +
    "authorizes the entity to borrow money and encumber real property, and whether it is signed. Also " +
    "extract the entity's EIN if stated, the principal office / business address, and the registered " +
    "agent's name (fraud cross-checks compare these against the assignment parties). Use " +
    "null for anything absent or unreadable — do NOT guess. Percentages as plain numbers (e.g. 50 for " +
    "50%). readable=false if poor.",
  schema: obj({
    entityLegalName: { type: ['string', 'null'] },
    managementType: { type: ['string', 'null'] },          // member_managed | manager_managed
    managingMember: { type: ['string', 'null'] },
    members: {
      type: 'array',
      items: obj({ name: { type: ['string', 'null'] }, ownershipPct: { type: ['number', 'null'] },
        isManager: { type: ['boolean', 'null'] }, type: { type: ['string', 'null'] } }), // individual | entity | trust
    },
    authorizesBorrowing: { type: ['boolean', 'null'] },     // clause authorizing debt/encumbrance
    signed: { type: ['boolean', 'null'] },
    effectiveDate: { type: ['string', 'null'] },
    // Fix 2026-07-23 (#211): the assignment-fraud enrichment reads these —
    // they were never in the schema, so shared-EIN / shared-address /
    // shared-agent signals could not fire off the OA. Additive + nullable.
    ein: { type: ['string', 'null'] },
    principalOfficeAddress: { type: ['string', 'null'] },
    registeredAgent: { type: ['string', 'null'] },
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
    "delinquent / revoked), the issue date, AND any expiration / valid-through date if the " +
    "certificate states one (some states print a 'valid until' date; use null if none). Use null " +
    "for anything absent or unreadable — do NOT guess. Dates YYYY-MM-DD. readable=false if poor.",
  schema: obj({
    entityLegalName: { type: ['string', 'null'] },
    state: { type: ['string', 'null'] },
    stateFileNumber: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },                   // good_standing | active | delinquent | revoked
    issueDate: { type: ['string', 'null'] },
    expirationDate: { type: ['string', 'null'] },           // some states print a 'valid until' date
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- LLC formation (Articles of Organization / Certificate of Formation) ----
const LLC_FORMATION = {
  docType: 'llc_formation',
  instructions:
    "You are reviewing an LLC formation document — the TITLE varies by state (Articles of " +
    "Organization, Certificate of Formation, Certificate of Organization) and it may instead be a " +
    "FOREIGN REGISTRATION STATEMENT (an out-of-state LLC registering to do business in another state). " +
    "Extract the exact entity legal name, the document title as printed (formationType), the entity " +
    "type, the state where this was FILED (filingState), the JURISDICTION OF FORMATION — the home " +
    "state where the entity was actually formed (for a foreign registration this is DIFFERENT from the " +
    "filing state; for a normal formation it's the same), whether this is a foreign registration " +
    "(isForeignRegistration), the formation/filing date, the state file number, and the registered " +
    "agent name. Use null for anything absent or unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    entityLegalName: { type: ['string', 'null'] },
    formationType: { type: ['string', 'null'] },            // the doc title as printed
    entityType: { type: ['string', 'null'] },
    stateOfFormation: { type: ['string', 'null'] },         // kept for back-compat = home jurisdiction
    jurisdictionOfFormation: { type: ['string', 'null'] },  // home state the entity was FORMED in
    filingState: { type: ['string', 'null'] },              // the state this document was filed in
    isForeignRegistration: { type: ['boolean', 'null'] },
    formationDate: { type: ['string', 'null'] },
    stateFileNumber: { type: ['string', 'null'] },
    registeredAgent: { type: ['string', 'null'] },
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
    "vacant-property policy. Also capture the MORTGAGEE / LOSS-PAYEE clause text verbatim and the LOAN " +
    "NUMBER shown on the policy/binder. Use null for anything absent or unreadable — do NOT guess. " +
    "Amounts as plain numbers, dates YYYY-MM-DD. readable=false if poor.",
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
    mortgageeClause: { type: ['string', 'null'] },
    loanNumber: { type: ['string', 'null'] },
    buildersRisk: { type: ['boolean', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Insurance INVOICE / paid receipt ----
// The insurance CONDITION takes two documents: the binder/evidence (above) AND proof the premium is
// PAID so coverage is actually in force at funding. This is that second document — an invoice or
// paid receipt from the carrier/agency. We read whether it is paid in full (and any balance still
// due), plus the identifying fields so it can be tied to the same policy/property/loan as the binder.
const INSURANCE_INVOICE = {
  docType: 'insurance_invoice',
  instructions:
    "You are reviewing an INSURANCE INVOICE or PAID RECEIPT for a loan file — the proof that the " +
    "property-insurance premium has been paid (or what is still owed). Extract the named insured/policy " +
    "holder EXACTLY as printed, the carrier/agency, the policy number, the property address, the total " +
    "premium billed, the amount PAID, the balance/amount still due, and whether it is PAID IN FULL. Also " +
    "capture the invoice date, the due date, and the LOAN NUMBER if shown. Set paidInFull=true only if " +
    "the document clearly shows a zero balance / paid-in-full / receipt of full payment; set it false if " +
    "a balance remains; use null if it cannot be determined. Use null for anything absent or unreadable — " +
    "do NOT guess. Amounts as plain numbers, dates YYYY-MM-DD. readable=false if poor.",
  schema: obj({
    namedInsured: { type: ['string', 'null'] },
    carrier: { type: ['string', 'null'] },
    policyNumber: { type: ['string', 'null'] },
    propertyAddress: addr(),
    premium: { type: ['number', 'null'] },
    amountPaid: { type: ['number', 'null'] },
    balanceDue: { type: ['number', 'null'] },
    paidInFull: { type: ['boolean', 'null'] },
    invoiceDate: { type: ['string', 'null'] },
    dueDate: { type: ['string', 'null'] },
    loanNumber: { type: ['string', 'null'] },
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
    "You are reviewing a mortgage TRI-MERGE credit report for a loan file. Extract the subject's name and " +
    "date of birth, the report date, and the THREE bureau FICO scores SEPARATELY — TransUnion, Experian, " +
    "and Equifax (a tri-merge shows one FICO per bureau; capture each as printed, null for a bureau not " +
    "reported). Also give the representative/middle FICO score if the report states one. Extract the number " +
    "of open mortgage tradelines, whether there are any 30/60/90-day mortgage lates, and whether there are " +
    "any bankruptcies, foreclosures, judgments, or tax liens. Do NOT extract the full SSN. Use null for " +
    "anything absent or unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    subjectName: { type: ['string', 'null'] },
    dob: { type: ['string', 'null'] },
    reportDate: { type: ['string', 'null'] },
    ficoScore: { type: ['number', 'null'] },          // the report's stated representative/middle score, if any
    ficoTransunion: { type: ['number', 'null'] },
    ficoExperian: { type: ['number', 'null'] },
    ficoEquifax: { type: ['number', 'null'] },
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

// ---- Scope of work / rehab budget (fix-&-flip renovation plan) ----
const SCOPE_OF_WORK = {
  docType: 'scope_of_work',
  instructions:
    "You are reviewing a SCOPE OF WORK / rehab budget for a fix-and-flip renovation. Extract the " +
    "property address, the TOTAL rehab/renovation budget (the grand total, as a plain number), the " +
    "number of line items listed, the contractor / preparer name if shown, and the date. If the sheet " +
    "shows a contingency line, capture its amount. Use null for anything absent or unreadable — do NOT " +
    "guess or add up numbers yourself unless a printed total is shown. readable=false if too poor to trust.",
  schema: obj({
    propertyAddress:  addr(),
    totalBudget:      { type: ['number', 'null'] },   // the printed grand total
    lineItemCount:    { type: ['number', 'null'] },
    contingency:      { type: ['number', 'null'] },
    contractorName:   { type: ['string', 'null'] },
    preparedDate:     { type: ['string', 'null'] },
    readable:         { type: 'boolean' },
    notes:            { type: ['string', 'null'] },
  }),
};

// ---- Payoff statement (the lien being refinanced) ----
const PAYOFF_STATEMENT = {
  docType: 'payoff_statement',
  instructions:
    "You are reviewing a mortgage PAYOFF STATEMENT / demand from a loan servicer (the exact figure to " +
    "pay off the existing loan being refinanced). Extract the servicer/lender name, the loan number, the " +
    "borrower or entity named, the property address, the UNPAID PRINCIPAL BALANCE, the PER-DIEM (daily) " +
    "interest amount, the TOTAL PAYOFF AMOUNT (the 'good through' total due), and the GOOD-THROUGH / " +
    "payoff-expiration date (the date the quoted total is valid through, YYYY-MM-DD). Set " +
    "wiringInstructionsPresent true if wire instructions are shown. Amounts as plain numbers. Use null " +
    "for anything absent or unreadable — do NOT guess. readable=false if too poor to trust.",
  schema: obj({
    servicerName: { type: ['string', 'null'] },
    loanNumber: { type: ['string', 'null'] },
    borrowerName: { type: ['string', 'null'] },
    propertyAddress: addr(),
    unpaidPrincipalBalance: { type: ['number', 'null'] },
    perDiemInterest: { type: ['number', 'null'] },
    totalPayoffAmount: { type: ['number', 'null'] },
    goodThroughDate: { type: ['string', 'null'] },
    wiringInstructionsPresent: { type: ['boolean', 'null'] },
    readable: { type: 'boolean' },
    notes: { type: ['string', 'null'] },
  }),
};

// ---- Voided check / wire instructions (the borrower's disbursement account) ----
const VOIDED_CHECK = {
  docType: 'voided_check',
  instructions:
    "You are reviewing a VOIDED CHECK or bank WIRE/ACH instruction sheet used to set up the borrower's " +
    "disbursement account. Extract the ACCOUNT HOLDER name EXACTLY as printed, whether the holder is a " +
    "person or a business/LLC, the bank name, the ROUTING number (9 digits) and the ACCOUNT number " +
    "(mask all but the last 4 — never output the full number), and whether the word VOID is present. " +
    "Use null for anything absent or unreadable — do NOT guess. Set readable=false if too poor to trust.",
  schema: obj({
    accountHolderName: { type: ['string', 'null'] },
    holderIsBusiness:  { type: ['boolean', 'null'] },
    bankName:          { type: ['string', 'null'] },
    routingNumber:     { type: ['string', 'null'] },
    accountNumber:     { type: ['string', 'null'] },   // last-4 only
    isVoided:          { type: ['boolean', 'null'] },
    readable:          { type: 'boolean' },
    notes:             { type: ['string', 'null'] },
  }),
};

// ---- Plans & permits (ground-up construction) ----
const PLANS_PERMITS = {
  docType: 'plans_permits',
  instructions:
    "You are reviewing PLANS and/or a building PERMIT for a ground-up construction (or major rehab) " +
    "loan. Extract the property address, the permit number, the permit type (e.g. building, demolition, " +
    "electrical), the issuing authority/municipality, the issue date and expiration date (YYYY-MM-DD), " +
    "whether the permit is APPROVED/ISSUED (vs applied-for/pending), and a short description of the " +
    "approved scope. Use null for anything absent/unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    propertyAddress: addr(),
    permitNumber:    { type: ['string', 'null'] },
    permitType:      { type: ['string', 'null'] },
    issuingAuthority:{ type: ['string', 'null'] },
    issueDate:       { type: ['string', 'null'] },
    expirationDate:  { type: ['string', 'null'] },
    approved:        { type: ['boolean', 'null'] },   // issued/approved vs applied-for/pending
    scopeDescription:{ type: ['string', 'null'] },
    readable:        { type: 'boolean' },
    notes:           { type: ['string', 'null'] },
  }),
};

// ---- Signed term sheet ----
const SIGNED_TERM_SHEET = {
  docType: 'signed_term_sheet',
  instructions:
    "You are reviewing a LOAN TERM SHEET that the borrower is expected to have SIGNED. Extract the " +
    "borrower/entity name, the property address, the loan amount, the interest rate (percent), whether " +
    "a BORROWER SIGNATURE is present, and the signature/acceptance date (YYYY-MM-DD). Amounts as plain " +
    "numbers. Use null for anything absent/unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    borrowerName:      { type: ['string', 'null'] },
    propertyAddress:   addr(),
    loanAmount:        { type: ['number', 'null'] },
    interestRate:      { type: ['number', 'null'] },
    signaturePresent:  { type: ['boolean', 'null'] },
    signedDate:        { type: ['string', 'null'] },
    readable:          { type: 'boolean' },
    notes:             { type: ['string', 'null'] },
  }),
};

// ---- Signed application + business-purpose disclosure ----
const SIGNED_APPLICATION = {
  docType: 'signed_application',
  instructions:
    "You are reviewing a signed LOAN APPLICATION and business-purpose disclosure for an investment/ " +
    "business-purpose mortgage. Extract the borrower name, the entity name if the loan is in an LLC, the " +
    "property address, whether a BORROWER SIGNATURE is present, the signature date (YYYY-MM-DD), and " +
    "whether a BUSINESS-PURPOSE / non-owner-occupied certification is present (the statement that the " +
    "loan is for business/investment purposes, not personal/household). Use null for anything absent or " +
    "unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    borrowerName:          { type: ['string', 'null'] },
    entityName:            { type: ['string', 'null'] },
    propertyAddress:       addr(),
    signaturePresent:      { type: ['boolean', 'null'] },
    signedDate:            { type: ['string', 'null'] },
    businessPurposePresent:{ type: ['boolean', 'null'] },
    readable:              { type: 'boolean' },
    notes:                 { type: ['string', 'null'] },
  }),
};

// ---- Investor structure printout (internal) ----
const INVESTOR_STRUCTURE = {
  docType: 'investor_structure',
  instructions:
    "You are reviewing an internal INVESTOR STRUCTURE / deal-structure printout for a loan. Extract the " +
    "property address, the loan amount, the total purchase price if shown, the interest rate (percent), " +
    "and the points/origination if shown. Amounts as plain numbers, rate/points as percentages. Use null " +
    "for anything absent or unreadable — do NOT guess. readable=false if poor.",
  schema: obj({
    propertyAddress: addr(),
    loanAmount:      { type: ['number', 'null'] },
    purchasePrice:   { type: ['number', 'null'] },
    interestRate:    { type: ['number', 'null'] },
    points:          { type: ['number', 'null'] },
    readable:        { type: 'boolean' },
    notes:           { type: ['string', 'null'] },
  }),
};

module.exports = {
  GOVERNMENT_ID, PURCHASE_CONTRACT, TITLE, BANK_STATEMENT,
  ASSIGNMENT, OPERATING_AGREEMENT, EIN_LETTER, GOOD_STANDING, LLC_FORMATION,
  INSURANCE, INSURANCE_INVOICE, FLOOD, SETTLEMENT, CREDIT_REPORT, BACKGROUND_REPORT, CONTRACT_AMENDMENT, SCOPE_OF_WORK,
  PAYOFF_STATEMENT, VOIDED_CHECK, PLANS_PERMITS, SIGNED_TERM_SHEET, SIGNED_APPLICATION, INVESTOR_STRUCTURE,
};
