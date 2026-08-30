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

/**
 * WHY A SETTING SAYS "not in use yet" — and why that sentence is in the code
 * rather than only in somebody's head.
 *
 * The house rule above promises a buyer that every tenant-specific choice is a
 * setting. Forty-one of these were declared ahead of the code that would read
 * them, so a knob on the settings screen changed NOTHING and said so nowhere — a
 * silent knob is worse than no knob, because it is believed. Each of those now
 * carries `notWired`, the screen prints it, and
 * `scripts/test-lt-settings-wired-pure.js` fails the build on a setting that is
 * neither read by something nor honest about not being read — and on a `notWired`
 * that has gone STALE because somebody wired it since.
 *
 * The reasons below are shared because they are genuinely the same reason. Adding
 * a setting nothing reads yet means adding one of these to it.
 */

/** The number is pinned to the MEASURED field dictionary, not to this setting. */
const NW_PINNED_FIELD = 'Not in use yet. The reader takes this field by NUMBER from the measured '
  + 'field dictionary (772 live loans), and the build fails if a path disagrees with it — that guard '
  + 'is what caught three field paths that could never have filled. Changing it here changes nothing '
  + 'today; it is declared so a buyer whose Encompass carries the fact somewhere else has one place to say so.';

/** The rule it describes is settled in code, where a test can hold it. */
const NW_SETTLED_RULE = 'Not in use yet. The rule it describes is settled in code, where the census '
  + 'test can hold it against the live book. It is declared so a buyer can reopen it without a release.';

/** The feature that would read it has not been built. */
const NW_NOT_BUILT = 'Not in use yet — the part of the system that would read it has not been built.';

/** The connection is configured by the hosting environment, not from here. */
const NW_ENV = 'Not in use yet. The connection is configured where the credentials live (the hosting '
  + 'settings), so it can differ per environment and no secret passes through this screen.';

