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
const {
  GOVERNMENT_ID, PURCHASE_CONTRACT, TITLE, BANK_STATEMENT,
  ASSIGNMENT, OPERATING_AGREEMENT, EIN_LETTER, GOOD_STANDING, LLC_FORMATION,
  INSURANCE, FLOOD, SETTLEMENT, CREDIT_REPORT, BACKGROUND_REPORT, CONTRACT_AMENDMENT, SCOPE_OF_WORK,
  PAYOFF_STATEMENT,
} = require('./schemas');
const { computeIdFindings } = require('./id-checks');
const { computeContractFindings } = require('./purchase-contract-checks');
const { computeTitleFindings } = require('./title-checks');
const { computeBankFindings } = require('./bank-statement-checks');
const {
  computeAssignmentFindings, computeOperatingAgreementFindings, computeEinFindings,
  computeGoodStandingFindings, computeFormationFindings, computeInsuranceFindings,
  computeFloodFindings, computeSettlementFindings, computeCreditFindings, computeBackgroundFindings,
  computeAmendmentFindings, computeScopeOfWorkFindings, computePayoffFindings,
} = require('./doc-checks');

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
  assignment: {
    docType: 'assignment', schema: ASSIGNMENT.schema, instructions: ASSIGNMENT.instructions,
    subject: 'application', image: false, check: computeAssignmentFindings,
  },
  operating_agreement: {
    docType: 'operating_agreement', schema: OPERATING_AGREEMENT.schema, instructions: OPERATING_AGREEMENT.instructions,
    subject: 'entity', image: false, check: computeOperatingAgreementFindings,
  },
  ein_letter: {
    docType: 'ein_letter', schema: EIN_LETTER.schema, instructions: EIN_LETTER.instructions,
    subject: 'entity', image: false, check: computeEinFindings,
  },
  good_standing: {
    docType: 'good_standing', schema: GOOD_STANDING.schema, instructions: GOOD_STANDING.instructions,
    subject: 'entity', image: false, check: computeGoodStandingFindings,
  },
  llc_formation: {
    docType: 'llc_formation', schema: LLC_FORMATION.schema, instructions: LLC_FORMATION.instructions,
    subject: 'entity', image: false, check: computeFormationFindings,
  },
  insurance: {
    docType: 'insurance', schema: INSURANCE.schema, instructions: INSURANCE.instructions,
    subject: 'application', image: false, check: computeInsuranceFindings,
  },
  flood: {
    docType: 'flood', schema: FLOOD.schema, instructions: FLOOD.instructions,
    subject: 'application', image: false, check: computeFloodFindings,
  },
  settlement: {
    docType: 'settlement', schema: SETTLEMENT.schema, instructions: SETTLEMENT.instructions,
    subject: 'application', image: false, check: computeSettlementFindings,
  },
  credit_report: {
    docType: 'credit_report', schema: CREDIT_REPORT.schema, instructions: CREDIT_REPORT.instructions,
    subject: 'borrower', image: false, check: computeCreditFindings,
  },
  background_report: {
    docType: 'background_report', schema: BACKGROUND_REPORT.schema, instructions: BACKGROUND_REPORT.instructions,
    subject: 'borrower', image: false, check: computeBackgroundFindings,
  },
  contract_amendment: {
    docType: 'contract_amendment', schema: CONTRACT_AMENDMENT.schema, instructions: CONTRACT_AMENDMENT.instructions,
    subject: 'application', image: false, check: computeAmendmentFindings,
  },
  scope_of_work: {
    docType: 'scope_of_work', schema: SCOPE_OF_WORK.schema, instructions: SCOPE_OF_WORK.instructions,
    subject: 'application', image: false, check: computeScopeOfWorkFindings,
  },
  payoff_statement: {
    docType: 'payoff_statement', schema: PAYOFF_STATEMENT.schema, instructions: PAYOFF_STATEMENT.instructions,
    subject: 'application', image: false, check: computePayoffFindings,
  },
};

function get(docType) { return REGISTRY[docType] || null; }
function docTypes() { return Object.keys(REGISTRY); }

module.exports = { REGISTRY, get, docTypes };
