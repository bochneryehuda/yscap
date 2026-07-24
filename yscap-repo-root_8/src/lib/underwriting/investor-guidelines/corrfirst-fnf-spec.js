'use strict';
/**
 * CorrFirst "Fix & Flip Purchase" condition guideline SPEC (ISG-2 / Investor-Specific
 * Soft Guidelines; owner-directed 2026-07-23). The 47 conditions from the owner's real
 * spreadsheet (Loan_Conditions__Fix_and_Flip_Purchase.xlsx), decoded into a structured,
 * checked-in source of truth. No guessing — only the owner's data.
 *
 * Each condition carries:
 *   cond_no            canonical condition number (1015, 1017, …).
 *   name, domain
 *   scope              'all_note_buyers'          → applies to EVERY note buyer
 *                      'note_buyer'               → CorrFirst only
 *                      'all_but_note_buyer_limits'→ condition universal, but the numeric
 *                                                   limits are the note buyer's (others use
 *                                                   industry standard)
 *   lifecycle          'active_now'          → post/evaluate now
 *                      'hold_attorney_closing'→ owned by the attorney/closing team until
 *                                               closings are brought in house (not posted now)
 *                      'defer_post_closing'  → post-closing, ignore for now
 *                      'closing_phase'       → a closing-process condition
 *   trigger            a rule_logic-shaped condition ({} = always applies), evaluated against
 *                      the file rule context (e.g. property_type=condo, loan_purpose cash-out).
 *   required_evidence  what clears it.
 *   checks             [{ text, note_buyer_specific }] — verifiable rules/limits; the ones
 *                      flagged note_buyer_specific are CorrFirst's exact numbers (others follow
 *                      industry standard).
 *   clears_by          how it's cleared.
 *   pilot_template_code the existing PILOT checklist_templates.code this maps to (null = new).
 *   match_quality      'exact' | 'partial' | 'new' (vs PILOT's current condition catalog).
 *
 * PURE data module — no DB, no I/O. The seeder (investor-guidelines/seed.js) ingests it
 * idempotently; the vetting engine (ISG-3) reads it. ADVISORY only; never blocks; touches
 * no frozen pricing number.
 */

const PRODUCT = 'fix_and_flip_purchase';
const NOTE_BUYER = 'corrfirst';         // investorKey / normNoteBuyer form
const NOTE_BUYER_NAME = 'CorrFirst';
const SOURCE_VERSION = '2026.07.1';     // this spreadsheet ingest
const SOURCE_TITLE = 'CorrFirst — Fix & Flip Purchase loan conditions';

// note_buyer_specific:true marks a CorrFirst-exact limit (others = industry standard).
const S = (text, nbs) => ({ text, note_buyer_specific: !!nbs });

// A rule_logic-shaped trigger, or {} for "always applies". Fields match
// conditions/field-registry (property_type, loan_purpose, in_flood_zone, units, …). The
// engine (ISG-3) evaluates these; unknown/soft triggers ({} or advisory) always include.
const T = {
  always: {},
  condo: { combinator: 'and', rules: [{ field: 'property_type', operator: 'eq', value: 'condo' }] },
  cash_out: { combinator: 'and', rules: [{ field: 'loan_purpose', operator: 'in', value: ['refinance_cash_out', 'cash_out'] }] },
  flood_zone: { combinator: 'and', rules: [{ field: 'in_flood_zone', operator: 'is_true' }] },
  entity_vesting: { combinator: 'and', rules: [{ field: 'vesting_type', operator: 'eq', value: 'entity' }] },
  renovation: { combinator: 'and', rules: [{ field: 'program_strategy', operator: 'in', value: ['fix_and_flip', 'ground_up', 'renovation'] }] },
  // "soft" triggers we cannot yet evaluate structurally — always surface, let the desk/human judge.
  tenant_occupied: {},
  non_arms_length: {},
  rural: {},
  loan_amount_gt_2000000: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'gt', value: 2000000 }] },
  appraisal_other_lender: {},
  termsheet_package: {},
  ny_only: { combinator: 'and', rules: [{ field: 'property_state', operator: 'eq', value: 'NY' }] },
  owner_mismatch: {},
};

