'use strict';
/**
 * DOCLAB (Private Lender Law) API v3.1 — THE CATALOG.
 *
 * Everything DocLab publishes about itself, as data: the document statuses, the
 * response codes, the loan categories, the prepayment option codes, the fee
 * templates, the whole variable dictionary, and which variable each RTL template
 * actually uses. PURE — no database, no network, no config. It is the one place
 * this integration is allowed to state a DocLab fact.
 *
 * WHY A CATALOG AT ALL. DocLab has exactly THREE required fields (lender_name,
 * loan_category, state) and treats every other variable as optional — a missing
 * one does not fail, it silently produces a loan document with a blank in it, or
 * it comes back days later as a "moreInfo" request from a person at PLL. That is
 * the opposite of a validation error: nothing errors, and a security instrument
 * gets drafted with a hole in it. So PILOT has to know, BEFORE it submits, which
 * variables THIS template needs — and the only published statement of that is the
 * per-template matrix. Encoding it is what lets us refuse to submit an incomplete
 * package instead of discovering it at the closing table.
 *
 * WHERE EVERY VALUE IN THIS FILE COMES FROM — all of it is committed alongside:
 *   · docs/doclab/reference/json-key-matrix.csv        → MATRIX / DSCR_ONLY_KEYS
 *   · docs/doclab/reference/data-dictionary-full.csv   → VARIABLES
 *   · docs/doclab/reference/loan-product-names.csv     → LOAN_CATEGORIES
 *   · docs/doclab/reference/Master_3.1.3.1.jsonc       → the payload shape
 *   · docs/doclab/DOCLAB-API-REFERENCE-V3.1.md         → statuses, codes, fees
 * `scripts/test-doclab-catalog-pure.js` re-reads those CSVs and fails if this file
 * has drifted from them, so the reference data and the code cannot disagree. When
 * PLL ships a new dictionary, replace the CSV and re-run the test — it will tell
 * you exactly what moved.
 *
 * NOTHING HERE IS GUESSED. A fact the source documentation does not state is
 * absent, or carried with `confirmed: false` and said out loud. The one thing this
 * integration must never do is invent a value that ends up printed on a mortgage.
 */

/* ────────────────────────────── the API itself ────────────────────────────── */

const API_VERSION = '3.1';

/**
 * The document life-cycle. `code` is DocLab's own numeric status code (their
 * "Document Status Codes" table); `name` is what the API actually returns in the
 * `status` field, which is camelCase and NOT the capitalised label in their docs —
 * so every read normalises through `statusOf()` rather than comparing strings.
 *
 * `terminal` means the request will not move again on its own. Note `completed` is
 * the ONLY happy terminal state: `approved` means the Word documents are being
 * generated, and `wordGenerated` means they exist but the PDF does not yet.
 *
 * `error` is deliberately NOT terminal — their own docs give it two causes ("a
 * variable is missing" and "a PDF failed to generate"), and both are recoverable
 * by re-submitting, so a poller must keep watching it.
 */
const STATUS = Object.freeze({
  temp:          { code: 10, terminal: false, label: 'Temp',          meaning: 'Received, but no template matched the lender + category + state. A PLL person has to assign one.' },
  initiated:     { code: 20, terminal: false, label: 'Initiated',     meaning: 'Created with no variables filled in.' },
  moreInfo:      { code: 30, terminal: false, label: 'MoreInfo',      meaning: 'PLL reviewed it and needs more information. Read the issues, fix the payload, update.' },
  submitted:     { code: 40, terminal: false, label: 'Submitted',     meaning: 'Every required value is present. Waiting to be approved.' },
  error:         { code: 50, terminal: false, label: 'Error',         meaning: 'A variable is missing, or a PDF failed to generate.' },
  approved:      { code: 60, terminal: false, label: 'Approved',      meaning: 'Approved — the Word documents are being generated.' },
  rejected:      { code: 70, terminal: true,  label: 'Rejected',      meaning: 'A PLL person rejected the request. Outside the normal flow.' },
  wordGenerated: { code: null, terminal: false, label: 'WordGenerated', meaning: 'The Word documents exist. A PDF can now be generated from them.' },
  completed:     { code: 80, terminal: true,  label: 'Completed',     meaning: 'The PDF loan documents have been generated and can be downloaded.' },
});

/**
 * `WordGenerated` appears in their Notification Flow status table but is missing
 * from their Document Status Codes table, so it has no published number. We do not
 * invent one — a null code is the honest answer, and nothing keys on the number.
 */
const STATUS_NAMES = Object.freeze(Object.keys(STATUS));

/** DocLab's own API response codes (their "API Response Codes" table). */
const RESPONSE_CODE = Object.freeze({
  200: 'Success',
  201: 'Created',
  401: 'Unauthorized',
  404: 'Not Found',
  500: 'Error',
  601: 'Not Allowed',
  602: 'Invalid',
  701: 'Comment Added',
});

/**
 * Root-level `license_type`. Their migration note: "10 → Licensed, 20 → Exception,
 * null → Not required". The Lender/Category endpoint reports `licenseNeeded` per
 * STATE, which is what decides whether this may be null on a given file.
 */
