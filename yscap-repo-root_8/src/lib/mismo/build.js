/**
 * MISMO 3.4 export builder — turns a loaded loan file (a plain JS object, see
 * `loadFile()` in index.js) into a well-formed MISMO v3.4 Reference Model XML
 * document.
 *
 * Container shape (the MISMO nesting the whole industry reads):
 *
 *   MESSAGE
 *     ABOUT_VERSIONS
 *     DEAL_SETS > DEAL_SET > DEALS > DEAL
 *       COLLATERALS > COLLATERAL > SUBJECT_PROPERTY   (address, value, sale price)
 *       LOANS > LOAN (SubjectLoan)                    (amount, rate, term, purpose)
 *       PARTIES > PARTY                               (borrower, co-borrower, vesting LLC)
 *       RELATIONSHIPS                                 (xlink arcs tying them together)
 *       EXTENSION                                     (RTL-specific extras: ARV, rehab…)
 *
 * Design choices, deliberately:
 *  - Every data point is OMITTED when blank (build via `leaf`, which returns
 *    null on empty) — a MISMO file should never carry empty elements.
 *  - Portal values with no exact MISMO home (ARV, rehab budget, experience) map
 *    to the closest standard field AND are preserved verbatim in the lender
 *    EXTENSION, so an export→import round-trip loses nothing.
 *  - Container order follows the MISMO v3.4 xsd:sequence (containers roughly
 *    alphabetical, EXTENSION always last). The relationship arcrole URIs are the
 *    one area to re-confirm against a receiving partner's sample file; they are
 *    isolated as named constants below for exactly that reason.
 */
const { el, leaf, render } = require('./xml');
const E = require('./enums');

// The MISMO residential namespace + the xlink namespace every 3.x file uses.
const NS_MISMO = 'http://www.mismo.org/residential/2009/schemas';
const NS_XLINK = 'http://www.w3.org/1999/xlink';
// Our own lender-extension namespace (extensions must live in a NON-MISMO
// namespace so a standard parser can ignore them cleanly).
const NS_YSCAP = 'http://www.yscapgroup.com/mismo/extension/1.0';
// The reference-model build identifier real GSE/AUS iLAD files carry (verified
// against production iLAD exports). A receiving partner that pins a different
// build can have this tuned to their expected value.
const MISMO_REFERENCE_MODEL_ID = '3.4.032420160128';

// Relationship arcrole URIs (MISMO URN form). Isolated so they can be aligned
// to a partner's sample without touching the tree-building logic.
const ARC = {
  base: 'urn:fdc:Mismo.org:2009:residential',
  partyToProperty: 'urn:fdc:Mismo.org:2009:residential/PARTY_IsAssociatedWith_PROPERTY',
  partyToLoan: 'urn:fdc:Mismo.org:2009:residential/PARTY_IsAssociatedWith_LOAN',
};

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : null;
};
// A date-only value renders as YYYY-MM-DD (our columns are already strings; a pg
// Date object is defended against just in case).
function dateStr(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 10);
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
// Parse "12 months" / "30 year" / "24" into a month count.
function termMonths(term) {
  if (term == null || term === '') return null;
  const s = String(term).toLowerCase();
  const n = num(s);
  if (n == null) return null;
  if (/year|yr|\byrs?\b/.test(s)) return Math.round(n * 12);
  return Math.round(n); // bare number or "months" -> already months
}

function addressEl(a) {
  if (!a) return null;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = { line1: a }; } }
  const line1 = a.line1 || a.street || a.address || '';
  const kids = [
    leaf('AddressLineText', line1),
    leaf('AddressUnitIdentifier', a.line2 || a.unit),
    leaf('CityName', a.city),
    leaf('StateCode', a.state),
    leaf('PostalCode', a.zip || a.postal),
    leaf('CountryCode', a.country || (line1 || a.city ? 'US' : null)),
  ].filter(Boolean);
  return kids.length ? el('ADDRESS', {}, kids) : null;
}

// ------------------------------------------------------------- PARTY builders --
function contactPoints(p) {
  const points = [];
  if (p.email) {
    points.push(el('CONTACT_POINT', {}, [
      el('CONTACT_POINT_EMAIL', {}, [leaf('ContactPointEmailValue', p.email)]),
      el('CONTACT_POINT_DETAIL', {}, [leaf('ContactPointRoleType', 'Home')]),
    ]));
  }
  if (p.phone) {
    points.push(el('CONTACT_POINT', {}, [
      el('CONTACT_POINT_TELEPHONE', {}, [leaf('ContactPointTelephoneValue', String(p.phone).replace(/[^0-9]/g, ''))]),
      el('CONTACT_POINT_DETAIL', {}, [leaf('ContactPointRoleType', 'Mobile')]),
    ]));
  }
  return points.length ? el('CONTACT_POINTS', {}, points) : null;
}

