'use strict';
/**
 * Public-records cross-check (R3.23, owner-directed 2026-07-22).
 *
 * Owner ask: "maybe the seller doesn't match the owner of public records on their
 * appraisal report and maybe the buyer doesn't match to our entity — you need to
 * make sure we have a clear chain."
 *
 * Full public-records API integration (ATTOM / DataTree / CoreLogic) is deferred
 * (no key yet). This advisory does the STRUCTURAL cross-doc check: reads the seller
 * name from the purchase contract, the grantor from the title / preliminary title
 * report, the seller from the appraisal (if present), and the buyer from the
 * contract vs the vesting LLC on file. Any pair mismatch → suggestion.
 *
 * Composes the same normalizer the entity-chain module uses so a naming quirk
 * doesn't false-fire ('ABC LLC' vs 'ABC L.L.C.' normalize equal).
 *
 * Per HARD RULE: never modifies the file. Only posts ai_suggestions.
 */

const { entityMatch, namesMatchLoose } = require('./compare');
const aiSug = require('./ai-suggestions');

function firstFields(exts, docType) {
  const e = (exts || []).find((x) => x.doc_type === docType || x.docType === docType);
  return e ? (e.fields || {}) : null;
}

/**
 * PURE — inspect a file's extractions + vesting entity name and return the set of
 * chain mismatches. Zero DB.
 * @param {{vestingName?:string}} fileCtx
 * @param {Array<{doc_type,fields}>} extractions
 * @returns {{mismatches:Array<{code, title, howTo, docValueA, docValueB, severity}>}}
 */
function analyze(fileCtx = {}, extractions = []) {
  const contract = firstFields(extractions, 'purchase_contract');
  const title = firstFields(extractions, 'title');
  const appraisal = firstFields(extractions, 'appraisal');
  const vestingName = fileCtx.vestingName || null;
  const out = [];

  // --- Seller consistency across contract vs title vs appraisal ---
  const sellerContract = contract && contract.sellerName;
  const grantorTitle = title && (title.grantor || title.sellerName || (Array.isArray(title.grantors) ? title.grantors[0] : null));
  const sellerAppraisal = appraisal && (appraisal.currentOwnerName || appraisal.sellerName || null);

  if (sellerContract && grantorTitle && entityMatch(sellerContract, grantorTitle) === false && namesMatchLoose(sellerContract, grantorTitle) === false) {
    out.push({ code: 'chain_seller_vs_title_grantor', severity: 'warning',
      title: 'Seller on contract does not match the property\'s recorded owner on title',
      howTo: `The purchase contract lists "${sellerContract}" as the seller but the title report shows "${grantorTitle}" as the recorded owner. A mismatch here is often benign (recent transfer, entity re-vesting) but sometimes indicates the seller is not the party who can legally convey — request a clarifying document (deed / title endorsement) before closing.`,
      docValueA: sellerContract, docValueB: grantorTitle });
  }
  if (sellerContract && sellerAppraisal && entityMatch(sellerContract, sellerAppraisal) === false && namesMatchLoose(sellerContract, sellerAppraisal) === false) {
    out.push({ code: 'chain_seller_vs_appraisal_owner', severity: 'info',
      title: 'Seller on contract does not match the current owner on the appraisal',
      howTo: `The contract seller "${sellerContract}" does not match the appraisal's "current owner" "${sellerAppraisal}". Confirm with the appraiser that the appraised property matches the contract (and that the appraisal wasn't ordered against a different owner of record).`,
      docValueA: sellerContract, docValueB: sellerAppraisal });
  }
  if (grantorTitle && sellerAppraisal && entityMatch(grantorTitle, sellerAppraisal) === false && namesMatchLoose(grantorTitle, sellerAppraisal) === false) {
    out.push({ code: 'chain_title_vs_appraisal_owner', severity: 'info',
      title: 'Title grantor does not match the appraisal\'s current owner',
      howTo: `The title report shows "${grantorTitle}" as owner of record but the appraisal names "${sellerAppraisal}". Two records of the same property should show the same owner — reconcile before closing.`,
      docValueA: grantorTitle, docValueB: sellerAppraisal });
  }

  // --- Buyer chain: contract buyer must be our vesting entity ---
  const contractBuyer = contract && contract.buyerName;
  if (vestingName && contractBuyer && entityMatch(vestingName, contractBuyer) === false) {
    // The seller-chain module already raises the FATAL when the contract buyer
    // isn't the vesting LLC; we don't double-flag — but we DO post an advisory
    // linking the mismatch to the file-wide chain so the AI panel makes the
    // relationship visible. Never a duplicate finding.
    out.push({ code: 'chain_vesting_vs_contract_buyer', severity: 'warning',
      title: 'The contract buyer is not our vesting entity',
      howTo: `Our vesting entity is "${vestingName}" but the contract buyer reads "${contractBuyer}". This gets fixed with a final assignment or contract amendment before closing.`,
      docValueA: vestingName, docValueB: contractBuyer });
  }

  return { mismatches: out };
}

/**
 * DB bridge — record each mismatch as an ai_suggestion. Dedupe key per code so
 * re-runs never spam. Best-effort per row.
 */
async function analyzeAndRecord(client, { applicationId, fileCtx, extractions }) {
  const v = analyze(fileCtx, extractions);
  if (!v.mismatches.length) return { recorded: 0, deduped: 0, failed: 0 };
  const suggestions = v.mismatches.map((m) => ({
    applicationId,
    source: 'entity_chain', kind: 'finding',
    title: m.title, body: m.howTo,
    severity: m.severity,
    evidence: { code: m.code, docValueA: m.docValueA, docValueB: m.docValueB, layer: 'public_records_crosscheck' },
    proposedAction: {
      type: 'create_finding',
      fields: { code: m.code, severity: m.severity, title: m.title, howTo: m.howTo, source: 'public_records' },
    },
    dedupeKey: `public_records:${m.code}`,
  }));
  return aiSug.recordMany(client, suggestions);
}

module.exports = { analyze, analyzeAndRecord };