const LICENSE_TYPE = Object.freeze({
  LICENSED: 10,
  EXCEPTION: 20,
  NOT_REQUIRED: null,
});

/* ───────────────────────────── the loan categories ───────────────────────────── */

/**
 * Every loan category DocLab publishes, with the renaming they are moving to
 * ("Loan Product Name Mapping (Current → New)") and which side of OUR house it
 * belongs to.
 *
 * `track` is ours, not theirs: 'rtl' is the bridge / holdback / construction /
 * commercial family this build is for, 'dscr' is the 30-year rental family that is
 * explicitly OUT of scope (owner-directed — see docs/doclab/DOCLAB-RTL-SCOPE.md).
 * `src/doclab/scope.js` refuses a 'dscr' category structurally; this is only where
 * the classification is recorded.
 *
 * `category` is the string that goes in `template.loan_category` VERBATIM. The
 * alternate name is documentation, NOT an alias to send — DocLab selects a template
 * by exact lender + category + state, and which of the two spellings OUR tenant is
 * configured under is a question only the Lender/Category endpoint can answer.
 */
const LOAN_CATEGORIES = Object.freeze([
  { category: '12 Month',                  altName: 'Stabilized Bridge 1 to 4', track: 'rtl',  holdback: false, note: 'Stabilized bridge, 1–4 unit.' },
  { category: '12 Month with Holdback',    altName: 'Bridge Rehab 1 to 4',      track: 'rtl',  holdback: true,  note: 'Bridge + rehab holdback, 1–4 unit.' },
  { category: 'Ground Up Construction',    altName: 'Ground Up Construction',   track: 'rtl',  holdback: true,  note: 'Listed as a loan product, but it has NO column in the published per-template matrix — its required-variable set is unconfirmed.' },
  { category: 'NY Building Loan',          altName: 'NY Building Loan',         track: 'rtl',  holdback: true,  note: 'New York building loan. The only template that needs section / block / lot / district.' },
  { category: 'CEMA RTL',                  altName: 'NY CEMA RTL',              track: 'rtl',  holdback: false, note: 'NY consolidation, extension and modification. Matrix column is "CEMA Acquisition Building Loan".' },
  { category: 'Commercial',                altName: 'Stabilized Bridge 5+ Unit', track: 'rtl', holdback: false, note: 'Stabilized bridge, 5+ unit.' },
  { category: 'Commercial with Holdback',  altName: 'Bridge Rehab 5+',          track: 'rtl',  holdback: true,  note: 'Bridge + rehab holdback, 5+ unit.' },
  { category: 'DSCR SFR',                  altName: 'DSCR SFR 1 to 4',          track: 'dscr', holdback: false, note: 'Out of scope for the RTL build.' },
  { category: 'DSCR Portfolio',            altName: 'DSCR Portfolio 1 to 4',    track: 'dscr', holdback: false, note: 'Out of scope for the RTL build.' },
  { category: 'CEMA DSCR',                 altName: 'CEMA DSCR',                track: 'dscr', holdback: false, note: 'Out of scope for the RTL build.' },
  { category: 'Commercial DSCR SFR',       altName: 'DSCR 1 to 4',              track: 'dscr', holdback: false, note: 'Out of scope for the RTL build.' },
  { category: 'Commercial DSCR Portfolio', altName: 'DSCR Portfolio 5+',        track: 'dscr', holdback: false, note: 'Out of scope for the RTL build.' },
  { category: 'DSCR - 30 Year Single Family Rental', altName: null,             track: 'dscr', holdback: false, note: 'Named in their MVP template list. Out of scope for the RTL build.' },
]);

/* ──────────────────────────── prepayment option codes ──────────────────────────── */

/**
 * Every option code DocLab lists. `prepayment_option_code` is a REQUIRED root
 * field — their migration note says so twice — so an RTL submission still has to
 * carry one even though this build wants no prepayment penalty. That is what
 * `RTL_CODES.none` is for.
 *
 * WHICH ONE IS VALID IS DECIDED BY THE STATE, NOT BY US. Prepayment penalties are
 * state-regulated and DocLab publishes a per-state list at
 * `GET /v3.1/loanprocess/getPrepaymentOptions/{stateName}` — a code that is not on
 * that state's list is refused. So this array is the universe of codes, never the
 * answer for a file: the answer is the intersection of this and the live list.
 *
 * `PPPTest` is in their published table and is plainly a test fixture. It is kept
 * so the catalog matches the source, and classified so it can never be selected.
 */