function residences(p) {
  const list = [];
  const cur = addressEl(p.currentAddress);
  if (cur) {
    const months = p.yearsAtResidence != null && p.yearsAtResidence !== ''
      ? Math.round(Number(p.yearsAtResidence) * 12) : null;
    list.push(el('RESIDENCE', {}, [
      cur,
      el('RESIDENCE_DETAIL', {}, [
        leaf('BorrowerResidencyBasisType', p.housingBasis),
        leaf('BorrowerResidencyDurationMonthsCount', months != null && isFinite(months) ? months : null),
        leaf('BorrowerResidencyType', 'Current'),
      ]),
    ]));
  }
  const prior = addressEl(p.priorAddress);
  if (prior) {
    list.push(el('RESIDENCE', {}, [
      prior,
      el('RESIDENCE_DETAIL', {}, [leaf('BorrowerResidencyType', 'Prior')]),
    ]));
  }
  return list.length ? el('RESIDENCES', {}, list) : null;
}

function employers(p) {
  if (!p.employer && !p.employmentType) return null;
  return el('EMPLOYERS', {}, [
    el('EMPLOYER', {}, [
      p.employer ? el('LEGAL_ENTITY', {}, [
        el('LEGAL_ENTITY_DETAIL', {}, [leaf('FullName', p.employer)]),
      ]) : null,
      el('EMPLOYMENT', {}, [
        leaf('EmploymentClassificationType', p.employmentType && /self|1099|k1|c corp|corp/i.test(p.employmentType) ? 'SelfEmployed' : null),
        leaf('EmploymentStatusType', 'Current'),
      ]),
    ]),
  ]);
}

function borrowerParty(p, label, roleType, seq) {
  if (!p) return null;
  const nameEl = el('NAME', {}, [
    leaf('FirstName', p.firstName),
    leaf('MiddleName', p.middleName),
    leaf('LastName', p.lastName),
    leaf('SuffixName', p.suffix),
  ]);
  const borrowerDetail = el('BORROWER_DETAIL', {}, [
    leaf('BorrowerBirthDate', dateStr(p.dob)),
    leaf('CitizenshipResidencyType', E.toMismoCitizenship(p.citizenship)),
    leaf('DependentCount', p.dependents != null && p.dependents !== '' ? Math.round(Number(p.dependents)) : null),
    leaf('MaritalStatusType', E.toMismoMarital(p.maritalStatus)),
  ]);
  const roleKids = [
    el('BORROWER', {}, [
      borrowerDetail.kids.length ? borrowerDetail : null,
      residences(p),
      employers(p),
    ]),
    el('ROLE_DETAIL', {}, [leaf('PartyRoleType', roleType || 'Borrower')]),
  ];
  const ssnDigits = p.ssn ? String(p.ssn).replace(/[^0-9]/g, '') : null;
  const taxIds = ssnDigits && ssnDigits.length === 9
    ? el('TAXPAYER_IDENTIFIERS', {}, [
      el('TAXPAYER_IDENTIFIER', {}, [
        leaf('TaxpayerIdentifierType', 'SocialSecurityNumber'),
        leaf('TaxpayerIdentifierValue', ssnDigits),
      ]),
    ])
    : null;
  return el('PARTY', { SequenceNumber: seq || 1, 'xlink:label': label }, [
    el('INDIVIDUAL', {}, [contactPoints(p), nameEl]),
    el('ROLES', {}, [el('ROLE', { 'xlink:label': `${label}_ROLE` }, roleKids)]),
    taxIds,
  ]);
}

function entityParty(llc, label, seq) {
  if (!llc || !llc.name) return null;
  const einDigits = llc.ein ? String(llc.ein).replace(/[^0-9]/g, '') : null;
  return el('PARTY', { SequenceNumber: seq || 3, 'xlink:label': label }, [
    el('LEGAL_ENTITY', {}, [
      el('LEGAL_ENTITY_DETAIL', {}, [leaf('FullName', llc.name)]),
    ]),
    el('ROLES', {}, [el('ROLE', { 'xlink:label': `${label}_ROLE` }, [
      el('ROLE_DETAIL', {}, [leaf('PartyRoleType', 'TitleHolder')]),
    ])]),
    einDigits && einDigits.length === 9
      ? el('TAXPAYER_IDENTIFIERS', {}, [el('TAXPAYER_IDENTIFIER', {}, [
        leaf('TaxpayerIdentifierType', 'EmployerIdentificationNumber'),
        leaf('TaxpayerIdentifierValue', einDigits),
      ])])
      : null,
  ]);
}

