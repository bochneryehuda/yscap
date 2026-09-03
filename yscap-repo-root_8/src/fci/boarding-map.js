'use strict';
/**
 * WHAT PILOT PUTS IN EVERY FCI BOARDING FIELD — the decision table behind the Start Servicing
 * button. RTL only (owner-confirmed 2026-08-21: "It's only RTL").
 *
 * `insertBoarding` is how a closed loan becomes a loan FCI services, and it takes 146 fields. This
 * file answers, for every one of them, the only question that matters: WHERE DOES THE VALUE COME
 * FROM? Each row names a PILOT column, a derivation, a constant, a value only the owner holds, a
 * figure that lives in the loan documents and no database, or an open question. Nothing here is a
 * guess dressed as an answer — a field nobody can source yet is `ASK`, and `ASK` blocks boarding.
 *
 * THIS FILE HOLDS DECISIONS. IT DOES NOT HOLD THE FIELD LIST. The field list is FCI's, extracted
 * from their published collection into docs/fci/BOARDING-FIELDS.md by
 * scripts/fci-boarding-fields.js. scripts/test-fci-boarding-map-pure.js proves the two cover each
 * other EXACTLY: a field FCI adds cannot go unmapped, and a row here cannot name a field that does
 * not exist. That is the whole point of keeping them apart — a hand-maintained list of 146 field
 * names would be wrong the day FCI ships v9, and wrong silently.
 *
 * IT IS DATA, NOT AN INTEGRATION. No database, no network, no credential, no FCI call. It cannot
 * board a loan; it describes what boarding one would send. The builder that turns a PILOT file into
 * a payload comes later and reads this — and it must refuse to build a payload while any required
 * field is still ASK.
 *
 * THE THREE NUMBERS THE OWNER NAMED, and where they land (asked 2026-08-26: "the holdback, the
 * outstanding balance, the initial release"):
 *
 *   PILOT sizes every RTL loan as, exactly:
 *       totalLoan = initialAdvance + rehabHoldback + financedReserve      (src/lib/pricing.js)
 *   whole dollars, floored, reconciling to the cent.
 *
 *   - the INITIAL RELEASE is `initialAdvance` — what left the table at closing
 *   - the HOLDBACK is `rehabHoldback` (+ `financedReserve` when the deal financed its interest)
 *   - the OUTSTANDING BALANCE at boarding is the initial release, on a non-Dutch loan
 *
 *   FCI HAS NO HOLDBACK FIELD. This is the single most important finding of the mapping and it is
 *   not a gap in our reading — `maximumDraw`, `drawAvailableBalance`, `fundedAmount` and
 *   `drawStatus` all exist on FCI's READ side (getLoanPortfolio) and NONE of them exists on
 *   `insertBoarding`. So either FCI derives the ceiling from the balances we send, or their
 *   boarding department keys it from the documents we upload. Which one decides whether a draw
 *   loan boards correctly through the API at all, and it is question B1 below.
 */

/**
 * HOW A ROW IS SOURCED.
 *
 *   PILOT     a named column or a derivation over named columns — the value already exists here
 *   CONSTANT  the same value on every RTL loan; `value` carries it
 *   OWNER     only the owner holds it (FCI account numbers, the trust account, the fee schedule)
 *   DOCUMENT  it is in the executed note and in no database — someone must key it once per file
 *   OMIT      deliberately not sent, with a reason
 *   ASK       genuinely unresolved. BLOCKS BOARDING. Every one is a numbered question below.
 */
const KINDS = Object.freeze(['PILOT', 'CONSTANT', 'OWNER', 'DOCUMENT', 'OMIT', 'ASK']);

const f = (block, field, kind, source, note) => Object.freeze({ block, field, kind, source, note });

/* ─────────────────────────────────────────────────────────────────────────────
   loan — the note itself
   ───────────────────────────────────────────────────────────────────────────── */

