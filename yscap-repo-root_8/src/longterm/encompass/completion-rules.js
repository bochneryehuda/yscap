'use strict';
/**
 * LONG-TERM (LT) — Encompass Milestone Completion rules: the "memory".
 *
 * WHAT THIS IS. In Encompass, "Milestone Completion" business rules decide which
 * loan FIELDS (and docs/tasks) must be filled before a file can complete a given
 * milestone (LO Prep → Submittal → … → Clear To Close → Funded). Each rule has a
 * NAME, the CHANNEL(s) it applies to, and a CONDITION (when it turns on). When the
 * condition is met, the rule's required fields must be present at their tagged
 * milestone or Encompass will not let the milestone finish.
 *
 * WHY IT IS HERE, AND WHAT IT IS NOT. This is REFERENCE KNOWLEDGE for the
 * Long-Term build — so a developer or an AI can see exactly how the tenant's
 * Encompass workflow is configured and understand why each field matters at each
 * stage. Long-Term does NOT enforce any of this. Nothing here blocks anything.
 * It is a map, not a gate. (Enforcement, if it is ever wanted, is a separate,
 * owner-directed decision.)
 *
 * WHERE IT COMES FROM, AND HOW COMPLETE IT IS.
 *   • The tenant has a "Milestone Requirements (91)" list — 91 rules.
 *   • Two screen recordings (2026-08-13) exposed the FIRST 22 rules and several
 *     Required-Fields tabs. The list was never scrolled past rule 22, so 69 rules
 *     are NOT yet captured (see MISSING below and how to obtain them).
 *   • The Encompass API does NOT return these rule definitions — only the 19
 *     milestone SETTINGS (see ./milestone-settings via lt_encompass_milestones).
 *     The audit (docs/longterm/ENCOMPASS-INTEGRATION.md) confirms the full rule
 *     export must come from Encompass Desktop / Admin Tools.
 *   • CONFIRMED (authoritative): the rule names, channels and conditions of the 22
 *     visible rules, and the field→milestone requirements normalized in the audit
 *     CSVs. RECONSTRUCTED (video, may contain OCR slips): the base rule's full
 *     ~111-field list, stitched from ~20 scroll frames. Each field carries a
 *     `source` so the two are never confused.
 *
 * The condition expressions use Encompass field syntax: `[<fieldId>]` reads a loan
 * field; `[#FR0112]` reads a form field; string comparisons are quoted. e.g.
 * `[19] = "Purchase"` means loan field 19 (Loan Purpose) equals "Purchase".
 */

const PRODUCT_NOTE =
  'DSCR / long-term is a NO-INCOME-DOC product, so the tenant models it as Loan Doc ' +
  'Type = "No Documentation". That is exactly the condition on the base rule (#12), ' +
  'which is why rule #12 carries the long-term field set.';