const PREPAYMENT_OPTION_CODES = Object.freeze({
  rtl: Object.freeze(['RTL-Yes', 'RTL-No']),
  dscr: Object.freeze([
    'DSCR-No', 'DSCR-5/4/3/2/1', 'DSCR-3/2/1', 'DSCR-3/3/3', 'DSCR-1/1/1', 'DSCR-1/1/1/1/1',
    'DSCR-3/2/1/1/1', 'DSCR-5/5/5/5/5', 'DSCR-4/3/2/1', 'DSCR-2/1', 'DSCR-5/5/4/4/3/2/1',
    'DSCR-5/4/3/1/1', 'DSCR-4/4/4/4', 'DSCR-4/3/3/2', 'DSCR-5/5/5', 'DSCR-5/5', 'DSCR-3/3',
    'DSCR-2/2', 'DSCR-2/2/2', 'DSCR-1/1', 'DSCR-5/5/5/4/3', 'DSCR-1', 'DSCR-2', 'DSCR-3',
    'DSCR-4', 'DSCR-5',
  ]),
  test: Object.freeze(['PPPTest']),
});

/**
 * The two RTL codes, named. `none` is what an RTL file sends: it satisfies the
 * required field while asking DocLab for no prepayment clause. `withPenalty` is
 * recorded because it exists, and is deliberately NOT wired to anything.
 */
const RTL_CODES = Object.freeze({ none: 'RTL-No', withPenalty: 'RTL-Yes' });

/**
 * `RTL-Yes` needs `prepayment_penalty_date` inside the `pre_payment_penalty` array
 * — their Prepayment Penalty page says so explicitly. `RTL-No` needs nothing, but
 * their migration note still says the array "is required and must contain at least
 * one value, even if the selected option does not utilize it."
 */
const PREPAYMENT_REQUIRED_VARIABLES = Object.freeze({
  'RTL-Yes': Object.freeze(['prepayment_penalty_date']),
  'RTL-No': Object.freeze([]),
});

/* ────────────────────────────────── the fees ────────────────────────────────── */

/**
 * Fee templates, from their Dynamic Fees page and the data dictionary's own
 * "template names that can be included in the loan packages" section.
 *
 * SINGLE vs MULTIPLE is a real structural difference, not a preference: a SINGLE
 * fee template has its own specific paragraph of legal language and may appear at
 * most ONCE in a package; a MULTIPLE (`Standard Fee`) template repeats one generic
 * sentence with a different name and amount each time, which is how an arbitrary
 * named fee ("Radon Testing", "Finders Fee") gets into the documents at all.
 *
 * `sort_order` in the payload is shared across BOTH arrays — the master payload
 * numbers its seven single fees 1–7 and then its one multiple-fee group 8 — so it
 * is one sequence over the whole `fees` object, not one per array.
 */
const SINGLE_FEE_TEMPLATES = Object.freeze([
  { template: 'Legal Fee',           description: 'Legal counsel fee charged to borrower.' },
  { template: 'Prepaid Interest',    description: 'Interest paid in advance at closing, covering funding date to the first regular payment.' },
  { template: 'Origination Fee',     description: 'Fee charged for processing the loan.' },
  { template: 'Interest Reserve',    description: 'Amount of interest prepaid on the loan, if any.' },
  { template: 'Initial Draw Fee',    description: 'Fee for processing the first disbursement.' },
  { template: 'Draw Set-Up Fee',     description: 'Fee to establish and manage the draw process at the start of the loan.' },
  { template: 'Subsequent Draw Fees', description: 'Fees for processing draw requests after the initial draw.' },
  { template: 'Appraisal Holdback',  description: 'Amount withheld until appraisal-related conditions are satisfied.' },
  { template: 'Exit Fee',            description: 'Fee charged when the loan is paid off or exits.' },
]);

const MULTIPLE_FEE_TEMPLATES = Object.freeze([
  { template: 'Standard Fee', description: 'Any additional named fee. Repeats once per fee, each with its own name and amount.' },
]);

/**
 * The legacy flat fee variables, and which dynamic fee template replaces each one.
 * From their Dynamic Fees table. `multiple: true` means it belongs inside a
 * `Standard Fee` group rather than being a single fee of its own.
 *
 * The flat variables still exist and the master payload still carries them — their
 * comment is "Not required if template supports dynamic fees". Which of the two a
 * given template wants is a per-template fact we do NOT have, so `payload.js` sends
 * the flat variables AND the fee array, exactly as their own master payload does.
 */
const DYNAMIC_FEE_KEYS = Object.freeze({
  interest_reserve:  { feeTemplate: 'Interest Reserve',    multiple: false },
  counsel_fee:       { feeTemplate: 'Legal Fee',           multiple: false },
  origination_fee:   { feeTemplate: 'Origination Fee',     multiple: false },
  prepaid_interest:  { feeTemplate: 'Prepaid Interest',    multiple: false },
  initial_draw_fee:  { feeTemplate: 'Initial Draw Fee',    multiple: false },
  draw_setup_fee:    { feeTemplate: 'Draw Set-Up Fee',     multiple: false },
  subsequent_draw_fee: { feeTemplate: 'Subsequent Draw Fees', multiple: false },
  funding_fee:       { feeTemplate: 'Standard Fee',        multiple: true, feeName: 'Funding Fee' },
  processing_fee:    { feeTemplate: 'Standard Fee',        multiple: true, feeName: 'Processing Fee' },
  underwriting_fee:  { feeTemplate: 'Standard Fee',        multiple: true, feeName: 'Underwriting Fee' },
  other_fee:         { feeTemplate: 'Standard Fee',        multiple: true, feeName: 'Other Fee' },
});