const LOAN = [
  // ── identity and the accounts the loan hangs off ──────────────────────────
  f('loan', 'prevAccount', 'PILOT', 'applications.ys_loan_number',
    'OUR loan number, carried into FCI\'s "previous account" slot. This is also the field that '
    + 'would collapse the whole matching problem: if the loans already at FCI carry it, matching by '
    + 'address stops being necessary and becomes a lookup. Question A1.'),
  f('loan', 'lenderAccount', 'OWNER', 'FCI lender account number',
    'Which of our FCI lender accounts the loan boards under. One per pool/entity; the owner has the list.'),
  f('loan', 'originalVendor', 'OWNER', 'FCI broker/vendor account number',
    'Appears in FCI\'s folder documentation and bulk form but NOT in their saved single request — so '
    + 'whether the single-loan mutation accepts it is unproven. It is the account the interest strip pays.'),
  f('loan', 'trustAccount', 'OWNER', 'FCI trust account name',
    'A free-text NAME, not an id ("FCI - Pool 1 Trust Account" in FCI\'s sample). Exact spelling matters '
    + 'and only the owner has it. Also required, separately, inside setFundings.'),

  // ── dates ─────────────────────────────────────────────────────────────────
  f('loan', 'originationDate', 'PILOT', 'applications.actual_closing', 'The date the note was signed.'),
  f('loan', 'fundingDate', 'PILOT', 'applications.funded_date',
    'Encompass is the authority here (CX.FUNDEDDATE) and PILOT mirrors it. On a table-funded loan this '
    + 'is the day the note buyer\'s money moved, which is not always the closing date.'),
  f('loan', 'firstPaymentDate', 'PILOT', 'applications.first_payment_date', null),
  f('loan', 'maturityDate', 'PILOT', 'applications.maturity_date',
    'applications.original_maturity_date holds the pre-extension date; the CURRENT maturity is what boards.'),
  f('loan', 'paidToDate', 'ASK', null,
    'On a brand-new loan nothing has been paid, so "paid to" is a convention, not a fact. FCI\'s own '
    + 'sample sends a date. Sending the wrong one moves the first accrual period. Question B2.'),
  f('loan', 'nextDueDate', 'PILOT', 'applications.first_payment_date',
    'At boarding the next due date IS the first payment date. It only diverges once payments post, '
    + 'and after that FCI owns it, not us.'),

  // ── balances — see the header block ───────────────────────────────────────
  f('loan', 'originalBalance', 'ASK', 'quote:totalLoan OR quote:initialAdvance',
    'THE decision. Dutch (noteType 20) accrues on the full note amount from day one, which argues for '
    + 'totalLoan; non-Dutch accrues only on money actually released, which argues for initialAdvance. '
    + 'Getting this wrong bills the borrower interest on money they never received. Question B1.'),
  f('loan', 'principalBalance', 'ASK', 'quote:initialAdvance',
    'The balance outstanding the day it boards. Reads as the initial release on a non-Dutch loan — but '
    + 'only if originalBalance means the full note, otherwise the two collapse. Question B1.'),
  f('loan', 'startingBalance', 'ASK', null,
    'FCI sends 0 in every published sample and never documents it. Untouched until FCI says what it is. '
    + 'Question B1.'),
  f('loan', 'payment', 'ASK', 'derive(principal x noteRate / 12) on interest-only',
    'Whether FCI wants the scheduled payment or computes it from the terms. Sending a figure that '
    + 'disagrees with their own arithmetic is how a borrower gets billed two different numbers. Question B3.'),
  f('loan', 'paymentImpound', 'CONSTANT', '0',
    'RTL does not escrow. Confirmed by every escrow field below also being 0.'),

  // ── rate ──────────────────────────────────────────────────────────────────
  f('loan', 'noteRate', 'PILOT', 'applications.rate_pct',
    'The BORROWER\'s rate. Not the investor\'s — the difference between them is the strip, below.'),
  f('loan', 'defaultRate', 'DOCUMENT', 'the executed note',
    'The default rate is in the note and in no PILOT column. One of the ~30 document-only fields.'),
  f('loan', 'spreadRate', 'PILOT', 'derive(noteRate - investorRate)',
    'THE INTEREST STRIP. What we keep when the loan is sold and someone else holds the paper. On a loan '
    + 'we still own there is no strip and this is 0 — which makes it a live signal, not a static field: '
    + 'it changes the day the loan sells. src/lib/release-party.js already answers sold/not_sold and must '
    + 'not be re-answered here.'),

  // ── what kind of loan this is ─────────────────────────────────────────────
  f('loan', 'lienPosition', 'CONSTANT', '1',
    'RTL is first-lien. A second would be a different product and should not reach this button.'),
  f('loan', 'loanType', 'ASK', null,
    'FCI publishes NO legend for loanType — it appears in their documentation sample and bulk form with '
    + 'the value 1 and is explained nowhere. Distinct from noteType, which is documented. Question B4.'),
  f('loan', 'noteType', 'PILOT', 'applications.accrual_type -> 20 dutch / 19 non_dutch',
    'DRAW_LOAN_DUTCH = 20, DRAW_LOAN_NON_DUTCH = 19. This is the field that finally gives '
    + 'applications.accrual_type its stated future use, and it must agree with the balances above: a '
    + 'Dutch note that boards non-Dutch under-bills for the life of the loan.'),
  f('loan', 'rateType', 'CONSTANT', '1',
    'FIXED_RATE. RTL notes do not float.'),
  f('loan', 'amortizationType', 'CONSTANT', '3',
    'INTEREST_ONLY. NOTE THE HAZARD: FCI publishes two AmortizationType legends that CONTRADICT each '
    + 'other, and the other one reads 3 differently. Confirm before the first live board.'),
  f('loan', 'paymentFrequency', 'CONSTANT', '1', 'MONTHLY.'),
  f('loan', 'primaryPurpose', 'CONSTANT', '1',
    'BUSINESS. Every RTL loan is business-purpose — that is what keeps it out of consumer lending, and '
    + 'it is the same fact that makes the borrower an entity rather than a person.'),
  f('loan', 'accruedMethod', 'ASK', null,
    'DUE_TO_DUE_FIXED / DUE_TO_DUE_ACTUAL / RECEIVED_TO_RECEIVED. Changes the interest on every '
    + 'irregular month. The note says how interest accrues; which of FCI\'s three that maps to is '
    + 'a servicing decision. Question B5.'),
  f('loan', 'is365DayYears', 'DOCUMENT', 'the executed note',
    'Actual/365 vs 30/360 — in the note. With is30DayMonths this is the day-count convention, and it '
    + 'moves real money every month.'),
  f('loan', 'is30DayMonths', 'DOCUMENT', 'the executed note', 'See is365DayYears.'),
  f('loan', 'negativeToPrincipal', 'ASK', null,
    'What FCI does with a shortfall. Unexplained in their documentation. Question B5.'),

  // ── escrows and impounds: RTL escrows nothing ─────────────────────────────
  f('loan', 'paymentPropertyTax', 'CONSTANT', '0', 'RTL does not escrow taxes — the borrower pays them.'),
  f('loan', 'paymentSchoolTax', 'CONSTANT', '0', null),
  f('loan', 'paymentCityTax', 'CONSTANT', '0', null),
  f('loan', 'paymentWaterSewerTax', 'CONSTANT', '0', null),
  f('loan', 'paymentTownshipTax', 'CONSTANT', '0', null),
  f('loan', 'paymentOtherTax', 'CONSTANT', '0', null),
  f('loan', 'withheldPropertyTax', 'CONSTANT', '0', null),
  f('loan', 'withheldHazardInsurance', 'CONSTANT', '0',
    'PILOT tracks hazard insurance as a CONDITION, not as an escrow — we require the policy, we do not '
    + 'collect for it.'),
  f('loan', 'withheldWindInsurance', 'CONSTANT', '0', null),
  f('loan', 'withheldFloodInsurance', 'CONSTANT', '0',
    'Flood is ordered and tracked (it is the one authorized Encompass write) but never escrowed.'),
  f('loan', 'reservePropertyTax', 'CONSTANT', '0', null),
  f('loan', 'reserveSchoolTax', 'CONSTANT', '0', null),
  f('loan', 'reserveCityTax', 'CONSTANT', '0', null),
  f('loan', 'reserveWaterSewerTax', 'CONSTANT', '0', null),
  f('loan', 'reserveTownshipTax', 'CONSTANT', '0', null),

  // ── late charges: all in the note ─────────────────────────────────────────
  f('loan', 'lateChargesDays', 'DOCUMENT', 'the executed note', 'The grace period before a late charge attaches.'),
  f('loan', 'lateChargesPct', 'DOCUMENT', 'the executed note', null),
  f('loan', 'lateChargesMin', 'DOCUMENT', 'the executed note', null),
  f('loan', 'lateChargeMax', 'DOCUMENT', 'the executed note',
    'Note FCI\'s own inconsistent naming — lateCharge_Max_ singular against lateCharge_s_Min. Spelling '
    + 'it their way is not optional.'),
  f('loan', 'lateChargesDaily', 'DOCUMENT', 'the executed note', null),
  f('loan', 'noPyramiding', 'DOCUMENT', 'the executed note',
    'Whether a late charge can be charged on a late charge.'),
  f('loan', 'lateChargesPostMaturity', 'DOCUMENT', 'the executed note',
    'Whether late charges keep running after maturity. On RTL, where files routinely run past maturity '
    + 'into an extension, this one is not academic.'),
  f('loan', 'lateChargesLenderPct', 'OWNER', 'the FCI servicing agreement',
    'How a late charge SPLITS between lender, vendor and FCI. That is the servicing agreement, not the note.'),
  f('loan', 'lateChargesVendorPct', 'OWNER', 'the FCI servicing agreement', null),
  f('loan', 'lateChargesCompanyMaxDist', 'OWNER', 'the FCI servicing agreement', null),

  // ── default interest: 24 fields, all in the note or the agreement ─────────
  f('loan', 'defaultIntIsEnabled', 'DOCUMENT', 'the executed note', 'Whether the note carries default interest at all.'),
  f('loan', 'defaultIntRate', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntEnableMaturity', 'DOCUMENT', 'the executed note',
    'Whether maturity alone triggers the default rate — the RTL case that actually happens.'),
  f('loan', 'defaultIntTypeCalculation', 'ASK', null, 'Undocumented enum. Question B6.'),
  f('loan', 'defaultIntUseCustomDate', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntDays', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntOptionDays', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntDateFrom', 'ASK', null, 'Undocumented enum. Question B6.'),
  f('loan', 'defaultCustomDateFrom', 'ASK', null,
    'Undocumented enum, and the only defaultInt* field NOT prefixed defaultInt — easy to mistype. Question B6.'),
  f('loan', 'defaultIntEffectiveDays', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntEffectiveOptionDays', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntEffectiveDateFrom', 'ASK', null, 'Undocumented enum. Question B6.'),
  f('loan', 'defaultIntModifier', 'ASK', null, 'Undocumented. Question B6.'),
  f('loan', 'defaultIntAllowLateCharges', 'DOCUMENT', 'the executed note',
    'Whether a loan already at the default rate ALSO takes late charges.'),
  f('loan', 'defaultIntActiveDaily', 'DOCUMENT', 'the executed note', null),
  f('loan', 'defaultIntLastEffectiveStatus', 'OMIT', null,
    'The last-* fields describe default interest ALREADY RUNNING on an existing loan. A loan boarding '
    + 'off our closing table has no history, so sending them would invent one.'),
  f('loan', 'defaultIntLastImplementationDate', 'OMIT', null, 'See defaultIntLastEffectiveStatus.'),
  f('loan', 'defaultIntLastEffectiveDate', 'OMIT', null, 'See defaultIntLastEffectiveStatus.'),
  f('loan', 'defaultIntLastTopDate', 'OMIT', null, 'See defaultIntLastEffectiveStatus.'),
  f('loan', 'defaultIntLenderPct', 'OWNER', 'the FCI servicing agreement', 'The default-interest split.'),
  f('loan', 'defaultIntVendorPct', 'OWNER', 'the FCI servicing agreement', null),
  f('loan', 'defaultIntCompanyMaxDist', 'OWNER', 'the FCI servicing agreement', null),

  // ── who may authorise what, after boarding ────────────────────────────────
  f('loan', 'approvalPayoff', 'OWNER', 'BROKER | LENDER | EITHER | BOTH',
    'Set AT BOARDING and it governs the rest of the loan\'s life: who FCI will take a payoff instruction '
    + 'from. On a loan we sell later, "lender" becomes someone else — which is why this interacts with '
    + 'the sale and is question C1.'),
  f('loan', 'approvalChangeFeesTerms', 'OWNER', 'BROKER | LENDER | EITHER | BOTH', 'Who may change fees or terms.'),
  f('loan', 'approvalReinstatement', 'OWNER', 'BROKER | LENDER | EITHER | BOTH',
    'THE SPELLING IS UNPROVEN. FCI\'s saved request says approvalReinstatement; their own documentation '
    + 'and enum legend say approvaleReinstatement, with the stray "e". One is rejected by the server and '
    + 'we cannot tell which without a live call. Question B7.'),
  f('loan', 'approvaleReinstatement', 'ASK', null,
    'The documentation\'s spelling of the row above. Listed so the choice is visible rather than silently '
    + 'made. Exactly one of the two ships. Question B7.'),
  f('loan', 'approvalStartForeclosure', 'OWNER', 'BROKER | LENDER | EITHER | BOTH', 'Who may start foreclosure.'),
];

/* ─────────────────────────────────────────────────────────────────────────────
   setBorrower — on RTL this is an ENTITY, not a person
   ───────────────────────────────────────────────────────────────────────────── */

const BORROWER = [
  f('setBorrower', 'isCompany', 'CONSTANT', 'true',
    'RTL is business-purpose and vests in an entity. A personal-name purchase '
    + '(applications.personal_name_purchase) is the exception and must not board on this path '
    + 'unexamined — question D1.'),
  f('setBorrower', 'company', 'PILOT', 'llcs.llc_name via applications.llc_id',
    'The vesting entity. PILOT\'s llcs table holds corporations, partnerships and trusts too, despite '
    + 'the name. Encompass field 1859 is the closing-document authority and reconciles against it.'),
  f('setBorrower', 'tin', 'PILOT', 'llcs.ein',
    'SENSITIVE. The entity\'s EIN. Note what is NOT used: borrowers.ssn_encrypted is a person\'s SSN, it '
    + 'lives behind an audited view_ssn gate, and it must not leave PILOT on this path. If the EIN is '
    + 'missing the loan does not board — it is not something to substitute around. Question D1.'),
  f('setBorrower', 'tinType', 'CONSTANT', '0',
    'EIN. Pairs with tin above; an entity TIN typed as an SSN would be wrong at the IRS, not just here.'),
  f('setBorrower', 'firstName', 'PILOT', 'borrowers.first_name',
    'The guarantor behind the entity. Whether FCI wants the signer here at all when isCompany is true, '
    + 'or a second setBorrower entry, is question D2.'),
  f('setBorrower', 'middleName', 'PILOT', 'borrowers.middle_name', null),
  f('setBorrower', 'lastName', 'PILOT', 'borrowers.last_name', null),
  f('setBorrower', 'contactName', 'PILOT', 'borrowers.full_name',
    'Who FCI talks to about this loan. The generated full_name column already assembles it.'),
  f('setBorrower', 'street', 'PILOT', 'borrowers.mailing_address ?? borrowers.current_address',
    'The BORROWER\'s address, deliberately not the property\'s — statements go where the borrower reads '
    + 'mail, and on a fix-and-flip the property is a building site.'),
  f('setBorrower', 'city', 'PILOT', 'borrowers.mailing_address ?? borrowers.current_address', null),
  f('setBorrower', 'state', 'PILOT', 'borrowers.mailing_address ?? borrowers.current_address', null),
  f('setBorrower', 'zipCode', 'PILOT', 'borrowers.mailing_address ?? borrowers.current_address', null),
  f('setBorrower', 'email', 'PILOT', 'borrowers.email', null),
  f('setBorrower', 'mobilePhone', 'PILOT', 'borrowers.cell_phone',
    'PILOT holds ONE phone number per borrower. It is a mobile, so it maps here and the other two '
    + 'phone fields go empty rather than repeating it.'),
  f('setBorrower', 'homePhone', 'OMIT', null, 'PILOT holds no home phone. Repeating the mobile would invent a fact.'),
  f('setBorrower', 'workPhone', 'OMIT', null, 'PILOT holds no work phone.'),
  f('setBorrower', 'fax', 'OMIT', null, 'PILOT holds no fax number.'),
  f('setBorrower', 'isPrimary', 'CONSTANT', 'true', 'The vesting entity is the primary borrower.'),
  f('setBorrower', 'deliveryOptions', 'ASK', null,
    'PRINT / EMAIL / PRINT_AND_EMAIL / NEVER — this decides whether FCI mails or emails the borrower '
    + 'statements. It is NOT one of our notifications, it is FCI\'s own borrower contact, and the owner '
    + 'has said not to set up automatic notifications. So it is not being chosen here. Question D3.'),
];

/* ─────────────────────────────────────────────────────────────────────────────
   setLenders — who holds the paper. Entirely the owner's, entirely internal.
   ───────────────────────────────────────────────────────────────────────────── */

const LENDERS = [
  f('setLenders', 'account', 'OWNER', 'FCI lender account number',
    'Must equal loan.lenderAccount and setFundings.lenderAccount — three fields, one account, and FCI '
    + 'will not reconcile them for us.'),
  f('setLenders', 'firstName', 'OWNER', 'the lending entity\'s name as FCI already holds it',
    'FCI splits a name across three fields even when the lender is a company. How our entity name is '
    + 'already spelled in their system is what has to be matched — not how we would spell it.'),
  f('setLenders', 'middleName', 'OWNER', 'the lending entity\'s name as FCI already holds it', null),
  f('setLenders', 'lastName', 'OWNER', 'the lending entity\'s name as FCI already holds it', null),
  f('setLenders', 'street', 'OWNER', 'the lending entity\'s address of record at FCI', null),
  f('setLenders', 'city', 'OWNER', 'the lending entity\'s address of record at FCI', null),
  f('setLenders', 'state', 'OWNER', 'the lending entity\'s address of record at FCI', null),
  f('setLenders', 'zipCode', 'OWNER', 'the lending entity\'s address of record at FCI', null),
  f('setLenders', 'tin', 'OWNER', 'the lending entity\'s EIN', 'SENSITIVE. Ours, not a borrower\'s.'),
  f('setLenders', 'email', 'OWNER', 'the servicing contact address we want FCI to use', null),
  f('setLenders', 'homePhone', 'OWNER', 'the lending entity\'s phone of record at FCI', null),
  f('setLenders', 'workPhone', 'OWNER', 'the lending entity\'s phone of record at FCI', null),
  f('setLenders', 'mobilePhone', 'OWNER', 'the lending entity\'s phone of record at FCI', null),
  f('setLenders', 'fax', 'OWNER', 'the lending entity\'s fax of record at FCI', null),
];

/* ─────────────────────────────────────────────────────────────────────────────
   setProperties — the collateral
   ───────────────────────────────────────────────────────────────────────────── */

const PROPERTIES = [
  f('setProperties', 'street', 'PILOT', 'applications.usps_address ?? applications.property_address',
    'USPS-verified first. This is the same address the matching logic compares on, and using one source '
    + 'for both is what keeps a boarded loan findable afterwards.'),
  f('setProperties', 'city', 'PILOT', 'applications.usps_address ?? applications.property_address', null),
  f('setProperties', 'state', 'PILOT', 'applications.usps_address ?? applications.property_address', null),
  f('setProperties', 'zipCode', 'PILOT', 'applications.usps_address ?? applications.property_address',
    'The ZIP is the authority over the locality — address.sameAddress already works that way and this '
    + 'must not disagree with it.'),
  f('setProperties', 'county', 'PILOT', 'address_canon_cache.county',
    'Resolved when the address was canonicalised. Missing on files never canonicalised — which is a '
    + 'reason to canonicalise, not a reason to guess a county.'),
  f('setProperties', 'type', 'PILOT', 'applications.property_type -> FCI property type',
    'LOSSY IN OUR DIRECTION. Our range-category (SFR / Multi 2-4 / Multi 5+ / Condo / Townhouse / Mixed '
    + 'Use) is coarser than FCI\'s 26 types, and "Multi 5+" is genuinely ambiguous between '
    + 'RESIDENTIAL_INCOME_5 = 7 and APARTMENT_COMPLEX_5_PLUS = 8. Question D4.'),
  f('setProperties', 'occupancyStatus', 'CONSTANT', '4',
    'INVESTOR. Business-purpose RTL by definition — the borrower does not live there. A file where they '
    + 'do is not this product.'),
  f('setProperties', 'description', 'OMIT', null,
    'Free text FCI shows to nobody we can identify. The address already says what the property is.'),
  f('setProperties', 'isPrimary', 'CONSTANT', 'true',
    'True for the FIRST property. A cross-collateralised file has several, only one is primary, and '
    + 'applications.ref_cross_collateralized / ref_multi_property already flag those — question D5.'),
];

/* ─────────────────────────────────────────────────────────────────────────────
   setFundings — the money split: whose funds, whose fees, whose rate
   ───────────────────────────────────────────────────────────────────────────── */

const FUNDINGS = [
  f('setFundings', 'lenderAccount', 'OWNER', 'FCI lender account number', 'Must equal loan.lenderAccount.'),
  f('setFundings', 'trustAccount', 'OWNER', 'FCI trust account name', 'Must equal loan.trustAccount.'),
  f('setFundings', 'funds', 'ASK', 'quote:initialAdvance OR quote:totalLoan',
    'How much this lender funded. Follows whatever originalBalance turns out to mean — the two cannot '
    + 'disagree. Question B1.'),
  f('setFundings', 'agreementeTemplateEnumValue', 'OWNER',
    'BASIC_LIMITED | HIGH_TOUCH_LIMITED | HIGH_TOUCH_FULL | BASIC_FULL_COLLECTION',
    'Which servicing agreement this loan runs under. It decides how much collection work FCI does, which '
    + 'is exactly the question of who chases a late borrower — and that bears on the reminder ladder.'),
  f('setFundings', 'rateType', 'CONSTANT', '1',
    'FIXED_RATE. FCI publishes no legend for the FUNDING block\'s rateType; this reuses the loan-level '
    + 'RateType legend by name, which the generated inventory flags as our inference, not FCI\'s word.'),
  f('setFundings', 'rateValue', 'PILOT', 'derive(noteRate - spreadRate) = the investor rate',
    'What the money-holder earns. noteRate - rateValue is the strip, so this and loan.spreadRate are two '
    + 'views of one fact and must reconcile.'),
  f('setFundings', 'brokerFeePct', 'OWNER', 'the FCI servicing agreement', 'FCI\'s fee schedule, not ours to infer.'),
  f('setFundings', 'brokerFeeFlat', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerFeeMin', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerFeeFlatNPerf', 'OWNER', 'the FCI servicing agreement',
    'The NON-PERFORMING rate — what FCI charges once the loan goes bad. Higher, by design.'),
  f('setFundings', 'brokerFeeMinNPerf', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'vendorFeePct', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'vendorFeeFlat', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'vendorFeeMin', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerResFee', 'OWNER', 'the FCI servicing agreement', 'Reinstatement fees.'),
  f('setFundings', 'brokerResAddFee', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerResAddDays', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerResAddFee_2', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerResAddDays_2', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerResAddFee_3', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'brokerResAddDays_3', 'OWNER', 'the FCI servicing agreement', null),
  f('setFundings', 'roundError', 'ASK', null, 'Undocumented. FCI sends true. Question B8.'),
  f('setFundings', 'gSTaxUse', 'ASK', null,
    'Undocumented, and the capital S makes it easy to mistype. FCI sends true. Question B8.'),
];

const BOARDING_MAP = Object.freeze([].concat(LOAN, BORROWER, LENDERS, PROPERTIES, FUNDINGS));

/**
 * THE OPEN QUESTIONS, grouped by who can answer them. Every ASK row above points at one of these,
 * and the test proves that pointer resolves — a question can neither vanish while a field still
 * cites it nor sit here unreferenced.
 *
 * A-questions collapse work if the answer is yes. B-questions are FCI's to answer and block the
 * first live board. C- and D-questions are the owner's.
 */
const QUESTIONS = Object.freeze([
  Object.freeze({ id: 'A1', who: 'FCI or the owner', blocks: 'matching',
    ask: 'Do the loans already at FCI carry our loan number in prevAccount, originatorLoanNumber or '
       + 'investorAssetNumber? If yes, matching by address stops being necessary — it becomes a lookup, '
       + 'and the largest piece of this work disappears. This is a five-minute check against one report.' }),
  Object.freeze({ id: 'B1', who: 'FCI', blocks: 'every draw loan',
    ask: 'On a draw loan, is originalBalance the FULL note amount or the initial release? What is '
       + 'startingBalance? And since insertBoarding has no holdback field at all while getLoanPortfolio '
       + 'returns maximumDraw and drawAvailableBalance — how does FCI learn the draw ceiling? Do they key '
       + 'it from the documents we upload?' }),
  Object.freeze({ id: 'B2', who: 'FCI', blocks: 'the first accrual period',
    ask: 'What should paidToDate be on a brand-new loan that has never taken a payment?' }),
  Object.freeze({ id: 'B3', who: 'FCI', blocks: 'the borrower\'s bill',
    ask: 'Does FCI want the scheduled payment amount, or does it compute the payment from the terms? If '
       + 'we send one and they compute another, the borrower gets two different numbers.' }),
  Object.freeze({ id: 'B4', who: 'FCI', blocks: 'boarding',
    ask: 'What is loanType, and how does it differ from noteType? It appears in FCI\'s documentation with '
       + 'the value 1 and no legend anywhere.' }),
  Object.freeze({ id: 'B5', who: 'FCI', blocks: 'interest on every irregular month',
    ask: 'Which accruedMethod matches an interest-only RTL note, and what does negativeToPrincipal do?' }),
  Object.freeze({ id: 'B6', who: 'FCI', blocks: 'default interest',
    ask: 'The default-interest enums — defaultIntTypeCalculation, defaultIntDateFrom, defaultCustomDateFrom, '
       + 'defaultIntEffectiveDateFrom, defaultIntModifier — are published with sample values and no legends. '
       + 'What are the permitted values?' }),
  Object.freeze({ id: 'B7', who: 'FCI', blocks: 'boarding',
    ask: 'approvalReinstatement or approvaleReinstatement? FCI\'s saved request uses the first, their '
       + 'documentation and enum legend the second. One of them the server rejects.' }),
  Object.freeze({ id: 'B8', who: 'FCI', blocks: 'the funding split',
    ask: 'What are roundError and gSTaxUse? Both are sent as true in every FCI sample and documented nowhere.' }),
  Object.freeze({ id: 'C1', who: 'the owner', blocks: 'boarding a loan we intend to sell',
    ask: 'The four approval settings are fixed AT BOARDING and govern the loan for life. When we sell a '
       + 'loan the lender of record changes — should a loan we intend to sell board with different '
       + 'approvals than one we intend to keep?' }),
  Object.freeze({ id: 'D1', who: 'the owner', blocks: 'any entity-less file',
    ask: 'A personal-name purchase has no EIN. Should those board at all on this button, and if so, whose '
       + 'TIN goes in — noting that a borrower SSN sits behind an audited gate and would be leaving PILOT?' }),
  Object.freeze({ id: 'D2', who: 'the owner', blocks: 'the borrower block',
    ask: 'When the borrower is an entity, does the guarantor go into FCI as a second borrower, or does only '
       + 'the entity board?' }),
  Object.freeze({ id: 'D3', who: 'the owner', blocks: 'borrower contact',
    ask: 'deliveryOptions decides whether FCI mails or emails the borrower their statements. That is FCI '
       + 'contacting the borrower, not us. PRINT, EMAIL, both, or never?' }),
  Object.freeze({ id: 'D4', who: 'the owner', blocks: 'multi-family files',
    ask: 'Our "Multi 5+" category maps to two different FCI types — RESIDENTIAL_INCOME_5 (7) and '
       + 'APARTMENT_COMPLEX_5_PLUS (8). Which?' }),
  Object.freeze({ id: 'D5', who: 'the owner', blocks: 'cross-collateralised files',
    ask: 'A cross-collateralised file has several properties and one loan. Does it board as one FCI loan '
       + 'with several setProperties entries, and which one is primary?' }),
]);

module.exports = Object.freeze({ BOARDING_MAP, QUESTIONS, KINDS });