// ------------------------------------------------------------ COLLATERAL/LOAN --
function subjectProperty(f, label) {
  const valuations = [];
  if (num(f.asIsValue) != null) {
    valuations.push(el('PROPERTY_VALUATION', {}, [
      el('PROPERTY_VALUATION_DETAIL', {}, [
        leaf('PropertyValuationAmount', num(f.asIsValue)),
        leaf('PropertyValuationMethodType', 'PriorAppraisal'),
      ]),
    ]));
  }
  const detailKids = [
    leaf('FinancedUnitCount', f.units != null && f.units !== '' ? Math.round(Number(f.units)) : E.unitsHint(f.propertyType)),
    leaf('PropertyEstimatedValueAmount', num(f.asIsValue)),
    leaf('PropertyUsageType', E.toMismoOccupancy(f.occupancy)),
    leaf('AttachmentType', E.toMismoAttachment(f.propertyType)),
  ].filter(Boolean);
  return el('COLLATERAL', { SequenceNumber: 1, 'xlink:label': label }, [
    el('SUBJECT_PROPERTY', {}, [
      addressEl(f.property),
      detailKids.length ? el('PROPERTY_DETAIL', {}, detailKids) : null,
      valuations.length ? el('PROPERTY_VALUATIONS', {}, valuations) : null,
      num(f.purchasePrice) != null ? el('SALES_CONTRACTS', {}, [
        el('SALES_CONTRACT', {}, [
          el('SALES_CONTRACT_DETAIL', {}, [leaf('SalesContractAmount', num(f.purchasePrice))]),
        ]),
      ]) : null,
    ]),
  ]);
}

function loan(f, label) {
  const months = termMonths(f.term);
  const purpose = E.toMismoLoanPurpose(f.loanType);
  const cashOut = E.toMismoRefiCashOut(f.loanType);
  return el('LOAN', { SequenceNumber: 1, 'xlink:label': label, LoanRoleType: 'SubjectLoan' }, [
    months != null ? el('AMORTIZATION', {}, [
      el('AMORTIZATION_RULE', {}, [
        leaf('AmortizationType', E.DEFAULT_AMORTIZATION_TYPE),
        leaf('LoanAmortizationPeriodCount', months),
        leaf('LoanAmortizationPeriodType', 'Month'),
      ]),
    ]) : null,
    el('LOAN_DETAIL', {}, [
      leaf('LoanMaturityPeriodCount', months),
      leaf('LoanMaturityPeriodType', months != null ? 'Month' : null),
    ]),
    f.loanNumber || f.investorLoanNumber ? el('LOAN_IDENTIFIERS', {}, [
      f.loanNumber ? el('LOAN_IDENTIFIER', {}, [
        leaf('LoanIdentifier', f.loanNumber),
        leaf('LoanIdentifierType', 'LenderLoan'),
      ]) : null,
      f.investorLoanNumber ? el('LOAN_IDENTIFIER', {}, [
        leaf('LoanIdentifier', f.investorLoanNumber),
        leaf('LoanIdentifierType', 'InvestorLoan'),
      ]) : null,
    ]) : null,
    el('TERMS_OF_LOAN', {}, [
      leaf('BaseLoanAmount', num(f.loanAmount)),
      leaf('LoanPurposeType', purpose),
      leaf('MortgageType', E.DEFAULT_MORTGAGE_TYPE),
      leaf('NoteAmount', num(f.loanAmount)),
      leaf('NoteRatePercent', num(f.rate)),
    ]),
    cashOut ? el('REFINANCE', {}, [leaf('RefinanceCashOutDeterminationType', cashOut)]) : null,
  ]);
}