// ── The 22 visible rules of the "Milestone Requirements (91)" list ────────────
// rtl:true  = this rule is RTL-specific (kept for the full picture, labeled).
// coverage  = how much of the rule was captured on camera.
const RULES = [
  { seq: 1, name: 'Declaration Details L (BOR)', channel: 'No channel',
    condition: '[URLA.x106] = "Y"',
    explanation: 'Borrower answered "Yes" to URLA declaration L (a property they will occupy / relationship-to-seller style declaration). Turns on extra declaration fields for the borrower.',
    coverage: 'condition_only' },
  { seq: 2, name: 'Declaration Details L (COB)', channel: 'No channel',
    condition: '[URLA.x107] = "Y" and [4004] <> ""',
    explanation: 'Same declaration L, for the CO-borrower — only when a co-borrower exists ([4004] = co-borrower first name is not blank).',
    coverage: 'condition_only' },
  { seq: 3, name: 'Declaration Details M (BOR)', channel: 'No channel',
    condition: '[265] = "Y" And [URLA.x174] <> "Y" And [URLA.x175] <> "Y" And [URLA.x176] = "Y" And [URLA…',
    explanation: 'Borrower declaration M branch (a specific combination of URLA declaration answers). Condition truncated on camera.',
    coverage: 'condition_partial' },
  { seq: 4, name: 'Declaration Details M (COB)', channel: 'No channel',
    condition: '[266] = "Y" And [URLA.x178] <> "Y" And [URLA.x179] <> "Y" And [URLA.x180] = "Y" And [URLA…',
    explanation: 'Same declaration M branch, for the co-borrower. Condition truncated on camera.',
    coverage: 'condition_partial' },
  { seq: 5, name: 'Declaration Details A Part 2 (BOR)', channel: 'No channel',
    condition: '[403] = "Yes"',
    explanation: 'Borrower answered "Yes" to declaration A part 2 (outstanding judgments / declarations follow-up).',
    coverage: 'condition_only' },
  { seq: 6, name: 'Declaration Details A (COB)', channel: 'No channel',
    condition: '[1343] = "Yes" and [4004] <> ""',
    explanation: 'Co-borrower declaration A, only when a co-borrower exists.',
    coverage: 'condition_only' },
  { seq: 7, name: 'Refinance', channel: 'All Channels',
    condition: '[19] = "NoCash-Out Refinance" OR [19] = "Cash-Out Refinance"',
    explanation: 'The loan is a refinance (either cash-out or no-cash-out). Turns on refinance-specific requirements.',
    coverage: 'condition_only' },
  { seq: 8, name: 'Dependents Age (COB)', channel: 'No channel',
    condition: '[85] > "0"',
    explanation: 'Co-borrower has one or more dependents ([85] = co-borrower dependent count) — requires their ages.',
    coverage: 'condition_only' },
  { seq: 9, name: 'Dependents Age (BOR)', channel: 'No channel',
    condition: '[53] > "0"',
    explanation: 'Borrower has one or more dependents ([53] = borrower dependent count) — requires their ages.',
    coverage: 'condition_only' },
  { seq: 10, name: 'Condo Approval', channel: 'No channel',
    condition: '[1041] = "Condominium" OR [1041] = "HighRiseCondominium" OR [1041] = "DetachedCondo"',
    explanation: 'Subject property is a condo (any condo sub-type on field 1041, the Fannie Mae property type). Turns on condo-approval requirements.',
    coverage: 'condition_only' },
  { seq: 11, name: 'Accessory Dwelling Unit', channel: 'No channel',
    condition: '[URLA.X309] = "Y"',
    explanation: 'Subject property has an ADU (accessory dwelling unit).',
    coverage: 'condition_only' },
  { seq: 12, name: 'milestone completion field requirements', channel: 'All Channels',
    condition: 'Loan Doc Type is No Documentation',
    explanation: 'THE BASE RULE for long-term / DSCR. "No Documentation" doc type = a no-income-doc (DSCR) loan, so this rule carries the long-term core field set — the ~111 fields in BASE_RULE_FIELDS below, tagged to LO Prep / Submittal / Clear To Close.',
    coverage: 'fields_reconstructed_partial', isBaseRule: true },
  { seq: 13, name: 'if vesting officer require LLC set', channel: 'All Channels',
    condition: '[4008] = "Trustee" OR [4008] = "Officer"',
    explanation: 'The borrower vests title as a Trustee or an Officer (field 4008 = vesting type) — i.e. the loan closes in an entity (LLC / trust / corp). Requires the entity vesting fields (name, org state/type, tax id, vesting, trust date). This is the entity-vesting requirement long-term loans rely on.',
    coverage: 'fields_complete_visible' },
  { seq: 14, name: 'Fix & Flip Form', channel: 'All Channels',
    condition: 'Loan Program is Fix & Flip Purchase + reno',
    explanation: 'RTL fix-and-flip program requirement. Kept for the full picture; not a long-term rule.',
    coverage: 'condition_only', rtl: true },
  { seq: 15, name: 'if purchase Transaction require', channel: 'All Channels',
    condition: '[19] = "Purchase"',
    explanation: 'The loan is a purchase ([19] = loan purpose). Turns on purchase-specific requirements. (Required-Fields tab not opened on camera.)',
    coverage: 'condition_only' },
  { seq: 16, name: 'if refi', channel: 'All Channels',
    condition: '[19] = "NoCash-Out Refinance" OR [19] = "Cash-Out Refinance"',
    explanation: 'Refinance requirement — requires the refi fields (year acquired, original cost, subject mortgage statement, cash-out determination type).',
    coverage: 'fields_complete_visible' },
  { seq: 17, name: 'iska', channel: 'All Channels',
    condition: '[CX.TABLEFUNDER] = "Correspondent" OR [CX.TABLEFUNDER] = "Table Funding"',
    explanation: 'Heter Iska (interest-permissibility document) requirement, keyed on the table-funding channel. (Required-Fields tab not opened on camera.)',
    coverage: 'condition_only' },
  { seq: 18, name: 'less then 2 year old address', channel: 'All Channels',
    condition: '[#FR0112] < 2',
    explanation: 'Borrower has lived at the present address less than 2 years (form field FR0112 = years at present address) — requires a prior address. (Required-Fields tab not opened on camera.)',
    coverage: 'condition_only' },
  { seq: 19, name: 'fidelis rtl', channel: 'All Channels',
    condition: '[CX.CAPITALPROVIDER] = "Fidelis Investors"',
    explanation: 'RTL note-buyer (capital provider) rule for Fidelis. Kept for the full picture; RTL-specific.',
    coverage: 'condition_only', rtl: true },
  { seq: 20, name: 'Delegate rtl', channel: 'All Channels',
    condition: '[CX.TABLEFUNDER] = "Direct RTL / Delegate" OR [CX.TABLEFUNDER] = "Direct RTL / W TP…',
    explanation: 'RTL delegated-funding channel rule. Kept for the full picture; RTL-specific. Condition truncated on camera.',
    coverage: 'condition_partial', rtl: true },
  { seq: 21, name: 'non del investor loan number at submithion', channel: 'All Channels',
    condition: '[CX.TABLEFUNDER] = "Correspondent" OR [CX.TABLEFUNDER] = "Non Delegated Correspondent"',
    explanation: 'Non-delegated correspondent funding — requires the investor name (at Submittal) and investor reference # (at Clear To Close). Relevant to long-term loans sold to an investor.',
    coverage: 'fields_partial' },
  { seq: 22, name: 'Delegate requirement at CTC', channel: 'All Channels',
    condition: '[CX.TABLEFUNDER] = "Delegate correspondent / In House"',
    explanation: 'RTL delegated-correspondent / in-house funding requirement at Clear To Close. Kept for the full picture; RTL-specific.',
    coverage: 'condition_only', rtl: true },
];

