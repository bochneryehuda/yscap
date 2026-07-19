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
const { GOVERNMENT_ID, PURCHASE_CONTRACT, TITLE, BANK_STATEMENT } = require('./schemas');
const { computeIdFindings } = require('./id-checks');
const { computeContractFindings } = require('./purchase-contract-checks');
const { computeTitleFindings } = require('./title-checks');
const { computeBankFindings } = require('./bank-statement-checks');

const REGISTRY = {
  government_id: {
    docType: 'government_id',
    schema: GOVERNMENT_ID.schema,
    instructions: GOVERNMENT_ID.instructions,
    subject: 'borrower',       // compares against the borrowers row
    image: true,
    check: computeIdFindings,
  },
  purchase_contract: {
    docType: 'purchase_contract',
    schema: PURCHASE_CONTRACT.schema,
    instructions: PURCHASE_CONTRACT.instructions,
    subject: 'application',    // compares against the loan-file view
    image: false,
    check: computeContractFindings,
  },
  title: {
    docType: 'title',
    schema: TITLE.schema,
    instructions: TITLE.instructions,
    subject: 'application',    // property_address; sellers feed the cross-document match
    image: false,
    check: computeTitleFindings,
  },
  bank_statement: {
    docType: 'bank_statement',
    schema: BANK_STATEMENT.schema,
    instructions: BANK_STATEMENT.instructions,
    subject: 'assets',         // { borrower_name, entity_names[] } — ownership + math rules
    image: false,
    check: computeBankFindings,
  },
};

function get(docType) { return REGISTRY[docType] || null; }
function docTypes() { return Object.keys(REGISTRY); }

module.exports = { REGISTRY, get, docTypes };
