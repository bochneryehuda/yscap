'use strict';
/**
 * Document-type registry — the one place that maps a document type to its extraction
 * shape and its check logic. Adding a new document type (title, bank statement, insurance,
 * LLC operating agreement, …) is a single new entry here plus its schema + checks module;
 * the engine and the route never change. `subject` says what the checks compare against:
 *   'borrower'    — the borrowers row (IDs file at the borrower/profile level)
 *   'application' — the loan-file view the caller builds from the application (+ entity)
 * `image: true` means the original image is also sent to the analyzer (photo IDs).
 */
const { GOVERNMENT_ID, PURCHASE_CONTRACT } = require('./schemas');
const { computeIdFindings } = require('./id-checks');
const { computeContractFindings } = require('./purchase-contract-checks');

const REGISTRY = {
  government_id: {
    docType: 'government_id',
    schema: GOVERNMENT_ID.schema,
    instructions: GOVERNMENT_ID.instructions,
    subject: 'borrower',
    image: true,
    check: computeIdFindings,
  },
  purchase_contract: {
    docType: 'purchase_contract',
    schema: PURCHASE_CONTRACT.schema,
    instructions: PURCHASE_CONTRACT.instructions,
    subject: 'application',
    image: false,
    check: computeContractFindings,
  },
};

function get(docType) { return REGISTRY[docType] || null; }
function docTypes() { return Object.keys(REGISTRY); }

module.exports = { REGISTRY, get, docTypes };