const SETTINGS = [
  // ── Product classification ────────────────────────────────────────────────
  { key: 'program.fieldId', group: 'Product', label: 'Loan program field',
    type: 'fieldId', default: '1401',
    description: 'The Encompass field that names the loan program.',
    evidence: 'loan.loanProgramName — filled on 100% of loans in the tenant.',
    notWired: NW_PINNED_FIELD },
  { key: 'program.longTermPatterns', group: 'Product', label: 'Long-term program patterns',
    type: 'list', default: ['DSCR'],
    description: 'A program whose name matches any of these is a LONG-TERM file.',
    evidence: 'All 490 long-term loans carry DSCR in the program name: Investor DSCR 30/40 YEAR FRM, '
      + 'DSCR I/O 30/40 Year FRM, DSCR ARM.',
    notWired: NW_SETTLED_RULE },
  { key: 'program.shortTermPatterns', group: 'Product', label: 'Short-term program patterns',
    type: 'list', default: ['Fix & Flip', 'Fix and Flip', 'Bridge', 'Ground Up'],
    description: 'A program whose name matches any of these is a SHORT-TERM (RTL) file and is NOT ours.',
    evidence: 'The 251 short-term loans are all "Fix & Flip Purchase + reno", 12-month terms.',
    notWired: NW_SETTLED_RULE },
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
    evidence: 'Census of 772 loans, 2026-08-14.',
    notWired: NW_SETTLED_RULE },

  // ── The DSCR ratio ────────────────────────────────────────────────────────
  { key: 'dscr.ratioFieldId', group: 'DSCR', label: 'DSCR ratio field',
    type: 'fieldId', default: 'CUST01FV',
    description: 'The custom field holding the computed DSCR.',
    evidence: "Tenant custom field CUST01FV, description 'DSCR', calculation Round([1005]/[912],2).",
    notWired: NW_PINNED_FIELD },
  { key: 'dscr.rentFieldId', group: 'DSCR', label: 'Monthly qualifying rent field',
    type: 'fieldId', default: '1005',
    description: 'Numerator: the MONTHLY QUALIFYING RENT on the subject property — the figure '
      + 'this loan actually qualifies on.',
    // NAMED BY THE OWNER, 2026-08-23: *"The amount that we are using for our rent
    // calculation is the monthly qualifying rent field ID 1005."* The field id was
    // already right; what was wrong was calling it "gross monthly MARKET rent". Those
    // are two different numbers on the same appraisal — live files show gaps of 56%
    // between the rent in place and the market rent an appraiser supports — so a
    // settings screen that names the wrong one tells an underwriter the ratio rests
    // on a figure nobody chose. 1005 holds whatever qualified the file; it is not, by
    // definition, the market figure.
    evidence: 'Owner-named 2026-08-23: field 1005 is the monthly qualifying rent. '
      + 'loan.subjectPropertyGrossRentalIncomeAmount.',
    notWired: NW_PINNED_FIELD },
  { key: 'dscr.housingExpenseFieldId', group: 'DSCR', label: 'Total housing expense (PITIA) field',
    type: 'fieldId', default: '912',
    description: 'Denominator: proposed total monthly housing expense.',
    evidence: 'loan.proposedHousingExpenseTotal. NOT CX.PITIA — that field is misconfigured '
      + 'in this tenant and returns negative values (see encompass/formulas.js).',
    notWired: NW_PINNED_FIELD },
  { key: 'dscr.minimumRatio', group: 'DSCR', label: 'Minimum acceptable DSCR',
    type: 'number', default: 1.0,
    description: 'Below this the property does not cover its own debt service.',
    evidence: 'Industry convention; the tenant holds no hard floor of its own.',
  },
  { key: 'dscr.comfortRatio', group: 'DSCR', label: 'Comfortable DSCR',
    type: 'number', default: 1.2,
    description: 'At or above this, the file sits in the conventional DSCR comfort zone.',
    evidence: 'Industry convention.',
  },
  { key: 'dscr.rentBasis', group: 'DSCR', label: 'Which rent feeds the DSCR',
    type: 'enum', default: 'qualifying', options: ['qualifying', 'estimated-market', 'actual-in-place', 'lower-of-both'],
    description: 'THE QUALIFYING RENT — whatever Encompass field 1005 holds for this loan. The '
      + 'appraisal reports both the rent in place and the market rent an appraiser supports; which '
      + 'of them qualified a given file was decided when 1005 was filled, and PILOT reads that '
      + 'answer rather than re-deciding it.',
    // ANSWERED BY THE OWNER, 2026-08-23. This shipped as an OPEN QUESTION, deliberately
    // left for the owner because "which rent qualifies a file" is credit policy and no
    // developer may guess it. The answer is that the question does not belong to PILOT
    // at all: the qualifying rent is the number in 1005, and reading anything else —
    // or applying a rule of our own over it — would price a loan on a figure the credit
    // decision did not use. The three older options are KEPT rather than deleted so a
    // buyer who genuinely wants a rule of their own has somewhere to put it, and so the
    // record still shows what was considered.
    evidence: 'Owner-named 2026-08-23: *"The amount that we are using for our rent calculation '
      + 'is the monthly qualifying rent field ID 1005."* Live appraisals show gaps of 56% '
      + '(2,500 in place vs 3,900 market) and vacant properties where no actual rent exists at '
      + 'all — which is exactly why the figure is read rather than derived.',
    notWired: NW_SETTLED_RULE },
  { key: 'dscr.carryBothRents', group: 'DSCR', label: 'Always store both rents',
    type: 'boolean', default: true,
    description: 'Keep actual rent, market rent and the occupancy state on the file so an '
      + 'underwriter can see what the ratio rests on.',
    evidence: 'MULTIFAMILY_RENT_SCHEDULE in the appraisal XML carries both, plus a comment that '
      + 'often says no lease was supplied.',
    notWired: NW_SETTLED_RULE },
  { key: 'dscr.recomputeLocally', group: 'DSCR', label: 'Recompute DSCR ourselves',
    type: 'boolean', default: true,
    description: 'Recompute rent ÷ housing expense on our side rather than trusting the stored value, '
      + 'so a stale or blank custom field never drives a decision.',
    evidence: 'The stored CUST01FV matched our recomputation on every loan that had both inputs, '
      + 'but it is blank on 34% of long-term files.',
    notWired: NW_SETTLED_RULE },

  // ── Credit ────────────────────────────────────────────────────────────────
  { key: 'credit.bureauFieldIds', group: 'Credit', label: 'Bureau score fields',
    type: 'map',
    default: { borrower: { experian: '67', transUnion: '1450', equifax: '1414' },
               coborrower: { experian: '60', transUnion: '1452', equifax: '1415' } },
    description: 'Where each bureau score lives, per borrower role.',
    evidence: 'Tenant standard fields; declared STRING even though they hold integers.',
    notWired: NW_PINNED_FIELD },
  { key: 'credit.selectionRule', group: 'Credit', label: 'Qualifying score rule',
    type: 'enum', default: 'middle-of-three-lower-of-two',
    options: ['middle-of-three-lower-of-two', 'lowest', 'highest', 'average'],
    description: 'How one qualifying score is chosen from the three bureaus.',
    evidence: 'CX.PAIR1..6 FICO formulas: median when all three report, minimum of the two that do.',
    notWired: NW_NOT_BUILT },
  { key: 'credit.fileQualifiesOn', group: 'Credit', label: 'File-level qualifying score',
    type: 'enum', default: 'lowest-across-all-borrowers',
    options: ['lowest-across-all-borrowers', 'primary-borrower-only', 'highest-across-all-borrowers'],
    description: 'Which borrower the file qualifies on when there are several.',
    evidence: 'CX.PAIRS16 = Min() across all six configured pairs.',
    notWired: NW_NOT_BUILT },

  // ── Borrower pairs ────────────────────────────────────────────────────────
  { key: 'borrowerPairs.maxPairs', group: 'Borrowers', label: 'Maximum borrower pairs',
    type: 'number', default: 6,
    description: 'How many borrower pairs a file may carry.',
    evidence: 'The tenant defines CX.PAIR1..CX.PAIR6 FICO fields. Live files use at most 3 '
      + '(737 loans have 1 pair, 31 have 2, 4 have 3).',
    notWired: NW_SETTLED_RULE },
  { key: 'borrowerPairs.storeAsList', group: 'Borrowers', label: 'Model pairs as a list',
    type: 'boolean', default: true,
    description: 'Carry borrowers as an ordered list of pairs rather than fixed borrower/co-borrower columns.',
    evidence: 'loan.applications[] is an array; a two-column model cannot hold pair 2 or 3.',
    notWired: NW_SETTLED_RULE },

  // ── Property ──────────────────────────────────────────────────────────────
  { key: 'property.typeFieldId', group: 'Property', label: 'Property type field',
    type: 'fieldId', default: '1041',
    description: 'Authoritative subject property type.',
    evidence: 'loan.loanProductData.gsePropertyType — 100% filled on long-term files, versus '
      + '54% for the alternative field 1553.',
    notWired: NW_PINNED_FIELD },
  { key: 'property.unitsFieldId', group: 'Property', label: 'Unit count field',
    type: 'fieldId', default: '16', evidence: 'loan.property.financedNumberOfUnits, 91.8% filled.',
    description: 'Number of financed units.',
    notWired: NW_PINNED_FIELD },
  { key: 'property.valueFieldPriority', group: 'Property', label: 'Property value priority',
    type: 'list', default: ['356', '1821', '136'],
    description: 'Which value to trust first: appraised, then estimated, then purchase price.',
    evidence: 'Fill rates on long-term files: appraised 74.5%, estimated 69.6%, purchase price 22.7%.',
    notWired: NW_PINNED_FIELD },
  { key: 'property.ltvFieldId', group: 'Property', label: 'LTV field',
    type: 'fieldId', default: '353', evidence: 'loan.ltv, 90.2% filled.', description: 'Loan to value.',
    notWired: NW_PINNED_FIELD },
  { key: 'property.valueBasisByPurpose', group: 'Property', label: 'Value basis by loan purpose',
    type: 'map', default: { Purchase: '136', 'Cash-Out Refinance': '356', 'NoCash-Out Refinance': '356' },
    description: 'Which value the max-loan calculation applies the LTV to.',
    evidence: 'CX.DSCRLOANAMOUNT: purchase price on a purchase, appraised value on a refinance.',
    notWired: NW_PINNED_FIELD },

  // ── Terms ─────────────────────────────────────────────────────────────────
  { key: 'terms.termMonthsFieldId', group: 'Terms', label: 'Loan term field',
    type: 'fieldId', default: '4', description: 'Amortization term in months.',
    evidence: 'loan.loanAmortizationTermMonths — 100% filled on every program.',
    notWired: NW_PINNED_FIELD },
  { key: 'terms.interestOnlyIndicatorFieldId', group: 'Terms', label: 'Interest-only indicator',
    type: 'fieldId', default: '2982', description: 'Boolean: is this loan interest-only?',
    evidence: 'Agrees with Terms.IntrOnly and HMDA.X109 on every loan.',
    notWired: NW_PINNED_FIELD },
  { key: 'terms.interestOnlyMonthsFieldId', group: 'Terms', label: 'Interest-only term (months)',
    type: 'fieldId', default: '1177', description: 'How long the interest-only period lasts.',
    evidence: 'loan.regulationZ.interestOnlyMonths — 120 on every DSCR I/O file, 12 or 24 on Fix & Flip.',
    notWired: NW_PINNED_FIELD },
  { key: 'terms.rateFieldId', group: 'Terms', label: 'Interest rate field',
    type: 'fieldId', default: '3', evidence: 'loan.requestedInterestRatePercent, DECIMAL_3.',
    description: 'Note rate.',
    notWired: NW_PINNED_FIELD },
  { key: 'terms.loanAmountFieldId', group: 'Terms', label: 'Loan amount field',
    type: 'fieldId', default: '1109', description: 'Requested loan amount.',
    evidence: 'loan.borrowerRequestedLoanAmount; field 2 (base loan amount) carries the same value.',
    notWired: NW_PINNED_FIELD },

  // ── Milestones ────────────────────────────────────────────────────────────
  { key: 'milestones.order', group: 'Workflow', label: 'Milestone order',
    type: 'list',
    default: ['Started', 'LO Prep', 'Loan Setup', 'Submittal', 'Cond. Approval', 'Processing',
      'Waiting for Docs', 'Resubmittal', 'Clear To Close', 'Schedule Closing', 'Ready for Docs',
      'Docs Out', 'Wire Order', 'Funding', 'Investor Delivery', 'Purchasing Conditions',
      'Final Docs', 'Closed', 'Completion'],
    description: 'The workflow, in order.',
    evidence: 'GET /encompass/v3/settings/milestones — 19 active milestones.',
    // NOT the shared "settled in code" reason, which is what this carried until the
    // catalog started refreshing itself. The order is now read LIVE from the
    // tenant's own milestone list on every catalog pass (`sync/milestone-catalog.js`
    // writes `sequence` from the order Encompass returns, and the stepper draws
    // that), so this list is only the shape PILOT shipped with. Wiring the setting
    // would make it OVERRIDE the tenant's own answer, which is the wrong direction:
    // a buyer who wants a different order changes it in Encompass, where the loans
    // actually move through it, and the next refresh follows.
    notWired: 'Not in use yet, and it is no longer the thing that decides. The order is read LIVE '
      + 'from your own Encompass milestone list every time the catalog refreshes, so this is only '
      + 'the list PILOT shipped with. Change the order in Encompass and PILOT follows it.' },
  { key: 'milestones.currentNameFieldId', group: 'Workflow', label: 'Current milestone field',
    type: 'fieldId', default: 'MS.STATUS',
    description: 'Where to read the current milestone from.',
    evidence: "The pipeline column Loan.CurrentMilestone is BLANK for every loan in this tenant; "
      + 'MS.STATUS (and loan.milestoneCurrentName) are 100% filled.',
    notWired: NW_PINNED_FIELD },

  // ── The PURCHASED step: OURS, not Encompass's (owner-directed 2026-08-23) ──
  //
  // The owner's own workflow carries a step Encompass's milestone list does not:
  // *"the purchase is a new milestone, and yes, you can build this up."* Encompass
  // has nineteen milestones and none of them is "the investor bought this loan" —
  // its late steps (Investor Delivery → Purchasing Conditions → Final Docs) are
  // about the WORK around the sale, not the sale itself.
  //
  // So this one step is PILOT's, and it is the only step in the ladder whose
  // "reached" is a FACT rather than a position: every other step is reached because
  // the loan is standing past it, and this one is reached because Encompass's own
  // sell-side investor status says the loan was purchased. A file sitting at Final
  // Docs has necessarily passed Purchasing Conditions; it has NOT necessarily been
  // bought, and marking it so would be a confident wrong answer on the one fact
  // this step exists to state.
  { key: 'milestones.purchasedName', group: 'Workflow', label: 'The "purchased" step',
    type: 'string', default: 'Purchased',
    description: 'What to call the step that means the investor has bought this loan. '
      + 'It is OURS — Encompass has no milestone for it.',
    evidence: 'The tenant\'s 19 Encompass milestones carry no purchase step; the owner\'s own '
      + 'workflow does (owner-directed 2026-08-23).' },
  { key: 'milestones.purchasedAfter', group: 'Workflow', label: 'It comes after',
    type: 'string', default: 'Purchasing Conditions',
    description: 'Which Encompass milestone the purchased step follows in the ladder. A name this '
      + 'tenant does not have puts the step at the END rather than dropping it.',
    evidence: 'Purchasing Conditions (16 of 19) is where the buyer\'s post-purchase conditions are '
      + 'worked, so the purchase itself lands on its heels.' },
  { key: 'milestones.purchasedStatusFieldId', group: 'Workflow', label: 'Investor status field',
    type: 'fieldId', default: '2031',
    description: 'The Encompass field that says what the investor has done with this loan.',
    evidence: 'Field 2031, loan.rateLock.sellSideInvestorStatus — a READ-ONLY Encompass dropdown '
      + '(Unassigned / Assigned - Bulk / Assigned - Flow / Shipped / Purchased / Rejected), filled '
      + 'on 100% of loans at Investor Delivery, Purchasing Conditions and Final Docs, and reading '
      + '"Purchased" on 187 of the 188 loans that carry it (772-loan census, 2026-08-14).' },
  { key: 'milestones.purchasedStatusValues', group: 'Workflow', label: 'Values that mean PURCHASED',
    type: 'list', default: ['Purchased'],
    description: 'Which values of that field mean the investor has bought the loan. Anything else '
      + 'the field says means it has NOT.',
    evidence: 'Of the six values Encompass allows, exactly one — "Purchased" — is the sale. '
      + '"Shipped" and the two "Assigned" values are the loan on its way there.' },
  { key: 'milestones.purchaseAdviceDateFieldId', group: 'Workflow', label: 'Purchase advice date field',
    type: 'fieldId', default: '2370',
    description: 'Where the DATE the investor bought the loan is recorded. Without it the step '
      + 'still reads as reached and simply says the date is not known.',
    evidence: 'Field 2370, "Purchase Advice Date" — filled on 175 of the 490 long-term loans, the '
      + 'same population as the investor status (176), and 100% at the three post-delivery '
      + 'milestones.' },
  { key: 'milestones.purchasedConsumerStatus', group: 'Workflow', label: 'What the borrower sees',
    type: 'string', default: 'Funded',
    description: 'The borrower-facing wording for the purchased step. It deliberately matches the '
      + 'other post-closing steps: who bought the loan is not the borrower\'s business.',
    evidence: 'All five post-closing milestones (Investor Delivery through Completion) carry the '
      + 'consumer wording "Funded" in Encompass\'s own catalog (db/547). The investor-name rule '
      + '(CLAUDE.md rule 10) forbids any client-facing hint of who the buyer is.' },

  // ── What the mirror is allowed to bring in ────────────────────────────────
  //
  // Owner-directed 2026-08-23: *"make sure it's only gonna pull according to our
  // rule: only long-term files."*
  //
  // Discovery asks Encompass for the WHOLE book, because no folder separates the
  // two products at the source — 772 loans, of which 251 are fix-and-flip and are
  // not ours. Up to now every one of them was mirrored and sorted out afterwards.
  // These two settings are what stop that: a loan the RULE PROVES is short-term is
  // never written and never read, and one already in the book is never listed.
  { key: 'sync.mirrorShortTerm', group: 'Sync', label: 'Bring short-term (RTL) loans in too',
    type: 'boolean', default: false,
    description: 'OFF means a loan our own rule proves is short-term is never mirrored — it is not '
      + 'written, and no Encompass call is spent reading it. A loan the rule CANNOT place is still '
      + 'brought in: refusing to mirror what we cannot classify would make files disappear with '
      + 'nothing saying so.',
    evidence: 'The tenant\'s book is 772 loans — 490 long-term and 251 short-term (product-term.js '
      + 'over the 2026-08-14 census). Mirroring the short-term half cost 251 loan reads per full '
      + 'pass and put files on the long-term side that were never ours.' },
  { key: 'pipeline.hideShortTerm', group: 'Pipeline', label: 'Hide short-term (RTL) files from the pipeline',
    type: 'boolean', default: true,
    description: 'A loan the rule proves is short-term is left off the long-term pipeline. It is '
      + 'still COUNTED in the census, so totals reconcile against Encompass and nothing vanishes '
      + 'without a trace — it simply stops appearing on a screen it does not belong on.',
    evidence: 'Owner-directed 2026-08-23. Needed as well as the mirror rule, because a short-term '
      + 'loan pulled in before that rule existed is already in the book.' },

  // ── Conditions ────────────────────────────────────────────────────────────
  { key: 'conditions.model', group: 'Conditions', label: 'Condition model',
    type: 'enum', default: 'enhanced', options: ['enhanced', 'legacy'],
    description: 'Enhanced Conditions (v3) or the legacy per-type endpoints.',
    evidence: 'The legacy v1 endpoints answer 200 with an empty array on all 772 loans; the v3 '
      + 'Enhanced Conditions endpoint returns the real 348 conditions.',
    notWired: NW_SETTLED_RULE },
  { key: 'conditions.openStatuses', group: 'Conditions', label: 'Statuses that count as OPEN',
    type: 'list', default: ['Added', 'Requested', 'Received', 'Rejected'],
    description: 'Which condition statuses appear on an outstanding-conditions list.',
    evidence: 'Live statuses: Added 195, Cleared 124, Fulfilled 12, Waived 11, Rejected 4, '
      + 'Received 1, Requested 1. The condition also carries a statusOpen boolean — prefer it '
      + 'when present and use this list as the fallback.',
    notWired: 'Not in use yet, and deliberately so: the centre ranks on `status_open` — Encompass\'s own answer — and never on the status word. Seven words were observed here and a buyer can add more, so a list parsed into a ranking would silently mis-sort the first time somebody did.' },
  { key: 'conditions.satisfiedStatuses', group: 'Conditions', label: 'Statuses that count as SATISFIED',
    type: 'list', default: ['Cleared', 'Fulfilled', 'Waived'], description: 'Closed-out statuses.',
    notWired: 'Not in use yet, for the same reason as the OPEN list: a condition is done when Encompass says it is done, never when its status word appears in a list we keep.' },
  { key: 'conditions.priorToGates', group: 'Conditions', label: 'Prior-to gates',
    type: 'list', default: ['Submittal', 'Approval', 'Docs', 'Closing', 'Funding', 'Purchase'],
    description: 'The gates a condition can block, earliest first.',
    evidence: 'Observed on live conditions and in the 197 condition templates.',
    notWired: NW_NOT_BUILT },
  { key: 'conditions.categories', group: 'Conditions', label: 'Condition categories',
    type: 'list', default: ['Property', 'Credit', 'Income', 'Assets', 'Legal', 'Miscellaneous'],
    evidence: 'The six categories used across the 197 templates.',
    description: 'How conditions are grouped.',
    notWired: 'Not in use yet, deliberately: the centre groups conditions by `prior_to` — Encompass\'s OWN answer to which gate a condition blocks — because that is the grouping the work actually follows. A second grouping kept here would eventually disagree with theirs about the same condition.' },
  { key: 'conditions.defaultSet', group: 'Conditions', label: 'Default condition set for long-term',
    type: 'string', default: 'DSCR MASTER SET (YSCAP)',
    description: 'The condition set a new long-term file starts from.',
    evidence: 'One of 19 sets in the tenant. Investor-specific DSCR sets also exist '
      + '(DEEPHAVEN, AMERICAN HERITAGE LENDING, OAK TREE, NQM FUNDING).',
    notWired: NW_NOT_BUILT },
  { key: 'conditions.borrowerFacingText', group: 'Conditions', label: 'Text shown to the borrower',
    type: 'enum', default: 'externalDescription', options: ['externalDescription', 'internalDescription', 'title'],
    description: 'Which field to show outward on a borrower or TPO condition list.',
    evidence: 'internalDescription carries staff notes and internal reference codes; '
      + 'externalDescription is the borrower-facing wording, and printDefinitions says whether '
      + 'a condition may be shown externally at all.',
    notWired: NW_NOT_BUILT },

  // ── eFolder ───────────────────────────────────────────────────────────────
  { key: 'efolder.linkDirection', group: 'eFolder', label: 'Document ↔ condition link',
    type: 'enum', default: 'document-holds-conditions', options: ['document-holds-conditions', 'condition-holds-documents'],
    description: 'Which side of the relationship stores the link.',
    evidence: 'document.conditions[] holds the EnhancedCondition references. There is no '
      + 'condition→documents endpoint; the mapping must be inverted on read.',
    notWired: NW_SETTLED_RULE },
  { key: 'efolder.receivedStatuses', group: 'eFolder', label: 'Statuses meaning "we have it"',
    type: 'list', default: ['received', 'reviewed', 'ready for UW', 'ready to ship'],
    evidence: 'Live document statuses across 20,569 rows.', description: 'Document statuses that count as in-hand.' },
  { key: 'efolder.outstandingStatuses', group: 'eFolder', label: 'Statuses meaning "still needed"',
    type: 'list', default: ['needed', 'ordered', 'reordered', 'expected', 'expected!', 'expired!'],
    description: 'Document statuses that belong on a chase list.',
    notWired: 'Not in use yet, deliberately: "still wanted" is everything that is not IN HAND, so this would be a second list beside the received one — and a status nobody recognised must count as outstanding, because an unfamiliar word is not evidence that a document arrived.' },
  { key: 'efolder.writesEnabled', group: 'eFolder', label: 'Allow uploads into Encompass',
    type: 'boolean', default: false,
    description: 'Master switch for the owner-authorized eFolder upload + condition link. Ships OFF: '
      + 'the write path is authorized but not yet implemented or verified against a live loan.',
    evidence: 'Owner-authorized 2026-08-14; recorded in docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md.',
    notWired: 'Not in use yet — the upload itself is BLOCKED. Its request and response shapes are recorded as unverified on docs/ENCOMPASS-WRITE-AUTHORIZATIONS.md, so no code may write to the eFolder; this is the switch that half will read once the shapes are confirmed against a live loan.' },

  // ── Connection ────────────────────────────────────────────────────────────
  { key: 'api.baseUrl', group: 'Connection', label: 'Encompass API base',
    type: 'string', default: 'https://api.elliemae.com', description: 'API host.',
    notWired: NW_ENV },
  { key: 'api.tokenScope', group: 'Connection', label: 'OAuth scope',
    type: 'string', default: 'lp',
    description: 'The scope requested at the token endpoint.',
    evidence: 'encompass_admin is REFUSED for this client id — the token endpoint answers '
      + '"the requested scope … exceeds that which the client is permitted".',
    notWired: NW_ENV },
  { key: 'api.minGapMs', group: 'Connection', label: 'Minimum gap between calls (ms)',
    type: 'number', default: 350,
    description: 'Self-imposed pacing so we never crowd the shared tenant.',
    notWired: NW_ENV },
  { key: 'api.preferredVersion', group: 'Connection', label: 'Preferred API version',
    type: 'enum', default: 'v3', options: ['v3', 'v1'],
    description: 'Which API generation to use by default.',
    evidence: 'v1 attachment endpoints are being sunset in ICE release 26.3. Conditions only '
      + 'work correctly on v3. A few reads (loan associates) still only answer on v1.',
    notWired: NW_ENV },

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

  // ── Compensation (owner-directed 2026-08-23) ──────────────────────────────
  // The pricing engine's compensation OVERLAY — display math on top of Lender Price,
  // which stays searched borrower-paid on every mode. The five figures resolve through
  // src/longterm/comp-plan.js: a person's own row wins over the company's value, which
  // wins over these declared defaults; the two lender fees are company-only. Changing
  // the COMPANY values is super-admin only (routes/settings.js SUPERADMIN_KEYS) — the
  // owner's words: "you need to set superadmin settings to control the company
  // defaults". The three points figures are also PERSONAL_KEYS, so a loan officer sets
  // their own on the personal screen.
  { key: 'comp.lenderPaid', group: 'Compensation', label: 'Lender-paid compensation (points)',
    type: 'number', default: 2.0,
    description: 'On a lender-paid search the board shows the raw price minus this many points: '
      + 'raw 102 shows as 100 (par), the investor pays the compensation, and the borrower pays '
      + 'no origination. Company default; each loan officer may set their own on the personal '
      + 'settings screen. Super admin only at the company level.',
    evidence: 'Owner-directed 2026-08-23: "Lender-paid compensation company default is going to '
      + 'be 2.0 … the raw pricing is going to show 102. It is going to show 100, which is par."' },
  { key: 'comp.borrowerPaid', group: 'Compensation', label: 'Borrower-paid compensation (points)',
    type: 'number', default: 2.0,
    description: 'On a borrower-paid search this is charged as ORIGINATION on the fee list; the '
      + 'board keeps the raw price (less any YSP). Company default; each loan officer may set '
      + 'their own, down or up. Super admin only at the company level.',
    evidence: 'Owner-directed 2026-08-23: "Borrower-paid compensation should also have a company '
      + 'default of two points … any loan officer that wants can decrease or increase."' },
  { key: 'comp.ysp', group: 'Compensation', label: 'YSP on borrower-paid searches (points)',
    type: 'number', default: 0,
    description: 'A yield-spread premium a loan officer may take ON TOP of borrower-paid '
      + 'origination: the displayed price drops by this many points and nothing on the fee list '
      + 'says why. Company default is zero; each loan officer sets their own.',
    evidence: 'Owner-directed 2026-08-23: raw 100.25 with a 0.25 YSP "is going to show only as '
      + '100 … adding a charge on the fee breakdown for two points origination only and keeping '
      + 'the YSP invisible."' },
  { key: 'comp.applicationFee', group: 'Compensation', label: 'Application fee ($)',
    type: 'number', default: 1595,
    description: 'The flat application fee on every DSCR file’s fee list. Company-wide — not a '
      + 'personal setting. Super admin only.',
    evidence: 'Owner-directed 2026-08-23: "always a $1,595 application fee".' },
  { key: 'comp.commitmentFee', group: 'Compensation', label: 'Commitment fee ($)',
    type: 'number', default: 500,
    description: 'The flat commitment fee on every DSCR file’s fee list. Company-wide — not a '
      + 'personal setting. Super admin only.',
    evidence: 'Owner-directed 2026-08-23: "and a $500 commitment fee".' },

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
  { key: 'contacts.pilotRoles', group: 'Contacts', label: 'Roles WE assign (Encompass has nobody for them)',
    type: 'list', default: ['file_setup'],
    description: 'Loan-team roles PILOT owns. Encompass never names them, so nothing read from '
      + 'Encompass may create, refresh or remove one — they are assigned here and stay here.',
    evidence: 'Owner-directed 2026-08-23: *"the workflow assignment on Encompass doesn\'t have '
      + 'anyone for file setup. It has processors, it has closers, it has funders, and it has '
      + 'officers. This one should be the starter of the file … the loan officer submits it to '
      + 'the processor, it goes to her workflow to set it up, and she is setting up the file."* '
      + 'Verified against the live tenant: its role list carries Loan Coordinator, Loan Processor, '
      + 'Underwriter, Closer, Funder and Post Closer, and no setup role at all.' },
  { key: 'contacts.fileSetupDefault', group: 'Contacts', label: 'Who sets a file up by default',
    type: 'string', default: 'Chaya Gruber',
    description: 'The person every long-term file starts assigned to for setup. An email address '
      + 'or a full name; whoever it names must be an active member of staff. It only ever FILLS an '
      + 'empty slot — it can never move a file somebody has already assigned.',
    evidence: 'Owner-directed 2026-08-23. A name (or an email) rather than an account id on '
      + 'purpose: an id is meaningless in any database but the one it came from, so a settings '
      + 'value carrying one would silently assign nobody the day this is set up anywhere else.' },
  { key: 'contacts.roleLabels', group: 'Contacts', label: 'What we call each role on screen',
    type: 'map',
    default: {
      file_setup: 'File setup',
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
      'processor', 'conditions', 'lock_status', 'expected_closing',
    ],
    description: 'Which columns the long-term pipeline shows, in order.' },
  { key: 'pipeline.inactiveFolders', group: 'Pipeline', label: 'Loan folders whose files are CLOSED (finished deals, funded included)',
    type: 'list',
    // ANSWERED BY THE OWNER 2026-08-23 (§11 q13). Until this date the default was []
    // and nothing was hidden from anybody, because which folder means "over" is a
    // business rule nobody here may guess. It is no longer a guess.
    default: ['Corr Post Purchase', 'Broker CLOSED RECONCILED', 'Broker CLOSED'],
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

  // ── The withdrawn book (owner-directed 2026-08-23) ────────────────────────
  // *"The canceled and withdrawn files should be in another view … It shouldn't be
  // mixing them up, just keeping status separately."*
  //
  // A deal that COMPLETED and a deal that DIED are different facts. Folding both into
  // one "not live" bucket is the mixing the owner ruled out, and it is not cosmetic:
  // a funded loan is revenue and a withdrawn one is a lost opportunity, and a desk
  // counting "closed files" wants the first without the second.
  { key: 'pipeline.withdrawnFolders', group: 'Pipeline', label: 'Loan folders whose files were WITHDRAWN or CANCELLED',
    type: 'list',
    default: ['Withdrawn files'],
    suggestFrom: 'loanFolders',
    description: 'Encompass loan folders holding deals that died — withdrawn, cancelled, declined. '
      + 'These get their own view, separate from both the active pipeline and the closed book, '
      + 'so a finished deal is never counted alongside a lost one. A folder on BOTH this list '
      + 'and the closed list is treated as withdrawn, because that is the more specific claim.',
    evidence: 'Owner-directed 2026-08-23, answering §11 q13: "Withdrawn files - this is with '
      + 'withdrawn and canceled files." 35 of the 772 files in the 2026-08-14 census sit there.' },

  // ── Folders that are not a book at all (owner-directed 2026-08-23) ────────
  // "Training - this is the training folder that you can ignore", "Prospect - this is
  // a prospect folder that you can ignore", "Pre-Approval - which you can also ignore
  // for now."
  //
  // HIDDEN IS NOT THE SAME AS FINISHED, which is why this is a third list and not more
  // entries on the closed one. A training file is not a deal in any state; putting it
  // in the closed book would inflate a number somebody reports.
  { key: 'pipeline.excludedFolders', group: 'Pipeline', label: 'Loan folders to hide entirely (not a real deal)',
    type: 'list',
    default: ['Training', 'Prospect', 'Pre-Approval'],
    suggestFrom: 'loanFolders',
    description: 'Encompass loan folders that are not real deals at all — training files, '
      + 'prospects, pre-approvals. Hidden from every pipeline view and from the borrower, but '
      + 'STILL COUNTED in the census, so the totals continue to reconcile against Encompass. '
      + 'This list loses to the other two: a folder named here AND on one of them still shows, '
      + 'because a configuration mistake must not make a file vanish from every screen.',
    evidence: 'Owner-directed 2026-08-23: Training (9 files), Prospect (7) and Pre-Approval (1) '
      + 'are each "you can ignore" in the owner\'s own words. 17 of 772 in the 2026-08-14 census.' },

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

  // THE BORROWER'S OWN SWITCH — BUILT READY, AND NOW ON.
  //
  // The owner (2026-08-16): *"The borrower should also have, in their login, the
  // option to switch from long-term to short-term."* Asked whether to turn it on,
  // they answered *"build it ready"* — so it was wired end to end and left off.
  // On 2026-08-17 they said *"turn switch on"*, and the default below is `true`.
  //
  // This comment still said "AND SWITCHED OFF" until 2026-08-18, directly above a
  // declaration that reads `default: true`. The `evidence` field beneath it had
  // been updated and the heading had not, which is the more dangerous half: a
  // reader who trusts headings and skims fields gets the opposite of the truth
  // about what a client can see.
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

  // ── The COMBINED PRICING ENGINE (owner-directed 2026-08-30) ───────────────
  // One row per investor: what we call them for a client, which of the two
  // pricing programs their products are fetched from, and whether they are on.
  //
  // A `map`, so the generic settings screen shows it READ-ONLY as JSON — which is
  // right: this is edited on the Combined Pricing Engine's own settings screen,
  // where each investor is a row with a picker rather than a brace somebody can
  // mistype. Declaring it here is what gives it a home in the ONE settings store
  // and puts it on the "what has this lender changed?" list.
  //
  // The DEFAULT IS EMPTY on purpose. The pre-fills — every investor's white-label
  // name, Lender Price as the source, NQM/Acra/eResi on LoanNEX, Button Finance
  // off — are DERIVED in `pricing/investor-settings.js` from the investor
  // registry and the white-label sheet. Copying them here would be a second copy
  // of a roster that already exists, and the one that drifts is the one somebody
  // prices a loan on. This map holds only what a person has deliberately CHANGED.
  { key: 'pricing.combinedInvestors', group: 'Pricing', label: 'Combined engine — investor settings',
    type: 'map', default: {},
    description: 'Per investor: { source: "lenderprice" | "loannex" | "both", enabled: true|false, '
      + 'whiteLabel: "..." }. Only deliberate changes are stored; everything else falls back to the '
      + 'pre-fill derived from the investor registry.',
    evidence: 'Owner-directed 2026-08-30: "You should open a settings menu where you have every '
      + 'single investor listed… For every investor, we can always switch it from where we want to '
      + 'take the information."' },
  // "THIS INVESTOR AND THIS INVESTOR ARE THE SAME" — the human-recorded overlay
  // (owner-directed 2026-08-30: *"we need to be able to link a investor from
  // lender price and loannex by if the name is a little different the system
  // should still understand that it's the same investor… Those investors are
  // spelled differently and have different names, but we need to be able to link
  // it and say, 'This investor and this investor are the same.'"*).
  //
  // WHY THIS EXISTS AND NOT JUST A BIGGER REGISTRY: identity came from the code
  // registry alone, so a spelling it did not carry resolved to nothing, the merge
  // dropped that row, and the investor's WHOLE BOARD disappeared with the only fix
  // being a code change. This is the door a person can open. The map is keyed on
  // the vendor's spelling and points at a CANONICAL investor key — a link may
  // never invent an investor or rename one, and a key nobody knows is refused at
  // the settings door rather than stored as though it had worked.
  //
  // EMPTY BY DEFAULT, for the same reason as the map above: nothing here is a
  // second copy of the registry, only what a person has deliberately decided.
  { key: 'pricing.investorLinks', group: 'Pricing', label: 'Combined engine — investor links',
    type: 'map', default: {},
    description: 'Per vendor spelling: { key: "<canonical investor key>", source: "lenderprice" | '
      + '"loannex", linkedBy, linkedAt }. A link outranks every registry match, so a person\'s '
      + 'decision beats a lookup; the label always comes from the canonical investor.',
    evidence: 'Owner-directed 2026-08-30: "We should be able to link them together side by side '
      + 'and then select this one. Want to see from this program."' },
  // -- Term sheets ----------------------------------------------------------
  // The officer-side term sheet (owner-directed 2026-08-30: *"we want to be able
  // also on the staff side to enable the term sheet option from today"*). The
  // BORROWER side of the pricing engine is a later phase and nothing here
  // switches it on.
  { key: 'termSheet.officerEnabled', group: 'Term sheets', label: 'Officer term sheets',
    type: 'boolean', default: true,
    description: 'Off: the Term sheet and Compare controls do not appear on the pricing '
      + 'board. On: an officer can issue a term sheet from a priced quote.',
    // SWITCHED ON 2026-08-30, owner-directed ("turn it on"), the same day the officer side
    // merged. It shipped OFF for one deploy so the merge changed nothing anybody could see.
    // Flipping the DECLARED DEFAULT is what turns it on everywhere, and it is safe precisely
    // because `store.save` DELETES a value equal to the declared default rather than storing
    // it: `false` has been the default since this key was written, so no tenant can be
    // holding a deliberate `false` for it to overrule. An admin turning it off from here on
    // stores a real deviation, which then wins.
    // STAFF ONLY, structurally: every route that reads this key sits under /api/lt, which is
    // mounted requireAuth + requireStaff. The BORROWER side of the pricing engine is a
    // separate switch and nothing here touches it.
    evidence: 'Owner-directed 2026-08-30 - the officer side may go live now; the borrower '
      + 'side waits on the prepayment-penalty work. Switched on the same day, on the '
      + 'owner\'s own instruction.' },
  { key: 'termSheet.expiryHours', group: 'Term sheets', label: 'A TERM SHEET is good for (hours)',
    type: 'number', default: 24,
    description: 'Hours from issue until a single-program TERM SHEET says it has expired, '
      + 'and the number the sheet prints on its own face. Nothing is deleted when it does - '
      + 'an expired sheet still replays, and says it is expired.',
    evidence: 'Owner-directed 2026-08-30 - "it should also say that it is expiring in 24 hours."' },
  { key: 'termSheet.expiryDays', group: 'Term sheets', label: 'A COMPARISON is good for (days)',
    type: 'number', default: 2,
    description: 'Days from issue until a comparison or scenario comparison says it has '
      + 'expired. A comparison is a working document rather than an offer, so it runs on a '
      + 'longer clock than a term sheet.' },
  { key: 'termSheet.cartMax', group: 'Term sheets', label: 'Options in one comparison',
    type: 'number', default: 8,
    description: 'The most options one comparison may hold. Past this it stops being a '
      + 'comparison and becomes a catalogue.' },
  { key: 'termSheet.pricedApartMinutes', group: 'Term sheets', label: 'Say when options were priced apart',
    type: 'number', default: 60,
    description: 'When the options on one comparison were priced further apart than this, '
      + 'the sheet states it - they reflect the market as it stood at each of those moments.' },
  { key: 'termSheet.companyName', group: 'Term sheets', label: 'Company name on the sheet',
    type: 'string', default: 'YS Capital Group',
    description: 'The name at the top of every term sheet.' },
  { key: 'termSheet.companyNmls', group: 'Term sheets', label: 'Company NMLS on the sheet',
    type: 'string', default: '2609746',
    description: 'Printed beside the company name.' },
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
