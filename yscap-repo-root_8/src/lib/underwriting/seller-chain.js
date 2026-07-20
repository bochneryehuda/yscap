'use strict';
/**
 * Seller → buyer OWNERSHIP CHAIN.
 *
 * A purchase (especially a wholesale/assignment) is a chain of parties: the property's CURRENT
 * owner of record sells it; on an assignment a wholesaler sits in the middle; and it must end at
 * the entity WE are vesting the loan into. An underwriter's job is to walk that chain and confirm
 * every link connects — the seller on the contract really owns the property, and the buyer at the
 * end is really our borrowing LLC. This module COMPOSES that chain from the documents so the desk
 * can SHOW it, and raises the one action the tie-out doesn't already own: when the contract /
 * assignment lands in the borrower's PERSONAL name instead of the vesting LLC, suggest the
 * final-assignment-to-LLC condition.
 *
 * Non-duplicative by design: the tie-out engine already raises the FATAL when the seller across
 * documents disagrees (`tieout_seller_name`) and when the contract buyer isn't the vesting entity
 * (`contract_buyer_mismatch`). This module does NOT re-raise those — it reads the same facts to
 * DRAW the chain (marking a broken link) and adds only the personal-name→LLC guidance. Pure; no
 * DB, no AI.
 */
const { namesMatchLoose, entityMatch, canonEntity, norm } = require('./compare');
const { borrowerName } = require('./file-view');

function firstFields(exts, docType) {
  const e = (exts || []).find((x) => x.doc_type === docType || x.docType === docType);
  return e ? (e.fields || {}) : null;
}
function toList(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).map((x) => (x == null ? '' : String(x).trim())).filter(Boolean);
}
// Are two party names the same real party? Try both a PERSON match and an ENTITY match; a true on
// either wins. Returns true / false / null(uncomparable — one side empty).
function sameParty(a, b) {
  if (!a || !b) return null;
  const p = namesMatchLoose(a, b), e = entityMatch(a, b);
  if (p === true || e === true) return true;
  if (p === false && e === false) return false;
  return null;
}
// Does `name` appear (as the same party) anywhere in `list`?
function partyInList(name, list) {
  if (!name || !list.length) return null;
  let anyFalse = false;
  for (const x of list) { const r = sameParty(name, x); if (r === true) return true; if (r === false) anyFalse = true; }
  return anyFalse ? false : null;
}
const isEntityName = (s) => /\b(llc|l\.?l\.?c|inc|corp|co|ltd|lp|llp|company|holdings|properties|capital|group|ventures|partners)\b/i.test(String(s || ''));

/**
 * @param {object} ctx  { borrower, vestingName }
 * @param {Array}  exts current extractions [{doc_type, fields}] (title, purchase_contract,
 *                       assignment, appraisal, settlement …)
 * @returns {{ nodes, edges, finalHolder, reachesVesting, status, findings }}
 */
