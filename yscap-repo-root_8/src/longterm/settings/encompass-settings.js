'use strict';
/**
 * LONG-TERM (LT) — the Encompass SETTINGS REGISTRY.
 *
 * THE HOUSE RULE (owner-directed 2026-08-14): nothing about how WE do things may be
 * hard-coded. Every tenant-specific choice — which field carries the DSCR, which
 * loan programs count as long-term, what a healthy ratio is, which milestones exist —
 * is declared here as a SETTING with OUR value as its default. The system runs
 * out of the box the way YS Capital works, and a future buyer changes these values
 * instead of changing code.
 *
 * So: if you are about to write a field id, a program name, a threshold or a
 * milestone name into LT logic, stop and add it here instead.
 *
 * Each setting declares:
 *   key         — stable dotted identifier
 *   group       — how it is grouped in an admin screen
 *   label       — what to call it in the UI
 *   description — what it does, in plain language
 *   type        — 'fieldId' | 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'map'
 *   default     — OUR value, taken from the live tenant census
 *   evidence    — why that default is right (so a buyer knows what they are changing)
 *
 * This module holds DEFINITIONS and pure resolution only. Persisting overrides is a
 * later step; `resolve()` already accepts them so nothing has to change when a
 * settings table arrives.
 */

const SETTINGS = [
  // ── Product classification ────────────────────────────────────────────────
  { key: 'program.fieldId', group: 'Product', label: 'Loan program field',
    type: 'fieldId', default: '1401',
    description: 'The Encompass field that names the loan program.',
    evidence: 'loan.loanProgramName — filled on 100% of loans in the tenant.' },
  { key: 'program.longTermPatterns', group: 'Product', label: 'Long-term program patterns',
    type: 'list', default: ['DSCR'],
    description: 'A program whose name matches any of these is a LONG-TERM file.',
    evidence: 'All 490 long-term loans carry DSCR in the program name: Investor DSCR 30/40 YEAR FRM, '
      + 'DSCR I/O 30/40 Year FRM, DSCR ARM.' },
  { key: 'program.shortTermPatterns', group: 'Product', label: 'Short-term program patterns',
    type: 'list', default: ['Fix & Flip', 'Fix and Flip', 'Bridge', 'Ground Up'],
    description: 'A program whose name matches any of these is a SHORT-TERM (RTL) file and is NOT ours.',
    evidence: 'The 251 short-term loans are all "Fix & Flip Purchase + reno", 12-month terms.' },
  { key: 'program.knownPrograms', group: 'Product', label: 'Known programs',
    type: 'map',
    default: {
      'Investor DSCR 30 YEAR FRM': { family: 'long-term', termMonths: 360, interestOnly: false },
      'DSCR I/O 30 Year FRM': { family: 'long-term', termMonths: 360, interestOnly: true, interestOnlyMonths: 120 },
      'Investor DSCR 40 YEAR FRM': { family: 'long-term', termMonths: 480, interestOnly: false },
      'DSCR I/O 40 Year FRM': { family: 'long-term', termMonths: 480, interestOnly: true, interestOnlyMonths: 120 },
      'DSCR ARM': { family: 'long-term', termMonths: 360, interestOnly: true, interestOnlyMonths: 120 },
      'Fix & Flip Purchase + reno': { family: 'short-term', termMonths: 12, interestOnly: true },
      'Conventional Fixed': { family: 'other', termMonths: 360, interestOnly: false },
      'Closed End Second': { family: 'other' },
      'Closed End Second Alt Doc': { family: 'other' },
      'HELOC- Qualify Using Rate/Index': { family: 'other' },
    },
    description: 'Every program seen in the tenant, with the terms it implies.',
    evidence: 'Census of 772 loans, 2026-08-14.' },

  // ── The DSCR ratio ────────────────────────────────────────────────────────
  { key: 'dscr.ratioFieldId', group: 'DSCR', label: 'DSCR ratio field',
    type: 'fieldId', default: 'CUST01FV',
    description: 'The custom field holding the computed DSCR.',
    evidence: "Tenant custom field CUST01FV, description 'DSCR', calculation Round([1005]/[912],2)." },
  { key: 'dscr.rentFieldId', group: 'DSCR', label: 'Gross monthly rent field',
    type: 'fieldId', default: '1005',
    description: 'Numerator: gross monthly market rent on the subject property.',
    evidence: 'loan.subjectPropertyGrossRentalIncomeAmount.' },
  { key: 'dscr.housingExpenseFieldId', group: 'DSCR', label: 'Total housing expense (PITIA) field',
    type: 'fieldId', default: '912',
    description: 'Denominator: proposed total monthly housing expense.',
    evidence: 'loan.proposedHousingExpenseTotal. NOT CX.PITIA — that field is misconfigured '
      + 'in this tenant and returns negative values (see encompass/formulas.js).' },
  { key: 'dscr.minimumRatio', group: 'DSCR', label: 'Minimum acceptable DSCR',
    type: 'number', default: 1.0,
    description: 'Below this the property does not cover its own debt service.',
    evidence: 'Industry convention; the tenant holds no hard floor of its own.' },
  { key: 'dscr.comfortRatio', group: 'DSCR', label: 'Comfortable DSCR',
    type: 'number', default: 1.2,
    description: 'At or above this, the file sits in the conventional DSCR comfort zone.',
    evidence: 'Industry convention.' },
  { key: 'dscr.rentBasis', group: 'DSCR', label: 'Which rent feeds the DSCR',
    type: 'enum', default: 'estimated-market', options: ['estimated-market', 'actual-in-place', 'lower-of-both'],
    description: 'The appraisal reports BOTH the rent in place and the market rent the appraiser '
      + 'supports. Which one qualifies the file is a credit-policy decision, not a technical one.',
    evidence: 'Live appraisals show gaps of 56% (2,500 in place vs 3,900 market) and vacant '
      + 'properties where no actual rent exists at all. Encompass field 1005 currently receives '
      + 'the market figure, so that is the shipped default — but it is the more generous of the two.' },
  { key: 'dscr.carryBothRents', group: 'DSCR', label: 'Always store both rents',
    type: 'boolean', default: true,
    description: 'Keep actual rent, market rent and the occupancy state on the file so an '
      + 'underwriter can see what the ratio rests on.',
    evidence: 'MULTIFAMILY_RENT_SCHEDULE in the appraisal XML carries both, plus a comment that '
      + 'often says no lease was supplied.' },
  { key: 'dscr.recomputeLocally', group: 'DSCR', label: 'Recompute DSCR ourselves',
    type: 'boolean', default: true,
    description: 'Recompute rent ÷ housing expense on our side rather than trusting the stored value, '
      + 'so a stale or blank custom field never drives a decision.',
    evidence: 'The stored CUST01FV matched our recomputation on every loan that had both inputs, '
      + 'but it is blank on 34% of long-term files.' },

  // ── Credit ────────────────────────────────────────────────────────────────
  { key: 'credit.bureauFieldIds', group: 'Credit', label: 'Bureau score fields',
    type: 'map',
    default: { borrower: { experian: '67', transUnion: '1450', equifax: '1414' },
               coborrower: { experian: '60', transUnion: '1452', equifax: '1415' } },
    description: 'Where each bureau score lives, per borrower role.',
    evidence: 'Tenant standard fields; declared STRING even though they hold integers.' },
  { key: 'credit.selectionRule', group: 'Credit', label: 'Qualifying score rule',
    type: 'enum', default: 'middle-of-three-lower-of-two',
    options: ['middle-of-three-lower-of-two', 'lowest', 'highest', 'average'],
    description: 'How one qualifying score is chosen from the three bureaus.',
    evidence: 'CX.PAIR1..6 FICO formulas: median when all three report, minimum of the two that do.' },
  { key: 'credit.fileQualifiesOn', group: 'Credit', label: 'File-level qualifying score',
    type: 'enum', default: 'lowest-across-all-borrowers',
    options: ['lowest-across-all-borrowers', 'primary-borrower-only', 'highest-across-all-borrowers'],
    description: 'Which borrower the file qualifies on when there are several.',
    evidence: 'CX.PAIRS16 = Min() across all six configured pairs.' },

  // ── Borrower pairs ────────────────────────────────────────────────────────
  { key: 'borrowerPairs.maxPairs', group: 'Borrowers', label: 'Maximum borrower pairs',
    type: 'number', default: 6,
    description: 'How many borrower pairs a file may carry.',
    evidence: 'The tenant defines CX.PAIR1..CX.PAIR6 FICO fields. Live files use at most 3 '
      + '(737 loans have 1 pair, 31 have 2, 4 have 3).' },
  { key: 'borrowerPairs.storeAsList', group: 'Borrowers', label: 'Model pairs as a list',
    type: 'boolean', default: true,
    description: 'Carry borrowers as an ordered list of pairs rather than fixed borrower/co-borrower columns.',
    evidence: 'loan.applications[] is an array; a two-column model cannot hold pair 2 or 3.' },

  // ── Property ──────────────────────────────────────────────────────────────
  { key: 'property.typeFieldId', group: 'Property', label: 'Property type field',
    type: 'fieldId', default: '1041',
    description: 'Authoritative subject property type.',
    evidence: 'loan.loanProductData.gsePropertyType — 100% filled on long-term files, versus '
      + '54% for the alternative field 1553.' },
  { key: 'property.unitsFieldId', group: 'Property', label: 'Unit count field',
    type: 'fieldId', default: '16', evidence: 'loan.property.financedNumberOfUnits, 91.8% filled.',
    description: 'Number of financed units.' },
  { key: 'property.valueFieldPriority', group: 'Property', label: 'Property value priority',
    type: 'list', default: ['356', '1821', '136'],
    description: 'Which value to trust first: appraised, then estimated, then purchase price.',
    evidence: 'Fill rates on long-term files: appraised 74.5%, estimated 69.6%, purchase price 22.7%.' },
  { key: 'property.ltvFieldId', group: 'Property', label: 'LTV field',
    type: 'fieldId', default: '353', evidence: 'loan.ltv, 90.2% filled.', description: 'Loan to value.' },
  { key: 'property.valueBasisByPurpose', group: 'Property', label: 'Value basis by loan purpose',
    type: 'map', default: { Purchase: '136', 'Cash-Out Refinance': '356', 'NoCash-Out Refinance': '356' },
    description: 'Which value the max-loan calculation applies the LTV to.',
    evidence: 'CX.DSCRLOANAMOUNT: purchase price on a purchase, appraised value on a refinance.' },

  // ── Terms ─────────────────────────────────────────────────────────────────
  { key: 'terms.termMonthsFieldId', group: 'Terms', label: 'Loan term field',
    type: 'fieldId', default: '4', description: 'Amortization term in months.',
    evidence: 'loan.loanAmortizationTermMonths — 100% filled on every program.' },
  { key: 'terms.interestOnlyIndicatorFieldId', group: 'Terms', label: 'Interest-only indicator',
    type: 'fieldId', default: '2982', description: 'Boolean: is this loan interest-only?',
    evidence: 'Agrees with Terms.IntrOnly and HMDA.X109 on every loan.' },
  { key: 'terms.interestOnlyMonthsFieldId', group: 'Terms', label: 'Interest-only term (months)',
    type: 'fieldId', default: '1177', description: 'How long the interest-only period lasts.',
    evidence: 'loan.regulationZ.interestOnlyMonths — 120 on every DSCR I/O file, 12 or 24 on Fix & Flip.' },
  { key: 'terms.rateFieldId', group: 'Terms', label: 'Interest rate field',
    type: 'fieldId', default: '3', evidence: 'loan.requestedInterestRatePercent, DECIMAL_3.',
    description: 'Note rate.' },
  { key: 'terms.loanAmountFieldId', group: 'Terms', label: 'Loan amount field',
    type: 'fieldId', default: '1109', description: 'Requested loan amount.',
    evidence: 'loan.borrowerRequestedLoanAmount; field 2 (base loan amount) carries the same value.' },

  // ── Milestones ────────────────────────────────────────────────────────────
  { key: 'milestones.order', group: 'Workflow', label: 'Milestone order',
    type: 'list',
    default: ['Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Cond. Approval', 'Processing',
      'Waiting for Docs', 'Resubmittal', 'Clear To Close', 'Schedule Closing', 'Ready for Docs',
      'Docs Out', 'Wire Order', 'Funding', 'Investor Delivery', 'Purchasing Conditions',
      'Final Docs', 'Closed', 'Completion'],
    description: 'The workflow, in order.',
    evidence: 'GET /encompass/v3/settings/milestones — 19 active milestones.' },
  { key: 'milestones.currentNameFieldId', group: 'Workflow', label: 'Current milestone field',
    type: 'fieldId', default: 'MS.STATUS',
    description: 'Where to read the current milestone from.',
    evidence: "The pipeline column Loan.CurrentMilestone is BLANK for every loan in this tenant; "
      + 'MS.STATUS (and loan.milestoneCurrentName) are 100% filled.' },

  // ── Conditions ────────────────────────────────────────────────────────────
  { key: 'conditions.model', group: 'Conditions', label: 'Condition model',
    type: 'enum', default: 'enhanced', options: ['enhanced', 'legacy'],
    description: 'Enhanced Conditions (v3) or the legacy per-type endpoints.',
    evidence: 'The legacy v1 endpoints answer 200 with an empty array on all 772 loans; the v3 '
      + 'Enhanced Conditions endpoint returns the real 348 conditions.' },
  { key: 'conditions.openStatuses', group: 'Conditions', label: 'Statuses that count as OPEN',
    type: 'list', default: ['Added', 'Requested', 'Received', 'Rejected'],
    description: 'Which condition statuses appear on an outstanding-conditions list.',
    evidence: 'Live statuses: Added 195, Cleared 124, Fulfilled 12, Waived 11, Rejected 4, '
      + 'Received 1, Requested 1. The condition also carries a statusOpen boolean — prefer it '
      + 'when present and use this list as the fallback.' },
  { key: 'conditions.satisfiedStatuses', group: 'Conditions', label: 'Statuses that count as SATISFIED',
    type: 'list', default: ['Cleared', 'Fulfilled', 'Waived'], description: 'Closed-out statuses.' },
  { key: 'conditions.priorToGates', group: 'Conditions', label: 'Prior-to gates',
    type: 'list', default: ['Submittal', 'Approval', 'Docs', 'Closing', 'Funding', 'Purchase'],
    description: 'The gates a condition can block, earliest first.',
    evidence: 'Observed on live conditions and in the 197 condition templates.' },
  { key: 'conditions.categories', group: 'Conditions', label: 'Condition categories',
    type: 'list', default: ['Property', 'Credit', 'Income', 'Assets', 'Legal', 'Miscellaneous'],
    evidence: 'The six categories used across the 197 templates.',
    description: 'How conditions are grouped.' },
  { key: 'conditions.defaultSet', group: 'Conditions', label: 'Default condition set for long-term',
    type: 'string', default: 'DSCR MASTER SET (YSCAP)',
    description: 'The condition set a new long-term file starts from.',
    evidence: 'One of 19 sets in the tenant. Investor-specific DSCR sets also exist '
      + '(DEEPHAVEN, AMERICAN HERITAGE LENDING, OAK TREE, NQM FUNDING).' },
  { key: 'conditions.borrowerFacingText', group: 'Conditions', label: 'Text shown to the borrower',
    type: 'enum', default: 'externalDescription', options: ['externalDescription', 'internalDescription', 'title'],
    description: 'Which field to show outward on a borrower or TPO condition list.',
    evidence: 'internalDescription carries staff notes and internal reference codes; '
      + 'externalDescription is the borrower-facing wording, and printDefinitions says whether '
      + 'a condition may be shown externally at all.' },

  // ── eFolder ───────────────────────────────────────────────────────────────
  { key: 'efolder.linkDirection', group: 'eFolder', label: 'Document ↔ condition link',
    type: 'enum', default: 'document-holds-conditions', options: ['document-holds-conditions', 'condition-holds-documents'],
    description: 'Which side of the relationship stores the link.',
    evidence: 'document.conditions[] holds the EnhancedCondition references. There is no '
      + 'condition→documents endpoint; the mapping must be inverted on read.' },
  { key: 'efolder.receivedStatuses', group: 'eFolder', label: 'Statuses meaning "we have it"',
    type: 'list', default: ['received', 'reviewed', 'ready for UW', 'ready to ship'],
    evidence: 'Live document statuses across 20,569 rows.', description: 'Document statuses that count as in-hand.' },
  { key: 'efolder.outstandingStatuses', group: 'eFolder', label: 'Statuses meaning "still needed"',
    type: 'list', default: ['needed', 'ordered', 'reordered', 'expected', 'expected!', 'expired!'],
    description: 'Document statuses that belong on a chase list.' },
  { key: 'efolder.writesEnabled', group: 'eFolder', label: 'Allow uploads into Encompass',
    type: 'boolean', default: false,
    description: 'Master switch for the owner-authorized eFolder upload + condition link. Ships OFF: '
      + 'the write path is authorized but not yet implemented or verified against a live loan.',
    evidence: 'Owner-authorized 2026-08-14; recorded in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md.' },

  // ── Connection ────────────────────────────────────────────────────────────
  { key: 'api.baseUrl', group: 'Connection', label: 'Encompass API base',
    type: 'string', default: 'https://api.elliemae.com', description: 'API host.' },
  { key: 'api.tokenScope', group: 'Connection', label: 'OAuth scope',
    type: 'string', default: 'lp',
    description: 'The scope requested at the token endpoint.',
    evidence: 'encompass_admin is REFUSED for this client id — the token endpoint answers '
      + '"the requested scope … exceeds that which the client is permitted".' },
  { key: 'api.minGapMs', group: 'Connection', label: 'Minimum gap between calls (ms)',
    type: 'number', default: 350,
    description: 'Self-imposed pacing so we never crowd the shared tenant.' },
  { key: 'api.preferredVersion', group: 'Connection', label: 'Preferred API version',
    type: 'enum', default: 'v3', options: ['v3', 'v1'],
    description: 'Which API generation to use by default.',
    evidence: 'v1 attachment endpoints are being sunset in ICE release 26.3. Conditions only '
      + 'work correctly on v3. A few reads (loan associates) still only answer on v1.' },

  // ── Stages (db/553) ───────────────────────────────────────────────────────
  // Owner-directed 2026-08-14: "use the Encompass stages, but map those Encompass
  // stages to our own stages. We're not going to have, on the consumer side, all
  // stages from Encompass." The Encompass milestone is mirrored verbatim; these
  // two settings are the SECOND layer. The borrower's label is never configured
  // here — it comes from the milestone's own consumer_status (db/547), so an
  // internal rename can never leak into what a borrower reads.
  { key: 'stages.order', group: 'Stages', label: 'Our pipeline stages',
    type: 'list',
    default: [
      { key: 'new', label: 'New', order: 10 },
      { key: 'setup', label: 'Setup', order: 20 },
      { key: 'submitted', label: 'Submitted', order: 30 },
      { key: 'underwriting', label: 'In Underwriting', order: 40 },
      { key: 'conditions_out', label: 'Conditions Out', order: 50 },
      { key: 'clear_to_close', label: 'Clear to Close', order: 60 },
      { key: 'closing', label: 'Closing', order: 70 },
      { key: 'funded', label: 'Funded', order: 80 },
      { key: 'post_closing', label: 'Post-Closing', order: 90 },
    ],
    description: 'The stages the internal pipeline groups and sorts by.',
    evidence: 'Nine, collapsed from the tenant\'s 19 Encompass milestones — nineteen is too '
      + 'many to read at a glance and several mean the same thing to us.' },
  { key: 'stages.map', group: 'Stages', label: 'Encompass milestone → our stage',
    type: 'map',
    default: {
      'Started': 'new',
      'LO Prep': 'setup',
      'Loan Setup': 'setup',
      'Submittal': 'submitted',
      'Cond. Approval': 'underwriting',
      'Processing': 'underwriting',
      'Resubmittal': 'underwriting',
      'Waiting for Docs': 'conditions_out',
      'Clear To Close': 'clear_to_close',
      'Schedule Closing': 'closing',
      'Ready for Docs': 'closing',
      'Docs Out': 'closing',
      'Wire Order': 'closing',
      'Funding': 'funded',
      'Investor Delivery': 'post_closing',
      'Purchasing Conditions': 'post_closing',
      'Final Docs': 'post_closing',
      'Closed': 'post_closing',
      'Completion': 'post_closing',
    },
    description: 'Which of our stages each Encompass milestone belongs to. A milestone that is '
      + 'not listed is SHOWN under its raw Encompass name in an "Other" bucket, never hidden.',
    evidence: 'All 19 milestone names verified against the live tenant 2026-08-14 — db/547 '
      + 'matched live exactly, zero diffs.' },

  // ── Access (db/553) ───────────────────────────────────────────────────────
  { key: 'access.roleScopes', group: 'Access', label: 'What each role sees',
    type: 'map',
    default: {
      super_admin: 'all',
      admin: 'all',
      closer: 'all',
      funder: 'all',
      underwriter: 'all',
      loan_officer: 'own',
      processor: 'own',
    },
    description: 'Whether a role sees the entire long-term pipeline ("all") or only their own '
      + 'files ("own"). A role with no entry resolves to "own" — never to "all".',
    evidence: 'Owner-directed 2026-08-14: admin, closer and funder see the entire pipeline '
      + '(closer and funder deliberately including files not yet assigned, because a closing or '
      + 'a wire is picked up off the queue); loan officers and processors see their own. '
      + 'The underwriter was NOT named and "all" here is an assumption matching their RTL '
      + 'see_all_files — the one entry awaiting confirmation.' },
  { key: 'access.roleOverrides', group: 'Access', label: 'Long-term role overrides',
    type: 'map', default: {},
    description: 'Per-person long-term role, keyed by PILOT staff id, for staff whose PILOT role '
      + 'does not describe their long-term job.',
    evidence: 'staff_users.role has no "funder" value, and adding one would be changing an RTL '
      + 'table to make Long-Term work. This is how a funder is recognised without touching it.' },
  { key: 'access.adminRoles', group: 'Access', label: 'Who may administer the long-term side',
    type: 'list', default: ['super_admin', 'admin'],
    description: 'The PILOT roles allowed to confirm who an Encompass login belongs to, and to '
      + 'change the people map.',
    evidence: 'Deliberately narrower than "sees the whole pipeline": the owner gave closers and '
      + 'funders the entire book so they can pick work off the queue, which is a different '
      + 'question from who may decide whose book is whose.' },

  // ── Contacts (db/553) ─────────────────────────────────────────────────────
  { key: 'contacts.roles', group: 'Contacts', label: 'Loan team roles we track',
    type: 'list',
    default: ['loan_officer', 'processor', 'underwriter', 'closer', 'funder', 'post_closer'],
    description: 'The loan-team roles mirrored onto every long-term file.',
    evidence: 'Fill on the long-term book: loan officer 98.4%, processor 80.2%, closer 46.3%, '
      + 'funder 45.7%, underwriter 31.2%. Closer and funder read 0% on short-term files, so they '
      + 'are genuinely a long-term concern.' },
  { key: 'contacts.encompassRoleNames', group: 'Contacts', label: 'Encompass role name per role',
    type: 'map',
    default: {
      loan_officer: 'Loan Coordinator',
      processor: 'Loan Processor',
      underwriter: 'Underwriter',
      closer: 'Closer',
      funder: 'Funder',
      post_closer: 'Post Closer',
    },
    description: 'What each role is CALLED in Encompass, for the LoanTeamMember.*.<role> reads.',
    evidence: 'THIS TENANT HAS NO ROLE CALLED "Loan Officer" — its loan-officer slot is '
      + '"Loan Coordinator" (roleId 1), verified live 2026-08-14. Field 317\'s LABEL says Loan '
      + 'Officer; the role the tenant assigns does not. "Loan Opener", "Shipper" and "Insurer" '
      + 'are standard Encompass roles that do not exist here at all — which is why this is a '
      + 'setting and why contact role is text rather than an enum.' },
  { key: 'contacts.roleLabels', group: 'Contacts', label: 'What we call each role on screen',
    type: 'map',
    default: {
      loan_officer: 'Loan officer',
      processor: 'Processor',
      underwriter: 'Underwriter',
      closer: 'Closer',
      funder: 'Funder',
      post_closer: 'Post-closer',
    },
    description: 'The on-screen label for each role. Separate from the Encompass name on purpose: '
      + 'what a tenant calls a role internally and what we show our own staff are two decisions.' },
  { key: 'contacts.placeholderEmails', group: 'Contacts', label: 'Emails that identify nobody',
    type: 'list', default: ['change.me@email.com'],
    description: 'Addresses that must never be used to auto-match an Encompass user to a PILOT '
      + 'person, however many users carry them.',
    evidence: '10 of the 46 users on this tenant share change.me@email.com. Auto-matching on it '
      + 'would hand ten people each other\'s pipelines.' },

  // ── Pipeline (db/553) ─────────────────────────────────────────────────────
  { key: 'pipeline.columns', group: 'Pipeline', label: 'Pipeline columns',
    type: 'list',
    default: [
      'loan_number', 'borrower', 'property', 'program', 'loan_amount', 'note_rate',
      'dscr', 'ltv', 'stage', 'milestone', 'days_in_stage', 'loan_officer',
      'processor', 'lock_status', 'expected_closing',
    ],
    description: 'Which columns the long-term pipeline shows, in order.' },
  { key: 'pipeline.inactiveFolders', group: 'Pipeline', label: 'Loan folders that mean the deal is over',
    type: 'list', default: [],
    // The screen offers the folder names the book ACTUALLY uses, with a count each.
    // See `src/longterm/observed.js` for why that is now possible.
    suggestFrom: 'loanFolders',
    description: 'Encompass loan folders whose files are finished — declined, withdrawn, trashed. '
      + 'The pipeline opens on the live book and puts these one click away, in the same table. '
      + 'A folder NOT on this list always counts as live, so leaving it empty (the default) '
      + 'shows every file exactly as before.',
    evidence: 'CORRECTED 2026-08-17. This used to read "the endpoint that lists them answers 403, '
      + 'so we cannot read them" — true of the endpoint, and FALSE of the fact. Every mirrored loan '
      + 'carries its own folder (`lt_loans.loan_folder`, from CX.LOAN.FOLDER.CURRENT), so the names '
      + 'and their file counts are already here and the screen now offers them. What has NOT changed '
      + 'is the half that matters: which of those folders MEAN the deal is over is a business rule '
      + 'nobody here may guess — treating a folder called "Archive" as finished on a hunch would '
      + 'silently empty part of an officer\'s pipeline. So the names are offered and a human picks; '
      + 'until somebody picks, nothing is hidden from anybody.' },

  // ── The product switch (owner-directed 2026-08-14) ────────────────────────
  // "everybody should have a switch on his login to switch to the long-term side".
  // Asked to choose the shape, the owner picked a TOP-BAR product switch remembered
  // per user.
  //
  // It is a SETTING rather than a column on staff_users for the reason rule 5
  // gives: adding a column to an RTL table to make Long-Term work is forbidden.
  // `lt_settings.scope` already exists to be more than 'company', so a person's
  // preference is stored under the scope `user:<staff id>` — the same declaration,
  // the same validation, a different scope.
  { key: 'ui.defaultProduct', group: 'Interface', label: 'Which side to open on',
    type: 'enum', options: ['rtl', 'long_term'], default: 'rtl',
    // The stored values are KEYS, not English, and this is the one setting an
    // ordinary person sees on their own preferences screen. The words live here with
    // the setting rather than in the screen: a label kept in the front end would be a
    // second place to change, and the two would drift.
    optionLabels: { rtl: 'Short-term (RTL)', long_term: 'Long-term' },
    description: 'The product side a person lands on when they sign in. Saved per user; '
      + 'the company default is what a brand-new user gets.',
    evidence: 'Long-Term is a side build and is not live, so the default must stay RTL — '
      + 'nobody should be moved to the new side by a deploy.' },

  // THE BORROWER'S OWN SWITCH — BUILT READY, AND SWITCHED OFF.
  //
  // The owner (2026-08-16): *"The borrower should also have, in their login, the
  // option to switch from long-term to short-term."* Asked whether to turn it on,
  // they answered *"build it ready"* — so it is wired end to end and this one
  // setting is the whole of what stands between it and the client's screen.
  //
  // DEFAULT TRUE — THE OWNER SAID GO (2026-08-17: *"turn switch on"*), which is the
  // "until they say otherwise" this setting was built waiting for. It shipped
  // `false` on 2026-08-16 because "build it ready" is not "turn it on"; that is now
  // answered, in the owner's own words, so the default flips rather than leaving the
  // product live-but-off behind a setting nobody remembers to press.
  //
  // WHAT TURNING IT ON DOES AND DOES NOT DO. It does NOT publish the long-term book
  // to clients. A borrower sees exactly the long-term files a HUMAN CONFIRMED are
  // theirs (`lt_loans.borrower_id`, written only by `borrower-links.confirmLink`),
  // and nothing else — an unmatched loan belongs to nobody and appears to nobody. So
  // on the day this flips, a borrower with no confirmed links sees an empty
  // long-term side, not somebody else's loan. That is the safe direction, and it is
  // the reason the mapping was built confirm-first in the first place.
  //
  // It stays a SETTING rather than becoming hard-wired: this is a decision about
  // whether the product is live, and the owner must be able to take it back without
  // a deploy. It is a COMPANY setting, not a per-user preference.
  { key: 'borrower.longTermVisible', group: 'Interface',
    label: 'Show long-term files on the borrower login',
    type: 'boolean', default: true,
    description: 'When this is on, a borrower can switch to the long-term side and see the '
      + 'long-term files that have been confirmed as theirs. When it is off, a borrower sees '
      + 'only their short-term (RTL) files and no switch at all.',
    evidence: 'Owner-directed 2026-08-17: "turn switch on". Built ready and left off '
      + '2026-08-16 ("build it ready"); the owner has now said go. A borrower still only '
      + 'ever sees files a human confirmed are theirs.' },

  // ── Rate lock (phase 7) ───────────────────────────────────────────────────
  // Every lock-SPECIFIC endpoint on this tenant answers 403, so the posture is read
  // from the loan itself: the `rateLock` entity where it answers, and these two
  // numbered fields where it does not. WHICH number holds which date is tenant
  // configuration, which is why it is a setting and not a constant — and why the
  // reader also trusts the ORDER of two dates over the mapping, since an expiration
  // cannot precede the lock it expires.
  { key: 'lock.lockDateFieldId', group: 'Rate lock', label: 'Lock date field',
    type: 'fieldId', default: '761',
    description: 'The Encompass field holding the date the rate was locked.',
    evidence: 'Fields 761 and 762 are populated on this tenant. Field 2148 — quoted as '
      + 'the lock date in a lot of general Encompass material — is EMPTY here.' },
  { key: 'lock.expirationFieldId', group: 'Rate lock', label: 'Lock expiration field',
    type: 'fieldId', default: '762',
    description: 'The Encompass field holding the date the lock expires. This value is '
      + 'ALWAYS trusted as stated and is never calculated from the lock date plus a day '
      + 'count — an extension moves it, and a calculated date would read as expired while '
      + 'the investor still honours it.' },
  { key: 'lock.lockedStatuses', group: 'Rate lock', label: 'Words that mean LOCKED',
    type: 'list', default: ['locked', 'lock confirmed', 'confirmed', 'accepted', 'active'],
    description: 'A status word not on this list or the next one is reported as UNKNOWN '
      + 'rather than guessed: a desk told a loan is floating when nobody knows will lock '
      + 'it twice, and one told it is locked when nobody knows will let a rate float.' },
  { key: 'lock.unlockedStatuses', group: 'Rate lock', label: 'Words that mean NOT LOCKED',
    type: 'list',
    default: ['not locked', 'unlocked', 'floating', 'float', 'cancelled', 'canceled', 'denied', 'expired', 'none'],
    description: 'Compared case-insensitively, with spaces, dashes and underscores treated alike.' },
  { key: 'lock.expiringSoonDays', group: 'Rate lock', label: 'Warn this many days before expiry',
    type: 'number', default: 7,
    description: 'How close to its expiration a lock is flagged on the pipeline.' },

  // ── Condition Center — DEFERRED (owner-directed 2026-08-14) ───────────────
  // "put the condition center in side for now that center should say colming soom
  // continie building the rest non stop".
  //
  // The deferral is a SETTING rather than a commented-out screen, for the same reason
  // everything else here is one: a buyer's answer is not ours. Off, the nav entry and the
  // workspace section render a "Coming soon" panel; on, they render the real thing — which
  // is what makes lifting the deferral a settings change rather than a deploy.
  //
  // DEFAULT false, and it stays false until the owner says otherwise. Nothing may READ a
  // condition while it is off: no stage, no access rule, no pipeline column. A feature that
  // quietly half-works behind a flag is worse than one that plainly says it is coming.
  { key: 'conditions.enabled', group: 'Conditions', label: 'Condition Center',
    type: 'boolean', default: false,
    description: 'Off: the Condition Center shows "Coming soon". On: it shows the real '
      + 'conditions. Set aside by the owner on 2026-08-14 while the rest is built.',
    evidence: 'The read-only sweep of 400 loans on 2026-08-14 found conditions ONLY on '
      + 'investor post-purchase files — 0 on all 136 active-pipeline loans — so nothing in '
      + 'the live book is waiting on this screen.' },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/** The definition for one setting. */
function definition(key) { return BY_KEY.get(String(key)) || null; }

/** Our shipped defaults, as a flat { key: value } map. */
function defaults() {
  const out = {};
  for (const s of SETTINGS) out[s.key] = s.default;
  return out;
}

/**
 * Effective settings = our defaults with any overrides applied on top.
 * Unknown keys are refused so a typo can never silently become configuration.
 */
function resolve(overrides = {}) {
  const out = defaults();
  const rejected = [];
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!BY_KEY.has(k)) { rejected.push(k); continue; }
    out[k] = v;
  }
  return { settings: out, rejectedKeys: rejected };
}

/** One value, with overrides applied. */
function value(key, overrides = {}) { return resolve(overrides).settings[String(key)]; }

/** Settings grouped for an admin screen. */
function groups() {
  const g = {};
  for (const s of SETTINGS) (g[s.group] = g[s.group] || []).push(s);
  return g;
}

/** Classify a program name into long-term / short-term / other, per settings. */
function classifyProgram(programName, overrides = {}) {
  const s = resolve(overrides).settings;
  const name = String(programName || '');
  const known = s['program.knownPrograms'][name];
  if (known) return known.family;
  const hit = (list) => list.some((p) => name.toLowerCase().includes(String(p).toLowerCase()));
  if (hit(s['program.longTermPatterns'])) return 'long-term';
  if (hit(s['program.shortTermPatterns'])) return 'short-term';
  return 'other';
}

module.exports = {
  SETTINGS, definition, defaults, resolve, value, groups, classifyProgram,
};
