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
    `SELECT id, borrower_id, co_borrower_id, llc_id, property_address, purchase_price, loan_amount,
            as_is_value, arv, rehab_budget, program, property_type, units,
            ys_loan_number, is_assignment, assignment_fee, underlying_contract_price
       FROM applications WHERE id = $1`, [appId])).rows[0] || null;
  if (!app) return null;
  const loadBorrower = async (id) => (id
    ? (await client.query(
        `SELECT id, first_name, last_name, date_of_birth, current_address, prior_address, fico
           FROM borrowers WHERE id = $1`, [id])).rows[0] || null
    : null);
  const borrower = await loadBorrower(app.borrower_id);
  // The CO-BORROWER is a second real person on the file (owner-directed 2026-07-27): a
  // government ID belonging to them was being compared to the PRIMARY borrower and false-flagged
  // as a fatal name/DOB mismatch. Load them so the ID checks know the whole set of people who may
  // legitimately have an ID on file.
  const coBorrower = app.co_borrower_id && app.co_borrower_id !== app.borrower_id
    ? await loadBorrower(app.co_borrower_id) : null;
  // The vesting entity on the file + every LLC the borrower is on record for (assets).
  const vesting = app.llc_id
    ? (await client.query(`SELECT llc_name, ein, is_verified FROM llcs WHERE id = $1`, [app.llc_id])).rows[0] || null
    : null;
  const entities = app.borrower_id
    ? (await client.query(`SELECT llc_name, is_verified FROM llcs WHERE borrower_id = $1 ORDER BY llc_name`, [app.borrower_id])).rows
    : [];
  // The current registered product breakdown — the engine's own SIZED figures. The leverage metrics
  // need the INITIAL ADVANCE (acquisition portion), NOT the total loan, to check loan-to-purchase /
  // as-is LTV: the frozen engine caps `maxAcqLTV * acqDenom` on the acquisition advance, while the
  // rehab holdback (part of the total loan) is legitimately allowed above those caps. Also exposes
  // the REGISTERED program so program-aware rules (e.g. the owner-verification threshold) use the
  // product the deal is actually registered under, not just applications.program. Read-only.
  const reg = (await client.query(
    `SELECT program, total_loan, quote FROM product_registrations
      WHERE application_id = $1 AND is_current LIMIT 1`, [appId])).rows[0] || null;
  let quoteObj = reg && reg.quote;
  if (typeof quoteObj === 'string') { try { quoteObj = JSON.parse(quoteObj); } catch (_) { quoteObj = null; } }
  const sizing = quoteObj && quoteObj.sizing ? quoteObj.sizing : null;
  const numOrNull = (v) => (v == null || !isFinite(Number(v)) ? null : Number(v));
  // Fix 2026-07-23 (#209): persisted quotes carry the caps at guidelines.caps —
  // a top-level quote.caps never exists on a real registration, so the metrics
  // silently fell back to the loosest per-program ceiling instead of the file's
  // ACTUAL registered tier caps.
  const qcaps = (quoteObj && (quoteObj.caps || (quoteObj.guidelines && quoteObj.guidelines.caps))) || null;
  const registration = reg ? {
    program: reg.program || null,
    totalLoan: numOrNull(reg.total_loan),
    initialAdvance: sizing ? numOrNull(sizing.initialAdvance) : null,
    rehabHoldback: sizing ? numOrNull(sizing.rehabHoldback) : null,
    financedReserve: sizing ? numOrNull(sizing.financedReserve) : null,
    // The file's ACTUAL registered engine caps (per-tier fractions) — so the underwriting metrics
    // check leverage against the SAME caps the loan was sized under, not a generic default (a
    // validly-sized loan can then never exceed its own caps → no spurious over-leverage findings).
    caps: qcaps ? {
      maxAcqLtv: numOrNull(qcaps.maxAcqLtv),
      maxArvLtv: numOrNull(qcaps.maxArvLtv),
      maxLtc: numOrNull(qcaps.maxLtc),
    } : null,
    // DID THE PRODUCT ACTUALLY PRICE AS AN ASSIGNMENT? (owner-directed 2026-08-02: the wholesale
    // review runs "only if the file shows it's an assignment of contract on the application AND on
    // the product and pricing"). The engine writes this block ONLY when it sized the loan on the
    // seller price plus the financeable fee (`pricing.js` requires `is_assignment` AND a captured
    // seller price), so its PRESENCE is the pricing side of that question — not a second flag
    // somebody could forget to set. Read-only; no frozen number is recomputed here.
    assignment: (quoteObj && quoteObj.assignment) ? {
      sellerPrice: numOrNull(quoteObj.assignment.sellerPrice),
      totalPrice: numOrNull(quoteObj.assignment.totalPrice),
      fee: numOrNull(quoteObj.assignment.fee),
      financeableFee: numOrNull(quoteObj.assignment.financeableFee),
      recognizedPrice: numOrNull(quoteObj.assignment.recognizedPrice),
    } : null,
    isAssignment: !!(quoteObj && quoteObj.assignment),
  } : null;
  // Which of the borrower's entities are VERIFIED (LLC section complete: formation + OA + EIN
  // reviewed, is_verified=true). A business bank account under an entity that is on file but NOT
  // verified should still prompt "finish setting up that entity" (owner-directed 2026-07-24) —
  // the bank check needs the verified subset to tell "known & verified" from "named but unverified".
  const verifiedEntityNames = [
    ...(vesting && vesting.is_verified ? [vesting.llc_name] : []),
    ...entities.filter((r) => r.is_verified).map((r) => r.llc_name),
  ].filter(Boolean);
  // Entity legal names PILOT has already READ off an entity document uploaded to the file — an
  // operating agreement, articles of formation, or EIN letter (owner 2026-07-27: "a lot of times
  // the operating agreement is uploaded WITH the bank statements — look for it before raising
  // fraud"). So a bank statement under a different LLC can point at the OA that is ALREADY on file
  // and ask the underwriter to verify + add the entity, instead of screaming for a document that is
  // sitting right there. Best-effort — a read failure leaves the set empty (the check just won't
  // find an on-file doc, which is the safe direction).
  let entityDocNames = [];
  try {
    const ed = await client.query(
      `SELECT DISTINCT fields->>'entityLegalName' AS name
         FROM document_extractions
        WHERE application_id = $1 AND is_current
          AND doc_type IN ('operating_agreement','llc_formation','ein_letter','good_standing')
          AND NULLIF(TRIM(COALESCE(fields->>'entityLegalName','')),'') IS NOT NULL`, [appId]);
    entityDocNames = ed.rows.map((r) => r.name).filter(Boolean);
  } catch (_) { entityDocNames = []; }
  // Names of every individual PILOT has read off an operating agreement on the file (members +
  // managing member). A ≥25% LLC owner may legitimately put their own government ID on the file
  // (KYC) — that ID is NOT the borrower, so its name must NOT be flagged as a borrower name
  // mismatch. Best-effort: a read failure leaves the set empty (the ID check just won't recognize
  // an owner-only name, which is the safe direction). Read-only.
  let ownerNames = [];
  try {
    const oa = await client.query(
      `SELECT fields FROM document_extractions
        WHERE application_id = $1 AND is_current AND doc_type = 'operating_agreement'`, [appId]);
    for (const r of oa.rows) {
      const f = (r && r.fields) || {};
      if (Array.isArray(f.members)) for (const m of f.members) { if (m && m.name) ownerNames.push(m.name); }
      if (f.managingMember) ownerNames.push(f.managingMember);
    }
    ownerNames = [...new Set(ownerNames.filter(Boolean))];
  } catch (_) { ownerNames = []; }
  return {
    app, borrower, coBorrower,
    vestingName: vesting && vesting.llc_name,
    ein: vesting && vesting.ein,
    entityNames: entities.map((r) => r.llc_name).filter(Boolean),
    verifiedEntityNames,
    entityDocNames,
    ownerNames,
    registration,
  };
}

