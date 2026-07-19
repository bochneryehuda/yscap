'use strict';

/**
 * MISMO 2.3.1 credit REQUEST builder (Xactus Credit ReportX + Pre-QualificationX).
 *
 * Pure string building, no network. Produces the XML body for an HTTPS POST
 * (Content-Type: text/xml). Every value is XML-attribute-escaped. Required
 * fields are validated up front and throw a 400-style error rather than
 * emitting a malformed request Xactus would reject (E101/E102).
 *
 * Confirmed shape (owner + Xactus OpenAPI, 2026-07-19):
 *   - Soft pull (Pre-QualificationX): CreditReportType="Other" +
 *     CreditReportTypeOtherDescription="SoftCheck".  DEFAULT product.
 *   - Hard pull (Credit ReportX):     CreditReportType="Merge".
 *   - DEFAULT action = "Reissue" (needs a prior CreditReportIdentifier);
 *     switchable to Submit / ForceNew (brand-new) / Upgrade / Unmerge.
 *   - Individual = one BORROWER; Joint = multiple BORROWERs, distinct BorrowerIDs.
 */

const MISMO_VERSION = '2.3.1';

// Which CreditReportType/OtherDescription each product uses.
const PRODUCTS = {
  prequal:      { type: 'Other', otherDesc: 'SoftCheck' }, // Pre-QualificationX (soft)
  creditreport: { type: 'Merge', otherDesc: null },        // Credit ReportX (hard)
};

// Actions allowed per product (per Xactus docs). Unmerge is Credit ReportX only.
const ACTIONS = {
  prequal:      new Set(['Submit', 'ForceNew', 'Reissue', 'Upgrade']),
  creditreport: new Set(['Submit', 'ForceNew', 'Reissue', 'Upgrade', 'Unmerge']),
};
// Actions that re-retrieve/modify an existing report → need its identifier.
const NEEDS_IDENTIFIER = new Set(['Reissue', 'Upgrade', 'Unmerge']);

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

/** Escape a value for use inside an XML attribute (double-quoted). Also strips
 * XML-invalid control chars (a raw NUL etc. would make Xactus reject the XML). */