/* ──────────────────────────── the RTL template columns ──────────────────────────── */

/**
 * The fourteen RTL columns of the published per-template matrix, each with the
 * EXACT header it carries in `docs/doclab/reference/json-key-matrix.csv`. The short
 * code is what `MATRIX` below uses; the test resolves code → header and diffs the
 * whole thing against the CSV, so the two can never drift.
 *
 * `instrument` is the security instrument the column is for — a deed of trust
 * (DOT), a deed to secure debt (DTSD) or a mortgage (MTG). Which one a loan uses is
 * decided by the STATE, and DocLab picks it from the template; we never send it.
 *
 * The DSCR columns of the same matrix are deliberately absent. `Ground Up
 * Construction` has no column in the matrix at all — see LOAN_CATEGORIES.
 */
const RTL_TEMPLATES = Object.freeze([
  { code: '12M_DOT',    header: '12 Month DOT',                   category: '12 Month',                 instrument: 'DOT' },
  { code: '12M_DTSD',   header: '12 Month DTSD',                  category: '12 Month',                 instrument: 'DTSD' },
  { code: '12M_MTG',    header: '12 Month MTG',                   category: '12 Month',                 instrument: 'MTG' },
  { code: '12MHB_DOT',  header: '12 Month with Holdback DOT',     category: '12 Month with Holdback',   instrument: 'DOT' },
  { code: '12MHB_DTSD', header: '12 Month with Holdback DTSD',    category: '12 Month with Holdback',   instrument: 'DTSD' },
  { code: '12MHB_MTG',  header: '12 Month with Holdback MTG',     category: '12 Month with Holdback',   instrument: 'MTG' },
  { code: 'NYBL_MTG',   header: 'NY Building Loan - MTG',         category: 'NY Building Loan',         instrument: 'MTG' },
  { code: 'COM_DOT',    header: 'Commercial DOT',                 category: 'Commercial',               instrument: 'DOT' },
  { code: 'COM_DTSD',   header: 'Commercial DTSD',                category: 'Commercial',               instrument: 'DTSD' },
  { code: 'COM_MTG',    header: 'Commercial MTG',                 category: 'Commercial',               instrument: 'MTG' },
  { code: 'COMHB_DOT',  header: 'Commercial with holdback DOT',   category: 'Commercial with Holdback', instrument: 'DOT' },
  { code: 'COMHB_DTSD', header: 'Commercial with holdback DTSD',  category: 'Commercial with Holdback', instrument: 'DTSD' },
  { code: 'COMHB_MTG',  header: 'Commercial with holdback MTG',   category: 'Commercial with Holdback', instrument: 'MTG' },
  { code: 'CEMA_ABL',   header: 'CEMA Acquisition Building Loan', category: 'CEMA RTL',                 instrument: 'MTG' },
]);

/* ─────────────────────── GENERATED from the reference CSVs ───────────────────────
   Everything below this line is a faithful transcription of the committed CSVs.
   `scripts/test-doclab-catalog-pure.js` re-derives it and fails on any difference,
   so edit the CSV and re-run the test — never hand-edit one side only.
   ──────────────────────────────────────────────────────────────────────────────── */

