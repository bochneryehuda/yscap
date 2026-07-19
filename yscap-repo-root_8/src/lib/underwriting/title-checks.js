'use strict';
/**
 * Title-report findings — check a title/prelim against the loan file, and surface the
 * vested owner(s) (the seller) for the cross-document seller match. On its own the title
 * mainly confirms the property; the powerful check is cross-document (seller must match
 * the purchase contract + appraisal) which lives in cross-document.js.
 *
 * Pure. `title` = fields for the TITLE schema; `file` = { property_address }.
 */
const { addrMatches, addrLine, norm } = require('./compare');

function finding(f) {
  return Object.assign(
    { source: 'title', severity: 'fatal', status: 'open', blocksCtc: f.severity !== 'warning' && f.severity !== 'info' },
    f,
  );
}

function computeTitleFindings(title, file, opts = {}) {
  const out = [];
  if (!title) return out;
  const f = file || {};

  if (title.readable === false || (!title.propertyAddress && !(title.vestedOwners || []).length)) {
    out.push(finding({ code: 'title_unreadable', severity: 'warning', field: 'document',
      title: 'The title report could not be read with confidence',
      howTo: 'Review the title by hand and confirm the property, vested owner (seller), and liens. Request a clearer copy if needed.',
      actions: ['open_condition', 'request_revision', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    return out;
  }

  // Property address vs file.
  if (addrMatches(title.propertyAddress, f.property_address) === false) {
    out.push(finding({ code: 'title_address_mismatch', severity: 'fatal', field: 'property_address',
      docValue: addrLine(title.propertyAddress), fileValue: addrLine(f.property_address),
      title: 'Property address on the title does not match the file',
      howTo: 'Confirm the title is for the right property — a different address means the wrong title or the wrong file.',
      actions: ['fix_file', 'keep', 'custom', 'dismiss', 'decline'] }));
  }

  // Seller (vested owner) present — needed for the cross-document seller match.
  const owners = (title.vestedOwners || []).filter((s) => norm(s));
  if (!owners.length) {
    out.push(finding({ code: 'title_seller_unreadable', severity: 'warning', field: 'seller',
      title: 'No vested owner (seller) could be read from the title',
      howTo: 'The vested owner is needed to confirm it matches the seller on the contract and appraisal. Confirm the owner of record on the title.',
      actions: ['open_condition', 'custom', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }

  return out;
}

/** Vested owners (sellers) for the cross-document match. */
function vestedOwners(title) {
  return Array.isArray(title && title.vestedOwners) ? title.vestedOwners.filter((s) => norm(s)) : [];
}

module.exports = { computeTitleFindings, vestedOwners };
