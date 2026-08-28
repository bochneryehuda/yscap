'use strict';
/**
 * LONG-TERM (LT) — the ANATOMY of an Encompass loan file.
 *
 * WHAT THIS IS. A map of how a loan is SHAPED in Encompass, so anything we build
 * against it starts from the real structure rather than a guess. Every statement
 * below was measured against all 772 loans in the live tenant on 2026-08-14 —
 * the counts are observations, not assumptions.
 *
 * The three addressing systems you must keep straight:
 *   1. FIELD ID   — '1005', 'CX.PITIA', 'URLA.X73'. What Encompass Desktop, the
 *                   business rules and the fieldReader API speak.
 *   2. JSON PATH  — '$.subjectPropertyGrossRentalIncomeAmount'. Where the value
 *                   sits in GET /encompass/v3/loans/{id}.
 *   3. CONTRACT PATH — 'loan.subjectPropertyGrossRentalIncomeAmount'. The SDK name.
 *   The schema endpoint gives all three per field, which is what lets the field
 *   dictionary connect a rule written in field ids to a value in a loan JSON.
 *
 * MULTI-INSTANCE NOTATION. In a business rule or calculation, '[67#2]' means
 * "field 67 on borrower pair 2". 1,070 of the tenant's standard fields are
 * multi-instance. This is why a field id alone is not an address on a loan with
 * more than one pair.
 *
 * READ-ONLY reference knowledge.
 */

// ── The loan root ────────────────────────────────────────────────────────────
const LOAN_ROOT = {
  keysOnEveryLoan: 173,
  identity: {
    id: 'the loan GUID — the only durable handle; every API path takes it',
    loanNumber: "field 364, e.g. 'YSCAP258134846' — the human key, 100% filled",
    loanCreationDate: 'when the file was opened',
    originationDate: 'field 745, application date — 100% filled on both products',
  },
  structure: {
    applications: 'the borrower PAIRS (see BORROWER_PAIRS below)',
    borrowerPairCount: 'how many pairs the file carries',
    currentApplicationIndex: 'which pair the "currentApplication" shortcuts resolve to',
    customFields: "the tenant's own fields as [{ fieldName, value, format }]",
    milestones: 'the workflow log (see MILESTONES below)',
    property: 'subject property',
    contacts: 'the file contacts (settlement agent, appraiser, title …)',
    loanProductData: 'GSE product data — property type, amortization, ARM detail',
    regulationZ: 'APR / interest-only / high-cost test data',
    closingCost: 'the fee worksheet',
    hmda: 'HMDA reporting block',
    correspondent: 'correspondent / investor delivery data',
  },
};

// ── Borrower pairs ───────────────────────────────────────────────────────────
// The single most misunderstood part of the file. `applications` is an ARRAY of
// borrower PAIRS. Each pair holds ONE borrower and ONE optional co-borrower.
const BORROWER_PAIRS = {
  what: 'loan.applications[] — each entry is one borrower pair (borrower + optional co-borrower).',
  observed: { onePair: 737, twoPairs: 31, threePairs: 4, maxSeen: 3 },
  configuredCapacity: 6,
  configuredCapacityEvidence:
    'The tenant defines CX.PAIR1..CX.PAIR6 borrower/co-borrower FICO fields, so the '
    + 'workflow is built for SIX pairs even though only three have been used to date. '
    + 'Anything we build should carry pairs as a list, not as fixed borrower/co-borrower columns.',
  perPair: {
    id: 'the application GUID',
    borrowerPairId: 'stable pair identifier — also what the eFolder uses (_borrower1, _borrower2 …)',
    borrower: 'the primary borrower entity',
    coborrower: 'the co-borrower entity (present only when there is one)',
    propertyUsageType: 'field 1811 — Investor on every long-term file',
    reoProperties: 'the REO schedule for that pair',
    totalAssetsAmount: 'pair-level asset total',
  },
  borrowerHighlights: {
    creditScores: {
      borrower: { experian: '67', transUnion: '1450', equifax: '1414' },
      coborrower: { experian: '60', transUnion: '1452', equifax: '1415' },
      note: 'All three are declared STRING in the schema even though they hold integers. '
        + 'Filled on ~55% of DSCR files (~3% for co-borrowers — most long-term files are single-borrower entities).',
    },
    residences:
      'borrower.residences[] — each has residencyType (Current | Prior) and residencyBasisType '
      + '(Rent | Own | NoPrimaryHousingExpense). This is "does he own or rent, and how long". '
      + 'Observed across the tenant: Current/Rent 386, Current/Own 186, Current/NoPrimaryHousingExpense 70, '
      + 'plus Prior/* rows when the current address is under two years. Duration lives in the '
      + 'residence entry, and the tenant rolls it up into CX.YEARS.AT.RESIDENCE.',
    employment: 'borrower.employment[] — largely NOT APPLICABLE on DSCR: URLA.X199 '
      + '("Borrower Current Employment Does Not Apply") is true on 98% of long-term files, because '
      + 'DSCR qualifies on property cash flow, not personal income.',
  },
};