const MATRIX = Object.freeze({
  'acknowledgement_corporate_status':        ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'amount_at_closing':                       ['12M_DTSD'],
  'block_number':                            ['NYBL_MTG', 'CEMA_ABL'],
  'borrower_address':                        ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'borrower_contribution':                   ['NYBL_MTG', 'CEMA_ABL'],
  'borrower_name':                           ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'borrower_state':                          ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'bylaws_operating_agreement':              ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'CEMA_ABL'],
  'certificate_number':                      ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG'],
  'collateral_property_address':             ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'collateral_property_county':              ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'CEMA_ABL'],
  'collateral_property_state':               ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'construction_holdback':                   ['12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'CEMA_ABL'],
  'date_of_closing':                         ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'district_number':                         ['NYBL_MTG', 'CEMA_ABL'],
  'draw_fee_amount':                         ['12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'CEMA_ABL'],
  'exit_fee_percentage':                     ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG'],
  'feeAmount (Dynamic_Fee)':                 ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'feeName (Dynamic_Fee)':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'first_day_of_month_plus_1_year':          ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'first_payment_date':                      ['COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'gap_loan_amount':                         ['CEMA_ABL'],
  'governing_law':                           ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'governing_law_all_caps':                  ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'guarantor_address':                       ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'guarantor_name':                          ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'guarantor_or_collectively_the_guarantor': ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_MTG', 'CEMA_ABL'],
  'individual_jointly_and_severally':        ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_MTG', 'CEMA_ABL'],
  'initial_advance':                         ['12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_MTG', 'COMHB_DOT', 'COMHB_MTG', 'CEMA_ABL'],
  'interest_rate':                           ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'last_day_of_the_month':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'last_day_to_draw':                        ['12MHB_DOT', '12MHB_DTSD', '12MHB_MTG'],
  'lender_address':                          ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'lender_name':                             ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'lender_name_all_caps':                    ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'lender_state':                            ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'lender_town_and_state':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'CEMA_ABL'],
  'lender_type_of_organization':             ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'loan_amount':                             ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'loan_id':                                 ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'loan_to_value_percent':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG'],
  'lot_number':                              ['NYBL_MTG', 'CEMA_ABL'],
  'maturity_date':                           ['12M_DTSD', '12MHB_DTSD', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'maturity_date_of_loan':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'membership_interest_percentage':          ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG'],
  'month_of_closing':                        ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'monthly_payment':                         ['CEMA_ABL'],
  'monthly_payment_date_begin':              ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'number_of_shares':                        ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG'],
  'pledgor':                                 ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'pledgor_address':                         ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG'],
  'pledgor_or_collectively_the_pledgor':     ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'CEMA_ABL'],
  'prepayment_penalty':                      ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'property_town':                           ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'purchase_refinance':                      ['NYBL_MTG', 'CEMA_ABL'],
  'purpose_of_loan':                         ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG'],
  'section_number':                          ['NYBL_MTG', 'CEMA_ABL'],
  'servicer_address':                        ['CEMA_ABL'],
  'servicer_name':                           ['CEMA_ABL'],
  'settlement_agent_name':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'settlement_agent_name_and_address':       ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'signatory_name':                          ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'signatory_title':                         ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'state_abbrev':                            ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'COM_DOT'],
  'title_agent':                             ['NYBL_MTG', 'CEMA_ABL'],
  'title_agent_name':                        ['NYBL_MTG', 'CEMA_ABL'],
  'title_agent_name_and_address':            ['NYBL_MTG', 'CEMA_ABL'],
  'trustee':                                 ['12M_DOT', '12MHB_DOT', 'COMHB_DOT'],
  'type_of_organization':                    ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'underwriter':                             ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
  'year_for_notary_block':                   ['12M_DOT', '12M_DTSD', '12M_MTG', '12MHB_DOT', '12MHB_DTSD', '12MHB_MTG', 'NYBL_MTG', 'COM_DOT', 'COM_DTSD', 'COM_MTG', 'COMHB_DOT', 'COMHB_DTSD', 'COMHB_MTG', 'CEMA_ABL'],
});

const DSCR_ONLY_KEYS = Object.freeze([
  'collateral_property_name',
  'grace_period_days',
  'initial_advance_upon_closing',
  'late_charge_percentage',
  'mers_number',
  'monthly_escrow_payments',
  'monthly_payment_with_escrows',
  'property_street_address',
  'state',
]);

