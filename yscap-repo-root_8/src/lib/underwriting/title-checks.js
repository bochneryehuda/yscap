'use strict';
/**
 * Title-report findings — check a title/prelim against the loan file, and surface the
 * vested owner(s) (the seller) for the cross-document seller match. On its own the title
 * mainly confirms the property; the powerful check is cross-document (seller must match
 * the purchase contract + appraisal) which lives in cross-document.js.
 *
 * Pure. `title` = fields for the TITLE schema; `file` = { property_address }.
 */
const { addrMatches, addrLine, norm, daysBetween, toISODate, num } = require('./compare');

const SEASONING_DAYS = 90;   // FHA anti-flip line; a resale inside this window is a flip signal.

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

  // Seasoning / flip: how long has the current owner held the property? A resale within ~90 days
  // is the classic property-flipping / value-inflation signal (FinCEN; the FHA anti-flip line). If
  // the prior sale price is known and the purchase is a >=100% markup, that's the FHA second-
  // appraisal trigger too — a strong inflation flag. Warning-only (feeds the fraud score).
  const acq = toISODate(title.ownerAcquisitionDate);
  if (acq && opts.today) {
    const daysOwned = daysBetween(acq, opts.today);
    if (daysOwned != null && daysOwned >= 0 && daysOwned < SEASONING_DAYS) {
      const prior = num(title.ownerAcquisitionPrice), price = num(f.purchase_price);
      const bigMarkup = prior != null && prior > 0 && price != null && price >= prior * 2;
      out.push(finding({ code: 'title_short_seasoning', severity: 'warning', field: 'seasoning',
        docValue: `owned ${daysOwned} day(s) (acquired ${acq})${bigMarkup ? `, reselling at ${Math.round((price / prior - 1) * 100)}% markup` : ''}`,
        fileValue: `${SEASONING_DAYS}-day seasoning line`,
        title: bigMarkup ? 'Rapid resale at a large markup (flip / value-inflation signal)' : 'The seller has owned the property only briefly (short seasoning)',
        howTo: `The current owner acquired this property ${daysOwned} day(s) ago${bigMarkup ? ' and is reselling at a 100%+ markup' : ''}. A short-seasoning resale is a common property-flip / value-inflation pattern — verify the value independently${bigMarkup ? ' (a second appraisal is warranted)' : ''} and confirm the transaction is arm\'s-length.`,
        actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
    }
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
