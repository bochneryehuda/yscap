'use strict';
/**
 * Purchase-contract findings — compare what the AI analyzer read off a purchase & sale
 * contract against the loan file, and raise findings. This is the contract review the
 * owner described: find the property address, the purchase price, the seller(s), the
 * buyer entity, and (on a wholesale deal) the assignment fee + underlying price, and
 * flag anything that doesn't match the file for underwriting review.
 *
 * Owner contract (mirrors src/lib/appraisal/findings.js):
 *   - EVERY mapped field that differs becomes a finding; we NEVER overwrite the file.
 *   - Property address / purchase price / buyer entity / assignment economics mismatches
 *     are FATAL and block clear-to-close — they flow into every leverage cap.
 *   - The seller name(s) are EXTRACTED and returned so the cross-document pass can later
 *     match them to the appraisal + title (there is no seller field on the file yet).
 *   - Anything unreadable routes to an underwriting "verify" finding, never a false
 *     mismatch.
 *
 * Pure + dependency-free. `contract` is the object extracted for the PURCHASE_CONTRACT
 * schema; `file` is the normalized loan-file view the caller builds from the application
 * (+ vesting entity):
 *   { property_address, purchase_price, entity_name, is_assignment,
 *     assignment_fee, underlying_contract_price }
 */
const { norm, addrMatches, addrLine, withinMoney, entityMatch, namesMatchLoose, num } = require('./compare');
// A buyer name that carries a company suffix is an ENTITY, never "the borrower personally".
const ENTITY_SUFFIX_RE = /\b(llc|l\.?l\.?c|inc|corp|co|ltd|lp|llp|company|holdings|properties|capital|group|ventures|partners|trust)\b/i;

function finding(f) {
  return Object.assign(
    { source: 'purchase_contract', severity: 'fatal', status: 'open', blocksCtc: f.severity !== 'warning' && f.severity !== 'info' },
    f,
  );
}
const money = (n) => (num(n) == null ? null : `$${num(n).toLocaleString('en-US')}`);

