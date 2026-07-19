'use strict';

/**
 * MISMO 3.4 credit REQUEST builder (Xactus Credit ReportX + Pre-QualificationX +
 * Mortgage Only + Refresh Report).
 *
 * 3.4 is ELEMENT-centric (values live in child elements) and deeply nested under
 * MESSAGE/DEAL_SETS/DEAL_SET/DEALS/DEAL, versus 2.3.1's attribute-centric shape.
 * This builder produces the request body for an HTTPS POST (Content-Type
 * text/xml). Same public shape as mismo2-request.buildCreditRequest so the import
 * flow can pick either version.
 *
 * Report type / action matrix (from the Xactus MISMO 3.4 spec):
 *   - Pre-QualificationX (soft): CreditReportType=Other + OtherDescription=SoftCheck (DEFAULT)
 *   - Credit ReportX (hard tri-merge): CreditReportType=Merge
 *   - Mortgage Only:  Other + Streamline
 *   - Refresh Report: Other + Refresh (needs a prior CreditReportIdentifier)
 *   - Actions: Submit | ForceNew | Reissue | Upgrade | Unmerge (Reissue/Upgrade/
 *     Unmerge/Refresh need a prior CreditReportIdentifier).
 */
const MISMO_VERSION = '3.4';
const XMLNS = 'http://www.mismo.org/residential/2009/schemas';
const XMLNS_XLINK = 'http://www.w3.org/1999/xlink';
const ARCROLE = 'urn:fdc:mismo.org:2009:residential/CREDIT_REQUEST_DATA_IsAssociatedWith_ROLE';

const PRODUCTS = {
  prequal:      { type: 'Other', otherDesc: 'SoftCheck' },  // Pre-QualificationX (soft) — DEFAULT
  creditreport: { type: 'Merge', otherDesc: null },         // Credit ReportX (hard tri-merge)
  mortgageonly: { type: 'Other', otherDesc: 'Streamline' }, // Mortgage Only (hard)
  refresh:      { type: 'Other', otherDesc: 'Refresh' },    // Refresh Report (soft, needs prior id)
};
const ACTIONS = {
  prequal:      new Set(['Submit', 'ForceNew', 'Reissue', 'Upgrade']),
  creditreport: new Set(['Submit', 'ForceNew', 'Reissue', 'Upgrade', 'Unmerge']),
  mortgageonly: new Set(['Submit', 'ForceNew', 'Reissue', 'Upgrade']),
  refresh:      new Set(['Submit', 'Reissue']),
};
const NEEDS_IDENTIFIER = new Set(['Reissue', 'Upgrade', 'Unmerge']);

function badRequest(msg) { const e = new Error(msg); e.status = 400; return e; }