// ── The base rule's field set (rule #12) ──────────────────────────────────────
// Reconstructed from ~20 scroll frames of the Required-Fields tab, string-sorted
// by field id. This is the long-term core requirement set. `source: 'reconstructed'`
// = read off the video (verify before relying on any single value);
// `source: 'audit_csv'` = also confirmed in the authoritative visible-requirements CSV.
// milestone ∈ LO Prep | Submittal | Docs Out | Clear To Close.
const BASE_RULE_FIELDS = [
  // Standard (numbered) fields
  { fieldId: '1005', description: 'Subject Property Gross Rent', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '1041', description: 'Subject Property Type Fannie Mae', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '1051', description: 'Trans Details MERS MIN #', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '11', description: 'Subject Property Street', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '1109', description: 'Trans Details Loan Amt', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '1172', description: 'Trans Details Loan Type', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '12', description: 'Subject Property City', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '1240', description: 'Borr Email', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: '1264', description: 'File Contacts Lender Co Name', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '13', description: 'Subject Property County', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '14', description: 'Subject Property State', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1401', description: 'Trans Details Loan Program', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1402', description: 'Borr DOB', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1405', description: 'Expenses Proposed Taxes', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1414', description: 'Borr Equifax BEACON (credit score)', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: '1450', description: 'Borr TransUnion Empirica (credit score)', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: '1487', description: 'Subject Property Occupancy Rate', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '15', description: 'Subject Property Zip', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1553', description: 'Subject Property Type', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '16', description: 'Subject Property # Units', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1612', description: 'Trans Details Interviewer Name', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '169', description: 'Borr Declarations G', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '17', description: 'Subject Property Legal Desc1', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '1785', description: 'Trans Details Closing Cost Program', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1811', description: 'Subject Property Occupancy Status', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1821', description: 'Subject Property Est Value', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '1823', description: 'Trans Details Interviewer Phone', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '19', description: 'Trans Details Loan Purpose', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '2101', description: 'Rate Lock Request Base Price Rate', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '230', description: 'Expenses Proposed Haz Ins', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '2302', description: 'Underwriting Approval Expired Date', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '2400', description: 'Closing Loan Info Loan is Locked', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '2626', description: 'Loan Info Channel', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '265', description: 'Borr Declarations M', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '3', description: 'Trans Details Interest Rate', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '313', description: 'File Contacts Broker Lender City', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '315', description: 'File Contacts Broker Lender Name', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '321', description: 'File Contacts Broker Lender State', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '323', description: 'File Contacts Broker Lender Zip', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '364', description: 'Trans Details Loan #', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '3968', description: 'Trans Details Interviewer Email', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '4000', description: 'Borrower First Name', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '4002', description: 'Borrower Last Name', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '4008', description: 'Borrower Vesting Type', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '4143', description: 'Borr Trans Details Application Taken By', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '418', description: 'Borr Declarations A', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '420', description: 'Trans Details Lien Position', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '432', description: 'Trans Details Rate Lock # Days', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '52', description: 'Borr Marital Status', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '53', description: 'Borr Dependent #', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '54', description: 'Borr Dependents Ages', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '608', description: 'Trans Details Amort Type', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '65', description: 'Borr SSN', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '66', description: 'Borr Home Phone', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '67', description: 'Borr Experian FICO (credit score)', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: '761', description: 'Trans Details Lock Date', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '762', description: 'Trans Details Rate Lock Expires', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: '763', description: 'Trans Details Est Closing Date', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: '912', description: 'Expenses Proposed Total Housing', milestone: 'LO Prep', source: 'reconstructed' },
  // Custom (CX / CUST) fields — DSCR/long-term core
  { fieldId: 'CUST01FV', description: 'DSCR', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.APPRAISALORDER', description: 'appraisal order', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.BPSCOMPANY', description: 'BPS Company expects', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: 'CX.BUYPRICE', description: 'BUYPRICE $', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: 'CX.CLOSINGFEES', description: 'Closing Fees – Application & Commitment', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: 'CX.CONFIRMEDINUW', description: 'Confirmed in Underwriting', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: 'CX.DSCRLOANAMOUNT', description: 'DSCR LOAN AMOUNT', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.DSCRLTV', description: 'DSCR LTV', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.FILLEDCLICKUP', description: 'Filled Clickup', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: 'CX.FILLEDPREQUAL', description: 'Filled Prequal Form', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: 'CX.GOVERNMENTID', description: 'Government Identification', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: 'CX.HOLDBACK', description: 'Margin and hold back', milestone: 'Clear To Close', source: 'audit_csv' },
  { fieldId: 'CX.INITIALDISCLOSURES', description: 'Initial Disclosures Signed & Saved to file', milestone: 'Submittal', source: 'audit_csv' },
  { fieldId: 'CX.INSURANCEORDERED', description: 'Insurance Ordered', milestone: 'Submittal', source: 'audit_csv' },
  { fieldId: 'CX.LLCDOCUMENTS', description: 'LLC Documents', milestone: 'LO Prep', source: 'audit_csv' },
  { fieldId: 'CX.LOCOMPENSATION', description: 'LO Compensation', milestone: 'Clear To Close', source: 'audit_csv' },
  { fieldId: 'CX.ORIGINATIONFEE', description: 'Origination fee', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: 'CX.PPPTERM', description: 'PPP TERM (prepayment penalty term)', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.PPPTYPE', description: 'PPP Type (prepayment penalty type)', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.PROPERTYTYPE', description: 'PROPERTY TYPE', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.PULLEDCREDIT', description: 'pulled credit', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.RESERVES', description: 'Reserves', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.SELLLOCKPRICE', description: 'SELLLOCKPRICE', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: 'CX.SELLLOCKPRICE$', description: 'SELLLOCKPRICE$', milestone: 'Clear To Close', source: 'reconstructed' },
  { fieldId: 'CX.SENTOUTINITIAL', description: 'Sent out initial disclosures', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: 'CX.SUBMITTEDTOINVESTOR', description: 'Submitted to Investor', milestone: 'Submittal', source: 'reconstructed', staffOnly: true },
  { fieldId: 'CX.TABLEFUNDER', description: 'TABLE FUNDER (funding channel)', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'CX.TITLEORDERED', description: 'Title Ordered', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: 'CX.USPSADDRESS', description: 'USPS address verification', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: 'CX.VERIFYADDRESS', description: 'Verify address on ID – if diff than primary address', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: 'CX.VERIFYBORROWER', description: 'Verify borrower ID name spelling / DOB', milestone: 'Submittal', source: 'reconstructed' },
  { fieldId: 'CX.WHICHINVESTOR', description: 'WHICH INVESTOR', milestone: 'LO Prep', source: 'reconstructed', staffOnly: true },
  // Form / URLA / Vendor fields
  { fieldId: 'FR0104', description: 'Borr Present Addr', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'FR0106', description: 'Borr Present City', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'FR0107', description: 'Borr Present State', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'FR0108', description: 'Borr Present Zip', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'FR0112', description: 'Borr Own # Yrs (years at present address)', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'FR0115', description: 'Borr Own/Rent Present Addr', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'FR0124', description: 'Borr Own # Mos (months at present address)', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X172', description: 'URLA Loan originator last name', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X188', description: 'Loan Originator Address Line Text', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X73', description: 'Property Address Line Text', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X84', description: 'Borr Declarations 5a B', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X86', description: 'Borr Declarations 5a C', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X90', description: 'Borr Declarations 5a D', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X92', description: 'Borr Declarations 5a D', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X94', description: 'Borr Declarations 5a E', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X96', description: 'Borr Declarations 5b F', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'URLA.X98', description: 'Borr Declarations 5b H', milestone: 'LO Prep', source: 'reconstructed' },
  { fieldId: 'VEND.X200', description: 'File Contacts Warehouse Co Name', milestone: 'Docs Out', source: 'reconstructed' },
  { fieldId: 'VEND.X263', description: 'File Contacts Investor Name', milestone: 'Submittal', source: 'reconstructed', staffOnly: true },
  { fieldId: 'VEND.X276', description: 'File Contacts Investor Ref #', milestone: 'Clear To Close', source: 'reconstructed', staffOnly: true },
];

// ── Fields required by the OTHER visible rules (confirmed in the audit CSV) ────
const RULE_FIELDS = {
  'if vesting officer require LLC set': [
    { fieldId: '1859', description: 'Borrower Vesting Borr 1 Corp/Trust Name', milestone: 'LO Prep', source: 'audit_csv' },
    { fieldId: '1860', description: 'Borrower Vesting Borr 1 Org State', milestone: 'LO Prep', source: 'audit_csv' },
    { fieldId: '1861', description: 'Borrower Vesting Borr 1 Org Type', milestone: 'LO Prep', source: 'audit_csv' },
    { fieldId: '1862', description: 'Borrower Vesting Borr 1 Org Tax ID', milestone: 'Clear To Close', source: 'audit_csv' },
    { fieldId: '1872', description: 'Borrower Vesting Borr 1 Vesting', milestone: 'Clear To Close', source: 'audit_csv' },
    { fieldId: '2554', description: 'Closing Docs Borr 1 Org Trust Date or Year', milestone: 'Clear To Close', source: 'audit_csv' },
  ],
  'if refi': [
    { fieldId: '24', description: 'Loan Info Refi Yr Acquired', milestone: 'LO Prep', source: 'audit_csv' },
    { fieldId: '25', description: 'Loan Info Refi Original Cost', milestone: 'LO Prep', source: 'audit_csv' },
    { fieldId: 'CX.SUBJECTMORTGAGE', description: 'Subject mortgage statement – for refi', milestone: 'LO Prep', source: 'audit_csv' },
    { fieldId: 'URLA.X165', description: 'Refinance Cash Out Determination Type', milestone: 'LO Prep', source: 'audit_csv' },
  ],
  'non del investor loan number at submithion': [
    { fieldId: 'VEND.X263', description: 'File Contacts Investor Name', milestone: 'Submittal', source: 'audit_csv', staffOnly: true },
    { fieldId: 'VEND.X276', description: 'File Contacts Investor Ref #', milestone: 'Clear To Close', source: 'audit_csv', staffOnly: true },
  ],
};

// ── What is NOT yet captured, and how to get it ───────────────────────────────
const MISSING = {
  rulesTotal: 91,
  rulesCaptured: 22,
  rulesMissing: 69,
  notes: [
    'The master list was never scrolled past rule 22, so 69 rules are uncaptured.',
    'The base rule (#12) field list is reconstructed from video and is partial — both field lists continued below the visible fold.',
    'Required-Fields tabs were NOT opened for rules 15 (purchase), 17 (iska), 18 (<2yr address), 20/22 (delegate).',
    'The audio narration could not be transcribed in this environment.',
  ],
  howToGetTheRest: [
    'Encompass Desktop / Admin Tools → Settings → Business Rules → Milestone Completion.',
    'For every enabled rule: record name, rule id, priority, activation condition, target milestone(s).',
    'Capture every Required Fields entry (field id + name + condition) and every Required Tasks entry.',
    'Resolve field ids in bulk via GET /encompass/v3/schemas/loan/standardFields?ids=<csv>&start=0&limit=100 and the custom-field settings endpoint.',
  ],
};

module.exports = { PRODUCT_NOTE, RULES, BASE_RULE_FIELDS, RULE_FIELDS, MISSING };
