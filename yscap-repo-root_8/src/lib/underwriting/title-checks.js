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
const { clauseNamesLender, clauseHasAddress, LENDER_MORTGAGEE_CLAUSE } = require('./lender');

const SEASONING_DAYS = 90;   // FHA anti-flip line; a resale inside this window is a flip signal.
const money = (n) => (num(n) == null ? null : `$${num(n).toLocaleString('en-US')}`);
// Loan numbers compared identity-insensitively to formatting (dashes/spaces/case).
const loanKey = (s) => String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
const isCondoOrPud = (t) => /condo|pud|planned unit/i.test(String(t || ''));
const hasEndorsement = (list, re) => Array.isArray(list) && list.some((e) => re.test(String(e || '')));

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

  // ---- Liens on title (clear-at-funding conditions) ----
  // A monetary lien on the title must be released, paid off, or subordinated before/at funding, or
  // our lien isn't in first position. Tax liens (property / federal IRS) are the most serious — a
  // property-tax lien has super-priority over our mortgage, and a federal tax lien clouds title.
  // Involuntary liens (judgment / mechanic's / HOA / child-support) likewise have to be cleared.
  // A seller's existing mortgage/deed of trust is normal (paid off from closing proceeds), so it's
  // surfaced as a payoff reminder, not a red flag. Warning-only — each opens a clear-at-funding
  // condition; the underwriter confirms the title company will clear it.
  const liens = Array.isArray(title.liens) ? title.liens.filter((l) => l && (l.holder || l.amount != null || l.type)) : [];
  const liensText = (l) => `${l.type || 'lien'}${l.holder ? ` — ${l.holder}` : ''}${num(l.amount) != null ? ` (${money(num(l.amount))})` : ''}`;
  const isTax = (l) => /\btax\b|irs|internal revenue/i.test(String(l.type || '') + ' ' + String(l.holder || ''));
  const isMortgage = (l) => /mortgage|deed of trust|deed-of-trust/i.test(String(l.type || ''));
  const isInvoluntary = (l) => /judg|mechanic|materialman|hoa|assessment|child support|lien/i.test(String(l.type || '')) && !isMortgage(l);

  const taxLiens = liens.filter(isTax);
  const otherInvoluntary = liens.filter((l) => !isTax(l) && isInvoluntary(l));
  const mortgages = liens.filter((l) => !isTax(l) && isMortgage(l));
  // A monetary lien whose type/holder matched none of the buckets must NOT vanish — surface it so a
  // real lien of an unrecognized type still gets a clear-at-funding look (never silently dropped).
  const unclassified = liens.filter((l) => !isTax(l) && !isMortgage(l) && !isInvoluntary(l) && num(l.amount) != null);

  if (taxLiens.length) {
    out.push(finding({ code: 'title_tax_lien', severity: 'warning', field: 'liens',
      docValue: taxLiens.map(liensText).join('; '), fileValue: null,
      title: 'A tax lien is on title — must be cleared before funding',
      howTo: `Title shows ${taxLiens.length} tax lien(s): ${taxLiens.map(liensText).join('; ')}. A property-tax lien has priority over our mortgage and a federal (IRS) tax lien clouds title — it must be paid, released, or subordinated before or at funding. Post a clear-at-funding condition and confirm the title company will clear it (a payoff/release must appear on the final title and settlement statement).`,
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }
  if (otherInvoluntary.length) {
    out.push(finding({ code: 'title_involuntary_lien', severity: 'warning', field: 'liens',
      docValue: otherInvoluntary.map(liensText).join('; '), fileValue: null,
      title: 'An outstanding lien on title must be cleared before funding',
      howTo: `Title shows ${otherInvoluntary.length} lien(s) that have to be resolved: ${otherInvoluntary.map(liensText).join('; ')}. A judgment, mechanic's, HOA, or similar lien must be released or paid at closing so our mortgage records in first position. Post a clear-at-funding condition and confirm the release on the final title.`,
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }
  if (mortgages.length) {
    out.push(finding({ code: 'title_existing_mortgage', severity: 'info', field: 'liens',
      docValue: mortgages.map(liensText).join('; '), fileValue: null,
      title: 'The seller has an existing mortgage to be paid off at closing',
      howTo: `Title shows ${mortgages.length} existing mortgage/deed of trust: ${mortgages.map(liensText).join('; ')}. This is normal on a purchase — confirm the settlement statement pays it off from proceeds so it's released and our lien records first.`,
      actions: ['acknowledge', 'post_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }
  if (unclassified.length) {
    out.push(finding({ code: 'title_other_lien', severity: 'warning', field: 'liens',
      docValue: unclassified.map(liensText).join('; '), fileValue: null,
      title: 'A monetary lien on title needs review',
      howTo: `Title shows ${unclassified.length} monetary lien(s) of an unrecognized type: ${unclassified.map(liensText).join('; ')}. Confirm with the title company whether each has to be released or paid before funding so our mortgage records in first position.`,
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }

  // ---- Abnormal Schedule B exceptions (title defects that threaten marketability) ----
  // Most Schedule B exceptions are boilerplate (taxes not yet due, standard easements, CC&Rs). A few
  // signal a real title problem: a pending lawsuit (lis pendens), a foreclosure in progress (notice
  // of default), an owner in bankruptcy, an encroachment, or an unreleased/pending lien. Surface
  // those for the underwriter — never the boilerplate. Warning-only.
  // NB: bare "encroach" / "mechanic" are DELIBERATELY excluded — the standard pre-printed survey
  // exception ("shortage in area, encroachments, overlaps…") and the standard mechanic's-lien
  // exception are boilerplate on nearly every commitment; matching them would cry wolf on clean
  // title. A real mechanic's lien is caught in the lien buckets above; a real boundary problem shows
  // as "boundary dispute". Keep this list to genuine defects.
  const ABNORMAL = /lis pendens|notice of default|foreclosure|bankruptcy|boundary dispute|unpaid tax|delinquent tax|pending litigation|\blawsuit\b|probate|life estate|adverse (possession|claim)/i;
  const exceptions = Array.isArray(title.exceptions) ? title.exceptions.filter((s) => norm(s)) : [];
  const abnormal = exceptions.filter((s) => ABNORMAL.test(String(s)));
  if (abnormal.length) {
    out.push(finding({ code: 'title_abnormal_exception', severity: 'warning', field: 'exceptions',
      docValue: abnormal.slice(0, 6).join(' | '), fileValue: null,
      title: 'Title has an unusual exception that may affect marketable title',
      howTo: `Schedule B lists ${abnormal.length} exception(s) that aren't routine: ${abnormal.slice(0, 6).join(' | ')}. These can threaten clear/marketable title (a pending lawsuit, foreclosure, bankruptcy, encroachment, or unpaid tax). Review each with the title company and confirm it will be removed or insured over before funding.`,
      actions: ['post_condition', 'request_document', 'grant_exception', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }

  // ---- Schedule A: our loan number, policy amount, and the lender mortgagee clause ----
  // The title policy must insure OUR loan: carry our loan number, insure at least the full loan
  // amount, and name us as the proposed insured with the exact ISAOA/ATIMA mortgagee clause. Each is
  // a warning that opens a pre-funding condition — the title company corrects the commitment.
  const fileLoanNo = f.loan_number, docLoanNo = title.loanNumber;
  if (fileLoanNo && docLoanNo && loanKey(fileLoanNo) !== loanKey(docLoanNo)) {
    out.push(finding({ code: 'title_loan_number_mismatch', severity: 'warning', field: 'loan_number',
      docValue: docLoanNo, fileValue: fileLoanNo,
      title: 'Loan number on the title does not match the file',
      howTo: `Schedule A shows loan number "${docLoanNo}" but the file's loan number is "${fileLoanNo}". Have the title company correct Schedule A so the policy is tied to this loan.`,
      actions: ['request_document', 'fix_file', 'post_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }
  const insured = num(title.insuredAmount), loanAmt = num(f.loan_amount);
  if (insured != null && loanAmt != null && loanAmt > 0 && insured < loanAmt - 1) {
    out.push(finding({ code: 'title_policy_amount_low', severity: 'warning', field: 'insured_amount',
      docValue: money(insured), fileValue: money(loanAmt),
      title: 'Title policy amount is below the loan amount',
      howTo: `The title policy insures ${money(insured)}, but the loan is ${money(loanAmt)}. The lender's policy must insure no less than the full loan amount — request an increased policy amount before funding.`,
      actions: ['request_document', 'post_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }
  const namesLender = clauseNamesLender(title.mortgageeClause);
  if (namesLender === false) {
    out.push(finding({ code: 'title_wrong_mortgagee', severity: 'warning', field: 'mortgagee_clause',
      docValue: title.mortgageeClause, fileValue: LENDER_MORTGAGEE_CLAUSE,
      title: 'Title does not name the lender with the correct mortgagee clause',
      howTo: `Schedule A must name the lender as proposed insured with the exact clause "${LENDER_MORTGAGEE_CLAUSE.replace(/\n/g, ', ')}". Have the title company correct it before funding.`,
      actions: ['request_document', 'post_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  } else if (namesLender === true && clauseHasAddress(title.mortgageeClause) === false) {
    out.push(finding({ code: 'title_mortgagee_address', severity: 'info', field: 'mortgagee_clause',
      docValue: title.mortgageeClause, fileValue: LENDER_MORTGAGEE_CLAUSE,
      title: 'Confirm the lender notice address on the title mortgagee clause',
      howTo: `The title names the lender but the notice address doesn't match "${LENDER_MORTGAGEE_CLAUSE.replace(/\n/g, ', ')}". Confirm the correct address is on Schedule A.`,
      actions: ['acknowledge', 'request_document', 'dismiss'] }));
  }

  // ---- Required endorsements by collateral type ----
  // Condo/PUD collateral needs the condominium / PUD endorsement; multi-parcel collateral needs a
  // contiguity/aggregation endorsement. We flag when the collateral calls for one and the title's
  // endorsement list doesn't show it (or no list was read) so the underwriter confirms it's added.
  if (isCondoOrPud(f.property_type) && !hasEndorsement(title.endorsements, /condo|pud|planned unit/i)) {
    out.push(finding({ code: 'title_missing_condo_endorsement', severity: 'warning', field: 'endorsements',
      docValue: (title.endorsements || []).join(', ') || '(none listed)', fileValue: `${f.property_type} collateral`,
      title: 'Confirm the condominium / PUD endorsement',
      howTo: `This is ${f.property_type} collateral, which requires the state condominium or PUD endorsement (confirming assessments, liens, and covenants don't impair our lien). Confirm it's on the title commitment before funding.`,
      actions: ['request_document', 'post_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
  }
  if (num(title.parcelCount) != null && num(title.parcelCount) > 1 && !hasEndorsement(title.endorsements, /contiguity|aggregation|multi.?parcel/i)) {
    out.push(finding({ code: 'title_multiparcel_contiguity', severity: 'warning', field: 'endorsements',
      docValue: `${num(title.parcelCount)} parcels`, fileValue: (title.endorsements || []).join(', ') || '(no contiguity endorsement)',
      title: 'Confirm a contiguity endorsement for the multiple parcels',
      howTo: `The collateral is ${num(title.parcelCount)} parcels. Confirm all parcels are in the insured legal description, each is a separate tax lot, and a contiguity/aggregation endorsement covers them (no gaps, strips, or access problems) before funding.`,
      actions: ['request_document', 'post_condition', 'dismiss'], opensCondition: 'underwriting_review_cleared' }));
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