/** Escape XML element text / attribute values; strip XML-invalid control chars. */
function esc(v) {
  return String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function ssnDigits(v) {
  const s = String(v == null ? '' : v);
  if (/[^\d\-.\s()]/.test(s)) return null;
  const d = s.replace(/[^\d]/g, '');
  return d.length === 9 ? d : null;
}
function req(v, name) { if (v == null || String(v).trim() === '') throw badRequest(`credit request: missing ${name}`); return v; }
/** Emit an element only when it has a value (keeps optional fields clean). */
function el(tag, v) { return v == null || String(v) === '' ? '' : `<${tag}>${esc(v)}</${tag}>`; }

/**
 * Build a MISMO 3.4 credit request XML string. Same opts as
 * mismo2-request.buildCreditRequest.
 */
function buildCreditRequest(opts = {}) {
  const requestingPartyName = req(opts.requestingPartyName, 'requestingPartyName');
  const submittingPartyName = req(opts.submittingPartyName, 'submittingPartyName');
  const lenderCaseIdentifier = req(opts.lenderCaseIdentifier, 'lenderCaseIdentifier');
  req(opts.requestId, 'requestId');

  const product = opts.product || 'prequal';
  if (!PRODUCTS[product]) throw badRequest(`credit request: unknown product '${product}'`);
  const { type: creditReportType, otherDesc } = PRODUCTS[product];

  const action = opts.action || 'Reissue';
  if (!ACTIONS[product].has(action)) throw badRequest(`credit request: action '${action}' not allowed for ${product}`);
  const creditReportIdentifier = opts.creditReportIdentifier;
  if ((NEEDS_IDENTIFIER.has(action) || product === 'refresh') && (creditReportIdentifier == null || String(creditReportIdentifier).trim() === '')) {
    throw badRequest(`credit request: action '${action}'/${product} requires creditReportIdentifier`);
  }

  const borrowers = Array.isArray(opts.borrowers) ? opts.borrowers : [];
  if (!borrowers.length) throw badRequest('credit request: at least one borrower required');
  const requestType = borrowers.length > 1 ? 'Joint' : 'Individual';

  const repo = opts.repositories || {};
  const tf = (v, dflt) => ((v == null ? dflt : v) ? 'true' : 'false');
  const eqB = tf(repo.equifax, true), exB = tf(repo.experian, true), tuB = tf(repo.transunion, true);
  if (eqB === 'false' && exB === 'false' && tuB === 'false') throw badRequest('credit request: at least one repository must be included');

  const requestDatetime = opts.requestDatetime || new Date().toISOString().slice(0, 19) + 'Z';

  const norm = borrowers.map((b, i) => {
    const label = b.borrowerLabel || `Borrower${String(i + 1).padStart(2, '0')}`;
    const ssn = ssnDigits(b.ssn);
    if (!ssn) throw badRequest(`credit request: borrower ${label} has an invalid SSN`);
    const r = b.residence || {};
    const first = req(b.firstName, `borrower ${label} firstName`);
    const last = req(b.lastName, `borrower ${label} lastName`);
    const mid = b.middleName || '';
    return {
      label, seq: i + 1, first, mid, last,
      full: [first, mid, last].filter(Boolean).join(' '),
      ssn,
      birthDate: b.birthDate || '',
      street: req(r.streetAddress, `borrower ${label} residence street`),
      city: req(r.city, `borrower ${label} residence city`),
      state: req(r.state, `borrower ${label} residence state`),
      zip: req(r.postalCode, `borrower ${label} residence postal code`),
      residencyType: r.residencyType || 'Current',
    };
  });

  const CRD = 'CreditRequestData001';
  const partiesXml = norm.map((b) => (
`				<PARTY SequenceNumber="${b.seq}">
					<INDIVIDUAL>
						<NAME>
							<FirstName>${esc(b.first)}</FirstName>
							<FullName>${esc(b.full)}</FullName>
							<LastName>${esc(b.last)}</LastName>
							<MiddleName>${esc(b.mid)}</MiddleName>
						</NAME>
					</INDIVIDUAL>
					<ROLES>
						<ROLE xlink:label="${esc(b.label)}">
							<BORROWER>${b.birthDate ? `
								<BORROWER_DETAIL><BorrowerBirthDate>${esc(b.birthDate)}</BorrowerBirthDate></BORROWER_DETAIL>` : ''}
								<RESIDENCES>
									<RESIDENCE SequenceNumber="1">
										<ADDRESS>
											<AddressLineText>${esc(b.street)}</AddressLineText>
											<CityName>${esc(b.city)}</CityName>
											<PostalCode>${esc(b.zip)}</PostalCode>
											<StateCode>${esc(b.state)}</StateCode>
										</ADDRESS>
										<RESIDENCE_DETAIL><BorrowerResidencyType>${esc(b.residencyType)}</BorrowerResidencyType></RESIDENCE_DETAIL>
									</RESIDENCE>
								</RESIDENCES>
							</BORROWER>
							<ROLE_DETAIL><PartyRoleType>Borrower</PartyRoleType></ROLE_DETAIL>
						</ROLE>
					</ROLES>
					<TAXPAYER_IDENTIFIERS>
						<TAXPAYER_IDENTIFIER>
							<TaxpayerIdentifierType>SocialSecurityNumber</TaxpayerIdentifierType>
							<TaxpayerIdentifierValue>${esc(b.ssn)}</TaxpayerIdentifierValue>
						</TAXPAYER_IDENTIFIER>
					</TAXPAYER_IDENTIFIERS>
				</PARTY>`
  )).join('\n');

  const relationshipsXml = norm.map((b) => (
`					<RELATIONSHIP xlink:from="${CRD}" xlink:to="${esc(b.label)}" xlink:arcrole="${ARCROLE}"/>`
  )).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<MESSAGE MISMOReferenceModelIdentifier="${MISMO_VERSION}" xmlns="${XMLNS}" xmlns:xlink="${XMLNS_XLINK}">
	<ABOUT_VERSIONS>
		<ABOUT_VERSION>
			<AboutVersionIdentifier IdentifierOwnerURI="http://www.yscapgroup.com">YS Capital Group LOS</AboutVersionIdentifier>
			<DataVersionIdentifier IdentifierOwnerURI="http://www.yscapgroup.com">V1.0</DataVersionIdentifier>
			<DataVersionName>YS Capital Credit Module</DataVersionName>
		</ABOUT_VERSION>
	</ABOUT_VERSIONS>
	<DEAL_SETS>
		<DEAL_SET>
			<DEALS>
				<DEAL>
					<LOANS>
						<LOAN LoanRoleType="SubjectLoan">
							<LOAN_IDENTIFIERS>
								<LOAN_IDENTIFIER>
									<LoanIdentifier>${esc(lenderCaseIdentifier)}</LoanIdentifier>
									<LoanIdentifierType>LenderCase</LoanIdentifierType>
								</LOAN_IDENTIFIER>
							</LOAN_IDENTIFIERS>
						</LOAN>
					</LOANS>
					<PARTIES>
${partiesXml}
					</PARTIES>
					<RELATIONSHIPS>
${relationshipsXml}
					</RELATIONSHIPS>
					<SERVICES>
						<SERVICE>
							<CREDIT>
								<CREDIT_REQUEST>
									<CREDIT_REQUEST_DATAS>
										<CREDIT_REQUEST_DATA xlink:label="${CRD}">
											<CREDIT_REPOSITORY_INCLUDED>
												<CreditRepositoryIncludedEquifaxIndicator>${eqB}</CreditRepositoryIncludedEquifaxIndicator>
												<CreditRepositoryIncludedExperianIndicator>${exB}</CreditRepositoryIncludedExperianIndicator>
												<CreditRepositoryIncludedTransUnionIndicator>${tuB}</CreditRepositoryIncludedTransUnionIndicator>
											</CREDIT_REPOSITORY_INCLUDED>
											<CREDIT_REQUEST_DATA_DETAIL>
												<CreditReportIdentifier>${esc(creditReportIdentifier || '')}</CreditReportIdentifier>
												<CreditReportRequestActionType>${esc(action)}</CreditReportRequestActionType>
												<CreditReportType>${esc(creditReportType)}</CreditReportType>${otherDesc ? `
												<CreditReportTypeOtherDescription>${esc(otherDesc)}</CreditReportTypeOtherDescription>` : ''}
												<CreditRequestDatetime>${esc(requestDatetime)}</CreditRequestDatetime>
												<CreditRequestType>${esc(requestType)}</CreditRequestType>
											</CREDIT_REQUEST_DATA_DETAIL>
										</CREDIT_REQUEST_DATA>
									</CREDIT_REQUEST_DATAS>
								</CREDIT_REQUEST>
							</CREDIT>
						</SERVICE>
					</SERVICES>
				</DEAL>
			</DEALS>
		</DEAL_SET>
		<PARTIES>
			<PARTY SequenceNumber="1">
				<LEGAL_ENTITY><LEGAL_ENTITY_DETAIL><FullName>${esc(requestingPartyName)}</FullName></LEGAL_ENTITY_DETAIL></LEGAL_ENTITY>
				<ROLES><ROLE xlink:label="RequestingParty001"><ROLE_DETAIL><PartyRoleType>RequestingParty</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
			</PARTY>
			<PARTY SequenceNumber="2">
				<LEGAL_ENTITY><LEGAL_ENTITY_DETAIL><FullName>${esc(submittingPartyName)}</FullName></LEGAL_ENTITY_DETAIL></LEGAL_ENTITY>
				<ROLES><ROLE xlink:label="SubmittingParty001"><ROLE_DETAIL><PartyRoleType>SubmittingParty</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
			</PARTY>
			<PARTY SequenceNumber="3">
				<LEGAL_ENTITY><LEGAL_ENTITY_DETAIL><FullName>Xactus, LLC</FullName></LEGAL_ENTITY_DETAIL></LEGAL_ENTITY>
				<ROLES><ROLE xlink:label="ReceivingParty001"><ROLE_DETAIL><PartyRoleType>ReceivingParty</PartyRoleType></ROLE_DETAIL></ROLE></ROLES>
			</PARTY>
		</PARTIES>
	</DEAL_SETS>
</MESSAGE>`;
}

module.exports = { buildCreditRequest, esc, ssnDigits, el, PRODUCTS, ACTIONS, NEEDS_IDENTIFIER, MISMO_VERSION };