// ------------------------------------------------------------------ EXTENSION --
// RTL / business-purpose fields that have no native MISMO home. Kept in our own
// namespace so a standard reader ignores them and our own importer restores them
// exactly. `OTHER` is the MISMO-sanctioned extension anchor.
function lenderExtension(f) {
  const x = f.extras || {};
  const fields = [
    ['Program', f.program],
    ['PropertyType', f.propertyType],
    ['AfterRepairValue', num(f.arv)],
    ['RehabBudget', num(f.rehabBudget)],
    ['RehabType', f.rehabType],
    ['DSCR', num(f.dscr)],
    ['LTV', num(f.ltv)],
    ['PrepaymentPenalty', f.ppp],
    ['SquareFeetPre', x.sqftPre],
    ['SquareFeetPost', x.sqftPost],
    ['RequestedExperienceFlips', x.expFlips],
    ['RequestedExperienceHolds', x.expHolds],
    ['RequestedExperienceGroundUp', x.expGround],
    ['FicoScore', f.borrower && f.borrower.fico],
    // Exact marital status (MISMO's Unmarried bucket loses Single/Divorced/Widowed).
    ['BorrowerMaritalStatus', f.borrower && f.borrower.maritalStatus],
    ['CoBorrowerMaritalStatus', f.coBorrower && f.coBorrower.maritalStatus],
    ['Lender', f.lender],
    ['Channel', f.channel],
  ].filter(([, v]) => v != null && v !== '');
  if (!fields.length) return null;
  return el('EXTENSION', {}, [
    el('OTHER', {}, [
      el('YSCAP:LOAN_EXTENSION', { 'xmlns:YSCAP': NS_YSCAP }, fields.map(([k, v]) => leaf(`YSCAP:${k}`, v))),
    ]),
  ]);
}

// ---------------------------------------------------------------- relationships
function relationships(labels) {
  const rels = [];
  let seq = 1;
  const add = (from, to, arcrole) => {
    rels.push(el('RELATIONSHIP', {
      'xlink:from': from, 'xlink:to': to, 'xlink:arcrole': arcrole, SequenceNumber: seq++,
    }, []));
  };
  for (const partyLabel of labels.borrowerParties) {
    if (labels.loan) add(partyLabel, labels.loan, ARC.partyToLoan);
    if (labels.collateral) add(partyLabel, labels.collateral, ARC.partyToProperty);
  }
  if (labels.entity && labels.collateral) add(labels.entity, labels.collateral, ARC.partyToProperty);
  return rels.length ? el('RELATIONSHIPS', {}, rels) : null;
}

/**
 * Build the MISMO 3.4 XML string for a loaded loan file.
 * @param {object} f  the object returned by loadFile() in index.js
 * @returns {string}  a complete XML document
 */
function buildMismoXml(f) {
  const LBL = {
    collateral: 'SUBJECT_COLLATERAL',
    loan: 'SUBJECT_LOAN',
    borrower: 'PARTY_BORROWER',
    coBorrower: 'PARTY_COBORROWER',
    entity: 'PARTY_ENTITY',
  };

  const parties = [
    borrowerParty(f.borrower, LBL.borrower, 'Borrower', 1),
    borrowerParty(f.coBorrower, LBL.coBorrower, 'Borrower', 2),
    entityParty(f.llc, LBL.entity, 3),
  ].filter(Boolean);

  const borrowerParties = [];
  if (f.borrower) borrowerParties.push(LBL.borrower);
  if (f.coBorrower) borrowerParties.push(LBL.coBorrower);

  const deal = el('DEAL', {}, [
    el('COLLATERALS', {}, [subjectProperty(f, LBL.collateral)]),
    el('LOANS', {}, [loan(f, LBL.loan)]),
    parties.length ? el('PARTIES', {}, parties) : null,
    relationships({
      borrowerParties,
      loan: LBL.loan,
      collateral: LBL.collateral,
      entity: f.llc && f.llc.name ? LBL.entity : null,
    }),
    lenderExtension(f),
  ]);

  const message = el('MESSAGE', {
    xmlns: NS_MISMO,
    'xmlns:xlink': NS_XLINK,
    MISMOReferenceModelIdentifier: MISMO_REFERENCE_MODEL_ID,
  }, [
    el('ABOUT_VERSIONS', {}, [
      el('ABOUT_VERSION', {}, [
        leaf('AboutVersionIdentifier', 'PILOT by YS Capital — MISMO 3.4 export'),
        leaf('CreatedDatetime', f.generatedAt || new Date().toISOString()),
      ]),
    ]),
    el('DEAL_SETS', {}, [
      el('DEAL_SET', {}, [
        el('DEALS', {}, [deal]),
      ]),
    ]),
  ]);

  return render(message);
}

module.exports = { buildMismoXml, NS_MISMO, NS_YSCAP, MISMO_REFERENCE_MODEL_ID };