const VARIABLES = Object.freeze({
  'borrower_address': { group: 'Borrower Information', version: '3.1.0', description: 'Complete mailing address of the borrower.' },
  'borrower_name': { group: 'Borrower Information', version: '3.1.0', description: 'Full legal name of the borrowing entity or individual.' },
  'borrower_state': { group: 'Borrower Information', version: '3.1.0', description: 'State where the borrowing entity is formed.' },
  'borrower_title': { group: 'Borrower Information', version: '3.1.0', description: 'Title or role of the borrower (e.g., "Managing Member", "President").' },
  'signatory_name (borrower)': { group: 'Borrower Information', version: '3.1.0', description: 'Name of the individual authorized to sign on behalf of the borrower.' },
  'signatory_title (borrower)': { group: 'Borrower Information', version: '3.1.0', description: 'Title of the borrower’s signatory (e.g., "CEO", "Authorized Representative").' },
  'collateral_property_address': { group: 'Collateral Property Details', version: '3.1.0', description: 'Full street address of the property used as collateral.' },
  'collateral_property_county': { group: 'Collateral Property Details', version: '3.1.0', description: 'County of the collateral property.' },
  'collateral_property_name': { group: 'Collateral Property Details', version: '3.1.0', description: 'Name or identifier of the collateral property (if applicable).' },
  'collateral_property_state': { group: 'Collateral Property Details', version: '3.1.0', description: 'State where the collateral property is located.' },
  'collateral_property_city': { group: 'Collateral Property Details', version: '3.1.1', description: 'City where the collateral property is located.' },
  'section_number': { group: 'Collateral Property Details', version: '3.1.1', description: 'Used to legally identify the property’s location within a survey system.' },
  'block_number': { group: 'Collateral Property Details', version: '3.1.1', description: 'Used to legally identify the property’s location within a survey system.' },
  'district_number': { group: 'Collateral Property Details', version: '3.1.1', description: 'Used to legally identify the property’s location within a survey system.' },
  'lot_number': { group: 'Collateral Property Details', version: '3.1.1', description: 'Used to legally identify the property’s location within a survey system.' },
  'state_abbrev': { group: 'Document Formatting', version: '3.1.0', description: 'Two-letter abbreviation of the state (e.g., "NY").' },
  'type_of_organization': { group: 'Document Formatting', version: '3.1.0', description: 'Legal structure of borrower or lender (e.g., LLC, Inc.).' },
  'year_for_notary_block': { group: 'Document Formatting', version: '3.1.0', description: 'Year to be printed in the notary acknowledgment section.' },
  'guarantor_address': { group: 'Guarator Information', version: '3.1.0', description: 'Complete mailing address of the guarantor.' },
  'guarantor_name': { group: 'Guarator Information', version: '3.1.0', description: 'Full legal name of the guarantor (individual or entity).' },
  'guarantor_title': { group: 'Guarator Information', version: '3.1.0', description: 'Title or role of the guarantor, if applicable.' },
  'signatory_name (guarantor)': { group: 'Guarator Information', version: '3.1.0', description: 'Name of the individual authorized to sign on behalf of the guarantor.' },
  'signatory_title (guarantor)': { group: 'Guarator Information', version: '3.1.0', description: 'Title of the guarantor’s signatory.' },
  'guarantor_or_collectively_the_guarantor': { group: 'Guarator Information', version: '3.1.0', description: 'if one guarantor: Guarantor, if multiple: collectively, the guarantor' },
  'pledgor': { group: 'Guarator Information', version: '3.1.0', description: 'Name of the individual/entity pledging collateral.' },
  'pledgor_address': { group: 'Guarator Information', version: '3.1.2', description: 'Address of the individual/entity pledging collateral.' },
  'pledgor_or_collectively_the_pledgor': { group: 'Guarator Information', version: '3.1.0', description: 'If one: Pledgor, if multiple: collectively, the pledgor' },
  'acknowledgement_corporate_status': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'FOR LLC: operating agreement and its members /FOR CORP: bylaws and its shareholders' },
  'amount_at_closing': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Initial advance of the loan' },
  'borrower_contribution': { group: 'Legal & Financial Terms', version: '3.1.4', description: '' },
  'bylaws_operating_agreement': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Boolean or file reference indicating if borrower entity documents are provided.' },
  'company_filing_status': { group: 'Legal & Financial Terms', version: '3.1.4', description: '' },
  'operating_agreement_or_bylaws': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'FOR LLC: operating agreement /FOR CORP: bylaws' },
  'certificate_number': { group: 'Legal & Financial Terms', version: '3.1.2', description: 'ID associated with a certificate tied to the loan or collateral' },
  'construction_holdback': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Amount held back for construction purposes, if applicable.' },
  'counsel_fee': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Legal counsel fee charged to borrower.' },
  'date_of_closing': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Date when the loan transaction is finalized.' },
  'orginal_closing_date': { group: 'Legal & Financial Terms', version: '3.1.4', description: '' },
  'default_rate_percent': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Interest rate applied upon borrower default.' },
  'funding_fee': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Fee for funding of the loan' },
  'gap_loan_amount': { group: 'Legal & Financial Terms', version: '3.1.4', description: 'The amount of funds in the loan amount which exceed the assigned loan in a CEMA. This figure represents the portion of the loan which the borrower will owe Mortgage Recording Tax on in New York' },
  'governing_law': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Jurisdiction whose laws govern the loan agreement.' },
  'governing_law_all_caps': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Same as above, but in uppercase for document formatting.' },
  'grace_period_days': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Number of days allowed before a late payment incurs penalties.' },
  'individual_jointly_and_severally': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Boolean indicating if individuals are liable jointly and severally.' },
  'initial_advance_upon_closing': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Initial advance of the loan' },
  'initial_advance': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Initial amount disbursed at closing.' },
  'interest_accrual': { group: 'Legal & Financial Terms', version: '3.1.4', description: '' },
  'interest_rate': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Annual interest rate of the loan.' },
  'interest_reserve': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Amount of interest prepaid on the loan, if any' },
  'last_day_of_the_month': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Boolean indicating if payments are due on the last day of the month.' },
  'last_day_to_draw': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Final date borrower can draw funds from the loan.' },
  'late_charge_percentage': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Percentage charged as a late fee.' },
  'legal_description': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Metes and bounds legal description of the real property.' },
  'legal_description_image': { group: 'Legal & Financial Terms', version: '3.1.1', description: 'Metes and bounds legal description of the real property.' },
  'membership_interest_percentage': { group: 'Legal & Financial Terms', version: '3.1.2', description: 'ownership percentage held by a member' },
  'monthly_payment': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Amount of the principal, interest monthly payment' },
  'monthly_escrow_payments': { group: 'Legal & Financial Terms', version: '3.1.3', description: 'This is the escrow portion of the payment, and can include property taxes, insurance, etc.' },
  'monthly_payment_with_escrow': { group: 'Legal & Financial Terms', version: '3.1.3', description: 'The total payment including principal, interest, and escrows' },
  'number_of_shares': { group: 'Legal & Financial Terms', version: '3.1.2', description: 'quantity of ownership shares held in a corporation or entity associated with the loan transaction.' },
  'prepayment_penalty': { group: 'Legal & Financial Terms', version: '3.1.0', description: 'Penalty if a loan is prepaid' },
  'prepayment_penalty_date': { group: 'Legal & Financial Terms', version: '3.1.1', description: 'date through which a prepayment penalty applies' },
  'lender_address': { group: 'Lender Information', version: '3.1.0', description: 'Full mailing address of the lender.' },
  'lender_city': { group: 'Lender Information', version: '3.1.4', description: '' },
  'lender_name': { group: 'Lender Information', version: '3.1.0', description: 'Legal name of the lender.' },
  'lender_name_abbreviated': { group: 'Lender Information', version: '3.1.4', description: '' },
  'lender_name_all_caps': { group: 'Lender Information', version: '3.1.0', description: 'Lender name in uppercase for document formatting.' },
  'lender_state': { group: 'Lender Information', version: '3.1.0', description: 'State where the lender is located.' },
  'lender_town_and_state': { group: 'Lender Information', version: '3.1.0', description: 'Combined town and state of lender for document use.' },
  'lender_type_of_organization': { group: 'Lender Information', version: '3.1.0', description: 'Type of legal entity (e.g., LLC, Corporation).' },
  'first_payment_date': { group: 'Loan Terms', version: '3.1.0', description: 'Date which the first payment comes due and payable.' },
  'extended_maturity_date': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'new_maturity_date': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'previous_maturity_date': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'loan_amount': { group: 'Loan Terms', version: '3.1.0', description: 'Total principal amount of the loan.' },
  'interest_accrual_payment_date': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'loan_to_value_percent': { group: 'Loan Terms', version: '3.1.0', description: 'Loan-to-value ratio as a percentage.' },
  'maturity_date_of_loan': { group: 'Loan Terms', version: '3.1.0', description: 'Date when the loan is due to be fully repaid.' },
  'maturity_date': { group: 'Loan Terms', version: '3.1.0', description: 'Date when the loan is due to be fully repaid.' },
  'maximum_default_rate_percentage': { group: 'Loan Terms', version: '3.1.0', description: 'Maximum interest rate applicable upon default.' },
  'modification_date': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'month_of_closing': { group: 'Loan Terms', version: '3.1.0', description: 'Month in which the loan closes (e.g., "September").' },
  'monthly_payment_date_begin': { group: 'Loan Terms', version: '3.1.0', description: 'Date when monthly payments begin.' },
  'draw_request_fee': { group: 'Loan Terms', version: '3.1.1', description: 'A fee charged each time the borrower requests a draw or disbursement of loan funds.' },
  'exit_fee_percentage': { group: 'Loan Terms', version: '3.1.1', description: 'A percentage-based fee charged when the loan is paid off or exits (maturity, refinance, or sale).' },
  'extension_fee': { group: 'Loan Terms', version: '3.1.2', description: 'Fee charged by the lender if the borrower needs more time beyond the original loan term' },
  'origination_fee': { group: 'Loan Terms', version: '3.1.0', description: 'Fee charged for processing the loan.' },
  'other_fee': { group: 'Loan Terms', version: '3.1.0', description: 'Any additional fees not categorized elsewhere.' },
  'purchase_refinance': { group: 'Loan Terms', version: '3.1.1', description: 'Refers to where the loan is a "Purchase" or "Refinance"' },
  'processing_fee': { group: 'Loan Terms', version: '3.1.0', description: 'Fee for administrative processing of the loan.' },
  'security_instrument': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'security_instrument_all_caps': { group: 'Loan Terms', version: '3.1.4', description: '' },
  'short_term_interest_amount': { group: 'Loan Terms', version: '3.1.0', description: 'Interest amount applicable for short-term loans.' },
  'property_street_address': { group: 'Property Details', version: '3.1.0', description: 'Street address of the property.' },
  'property_town': { group: 'Property Details', version: '', description: '' },
});

