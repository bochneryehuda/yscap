'use strict';
/**
 * LONG-TERM (LT) — MISMO: the appraisal dataset we receive, and the loan-application
 * dataset the GSEs expect.
 *
 * TWO DIFFERENT MISMO THINGS, OFTEN CONFUSED
 *
 *   APPRAISAL   — MISMO **2.6 GSE**, root element `VALUATION_RESPONSE`. This is the
 *                 UAD appraisal report (the 1004 / 1025 form) delivered by the AMC.
 *                 It describes the PROPERTY. Five live examples were analysed on
 *                 2026-08-14 and everything in APPRAISAL below is measured from them.
 *
 *   APPLICATION — MISMO **3.4 / ULAD**, root element `MESSAGE` → `DEAL_SETS`. This is
 *                 the redesigned URLA (Form 1003) dataset the GSEs require. It
 *                 describes the BORROWER, the LOAN and the COLLATERAL. Encompass
 *                 exposes it through the `URLA.*` field family.
 *
 * They are not versions of each other and they do not share a schema. A file needs
 * both: the appraisal tells us what the property earns, the application tells us who
 * is borrowing and on what terms.
 */

// ─────────────────────────────────────────────────────────────────────────────
// APPRAISAL — MISMO 2.6 GSE VALUATION_RESPONSE (measured from 5 live reports)
// ─────────────────────────────────────────────────────────────────────────────
const APPRAISAL = {
  version: '2.6 / 2.6GSE (both seen — the attribute is MISMOVersionID on the root)',
  root: 'VALUATION_RESPONSE',
  measured: { files: 5, distinctElementPaths: 197, distinctAttributes: 496 },
  note: 'The data lives in ATTRIBUTES, not element text. An element like INCOME_ANALYSIS '
    + 'carries its whole payload as attributes.',

  sections: {
    PARTIES: 'APPRAISER (with licence + inspection), LENDER, BORROWER, MANAGEMENT_COMPANY (the AMC)',
    PROPERTY: '_StreetAddress, _City, _County, _State, _PostalCode, _CurrentOccupancyType, _RightsType',
    VALUATION: 'PropertyAppraisedValueAmount, AppraisalEffectiveDate',
    VALUATION_METHODS: 'COST_ANALYSIS, INCOME_ANALYSIS, SALES_COMPARISON, COMPARABLE_SALE, '
      + 'MULTIFAMILY_RENTALS, MULTIFAMILY_RENT_SCHEDULE, RESEARCH, DEPRECIATION, NEW_IMPROVEMENT',
    REPORT: 'FORM (one per form/addendum/photo page) + EMBEDDED_FILE — the whole PDF, base64, '
      + 'which is why these files run 3–7 MB',
  },

  // The part that matters most for a long-term file.
  incomeApproach: {
    element: 'VALUATION_METHODS/INCOME_ANALYSIS',
    attributes: {
      EstimatedMarketMonthlyRentAmount: "the appraiser's MARKET rent",
      GrossRentMultiplierFactor: 'GRM used',
      ValueIndicatedByIncomeApproachAmount: 'value by the income approach',
      _Comment: "the appraiser's reasoning, free text",
    },
    rentSchedule: {
      element: 'VALUATION_METHODS/MULTIFAMILY_RENT_SCHEDULE',
      attributes: {
        RentalActualGrossMonthlyRentAmount: 'the rent IN PLACE today',
        RentalActualTotalMonthlyIncomeAmount: 'actual total including other income',
        RentalEstimatedGrossMonthlyRentAmount: 'the rent the appraiser thinks the market supports',
        RentalEstimatedTotalMonthlyIncomeAmount: 'estimated total',
        MarketRentalDataComment: 'support for the estimate',
        RentalDataAnalysisComment: 'e.g. "NO LEASE SUPPLIED TO APPRAISER"',
      },
    },
  },

  // ── Why this matters to DSCR ───────────────────────────────────────────────
  dscrConnection: {
    what:
      'Field 1005 (Subject Property Gross Rent) is the NUMERATOR of the DSCR ratio, and '
      + 'the appraisal is where that number comes from. But the appraisal offers TWO rents '
      + 'and they are frequently far apart.',
    evidence: [
      { property: 'Plymouth, PA', actual: 2500, estimatedMarket: 3900,
        note: 'market rent is 56% above the rent actually being collected' },
      { property: 'Roselle, NJ', actual: 'VACANT', estimatedMarket: 5000,
        note: 'no actual rent exists — only the estimate' },
      { property: 'Jersey City, NJ', actual: null, estimatedMarket: 5000, note: 'GRM 150' },
    ],
    consequence:
      'Using estimated market rent produces a higher DSCR than using in-place rent. On the '
      + 'Plymouth file the difference is the gap between a comfortable ratio and a marginal '
      + 'one. Which rent feeds 1005 is a CREDIT POLICY decision, not a technical one — so it '
      + 'was ANSWERED by the owner on 2026-08-23 — the qualifying rent is whatever field 1005 holds, so PILOT reads it rather than re-deciding it (`dscr.rentBasis` = qualifying). We still carry both plus '
      + 'the occupancy state so an underwriter can see what the ratio rests on.',
    alsoUseful:
      '_CurrentOccupancyType (TenantOccupied / Vacant) tells you whether an actual rent can '
      + 'exist at all, and RentalDataAnalysisComment often says outright that no lease was '
      + 'supplied — which is a condition waiting to be raised.',
  },

  // Parsing traps found across only five files.
  gotchas: [
    { issue: 'Two date formats', detail: "'05/22/2026' in some reports, '2026-04-21' in others. "
      + 'Parse both; never assume ISO.' },
    { issue: 'Numbers arrive as formatted strings', detail: "'314,000', '3,900' — strip commas "
      + 'before any arithmetic.' },
    { issue: "'VACANT' where a number belongs", detail: 'RentalActualGrossMonthlyRentAmount can '
      + 'be the literal string VACANT. A naive Number() gives NaN and a careless one gives 0, '
      + 'which would read as "this property earns nothing".' },
    { issue: 'Empty-string attributes', detail: "RentalActualAdditionalMonthlyIncomeAmount = '' "
      + 'means not applicable, not zero.' },
    { issue: 'The income approach is often switched off', detail: 'Two of five reports carry '
      + 'ValueIndicatedByIncomeApproachAmount = 0 with a comment explaining the approach was '
      + 'not applicable. Zero is not a value — check the comment before believing it.' },
    { issue: 'File size', detail: 'The embedded base64 PDF is ~3 MB of a 3–7 MB file. Stream or '
      + 'strip EMBEDDED_FILE before parsing in bulk.' },
    { issue: 'FORM repeats', detail: 'One FORM element per page-group — AppraisalForm, '
      + 'SubjectPhotos, Addendum, Sketch, LocationMap, comparable photo pages. One report had '
      + '25. The primary form is flagged AppraisalReportContentIsPrimaryFormIndicator.' },
  ],

  // The form codes the tenant stores in fields 2356 / 2358 / TSUM.PropertyFormType.
  formCodes: {
    'FNMA-1004-v2005': 'Uniform Residential Appraisal Report — single-family',
    'FNMA-1025-v2005': 'Small Residential Income Property Report — 2 to 4 units. The one that '
      + 'carries a real rent schedule, and therefore the one a multi-unit DSCR file needs.',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// APPLICATION — MISMO 3.4 / ULAD (the redesigned URLA, Form 1003)
// ─────────────────────────────────────────────────────────────────────────────
const ULAD = {
  version: 'MISMO v3.4',
  what:
    'The Uniform Loan Application Dataset — the GSE-mandated dataset behind the redesigned '
    + 'URLA (Form 1003). The ULAD Mapping Document ties every field on the form to its MISMO '
    + '3.4 data point. It is a DATASET, not a specification: it tells you the standard terms, '
    + 'not the wire format.',
  keyIdea:
    'The redesigned URLA moved to a DYNAMIC structure with repeatable segments. Where the old '
    + 'form allowed one or two static entries, 3.4 allows many — multiple borrowers, multiple '
    + 'income sources, multiple assets, multiple properties. This is the same lesson the '
    + 'Encompass census taught from the other direction: applications[] is an ARRAY of '
    + 'borrower pairs, and anything modelled as fixed columns will not hold a real file.',

  // The nine sections of the redesigned 1003 — the spine an LOS application should follow.
  sections: [
    { n: '1a', title: 'Personal Information',
      encompass: 'applications[].borrower — name, DOB (1402), SSN (65), citizenship, marital status, dependants, contact',
      ltNote: 'On a DSCR file the borrower is usually an ENTITY, with the natural person behind it as guarantor.' },
    { n: '1b', title: 'Current Employment/Self-Employment and Income',
      encompass: 'borrower.employment[]',
      ltNote: 'Deliberately EMPTY on long-term: URLA.X199 ("employment does not apply") is true on 98% of DSCR files.' },
    { n: '1c/1d', title: 'Additional and Previous Employment', encompass: 'borrower.employment[] with indicators', ltNote: 'Not used on DSCR.' },
    { n: '1e', title: 'Income from Other Sources', encompass: 'borrower.income[]',
      ltNote: 'Where subject-property rent would live on a conventional file. DSCR instead qualifies on 1005 ÷ 912.' },
    { n: '2a', title: 'Assets — Bank Accounts, Retirement, Other', encompass: 'applications[].assets[]',
      ltNote: 'Still relevant on DSCR for reserves and cash to close.' },
    { n: '2b', title: 'Other Assets and Credits', encompass: 'applications[].assets[]' },
    { n: '2c/2d', title: 'Liabilities and Other Obligations', encompass: 'applications[].liabilities[]' },
    { n: '3a', title: 'Property You Own (REO)', encompass: 'applications[].reoProperties[]',
      ltNote: 'Central to DSCR — investor experience is counted from the REO schedule.' },
    { n: '4a', title: 'Loan and Property Information',
      encompass: 'loan.property, 1109 amount, 19 purpose, 1811 occupancy, 1041 type, 16 units',
      ltNote: 'The core of a long-term file.' },
    { n: '4b/4c', title: 'Other New Mortgage Loans / Rental Income on the Property',
      encompass: 'URLA.X80 ("Rental Income on the Property You want to Purchase")',
      ltNote: 'URLA.X80 is TRUE on 99.6% of long-term files and 7.6% of Fix & Flip — one of the '
        + 'sharpest single-field separators between the two products.' },
    { n: '5a/5b', title: 'Declarations', encompass: 'URLA.X* declaration fields, 418, 1343, 403' },
    { n: '6', title: 'Acknowledgements and Agreements', encompass: 'consent + eSign tracking' },
    { n: '7', title: 'Military Service', encompass: 'borrower military service fields', ltNote: 'Rarely relevant on DSCR.' },
    { n: '8', title: 'Demographic Information', encompass: 'HMDA.* family',
      ltNote: 'HMDA generally does not apply to business-purpose investor loans; the tenant still '
        + 'carries the fields, mostly with the 8888/9999 "not applicable" sentinels.' },
    { n: '9', title: 'Loan Originator Information', encompass: '1612 interviewer, NMLS ids' },
  ],

  ltGuidance:
    'A long-term application should NOT be a 1003 with fields greyed out. Sections 1b–1e are '
    + 'inapplicable by design; sections 3a (REO / experience), 4a (property) and 4c (rental '
    + 'income) carry the weight. Keep the ULAD section NUMBERS as the internal spine anyway, so '
    + 'anything we build maps cleanly to the GSE dataset and to the URLA.* fields Encompass '
    + 'already stores — that is what makes the data portable to an investor later.',
};

module.exports = { APPRAISAL, ULAD };