// ── Subject property ─────────────────────────────────────────────────────────
const SUBJECT_PROPERTY = {
  address: { street: '11', city: '12', county: '13', state: '14', zip: '15' },
  units: { fieldId: '16', path: 'loan.property.financedNumberOfUnits', dscrFill: '91.8%' },
  type: {
    gse: { fieldId: '1041', path: 'loan.loanProductData.gsePropertyType', dscrFill: '100%',
      note: 'The reliable one on long-term. Enumerated (Detached, Attached, Condominium, PUD, …).' },
    tsum: { fieldId: '1553', path: 'loan.tsum.propertyType', dscrFill: '54.3%',
      note: 'A second, sparser property-type field. Do not treat as authoritative.' },
  },
  occupancy: { fieldId: '1811', value: 'Investor on 456 of 457 Investor DSCR files' },
  occupancyRate: { fieldId: '1487', dscrFill: '100%' },
  values: {
    appraised: { fieldId: '356', dscrFill: '74.5%', note: 'Int. The closing value.' },
    estimated: { fieldId: '1821', dscrFill: '69.6%', note: 'The pre-appraisal estimate.' },
    purchasePrice: { fieldId: '136', dscrFill: '22.7%', note: 'Only on purchases — 82.9% on Fix & Flip.' },
    originalCost: { fieldId: '25', dscrFill: '41.4%', note: 'Refinance original cost.' },
  },
  rent: { fieldId: '1005', path: 'loan.subjectPropertyGrossRentalIncomeAmount', dscrFill: '65.9%',
    note: 'The MONTHLY QUALIFYING RENT — the figure the loan qualifies on, which is not necessarily the market rent an appraiser supports (owner-named 2026-08-23). The NUMERATOR of the DSCR ratio.' },
  ltv: { fieldId: '353', path: 'loan.ltv', dscrFill: '90.2%' },
};

// ── Terms ────────────────────────────────────────────────────────────────────
const TERMS = {
  loanAmount: { requested: '1109', base: '2', note: 'Both filled ~92% on DSCR and carry the same value.' },
  interestRate: { fieldId: '3', format: 'DECIMAL_3', dscrFill: '86.9%' },
  termMonths: { fieldId: '4', path: 'loan.loanAmortizationTermMonths', dscrFill: '100%',
    observed: { '360': 'every 30-year DSCR program', '480': 'the 40-year DSCR programs', '12': 'Fix & Flip' } },
  amortizationType: { fieldId: '608', observed: 'Fixed on every program in the tenant today' },
  loanType: { fieldId: '1172', observed: 'Conventional across the board' },
  loanPurpose: { fieldId: '19', observed: 'DSCR skews Cash-Out Refinance; Fix & Flip is 96% Purchase' },
  interestOnly: {
    indicator: { fieldIds: ['2982', 'Terms.IntrOnly', 'HMDA.X109'], type: 'Boolean' },
    months: { fieldId: '1177', path: 'loan.regulationZ.interestOnlyMonths', type: 'Int' },
    howItReads:
      'The IO TERM is field 1177, in MONTHS, and it is the number that distinguishes the programs. '
      + 'DSCR I/O 30 Year and DSCR I/O 40 Year both carry 120 months (10 years IO, then amortizing '
      + 'over the remaining 240 / 360). Fix & Flip carries 12 or 24 — the whole term, because a bridge '
      + 'loan is interest-only end to end. Plain "Investor DSCR 30 YEAR FRM" carries no IO at all on '
      + '444 of 457 files.',
  },
};

