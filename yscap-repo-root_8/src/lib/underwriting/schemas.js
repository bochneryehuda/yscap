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

module.exports = { GOVERNMENT_ID, PURCHASE_CONTRACT, TITLE, BANK_STATEMENT };