function buildSellerChain(ctx = {}, exts = []) {
  const vesting = ctx.vestingName || null;
  const person = borrowerName(ctx.borrower) || null;

  const title = firstFields(exts, 'title');
  const contract = firstFields(exts, 'purchase_contract');
  const assignment = firstFields(exts, 'assignment');
  const appraisal = firstFields(exts, 'appraisal');
  const settlement = firstFields(exts, 'settlement');

  // The parties, read off the documents.
  const ownerOfRecord = [
    ...toList(title && title.vestedOwners),
    ...toList(appraisal && (appraisal.sellerNames || appraisal.ownerOfRecord || appraisal.sellerName)),
  ];
  const contractSeller = toList(contract && contract.sellerNames);
  const contractBuyer = toList(contract && contract.buyerName);
  const assignee = toList(assignment && assignment.assigneeName);
  const settleBuyer = toList(settlement && settlement.buyerName);

  const isAssignment = !!(ctx.app ? ctx.app.is_assignment : false) || assignee.length > 0;
  // The party at the END of the chain — who ends up holding the deal (assignee if assigned, else
  // the contract buyer; the settlement buyer is a cross-check).
  const finalHolder = (assignee[0] || contractBuyer[0] || settleBuyer[0]) || null;

  // Compose the ordered chain of nodes. Each node: a role + the name(s) the documents show + a
  // source label. Undocumented links are still shown as gaps so the underwriter sees the whole path.
  const nodes = [];
  const push = (role, names, source) => { const arr = toList(names); nodes.push({ role, names: arr, name: arr[0] || null, source, present: arr.length > 0 }); };
  push('Owner of record', ownerOfRecord, title ? 'Title report' : (appraisal ? 'Appraisal' : null));
  push('Seller on contract', contractSeller, contract ? 'Purchase contract' : null);
  if (isAssignment) {
    push('Buyer on contract (assignor)', contractBuyer, contract ? 'Purchase contract' : null);
    push('Assignee', assignee, assignment ? 'Assignment' : null);
  } else {
    push('Buyer on contract', contractBuyer, contract ? 'Purchase contract' : null);
  }
  push('Vesting entity (our borrower)', vesting ? [vesting] : [], 'Loan file');

  // Edges between consecutive PRESENT nodes, marked match / mismatch / unknown. The seller↔owner
  // and buyer↔vesting mismatches are the tie-out's fatals; here they only COLOR the chain view.
  const edges = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1];
    if (!a.present || !b.present) { edges.push({ from: a.role, to: b.role, status: 'gap' }); continue; }
    // Consecutive links that SHOULD be the same party: owner-of-record == contract-seller;
    // assignee == vesting entity. A contract-seller → contract-buyer link is a real transfer (two
    // different parties), so it's a 'transfer', not a match check.
    const isTransfer = /Seller/.test(a.role) && /Buyer/.test(b.role);
    if (isTransfer) { edges.push({ from: a.role, to: b.role, status: 'transfer' }); continue; }
    const r = partyInList(a.name, b.names);
    edges.push({ from: a.role, to: b.role, status: r === true ? 'match' : r === false ? 'mismatch' : 'unknown' });
  }

  const reachesVesting = vesting ? (partyInList(vesting, toList(finalHolder)) === true
    || partyInList(vesting, assignee) === true || partyInList(vesting, contractBuyer) === true) : null;

  const findings = [];
  const mk = (o) => Object.assign({ source: 'seller_chain', status: 'open', blocksCtc: false }, o);

  // The one NEW action: the deal lands in the borrower's PERSONAL name, not the vesting LLC.
  // Suggest a final assignment of contract into the LLC (not a hard block — it's fixable at/before
  // closing with an assignment/vesting amendment).
  if (finalHolder && vesting && person) {
    const isPersonal = sameParty(finalHolder, person) === true;
    const isVesting = sameParty(finalHolder, vesting) === true;
    if (isPersonal && !isVesting) {
      findings.push(mk({
        code: 'contract_in_personal_name', severity: 'warning', field: 'vesting',
        docValue: finalHolder, fileValue: vesting,
        title: 'Contract is in the borrower’s personal name, not the vesting LLC',
        howTo: `The ${isAssignment ? 'assignment' : 'purchase contract'} names ${finalHolder} (the borrower personally), but the loan vests into ${vesting}. Add a condition for a final assignment of contract (or a vesting amendment) putting the contract into ${vesting} before closing.`,
        actions: ['post_condition', 'request_document', 'dismiss'],
        opensCondition: 'assignment_to_vesting_entity',
      }));
    } else if (!isVesting && reachesVesting === false && !isEntityName(finalHolder)) {
      // The chain ends at some individual who is neither our borrower nor the LLC — advise a look
      // (the hard "buyer isn't the entity" fatal is the tie-out's; this is the softer chain note).
      findings.push(mk({
        code: 'chain_vesting_not_reached', severity: 'info', field: 'vesting',
        docValue: finalHolder, fileValue: vesting,
        title: 'The purchase chain does not clearly reach the vesting entity',
        howTo: `The end of the purchase chain (${finalHolder}) is not clearly ${vesting}. Confirm how the property gets into ${vesting} — an assignment or a vesting amendment may be needed.`,
        actions: ['post_condition', 'request_document', 'dismiss'],
      }));
    }
  }

  // Chain status headline for the desk.
  const anyMismatch = edges.some((e) => e.status === 'mismatch');
  const anyGap = edges.some((e) => e.status === 'gap');
  const status = anyMismatch ? 'broken' : (anyGap ? 'incomplete' : (reachesVesting === true ? 'intact' : 'incomplete'));

  return { nodes, edges, finalHolder, reachesVesting, status, findings };
}

module.exports = { buildSellerChain, _internals: { sameParty, partyInList, isEntityName } };