function borrowerName(b) {
  if (!b) return null;
  const n = require('../person-name').displayName(b);
  return n || null;
}

// Build the subject a given document type's check compares against.
function subjectFor(docType, ctx) {
  const { app, borrower, coBorrower, vestingName, entityNames, verifiedEntityNames, entityDocNames, ownerNames } = ctx || {};
  switch (docType) {
    case 'government_id':
      // The whole SET of people who may legitimately have an ID on this file — the primary
      // borrower, the co-borrower, and (name-only) any LLC owner read off an operating agreement.
      // The ID check matches an ID to ANY of them, so a co-borrower's ID is no longer flagged as a
      // fatal name/DOB mismatch against the primary borrower (owner-directed 2026-07-27).
      return { people: [borrower, coBorrower].filter(Boolean), ownerNames: ownerNames || [] };
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
    case 'voided_check':
      // verified_entity_names lets the bank check tell a KNOWN & VERIFIED entity (funds count,
      // no flag) from one that is merely named on file (advisory: finish the LLC section). Always
      // an array here (loadContext returns [] when nothing is verified) — so the check's
      // never-fabricate guard is satisfied and the advisory actually evaluates in production.
      return { borrower_name: borrowerName(borrower), entity_names: entityNames || [],
        verified_entity_names: verifiedEntityNames || [],
        // entity docs (OA / formation / EIN) already read on the file, so a different-entity account
        // can point at the ownership proof that is ALREADY here rather than demand a fresh one.
        entity_docs_on_file: entityDocNames || [] };
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
    case 'plans_permits':
      return { property_address: app && app.property_address, loan_type: app && app.loan_type };
    case 'signed_term_sheet':
      return { property_address: app && app.property_address, loan_amount: app && app.loan_amount,
        borrower_name: borrowerName(borrower) };
    case 'signed_application':
      return { property_address: app && app.property_address, borrower_name: borrowerName(borrower),
        entity_name: vestingName || null };
    case 'investor_structure':
      return { property_address: app && app.property_address, loan_amount: app && app.loan_amount,
        purchase_price: app && app.purchase_price };
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
