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

module.exports = { GOVERNMENT_ID };