const CONDITIONS = [
  { cond_no: 1015, name: 'CREDIT REPORT', domain: 'credit', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Tri-merged credit report for each borrower on the loan.', checks: [],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_credit', match_quality: 'exact', source_row: 1 },
  { cond_no: 1017, name: 'ID', domain: 'identity', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: "Driver's License or state ID for all personal guarantors; passport if citizenship question; front+back of permanent-resident-alien card; visa/legal-presence proof for non-permanent-resident aliens; else ITIN.",
    checks: [], clears_by: 'document_upload', pilot_template_code: 'rtl_p1_id', match_quality: 'exact', source_row: 2 },
  { cond_no: 1022, name: 'LIQUID ASSETS', domain: 'assets_liquidity', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Most recent 1 month bank statements — all pages, bank name, full account number, ownership verified; Full Access Letter if account owner does not match borrower/guarantor; 2 months where the program matrix requires.',
    checks: [S('Unsecured loans are not an acceptable source of funds for DSCR'), S('Must document sufficient assets to close + meet reserve requirements'), S('Cash-out from a refi may cover reserves EXCEPT on Multiflow+')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_assets', match_quality: 'exact', source_row: 3 },
  { cond_no: 1026, name: 'TITLE AND TAX CERTIFICATION', domain: 'title', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Full title policy showing 24-month chain of title; Title Commitment; Tax Cert; marked-up title/proforma (or title-company email listing exceptions to be removed); title-company contact person.',
    checks: [S('Title dated within 90 days of closing'), S('Vesting matches application'), S("Seller's Lender Name ISAOA/ATIMA as proposed insured"), S('Title final loan amount >= actual loan amount')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_row: 4 },
  { cond_no: 1029, name: 'FLOOD DETERMINATION', domain: 'flood', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Flood-zone determination cert; if zone contains A or V code, signed & dated Notice of Special Flood Hazards.',
    checks: [S('Cert address matches loan address')], clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_flood', match_quality: 'exact', source_row: 5 },
  { cond_no: 2000, name: 'BORROWER SIGNED TERM SHEET OR INITIAL OR FINAL APPLICATION', domain: 'other', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Borrower-signed term sheet OR initial OR final application.', checks: [],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_signedts', match_quality: 'partial', source_row: 6 },
  { cond_no: 2002, name: 'TRACK RECORD/EXPERIENCE', domain: 'track_record', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Completed track-record form + HUD-1 from purchase AND HUD-1 from sale within the last 36 months.',
    checks: [S('History of like transactions within 36 months'), S('Track record is distinct from first-time-investor status')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_reo', match_quality: 'exact', source_row: 7 },
  { cond_no: 2004, name: 'APPRAISAL REQUIREMENTS - ALL RENO OR GUC AND COMMERCIAL BRIDGE', domain: 'appraisal', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Interior + exterior appraisal (1004/1073/2090/1025/commercial). Renovation: >= 3 As-Is and >= 3 ARV comps, first 3 ARV made subject-to, budget + scope of work in the report, appraiser ties ARV to the scope/budget. AIVM from RicherValues on all 1-4 unit properties.',
    checks: [S('Value supports requested LTV/CLTV'), S('>= 3 As-Is and >= 3 ARV comps on renovation loans')],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_appraisaldocs', match_quality: 'partial', source_row: 8 },
  { cond_no: 2005, name: 'BACKGROUND CHECK', domain: 'background_ofac', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Background check per borrower/guarantor; OFAC + FATF search for foreign nationals.',
    checks: [S('Ineligible: felony, or fraud/embezzlement misdemeanor, or adverse fraud screen within 5 years'), S('Ineligible: 10+ judgments/liens in last 36 months OR current liens over $250,000 (released/satisfied excluded)'), S('Background check within 60 days of the note date')],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_fraud', match_quality: 'partial', source_row: 9 },
  { cond_no: 1058, name: 'EXECUTED LOAN AGREEMENT', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'defer_post_closing', trigger: T.always,
    required_evidence: 'Copy of the executed loan agreement.', checks: [], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 10 },
  { cond_no: 1074, name: 'PERSONAL GUARANTY', domain: 'entity_vesting', scope: 'all_note_buyers', lifecycle: 'defer_post_closing', trigger: T.entity_vesting,
    required_evidence: 'Executed personal guaranty for any transaction closing in the name of an entity.', checks: [], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 11 },
  { cond_no: 1056, name: 'Certificate of Business and/or Commercial purpose loans', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'defer_post_closing', trigger: T.always,
    required_evidence: 'Borrower signs at closing: Certificate of Business/Commercial Purpose, Certificate of Commercial Loans, and Waivers of Federal & State TIL Disclosure.', checks: [], clears_by: 'attorney_closing', pilot_template_code: 'rtl_cond_disclosures', match_quality: 'partial', source_row: 12 },
  { cond_no: 1071, name: 'Affidavit of Non Owner Occupancy', domain: 'occupancy', scope: 'all_note_buyers', lifecycle: 'defer_post_closing', trigger: T.always,
    required_evidence: 'Borrower signs Affidavit of Non-Owner Occupancy at closing (may be folded into the Business Purpose Affidavit).', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 13 },
  { cond_no: 1030, name: 'CLOSING PROTECTION LETTER', domain: 'title', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: "Signed CPL (borrower name matches vesting, property address, title company); seller's mortgagee clause with ISAOA/ATIMA. TX: no ISAOA/ATIMA. NY: Agent Authorization letter in lieu of CPL.",
    checks: [S('CPL within 60 days of the note date')], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 14 },
  { cond_no: 2185, name: 'TITLE COMPANY ERRORS & OMISSIONS POLICY', domain: 'title', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: "Copy of the title company's valid Errors & Omissions insurance policy.", checks: [S('Effective date through the note date')], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 15 },
  { cond_no: 2186, name: 'HAZARD INSURANCE REQUIREMENTS-SFR RENO & BRIDGE', domain: 'insurance_hazard', scope: 'all_but_note_buyer_limits', lifecycle: 'active_now', trigger: T.always,
    required_evidence: "Hazard policy = loan amount or 100% replacement cost; name insured matches vesting; mortgagee clause = seller's lender with ISAOA/ATIMA; builder's risk for renovation loans; annual premium listed; invoice showing owed/paid-in-full; insurance-company contact person.",
    checks: [S('Liability >= $300,000 for loan amounts up to $500,000', true), S('Liability >= $500,000 for $500,001–$1,000,000', true), S('Liability >= $1,000,000 for loan amounts over $1,000,000', true), S('A lesser liability amount is acceptable only if the insurer confirms it is the maximum allowed')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_insurance', match_quality: 'partial', source_row: 16 },
  { cond_no: 2193, name: 'CONSTRUCTION BUDGET/FEASIBILITY REQUIREMENTS', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.renovation,
    required_evidence: 'Renovation/construction budget + scope of work, signed & dated by the borrower (Swifty50 need not be signed/dated); a Construction Narrative; a detailed per-line-item scope of work.',
    checks: [S('Maximum contingency may not exceed 10% of the total budget', true), S('Budget < $150K: internal review; budget > $150K: third-party feasibility by an approved vendor', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_p3_sow1', match_quality: 'partial', source_row: 17 },
  { cond_no: 3035, name: 'SELLER CONCESSION-RESIDENTIAL BRIDGE (Swifty50), FIX & FLIP, AND GUC', domain: 'seller_concession', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Sale price and concession figures from the contract and settlement statement.',
    checks: [S('Maximum seller concession is 6% of the sale price', true), S('3% for Swifty50 Mixed-Use or Multifamily 5+ units', true)],
    clears_by: 'system_field_check', pilot_template_code: null, match_quality: 'new', source_row: 18 },
  { cond_no: 1018, name: 'LEASE (IF PROPERTY IS TENANT OCCUPIED)', domain: 'lease_rent', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.tenant_occupied,
    required_evidence: 'Current rental agreement/lease; management agreement if a refinance and the landlord on the lease does not match the borrower/guarantor; a Rent Roll is acceptable if 10+ units.',
    checks: [S('Lease is current, valid, and pertains to the subject property')], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 19 },
  { cond_no: 2454, name: 'PLEDGE AND SECURITY AGREEMENT', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.ny_only,
    required_evidence: 'Executed Pledge and Security Agreement (NY loans only). Not applicable to entities that close in a trust.', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 20 },
  { cond_no: 4249, name: 'CLOSED LOAN PACKAGE', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'Full closed loan package.', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 21 },
  { cond_no: 4256, name: 'CONTACT INFO FOR TITLE/ESCROW/SETTLEMENT & INSURANCE COMPANIES', domain: 'other', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Company name, address, and contact full name/email/phone for the title/escrow/settlement company and the insurance company (and any separate flood/liability insurers).', checks: [],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_titlec', match_quality: 'partial', source_row: 25 },
  { cond_no: 4257, name: 'FINAL SETTLEMENT STATEMENT', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'closing_phase', trigger: T.always,
    required_evidence: 'Fully executed Final Settlement Agreement.', checks: [S('If assets were needed at closing per the settlement statement, confirm the file covers that plus any reserve requirement')],
    clears_by: 'attorney_closing', pilot_template_code: 'rtl_cond_settlement', match_quality: 'exact', source_row: 26 },
  { cond_no: 4258, name: 'EXECUTED PROMISSORY NOTE', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'A copy of the executed promissory note.', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 27 },
  { cond_no: 4259, name: 'EXECUTED MORTGAGE (JUDICIAL STATES) /DEED OF TRUST (NON JUDICIAL STATES) /DEED TO SECURE (GA ONLY)', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'Executed mortgage (judicial states) / deed of trust (non-judicial states) / deed to secure (GA only).', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 28 },
  { cond_no: 1020, name: 'VESTING ENTITY DOCUMENTS--LIMITED LIABILITY COMPANY', domain: 'entity_vesting', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.entity_vesting,
    required_evidence: 'EIN printout; Certificate of Formation/Articles of Organization; executed Operating Agreement showing % ownership; Certificate of Good Standing if formed > 60 days from the note date; LLC Resolution (with subject property address) if not all members are guarantors; foreign registration + Good Standing if the entity state differs from the property state; DL/state ID for all entity members.',
    checks: [S('Entity is not a non-profit and is US-domiciled'), S('Guarantor(s) are at least 51% stakeholders in the entity')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_llc', match_quality: 'exact', source_row: 30 },
  { cond_no: 1009, name: 'E-MAIL ADDRESS FOR BORROWER', domain: 'other', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    disposition: 'file_data', data_field: 'borrower_email',
    required_evidence: 'Account manager or underwriter verifies an accurate email address for the borrower.', checks: [], clears_by: 'internal_verification', pilot_template_code: null, match_quality: 'new', source_row: 31 },
  { cond_no: 1089, name: 'PURCHASE CONTRACT', domain: 'purchase_contract', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Fully executed contract of sale with all pages, assignments, and addendums; an addendum/modification if the original contract is expired.',
    checks: [S('All contract dates are valid'), S('If closing in an entity, the buyer on the contract is the entity, not the personal name')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_contract', match_quality: 'exact', source_row: 32 },
  { cond_no: 2120, name: 'CONDO/CONDOTEL REQUIREMENTS', domain: 'condo', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.condo,
    required_evidence: 'Full Project Questionnaire including the Fannie Mae Addendum; current-year approved Budget; Master Insurance Certificate with the mortgagee clause; Master Flood Policy if applicable; HO-6 policy if the master certificate lacks walls-in coverage.', checks: [],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 33 },
  { cond_no: 2121, name: 'Condo/Condotel Closing Requirements', domain: 'condo', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.condo,
    required_evidence: 'A Condo Rider.', checks: [], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 34 },
  { cond_no: 1050, name: 'SS NUMBER VERIFICATION', domain: 'ssn_verification', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'SSN verified via the credit report (if no other SSN is listed and the report is verified); else a copy of the Social Security card or a completed SSA-89 sent for 3rd-party verification.',
    checks: [S('SSA-89 e-sign only via an IRS-approved e-sign vendor, else a wet-signed form is required', true)],
    clears_by: 'internal_verification', pilot_template_code: 'rtl_p1_ssn', match_quality: 'partial', source_row: 40 },
  { cond_no: 1145, name: 'AKA AFFIDAVIT', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'Borrower signs a statement at closing regarding the AKAs shown on the credit report.', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 43 },
  { cond_no: 1147, name: 'Note and Security instrument and applicable riders.', domain: 'closing_docs', scope: 'all_note_buyers', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'Borrowers sign the Note and Security instrument and applicable riders.', checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 45 },
  { cond_no: 1054, name: 'SECOND APPRAISAL IS REQUIRED', domain: 'appraisal', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.loan_amount_gt_2000000,
    required_evidence: 'A full second appraisal.',
    checks: [S('Required if the loan amount is greater than $2,000,000 (Res 1-4 Unit DSCR, Multi-flow, Optimal Bridge, Optimal Fix and Flip, Optimal GUC)', true)],
    clears_by: 'third_party_order', pilot_template_code: null, match_quality: 'new', source_row: 46 },
  { cond_no: 2599, name: 'FLOOD INSURANCE REQUIREMENT', domain: 'insurance_flood', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.flood_zone,
    required_evidence: 'If the property is in a flood zone (A or V code): a signed & dated flood application, the declaration page, and proof the policy is paid in full.',
    checks: [S('1-4 unit residential: lesser of 100% replacement cost / NFIP max ($250,000 dwelling) / unpaid principal balance'), S('5+ units or mixed-use: lesser of 100% replacement cost / NFIP max ($500,000 dwelling) / unpaid principal balance')],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 47 },
  { cond_no: 3086, name: 'ASSET VERIFICATION-RENOVATION LOANS', domain: 'assets_liquidity', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.renovation,
    required_evidence: 'Asset verification for the difference between the Total Rehab Budget and the Rehab Amount financed; cash back on a refinance may be applied toward this requirement.', checks: [],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_assets', match_quality: 'partial', source_row: 48 },
  { cond_no: 3221, name: 'VERIFY THE REHAB BUDGET AMOUNT', domain: 'construction_feasibility', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.renovation,
    required_evidence: 'Account manager verifies the rehab budget in the structure screen matches the Budget & Scope of Work; if a closed loan, also matches the holdback amount on the HUD.', checks: [],
    clears_by: 'system_field_check', pilot_template_code: 'rtl_p3_sow1', match_quality: 'partial', source_row: 49 },
  { cond_no: 3333, name: 'NON ARMS LENGTH TRANSACTION', domain: 'non_arms_length', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.non_arms_length,
    disposition: 'concern', concern_field: 'non_arms_length_concern',
    required_evidence: 'Underwriter verifies the relationship between the parties, analyzes any property-value increase from the prior transaction for reasonableness, and confirms the transaction is not a bailout via the seller mortgage payment history (if a sale).', checks: [],
    clears_by: 'internal_verification', pilot_template_code: null, match_quality: 'new', source_row: 50 },
  { cond_no: 3345, name: 'RURAL PROPERTY VERIFICATION', domain: 'rural', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.rural,
    disposition: 'appraisal', concern_field: 'appraisal_rural',
    required_evidence: 'Verify whether the property is rural via the USDA Eligibility Map; if rural, confirm the structure screen has rural = yes and revalidate the product.', checks: [],
    clears_by: 'system_field_check', pilot_template_code: null, match_quality: 'new', source_row: 51 },
  { cond_no: 3349, name: 'APPRAISAL TRANSFER REQUIREMENTS', domain: 'appraisal', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.appraisal_other_lender,
    disposition: 'appraisal', concern_field: 'appraisal_transferred',
    required_evidence: "If the appraisal is in YS Capital Group's name it clears; else appraisal PDF + Appraiser Independence Certification + original paid-in-full invoice + Transfer Letter on the transferring lender's letterhead (property address, borrower name, completion date) certifying AIR compliance and assigning rights.", checks: [],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 54 },
  { cond_no: 3811, name: 'FIRST TIME HOME BUYER AND/OR FIRST TIME INVESTOR-BRIDGE AND FNF LOANS', domain: 'track_record', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'To not be a First Time Home Buyer: proof of property ownership (not vacant land) in the last 36 months. To not be a First Time Investor: an investment property sold in the last 36 months OR a property refinanced after a completed rehab in the last 36 months.',
    checks: [S('First Time Home Buyers and First Time Investors are allowed, but must close in an entity', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 56 },
  { cond_no: 2798, name: 'SUBJECT PROPERTY MEDIAN HOME VALUE', domain: 'appraisal', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Zillow median home value for the subject and the appraisal comps.',
    checks: [S('As-Is and ARV must not exceed 125% of Zillow median for 1-unit', true), S('200% for 2-unit', true), S('300% for 3-4 unit', true), S('Exempt if directly on water, ski-in/ski-out, a View property, or 3+ comps within 1 mile; commercial 5+ units exempt')],
    clears_by: 'internal_verification', pilot_template_code: null, match_quality: 'new', source_row: 58 },
  { cond_no: 3346, name: 'OFAC & Other Watch Lists', domain: 'background_ofac', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Check individual guarantors and the borrowing entity against the OFAC Sanction List; upload evidence of the search.', checks: [],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_fraud', match_quality: 'partial', source_row: 59 },
  { cond_no: 2007, name: 'Spousal Consent', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'hold_attorney_closing', trigger: T.entity_vesting,
    required_evidence: 'A Spousal Consent to the personal guaranty.',
    checks: [S('Required for entity loans of $1,000,000 or greater', true), S('Required generally in AK, AZ, ID, LA, NM, TX, WA, WI', true)],
    clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_row: 61 },
  { cond_no: 2395, name: 'FINAL TITLE POLICY (IF AVAILABLE) AND RECORDED SECURITY INSTRUMENT', domain: 'title', scope: 'note_buyer', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'A long-form final title policy and recorded security instrument; if unavailable, seller-provided correspondence with the title agent that it is not yet available.', checks: [],
    clears_by: 'attorney_closing', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_row: 70 },
  { cond_no: 10022, name: 'Cash Out Letter', domain: 'cash_out', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.cash_out,
    required_evidence: 'A written explanation of the use of the cash-out proceeds.', checks: [], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 73 },
  { cond_no: 10023, name: 'Occupancy Cert', domain: 'occupancy', scope: 'all_note_buyers', lifecycle: 'active_now', trigger: T.termsheet_package,
    disposition: 'closing_package',
    required_evidence: 'An occupancy certificate (part of the term-sheet package).', checks: [], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_row: 74 },
];

// -------------------------------------------------------------------------------------
// Pure applicability helpers (no DB). The vetting engine (ISG-3) uses evaluateTrigger via
// the real rule evaluator; these give a self-contained view for tests + non-DB callers.
// -------------------------------------------------------------------------------------

/**
 * appliesToNoteBuyer(cond, noteBuyerKey) → boolean (PURE).
 * A row applies to a file's note buyer when it is scoped to all note buyers, OR it is
 * note-buyer-scoped and this IS that note buyer. `all_but_note_buyer_limits` conditions
 * apply to EVERYONE (the condition is universal; only its limits are note-buyer-specific).
 */
function appliesToNoteBuyer(cond, noteBuyerKey) {
  if (!cond || typeof cond !== 'object') return false;
  if (cond.scope === 'all_note_buyers' || cond.scope === 'all_but_note_buyer_limits') return true;
  if (cond.scope === 'note_buyer') return String(noteBuyerKey || '').toLowerCase() === NOTE_BUYER;
  return false;
}

/**
 * limitsApplyToNoteBuyer(cond, noteBuyerKey) → boolean (PURE).
 * Whether the condition's note_buyer_specific checks (exact numeric limits) apply to this
 * note buyer. For `note_buyer` and `all_but_note_buyer_limits` scopes the limits are the
 * note buyer's — other buyers follow industry standard (so their flagged checks are advisory).
 */
function limitsApplyToNoteBuyer(cond, noteBuyerKey) {
  if (!cond) return false;
  if (cond.scope === 'all_note_buyers') return true; // its checks are universal already
  return String(noteBuyerKey || '').toLowerCase() === NOTE_BUYER;
}

/** activeConditions() → only lifecycle==='active_now' (the set the engine posts/evaluates now). */
function activeConditions() { return CONDITIONS.filter((c) => c.lifecycle === 'active_now'); }

/** applicableFor(noteBuyerKey, { includeDeferred }) → the conditions that apply to a note buyer. */
function applicableFor(noteBuyerKey, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return CONDITIONS.filter((c) => appliesToNoteBuyer(c, noteBuyerKey) && (o.includeDeferred || c.lifecycle === 'active_now'));
}

const SCOPES = Object.freeze(['all_note_buyers', 'note_buyer', 'all_but_note_buyer_limits']);
const LIFECYCLES = Object.freeze(['active_now', 'hold_attorney_closing', 'defer_post_closing', 'closing_phase']);
const CLEARS_BY = Object.freeze(['document_upload', 'internal_verification', 'third_party_order', 'attorney_closing', 'system_field_check']);

module.exports = {
  PRODUCT, NOTE_BUYER, NOTE_BUYER_NAME, SOURCE_VERSION, SOURCE_TITLE,
  CONDITIONS,
  appliesToNoteBuyer, limitsApplyToNoteBuyer, activeConditions, applicableFor,
  SCOPES, LIFECYCLES, CLEARS_BY, TRIGGERS: T,
};