function esc(v) {
  return String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** SSN → 9 digits (the request carries the raw 9 digits). A value with any char
 * other than digits and common separators is a typo → reject (don't "fix" it). */
function ssnDigits(v) {
  const s = String(v == null ? '' : v);
  if (/[^\d\-.\s()]/.test(s)) return null;
  const d = s.replace(/[^\d]/g, '');
  return d.length === 9 ? d : null;
}

function req(v, name) { if (v == null || String(v).trim() === '') throw badRequest(`credit request: missing ${name}`); return v; }

/**
 * Build a MISMO 2.3.1 credit request XML string.
 *
 * opts:
 *   requestingPartyName   (string, required)  — the ordering entity
 *   submittingPartyName   (string, required)  — software/platform ("YS Capital Group LOS")
 *   lenderCaseIdentifier  (string, required)  — our loan number (echoed back)
 *   requestId             (string, required)  — our correlation id
 *   product               'prequal' | 'creditreport'   (default 'prequal')
 *   action                'Submit'|'ForceNew'|'Reissue'|'Upgrade'|'Unmerge' (default 'Reissue')
 *   creditReportIdentifier(string) — required for Reissue/Upgrade/Unmerge
 *   repositories          { equifax, experian, transunion } booleans (default all true)
 *   requestDatetime       ISO 8601 string (default: now)
 *   borrowers[]           { borrowerId?, firstName, middleName?, lastName, nameSuffix?, ssn,
 *                           residence: { streetAddress, city, state, postalCode, residencyType? } }
 */
function buildCreditRequest(opts = {}) {
  const requestingPartyName = req(opts.requestingPartyName, 'requestingPartyName');
  const submittingPartyName = req(opts.submittingPartyName, 'submittingPartyName');
  const lenderCaseIdentifier = req(opts.lenderCaseIdentifier, 'lenderCaseIdentifier');
  const requestId = req(opts.requestId, 'requestId');

  const product = opts.product || 'prequal';
  if (!PRODUCTS[product]) throw badRequest(`credit request: unknown product '${product}'`);
  const { type: creditReportType, otherDesc } = PRODUCTS[product];

  const action = opts.action || 'Reissue';
  if (!ACTIONS[product].has(action)) throw badRequest(`credit request: action '${action}' not allowed for ${product}`);
  const creditReportIdentifier = opts.creditReportIdentifier;
  if (NEEDS_IDENTIFIER.has(action) && (creditReportIdentifier == null || String(creditReportIdentifier).trim() === '')) {
    throw badRequest(`credit request: action '${action}' requires creditReportIdentifier`);
  }

  const borrowers = Array.isArray(opts.borrowers) ? opts.borrowers : [];
  if (!borrowers.length) throw badRequest('credit request: at least one borrower required');
  const requestType = borrowers.length > 1 ? 'Joint' : 'Individual';

  const repo = opts.repositories || {};
  const yn = (v, dflt) => ((v == null ? dflt : v) ? 'Y' : 'N');
  const eqI = yn(repo.equifax, true), exI = yn(repo.experian, true), tuI = yn(repo.transunion, true);
  if (eqI === 'N' && exI === 'N' && tuI === 'N') throw badRequest('credit request: at least one repository must be included');

  const requestDatetime = opts.requestDatetime || new Date().toISOString().slice(0, 19);

  // normalize borrower ids (B1, C1, C2…) and validate
  const norm = borrowers.map((b, i) => {
    const borrowerId = b.borrowerId || (i === 0 ? 'B1' : `C${i}`);
    const ssn = ssnDigits(b.ssn);
    if (!ssn) throw badRequest(`credit request: borrower ${borrowerId} has an invalid SSN`);
    const r = b.residence || {};
    return {
      borrowerId,
      firstName: req(b.firstName, `borrower ${borrowerId} firstName`),
      middleName: b.middleName || '',
      lastName: req(b.lastName, `borrower ${borrowerId} lastName`),
      nameSuffix: b.nameSuffix || '',
      ssn,
      streetAddress: req(r.streetAddress, `borrower ${borrowerId} residence street`),
      city: req(r.city, `borrower ${borrowerId} residence city`),
      state: req(r.state, `borrower ${borrowerId} residence state`),
      postalCode: req(r.postalCode, `borrower ${borrowerId} residence postal code`),
      residencyType: r.residencyType || 'Current',
    };
  });
  const borrowerIdList = norm.map((b) => b.borrowerId).join(' ');

  const otherAttr = otherDesc ? ` CreditReportTypeOtherDescription="${esc(otherDesc)}"` : '';
  const idAttr = creditReportIdentifier != null && String(creditReportIdentifier).trim() !== ''
    ? ` CreditReportIdentifier="${esc(creditReportIdentifier)}"` : '';

  const borrowerXml = norm.map((b) => (
`        <BORROWER BorrowerID="${esc(b.borrowerId)}" _FirstName="${esc(b.firstName)}" _MiddleName="${esc(b.middleName)}" _LastName="${esc(b.lastName)}" _NameSuffix="${esc(b.nameSuffix)}" _SSN="${esc(b.ssn)}">
          <_RESIDENCE _StreetAddress="${esc(b.streetAddress)}" _City="${esc(b.city)}" _State="${esc(b.state)}" _PostalCode="${esc(b.postalCode)}" BorrowerResidencyType="${esc(b.residencyType)}"/>
        </BORROWER>`
  )).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<REQUEST_GROUP MISMOVersionID="${MISMO_VERSION}">
  <REQUESTING_PARTY _Name="${esc(requestingPartyName)}"/>
  <SUBMITTING_PARTY _Name="${esc(submittingPartyName)}"/>
  <REQUEST RequestDatetime="${esc(requestDatetime)}">
    <REQUEST_DATA>
      <CREDIT_REQUEST MISMOVersionID="${MISMO_VERSION}" LenderCaseIdentifier="${esc(lenderCaseIdentifier)}">
        <CREDIT_REQUEST_DATA CreditRequestID="${esc(requestId)}" BorrowerID="${esc(borrowerIdList)}" CreditReportRequestActionType="${esc(action)}" CreditReportType="${esc(creditReportType)}"${otherAttr} CreditRequestType="${esc(requestType)}"${idAttr}>
          <CREDIT_REPOSITORY_INCLUDED _EquifaxIndicator="${eqI}" _ExperianIndicator="${exI}" _TransUnionIndicator="${tuI}"/>
        </CREDIT_REQUEST_DATA>
        <LOAN_APPLICATION>
${borrowerXml}
        </LOAN_APPLICATION>
      </CREDIT_REQUEST>
    </REQUEST_DATA>
  </REQUEST>
</REQUEST_GROUP>`;
}

module.exports = { buildCreditRequest, esc, ssnDigits, PRODUCTS, ACTIONS, NEEDS_IDENTIFIER, MISMO_VERSION };