/* ────────────────────────── end of the generated block ────────────────────────── */

/**
 * The repeating sections. Everything else in `variables` is a flat key/value.
 *
 * The matrix names these by their INNER key (`borrower_name`, `guarantor_name`,
 * `signatory_name`) because that is what the template merges — it never names the
 * array itself. So `MATRIX['borrower_name']` telling you a template needs a
 * borrower name is what tells you it needs the `borrowers` array.
 *
 * `pre_payment_penalty` is spelled with the underscore inside `variables`, while
 * the ROOT-level code field is `prepayment_option_code` with none. That is DocLab's
 * own inconsistency, reproduced from their master payload verbatim — do not
 * "correct" either one.
 */
const ARRAY_VARIABLES = Object.freeze({
  borrowers: Object.freeze({
    itemKeys: Object.freeze(['borrower_name', 'borrower_state', 'borrower_address', 'borrower_title']),
    nested: Object.freeze({ signatories: Object.freeze(['signatory_name', 'signatory_title']) }),
  }),
  guarantors: Object.freeze({
    itemKeys: Object.freeze(['guarantor_name', 'guarantor_address', 'guarantor_title']),
    nested: Object.freeze({ signatories: Object.freeze(['signatory_name', 'signatory_title']) }),
  }),
  collateral_properties: Object.freeze({
    itemKeys: Object.freeze(['collateral_property_address', 'collateral_property_city', 'collateral_property_county',
      'collateral_property_state', 'collateral_property_name', 'collateral_property_town']),
    nested: Object.freeze({}),
  }),
  pre_payment_penalty: Object.freeze({
    itemKeys: Object.freeze(['prepayment_penalty_date', 'prepayment_penalty_type']),
    nested: Object.freeze({}),
  }),
  fees: Object.freeze({
    // Not a plain array — an object of two arrays. See SINGLE_/MULTIPLE_FEE_TEMPLATES.
    itemKeys: Object.freeze(['single_fee', 'multiple_fees']),
    nested: Object.freeze({}),
    isObject: true,
  }),
});

