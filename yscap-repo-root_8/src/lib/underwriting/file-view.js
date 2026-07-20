'use strict';
/**
 * The loan-file "view" the underwriting checks compare a document against — built from
 * the application + borrower + vesting entity the SAME way the appraisal import builds
 * its file view. Each document type compares against a different slice:
 *   government_id  -> the borrowers row (name / DOB / address)          (subject: 'borrower')
 *   purchase_contract / title -> the application view (address, price,  (subject: 'application')
 *                                buyer entity, assignment economics)
 *   bank_statement -> the assets view (borrower name + entity names)    (subject: 'assets')
 *
 * Keeping this in one module means the route never hand-assembles a subject (and can never
 * drift from what a check expects). Read-only: it only SELECTs; nothing here writes.
 *
 * It also normalizes a STORED extraction back into the small shape the cross-document
 * reconciliation consumes ({ sellerNames, buyerName, price, address }) so a file's saved
 * documents can be checked against each other without re-reading them.
 */
const { sellerNames: contractSellers } = require('./purchase-contract-checks');

// The columns each subject needs — fetched once by the route, sliced here.
async function loadContext(client, appId) {
  const app = (await client.query(
    `SELECT id, borrower_id, llc_id, property_address, purchase_price, loan_amount,
            as_is_value, arv, rehab_budget, program, property_type, units,
            ys_loan_number, is_assignment, assignment_fee, underlying_contract_price
       FROM applications WHERE id = $1`, [appId])).rows[0] || null;
  if (!app) return null;
  const borrower = app.borrower_id
    ? (await client.query(
        `SELECT id, first_name, last_name, date_of_birth, current_address, prior_address, fico
           FROM borrowers WHERE id = $1`, [app.borrower_id])).rows[0] || null
    : null;
  // The vesting entity on the file + every LLC the borrower is on record for (assets).
  const vesting = app.llc_id
    ? (await client.query(`SELECT llc_name, ein FROM llcs WHERE id = $1`, [app.llc_id])).rows[0] || null
    : null;
  const entities = app.borrower_id
    ? (await client.query(`SELECT llc_name FROM llcs WHERE borrower_id = $1 ORDER BY llc_name`, [app.borrower_id])).rows
    : [];
  return {
    app, borrower,
    vestingName: vesting && vesting.llc_name,
    ein: vesting && vesting.ein,
    entityNames: entities.map((r) => r.llc_name).filter(Boolean),
  };
}

function borrowerName(b) {
  if (!b) return null;
  const n = `${b.first_name || ''} ${b.last_name || ''}`.trim();
  return n || null;
}

// Build the subject a given document type's check compares against.
function subjectFor(docType, ctx) {
  const { app, borrower, vestingName, entityNames } = ctx || {};
  switch (docType) {
    case 'government_id':
      return borrower; // the borrowers row (name / DOB / address)
    case 'purchase_contract':
    case 'title':
      return {
        property_address: app && app.property_address,
        purchase_price: app && app.purchase_price,
        entity_name: vestingName || null,
        borrower_name: borrowerName(borrower), // so the buyer check can tell "borrower personally" from a stranger
        is_assignment: !!(app && app.is_assignment),
        assignment_fee: app && app.assignment_fee,
        underlying_contract_price: app && app.underlying_contract_price,
        // title-only: the policy must insure the full loan, carry our loan number + mortgagee clause,
        // and the right endorsements for the collateral type.
        loan_amount: app && app.loan_amount,
        loan_number: (app && app.ys_loan_number) || null,
        property_type: app && app.property_type,
      };
    case 'bank_statement':
      return { borrower_name: borrowerName(borrower), entity_names: entityNames || [] };
    case 'assignment':
      return {
        entity_name: vestingName || null, is_assignment: !!(app && app.is_assignment),
        assignment_fee: app && app.assignment_fee, underlying_contract_price: app && app.underlying_contract_price,
      };
    case 'insurance':
    case 'settlement':
      return {
        property_address: app && app.property_address, entity_name: vestingName || null,
        loan_amount: app && app.loan_amount, purchase_price: app && app.purchase_price,
        rehab_budget: app && app.rehab_budget, // so the insurance check knows this is a construction/rehab deal
        loan_number: (app && app.ys_loan_number) || null, // the policy must carry our loan number + mortgagee clause
      };
    case 'operating_agreement':
    case 'ein_letter':
    case 'good_standing':
    case 'llc_formation':
      return { entity_name: vestingName || null, borrower_name: borrowerName(borrower) };
    case 'credit_report':
    case 'background_report':
      return { borrower_name: borrowerName(borrower), entity_name: vestingName || null, borrower,
        registered_fico: borrower && borrower.fico }; // the FICO the loan was PRICED on (borrowers.fico)
    case 'flood':
      return { property_address: app && app.property_address };
    case 'payoff_statement':
      return { property_address: app && app.property_address, loan_amount: app && app.loan_amount,
        loan_type: app && app.loan_type };
    case 'scope_of_work':
      return { property_address: app && app.property_address, rehab_budget: app && app.rehab_budget };
    default:
      return app || null;
  }
}

/**
 * Normalize one stored extraction's `fields` into the cross-document shape. Only the
 * fields the reconciliation needs are pulled; a type that doesn't carry a given fact
 * simply omits it (the pass compares only present facts, pairwise).
 */
function normalizeForCrossDoc(docType, fields) {
  const f = fields || {};
  switch (docType) {
    case 'purchase_contract':
      return {
        sellerNames: contractSellers(f),
        buyerName: f.buyerName || null,
        price: f.purchasePrice != null ? f.purchasePrice : null,
        address: f.propertyAddress || null,
      };
    case 'title':
      return {
        sellerNames: Array.isArray(f.vestedOwners) ? f.vestedOwners.filter(Boolean) : [],
        address: f.propertyAddress || null,
      };
    case 'appraisal':
      return {
        sellerNames: Array.isArray(f.sellerNames) ? f.sellerNames.filter(Boolean)
          : (f.sellerName ? [f.sellerName] : []),
        price: f.contractPrice != null ? f.contractPrice : (f.salePrice != null ? f.salePrice : null),
        address: f.propertyAddress || null,
      };
    default:
      return null; // types that carry none of the cross-checked facts
  }
}

module.exports = { loadContext, subjectFor, normalizeForCrossDoc, borrowerName };
