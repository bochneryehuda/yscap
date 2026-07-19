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
const { norm, addrMatches, addrLine, withinMoney, entityMatch, num } = require('./compare');

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
  if (withinMoney(contract.purchasePrice, f.purchase_price, 1) === false) {
    out.push(finding({ code: 'contract_price_mismatch', severity: 'fatal', field: 'purchase_price',
      docValue: money(contract.purchasePrice), fileValue: money(f.purchase_price),
      title: 'Purchase price on the contract does not match the file',
      howTo: `Contract shows ${money(contract.purchasePrice)} vs file ${money(f.purchase_price)}. Reconcile — the price flows into every leverage cap.`,
      actions: ['fix_file', 'keep', 'custom', 'dismiss'] }));
  }

  // ---- 3. Buyer entity (must be the borrowing entity on the file) ----
  // Entity-aware match so "L.L.C." vs "LLC" (or Inc./Corp. punctuation) is not a false
  // fatal (audit fix), while a genuinely different buyer still fires.
  if (contract.buyerName && f.entity_name && entityMatch(contract.buyerName, f.entity_name) === false) {
    out.push(finding({ code: 'contract_buyer_mismatch', severity: 'fatal', field: 'buyer_entity',
      docValue: contract.buyerName, fileValue: f.entity_name,
      title: 'Buyer on the contract is not the borrowing entity on the file',
      howTo: 'The contract must name the borrowing entity as the buyer. Confirm the vesting entity — a different buyer needs an assignment to the borrower or a corrected contract.',
      actions: ['fix_file', 'custom', 'dismiss', 'decline'] }));
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