// ── Expenses / the PITIA block ───────────────────────────────────────────────
const HOUSING_EXPENSE = {
  total: { fieldId: '912', path: 'loan.proposedHousingExpenseTotal', dscrFill: '92.2%',
    note: 'THE proposed total housing expense — the real PITIA, and the DENOMINATOR of the DSCR ratio.' },
  firstMortgagePI: { fieldId: '228', path: 'loan.proposedFirstMortgageAmount', dscrFill: '91.6%' },
  hoa: { fieldId: '233', dscrFill: '3.7%' },
  mortgageInsurance: { fieldId: '232', dscrFill: '0%', note: 'DSCR carries no MI.' },
  warning:
    'Do NOT use CX.PITIA for a PITIA. Its tenant formula is misconfigured — see formulas.js.',
};

// ── Milestones ───────────────────────────────────────────────────────────────
const MILESTONES = {
  settingsEndpoint: 'GET /encompass/v3/settings/milestones?includeArchived=false&view=Detail',
  order: ['Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Cond. Approval', 'Processing',
    'Waiting for Docs', 'Resubmittal', 'Clear To Close', 'Schedule Closing', 'Ready for Docs',
    'Docs Out', 'Wire Order', 'Funding', 'Investor Delivery', 'Purchasing Conditions',
    'Final Docs', 'Closed', 'Completion'],
  onTheLoan: {
    milestoneCurrentName: 'the milestone the file sits at right now',
    milestoneNextName: 'the one after it',
    milestoneStage: "a coarser bucket, e.g. 'PREQUAL'",
    'milestones[]': 'the full log: name, doneIndicator, startDate, loanAssociate (who owns it), duration',
  },
  fieldIds: {
    'MS.STATUS': 'current milestone NAME as a field id — 100% filled, unlike the pipeline column',
    'MS.STATUSDATE': 'current milestone date',
    'MS.START': 'file started', 'MS.SUB': 'submitted', 'MS.PROC': 'processed',
    'MS.FUN': 'funded', 'MS.CLO': 'completed',
    'MS.SUB.DUE': 'submitted due', 'MS.FUN.DUE': 'funded due', 'MS.CLO.DUE': 'completed due',
  },
  gotcha:
    "The loan pipeline's Loan.CurrentMilestone column comes back BLANK for every loan in this "
    + 'tenant. Read the milestone from the loan body (milestoneCurrentName) or from field MS.STATUS.',
};

// Where the long-term population actually sits (2026-08-14 census).
const DSCR_STAGE_DISTRIBUTION = {
  'Purchasing Conditions': 152, Started: 96, Completion: 84, Submittal: 33, 'Loan Setup': 30,
  'Cond. Approval': 21, 'Investor Delivery': 16, 'Final Docs': 14, 'LO Prep': 14,
  'Waiting for Docs': 8, 'Docs Out': 8, Funding: 4, Resubmittal: 3, 'Schedule Closing': 2,
  Closed: 2, 'Wire Order': 2, 'Ready for Docs': 1,
};

module.exports = {
  LOAN_ROOT, BORROWER_PAIRS, SUBJECT_PROPERTY, TERMS, HOUSING_EXPENSE,
  MILESTONES, DSCR_STAGE_DISTRIBUTION,
};