/**
 * The three fields DocLab requires to select a template. Their API Setup page:
 * "The PLL API has ONLY three required fields for document creation: Lender Name
 * (lender_name), loan type (loan_category), and location (state)."
 *
 * Their Template Selection page adds the trap: the same three ALSO have to appear
 * inside `variables`, where they may hold DIFFERENT values — the template object
 * picks the template, the variables populate the document. "Please note, that
 * lender_name, state, and loan_category must still be included in the variables
 * object." Their master payload sends `state` and `loan_category` in `variables` as
 * a single SPACE (" "), commented "Required but can be empty space".
 */
const TEMPLATE_KEYS = Object.freeze(['lender_name', 'loan_category', 'state']);

/* ────────────────────────────────── helpers ────────────────────────────────── */

/** Look a status up however it arrives — 'Completed', 'completed', 80, '80'. */
function statusOf(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  const direct = Object.keys(STATUS).find((k) => k.toLowerCase() === s.toLowerCase());
  if (direct) return direct;
  const n = Number(s);
  if (Number.isFinite(n)) {
    const byCode = Object.keys(STATUS).find((k) => STATUS[k].code === n);
    if (byCode) return byCode;
  }
  return null;
}

/** True when the request will not move again on its own. Unknown → false (keep watching). */
function isTerminal(v) {
  const k = statusOf(v);
  return !!(k && STATUS[k].terminal);
}

/** The one happy ending: the PDF loan documents exist. */
function isComplete(v) { return statusOf(v) === 'completed'; }

/** The category row, matched case-insensitively on either published spelling. */
function categoryOf(name) {
  const s = String(name || '').trim().toLowerCase();
  if (!s) return null;
  return LOAN_CATEGORIES.find((c) =>
    c.category.toLowerCase() === s || (c.altName && c.altName.toLowerCase() === s)) || null;
}

/** The template columns for a loan category (several — one per security instrument). */
function templatesForCategory(name) {
  const row = categoryOf(name);
  if (!row) return [];
  return RTL_TEMPLATES.filter((t) => t.category === row.category);
}

/**
 * Every variable at least one of this category's templates asks for.
 *
 * THE UNION IS THE ONLY HONEST ANSWER, and it is deliberately conservative. A
 * category maps to up to three columns (deed of trust / deed to secure debt /
 * mortgage) and DocLab picks which one from the STATE — a fact the matrix does not
 * carry, so we cannot know in advance which of the three will be used. Taking the
 * union means we may ask for a value the chosen instrument does not print; taking
 * the intersection would mean submitting without a value the chosen instrument
 * does print. Over-collecting is a question to a colleague; under-collecting is a
 * blank on a recorded document.
 *
 * Returns [] for a category with no matrix column (Ground Up Construction) — which
 * `completeness()` reports as "unknown", never as "nothing needed".
 */
function variablesForCategory(name) {
  const codes = templatesForCategory(name).map((t) => t.code);
  if (!codes.length) return [];
  return Object.keys(MATRIX)
    .filter((k) => MATRIX[k].some((c) => codes.includes(c)))
    .sort();
}

/**
 * True when the published matrix has nothing to say about this category, so
 * "which variables does it need?" has no answer we are entitled to give.
 */
function matrixKnownFor(name) { return templatesForCategory(name).length > 0; }

/**
 * The matrix names two keys that are not literal JSON keys — `feeName
 * (Dynamic_Fee)` and `feeAmount (Dynamic_Fee)` describe the fee ARRAY rather than
 * a flat variable. They are kept in MATRIX so it matches the CSV exactly, and
 * excluded here so a completeness check never demands a variable that cannot be
 * sent on its own.
 */
const MATRIX_PSEUDO_KEYS = Object.freeze(['feeName (Dynamic_Fee)', 'feeAmount (Dynamic_Fee)']);
function isPseudoKey(k) { return MATRIX_PSEUDO_KEYS.includes(k); }

module.exports = {
  API_VERSION,
  STATUS, STATUS_NAMES, RESPONSE_CODE, LICENSE_TYPE,
  LOAN_CATEGORIES,
  PREPAYMENT_OPTION_CODES, RTL_CODES, PREPAYMENT_REQUIRED_VARIABLES,
  SINGLE_FEE_TEMPLATES, MULTIPLE_FEE_TEMPLATES, DYNAMIC_FEE_KEYS,
  RTL_TEMPLATES, MATRIX, DSCR_ONLY_KEYS, VARIABLES,
  ARRAY_VARIABLES, TEMPLATE_KEYS, MATRIX_PSEUDO_KEYS,
  statusOf, isTerminal, isComplete,
  categoryOf, templatesForCategory, variablesForCategory, matrixKnownFor, isPseudoKey,
};