function computeContractFindings(contract, file, opts = {}) {
  const out = [];
  if (!contract) return out;
  const f = file || {};

  // ---- 0. Unreadable → route to underwriting verify, never a false mismatch ----
  if (contract.readable === false || (!contract.propertyAddress && contract.purchasePrice == null)) {
    out.push(finding({ code: 'contract_unreadable', severity: 'warning', field: 'document',
      title: 'The purchase contract could not be read with confidence',
      howTo: 'Open the contract and confirm the property, price, seller, and buyer by hand — nothing is filled in automatically. If the copy is poor, request a clearer one.',
      actions: ['open_condition', 'request_revision', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    return out;
  }

  // ---- 1. Property address ----
  if (addrMatches(contract.propertyAddress, f.property_address) === false) {
    out.push(finding({ code: 'contract_address_mismatch', severity: 'fatal', field: 'property_address',
      docValue: addrLine(contract.propertyAddress), fileValue: addrLine(f.property_address),
      title: 'Property address on the contract does not match the file',
      howTo: 'Confirm this contract is for the right property. A different address means the wrong file or the wrong contract.',
      actions: ['fix_file', 'keep', 'custom', 'dismiss', 'decline'] }));
  }

  // ---- 2. Purchase price ----
  // On an ASSIGNMENT / wholesale deal the contract on file is the SELLER's underlying purchase &
  // sale agreement, so its stated price is the seller's ORIGINAL price (e.g. $438k) — NOT the
  // fee-inclusive total the borrower pays (e.g. $474k). Blindly comparing the contract price to the
  // file's total fired a FALSE "purchase price mismatch" fatal on every assignment (owner-directed
  // 2026-07-24). On an assignment we therefore treat a contract price that equals EITHER the
  // seller's underlying price OR the fee-inclusive total as a MATCH, and only flag it when it
  // matches NEITHER (a genuine mismatch); the assignment economics themselves (fee, underlying
  // price, and the file-level reconciliation) are checked in §4/§4b/§4c below. On a straight
  // purchase the check is unchanged.
  // An assignment is ANY file marked is_assignment — NOT only one whose underlying price is already
  // captured. That extra gate (`&& underlying != null`) was the residual false-fatal (owner
  // 2026-07-27, "don't populate reviews that the contract does not match if it didn't calculate
  // directly"): a wholesale file whose seller price hasn't been entered yet fell back to the naive
  // straight-purchase compare and re-fired the FATAL, because the contract shows the seller's price
  // ($438k) while the file holds the fee-inclusive total ($474k). On an assignment we NEVER conclude
  // a price mismatch from a value we can't reconcile — the un-captured seller price is surfaced as a
  // non-fatal "capture the assignment fields" advisory (reasonability.assignment_fields_missing),
  // not a false accusation here.
  const isAsg = !!f.is_assignment;
  let priceMismatch = false;
  if (isAsg) {
    // Match the contract price to EITHER the seller's underlying price OR the fee-inclusive total.
    // A price we don't have on file yet (underlying null) is UNKNOWN, not a mismatch.
    const mUnder = num(f.underlying_contract_price) != null ? withinMoney(contract.purchasePrice, f.underlying_contract_price, 1) : null;
    const mTotal = withinMoney(contract.purchasePrice, f.purchase_price, 1);
    // Fire only when BOTH acceptable prices are KNOWN and the contract matches NEITHER. If the
    // underlying is not yet captured (mUnder null), we cannot conclude a mismatch → no fatal.
    priceMismatch = mTotal === false && mUnder === false;
  } else {
    priceMismatch = withinMoney(contract.purchasePrice, f.purchase_price, 1) === false;
  }
  if (priceMismatch) {
    const expected = isAsg ? f.underlying_contract_price : f.purchase_price;
    out.push(finding({ code: 'contract_price_mismatch', severity: 'fatal', field: 'purchase_price',
      docValue: money(contract.purchasePrice), fileValue: money(expected),
      title: 'Purchase price on the contract does not match the file',
      howTo: isAsg
        ? `The contract shows ${money(contract.purchasePrice)}, which matches neither the seller's original price on file (${money(f.underlying_contract_price)}) nor the total purchase price (${money(f.purchase_price)}). Reconcile — the price flows into every leverage cap.`
        : `Contract shows ${money(contract.purchasePrice)} vs file ${money(f.purchase_price)}. Reconcile — the price flows into every leverage cap.`,
      actions: ['fix_file', 'keep', 'custom', 'dismiss'] }));
  }

  // ---- 3. Buyer entity (must be the borrowing entity on the file) ----
  // Entity-aware match so "L.L.C." vs "LLC" (or Inc./Corp. punctuation) is not a false
  // fatal (audit fix), while a genuinely different buyer still fires. EXCEPTION: when the buyer is
  // the BORROWER PERSONALLY (not the LLC), this is the common "contract in personal name" case —
  // it's fixable with a final assignment / vesting amendment, so the seller-chain module raises the
  // softer `contract_in_personal_name` condition suggestion instead of a hard fatal here (owner-
  // directed 2026-07-20). Only a buyer who is NEITHER the entity NOR the borrower is a fatal.
  if (contract.buyerName && f.entity_name && entityMatch(contract.buyerName, f.entity_name) === false) {
    // Defer to the chain's softer condition ONLY when the buyer is the borrower AS A PERSON — not an
    // entity that merely contains the borrower's name ("John Smith Properties LLC"), and only when
    // the file has a real (≥2-token) borrower name (a one-token name would over-match a stranger).
    const looksLikeEntity = ENTITY_SUFFIX_RE.test(String(contract.buyerName || ''));
    const realName = f.borrower_name && String(f.borrower_name).trim().split(/\s+/).filter(Boolean).length >= 2;
    const isBorrowerPersonally = realName && !looksLikeEntity && namesMatchLoose(contract.buyerName, f.borrower_name) === true;
    if (!isBorrowerPersonally) {
      out.push(finding({ code: 'contract_buyer_mismatch', severity: 'fatal', field: 'buyer_entity',
        docValue: contract.buyerName, fileValue: f.entity_name,
        title: 'Buyer on the contract is not the borrowing entity on the file',
        howTo: 'The contract must name the borrowing entity as the buyer. Confirm the vesting entity — a different buyer needs an assignment to the borrower or a corrected contract.',
        actions: ['fix_file', 'custom', 'dismiss', 'decline'] }));
    }
  }

  // ---- 4. Assignment / wholesale economics ----
  if (f.is_assignment) {
    if (withinMoney(contract.assignmentFee, f.assignment_fee, 1) === false) {
      out.push(finding({ code: 'assignment_fee_mismatch', severity: 'fatal', field: 'assignment_fee',
        docValue: money(contract.assignmentFee), fileValue: money(f.assignment_fee),
        title: 'Assignment fee on the contract does not match the file',
        howTo: `Contract shows a ${money(contract.assignmentFee)} assignment fee vs file ${money(f.assignment_fee)}. The financeable fee is capped at 15% of the seller's original price — reconcile.`,
        actions: ['fix_file', 'keep', 'custom', 'dismiss'] }));
    }
    if (withinMoney(contract.underlyingPrice, f.underlying_contract_price, 1) === false) {
      out.push(finding({ code: 'underlying_price_mismatch', severity: 'fatal', field: 'underlying_contract_price',
        docValue: money(contract.underlyingPrice), fileValue: money(f.underlying_contract_price),
        title: "Seller's original price on the contract does not match the file",
        howTo: `Contract shows a ${money(contract.underlyingPrice)} original (seller) price vs file ${money(f.underlying_contract_price)}. This is the basis for the 15% fee cap — reconcile.`,
        actions: ['fix_file', 'keep', 'custom', 'dismiss'] }));
    }
  } else if (contract.isAssignment === true) {
    // The contract looks like a wholesale/assignment but the file isn't marked as one.
    out.push(finding({ code: 'assignment_unexpected', severity: 'warning', field: 'is_assignment',
      docValue: 'assignment/wholesale', fileValue: 'not an assignment',
      title: 'The contract looks like an assignment, but the file is not marked as one',
      howTo: 'Confirm whether this is a wholesale/assignment deal. If it is, mark the file and capture the assignment fee + original price so the leverage caps price correctly.',
      actions: ['fix_file', 'acknowledge', 'dismiss'] }));
  }

  // ---- 4b. Assignment internal consistency + the frozen 15% cap (audit fix) ----
  // Validate the CONTRACT's own numbers, independent of the file: the total should be
  // the seller's original price plus the fee, and the financeable fee is capped at 15%
  // of the seller's ORIGINAL price (owner's hard-frozen rule).
  if (contract.isAssignment === true || f.is_assignment) {
    const pp = num(contract.purchasePrice), under = num(contract.underlyingPrice), fee = num(contract.assignmentFee);
    if (pp != null && under != null && fee != null && Math.abs(pp - (under + fee)) > 1) {
      out.push(finding({ code: 'assignment_math_inconsistent', severity: 'warning', field: 'assignment_fee',
        docValue: `${money(pp)} vs ${money(under)} + ${money(fee)}`, fileValue: null,
        title: 'Assignment math on the contract does not add up',
        howTo: `The total price ${money(pp)} should equal the seller's original price ${money(under)} plus the assignment fee ${money(fee)}. Reconcile the figures before pricing.`,
        actions: ['request_revision', 'acknowledge', 'custom', 'dismiss'] }));
    }
    if (under != null && fee != null && under > 0 && fee > 0.15 * under + 1) {
      const cap = 0.15 * under;
      out.push(finding({ code: 'assignment_fee_over_cap', severity: 'warning', field: 'assignment_fee',
        docValue: money(fee), fileValue: money(cap),
        title: 'Assignment fee exceeds the 15% financeable cap',
        howTo: `The financeable fee is capped at 15% of the seller's original price (${money(cap)}); the contract shows ${money(fee)}. The excess is out-of-pocket unless an approved exception is on file.`,
        actions: ['grant_exception', 'acknowledge', 'custom', 'dismiss'] }));
    }
  }

  // ---- 4c. File reconciliation: the price increase over the seller's price IS the fee ----
  // The owner's rule (2026-07-24): on an assignment the ONLY reason the price on file is higher
  // than the seller's original contract price is the assignment (flip) fee. So the seller's
  // underlying price plus the assignment fee must equal the purchase price on file. When it
  // reconciles we do NOT flag the higher price (that was the false fatal above); when it does not,
  // THIS is the real thing to surface — the price jump doesn't match the recorded fee. Advisory
  // (warning), never a hard block. Pure file-data check — independent of the contract document, so
  // it holds even before the contract is read.
  if (f.is_assignment) {
    const under = num(f.underlying_contract_price), fee = num(f.assignment_fee), total = num(f.purchase_price);
    if (under != null && fee != null && total != null && Math.abs(total - (under + fee)) > 1) {
      out.push(finding({ code: 'assignment_price_unreconciled', severity: 'warning', field: 'purchase_price',
        docValue: `${money(under)} + ${money(fee)} = ${money(under + fee)}`, fileValue: money(total),
        title: "The price increase on this assignment doesn't equal the assignment fee",
        howTo: `The seller's original price on file (${money(under)}) plus the assignment fee (${money(fee)}) should equal the purchase price on file (${money(total)}). The increase over the seller's price is ${money(total - under)}, which does not match the ${money(fee)} fee — confirm the seller price, the fee, and the final price all agree.`,
        actions: ['fix_file', 'custom', 'acknowledge', 'dismiss'] }));
    }
  }

  // ---- 5. Seller name(s) — extracted for the cross-document match (title/appraisal) ----
  const sellers = Array.isArray(contract.sellerNames) ? contract.sellerNames.filter((s) => norm(s)) : [];
  if (!sellers.length) {
    out.push(finding({ code: 'contract_seller_unreadable', severity: 'warning', field: 'seller',
      title: 'No seller name could be read from the contract',
      howTo: 'The seller name is needed to check it matches the title and appraisal. Confirm the seller on the contract.',
      actions: ['open_condition', 'custom', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }

  return out;
}

// The seller name(s) the cross-document pass will match against title + appraisal.
function sellerNames(contract) {
  return Array.isArray(contract && contract.sellerNames)
    ? contract.sellerNames.filter((s) => norm(s)) : [];
}

function summarize(findings) {
  const open = (findings || []).filter((f) => f.status === 'open');
  return {
    fatal: open.filter((f) => f.severity === 'fatal').length,
    warning: open.filter((f) => f.severity === 'warning').length,
    info: open.filter((f) => f.severity === 'info').length,
    blocksCtc: open.some((f) => f.severity === 'fatal' && f.blocksCtc),
  };
}

module.exports = { computeContractFindings, sellerNames, summarize };
