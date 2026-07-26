'use strict';
/**
 * ISG-BL — Blue Lake Capital RTL soft-guideline spec (note buyer `bluelake`).
 *
 * Decoded from the owner's three Blue Lake documents (2026-07-23), read page-by-page:
 *   • Blue_Lake_RTL_Guidelines__V04.20.26.pdf (28pp) — the guideline body + Appendices A–F
 *   • Blue_Lake_Guidelines_Presentation.pdf (9 slides) — program summary / sponsor tiering
 *   • Blue_Lake_RTL_Required_Loan_Documents_List.pdf (1p) — pre/post-close document list
 *
 * This is the SOFT, document-cleared guideline layer for the Blue Lake note buyer — the
 * back-end conditions the desk (ISG-3) vets each file's documents + fields against and
 * suggests which conditions to post. It is a SEPARATE layer from (a) the frozen
 * pricing/structure engine and (b) the document-intelligence / fraud layer, but shares the
 * same brain (they all talk to each other via note_buyer_conditions + the desk).
 *
 * OWNER DIRECTIVES baked in (2026-07-23):
 *   1. "The Gold program IS Blue Lake." The detailed leverage/tier grid lives in the FROZEN
 *      Gold Standard engine (gold-standard.js), NOT here. Every leverage/tier/pricing rule
 *      below carries meta.governed_by='gold_program' and NO enforced number — the desk defers
 *      the actual cap to the live Gold engine so Blue Lake auto-updates when Gold updates.
 *      Only the stated OUTER maxima (LTC 93 / LTAIV 90 / LTARV 75) are recorded, as context.
 *   2. "Construction" = GROUND-UP. General Liability + a Feasibility Report attach on
 *      GROUND-UP *and* HEAVY REHAB (T.ground_up_or_heavy).
 *   3. Assignment fee = the lesser of $75,000 or 15% of the purchase price (the p8 wording;
 *      the p13 "10%" is superseded) — and this matches the frozen Gold engine, so it is a
 *      Gold-governed check, not a forked number.
 *   4. FICO: 660 is the hard floor for EVERY guarantor; 680+ is needed for a standard tier;
 *      660–679 only by approved exception.
 *   5. Focus PRE-CLOSE. Post-close items (draw date-down endorsements, final closing set) are
 *      kept but marked lifecycle 'defer_post_closing' / phase post_close — set aside for the
 *      future post-closing build.
 *
 * ADVISORY / read-only: nothing here posts, blocks, clears, or sizes a loan; it never touches
 * a frozen number. Borrower-facing surfaces must NEVER show "Blue Lake" — the borrower name is
 * the "Gold Standard program" (CLAUDE.md). This spec is staff-only data.
 */

const PRODUCT = 'rtl';                         // Blue Lake RTL (all strategies)
const NOTE_BUYER = 'bluelake';                 // investorKey / normNoteBuyer form
const NOTE_BUYER_NAME = 'Blue Lake Capital';
const SOURCE_VERSION = '2026.04.20';           // guideline doc V04.20.26
const SOURCE_TITLE = 'Blue Lake Capital — RTL Guidelines V04.20.26';
const GOVERNED_BY_GOLD = Object.freeze({ governed_by: 'gold_program' });

// check helper: text + note_buyer_specific flag (an exact Blue Lake limit).
const S = (text, nbs) => ({ text, note_buyer_specific: !!nbs });

// A rule_logic-shaped trigger, or {} = "always applies". Fields match conditions/field-registry.
// The desk (ISG-3) evaluates these via the real rule evaluator and FAILS OPEN on any field the
// registry doesn't have yet (rehab_type, citizenship sub-type, etc.) — so a requirement is never
// silently dropped; it just always surfaces until the field exists.
const T = {
  always: {},
  ground_up: { combinator: 'and', rules: [{ field: 'rehab_type', operator: 'in', value: ['ground_up', 'construction'] }] },
  heavy_rehab: { combinator: 'and', rules: [{ field: 'rehab_type', operator: 'eq', value: 'heavy' }] },
  // GL + Feasibility + Builders Risk attach on GROUND-UP *and* HEAVY REHAB (owner 2026-07-23).
  ground_up_or_heavy: { combinator: 'and', rules: [{ field: 'rehab_type', operator: 'in', value: ['ground_up', 'construction', 'heavy'] }] },
  renovation: { combinator: 'and', rules: [{ field: 'rehab_type', operator: 'in', value: ['renovation', 'light'] }] },
  has_rehab: { combinator: 'and', rules: [{ field: 'rehab_budget', operator: 'gt', value: 0 }] },
  bridge: { combinator: 'and', rules: [{ field: 'program_strategy', operator: 'eq', value: 'bridge' }] },
  is_assignment: { combinator: 'and', rules: [{ field: 'is_assignment', operator: 'is_true' }] },
  refinance: { combinator: 'and', rules: [{ field: 'loan_purpose', operator: 'in', value: ['refinance', 'refi'] }] },
  cash_out: { combinator: 'and', rules: [{ field: 'loan_purpose', operator: 'in', value: ['cash_out', 'refinance_cash_out', 'cash_out_refinance'] }] },
  entity: { combinator: 'and', rules: [{ field: 'has_llc', operator: 'is_true' }] },
  foreign_national: { combinator: 'and', rules: [{ field: 'citizenship', operator: 'eq', value: 'foreign_national' }] },
  flood_zone: { combinator: 'and', rules: [{ field: 'in_flood_zone', operator: 'is_true' }] },
  loan_gt_1_5m: { combinator: 'and', rules: [{ field: 'loan_amount', operator: 'gt', value: 1500000 }] },
  ny_ak_hi: { combinator: 'and', rules: [{ field: 'property_state', operator: 'in', value: ['NY', 'AK', 'HI'] }] },
  // "soft" triggers that need a field the registry does not yet carry — always surface (fail-open):
  rural: {},
  non_arms_length: {},
  listed_recently: {},
  conversion: {},
  mid_construction: {},
};

// The 27 eligible jurisdictions (26 states + DC).
const ELIGIBLE_STATES = Object.freeze(['AL', 'CO', 'CT', 'DE', 'DC', 'GA', 'IL', 'IN', 'KS', 'KY', 'MD', 'MA', 'MI', 'MO', 'NV', 'NJ', 'NC', 'OH', 'OK', 'PA', 'RI', 'SC', 'TN', 'TX', 'UT', 'VA', 'WA']);
// High-volatility MSAs: a 5% LTC/LTAIV/LTARV reduction (governed by the Gold engine).
const HIGH_VOLATILITY_MSAS = Object.freeze(['Detroit-Warren-Dearborn, MI', 'Chicago-Naperville-Joliet, IL-IN-WI', 'Philadelphia-Camden-Wilmington, PA-NJ-DE-MD', 'Baltimore-Columbia-Towson, MD', 'Memphis, TN-MS-AR']);
// Approved construction-feasibility vendors (Appendix A).
const FEASIBILITY_VENDORS = Object.freeze(['Trinity', 'Granite', 'Buildzig', 'CFSI Loan Management', 'NVMS']);

// A leverage/pricing condition whose actual numbers live in the frozen Gold engine.
const gold = (over) => Object.assign({ scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always, checks: [], clears_by: 'system', pilot_template_code: null, match_quality: 'new', meta: GOVERNED_BY_GOLD }, over);

const CONDITIONS = [
  // ---------------------------------------------------------------------------------
  // PROGRAM / STRUCTURE / TERMS
  // ---------------------------------------------------------------------------------
  { cond_no: 1, name: 'ELIGIBLE BORROWING ENTITY', domain: 'entity_vesting', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Loan closed in the name of a legally formed LLC, S Corp, or C Corp in good standing and registered to do business in the property state. No loans in an individual name.',
    checks: [S('Borrowing entity is an approved LLC, S Corp, or C Corp', true), S('Entity in good standing and registered in the property state', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_llc_formation', match_quality: 'partial', source_page: 12 },
  { cond_no: 2, name: 'FIRST LIEN ONLY', domain: 'title', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Title commitment confirming the loan is in first-lien position.',
    checks: [S('First liens only', true)], clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_page: 4 },
  { cond_no: 3, name: 'MAXIMUM LOAN TERM', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Note term within the maximum initial term: 18 months for non-construction (bridge/renovation/heavy rehab); 24 months for ground-up construction.',
    checks: [S('18 months max initial term — non-construction', true), S('24 months max initial term — ground-up construction', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 4 },
  { cond_no: 4, name: 'FULL RECOURSE / INTEREST-ONLY', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Executed full repayment (recourse) guaranty; note is interest-only.',
    checks: [S('Recourse = full repayment guaranty', true), S('Amortization is interest-only', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 4 },
  gold({ cond_no: 5, name: 'MIN / MAX LOAN SIZE', domain: 'program_eligibility',
    required_evidence: 'Loan amount within Blue Lake / Gold program limits ($100,000 min to $3,000,000 max stated; the live Gold engine governs).',
    checks: [S('Min loan $100,000 (Gold-governed)', true), S('Max loan $3,000,000 (Gold-governed)', true)], source_page: 4 }),
  gold({ cond_no: 6, name: 'MAX SPONSOR LOAN EXPOSURE', domain: 'program_eligibility',
    required_evidence: 'Aggregate committed + outstanding sponsor exposure within the max ($9,999,999 stated; Gold-governed).',
    checks: [S('Max sponsor loan exposure $9,999,999', true)], source_page: 5 }),
  { cond_no: 7, name: 'LOAN AGED WITHIN 30 DAYS OF SUBMISSION', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Note date within 30 days of submission for purchase.',
    checks: [S('Originated within 30 days of submission', true)], clears_by: 'system', pilot_template_code: null, match_quality: 'new', source_page: 5 },
  { cond_no: 8, name: 'STATED EXIT STRATEGY', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'A stated exit strategy at origination (not a short-term/vacation-rental exit).',
    checks: [S('A stated exit strategy is required for all loans', true), S('Short-term / vacation-rental exit (B&B, hostel) is ineligible', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 7 },
  { cond_no: 9, name: 'INTEREST ACCRUES ON OUTSTANDING BALANCE ONLY (NO DUTCH)', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Loan accrues interest on the outstanding balance only. Interest-accruing holdbacks / Dutch loans are ineligible.',
    checks: [S('Interest on outstanding balances only; Dutch loans ineligible', true)], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 9 },
  { cond_no: 10, name: 'ACH AUTO-PAY SETUP FORM', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'A completed, borrower-signed ACH setup form authorizing automated interest payment.',
    checks: [], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 10 },
  { cond_no: 11, name: 'ELIGIBLE STATE', domain: 'state_overlay', scope: 'note_buyer', lifecycle: 'active_now',
    trigger: { combinator: 'and', rules: [{ field: 'property_state', operator: 'in', value: ELIGIBLE_STATES }] },
    required_evidence: `Property in one of the 27 eligible jurisdictions (${ELIGIBLE_STATES.join(', ')}).`,
    checks: [S('Property state is one of the 27 eligible jurisdictions', true)], clears_by: 'system', pilot_template_code: null, match_quality: 'new', source_page: 5 },

  // ---------------------------------------------------------------------------------
  // LEVERAGE / VALUATION — all governed by the live Gold engine (no forked numbers)
  // ---------------------------------------------------------------------------------
  gold({ cond_no: 20, name: 'LEVERAGE CAPS (LTC / LTAIV / LTARV)', domain: 'valuation',
    required_evidence: 'Loan within the Gold program leverage caps for the borrower tier. Stated outer maxima: LTC 93%, LTAIV 90%, LTARV 75% — the live Gold engine governs the per-tier cell.',
    checks: [S('LTC within Gold cap (outer max 93%)', true), S('LTAIV within Gold cap (outer max 90%)', true), S('LTARV within Gold cap (outer max 75%)', true)], source_page: 4 }),
  gold({ cond_no: 21, name: 'HIGH-VOLATILITY MSA — 5% LEVERAGE REDUCTION', domain: 'valuation', trigger: T.always,
    required_evidence: `In a listed high-volatility MSA, LTC/LTAIV/LTARV are reduced 5% (${HIGH_VOLATILITY_MSAS.join('; ')}). Applied by the Gold engine.`,
    checks: [S('5% LTC/LTAIV/LTARV reduction in a listed MSA (Gold-governed)', true)], source_page: 7 }),
  gold({ cond_no: 22, name: 'ASSIGNMENT FEE CAP', domain: 'valuation', trigger: T.is_assignment,
    required_evidence: 'Financeable assignment fee = the lesser of $75,000 or 15% of the original seller contract price; as-is value must support purchase price + fee; original two-party purchase agreement provided; any assignment escalated; a non-arm\'s-length transaction among the parties is ineligible. Fee math governed by the Gold engine.',
    checks: [S('Assignment fee ≤ lesser of $75,000 or 15% of the seller\'s original contract price (Gold-governed)', true), S('As-is value ≥ purchase price + assignment fee', true), S('Original two-party purchase agreement provided', true), S('Assignment escalated for review prior to purchase', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_contract', match_quality: 'partial', source_page: 8 }),
  { cond_no: 23, name: 'RECENTLY-LISTED PROPERTY VALUE HAIRCUT', domain: 'valuation', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.listed_recently,
    required_evidence: 'If the property was listed in the previous 6 months, value = the lower of the appraised value or the lowest list price.',
    checks: [S('Listed within 6 months → lower of appraised value or lowest list price', true)], clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 5 },
  { cond_no: 24, name: 'INTERESTED-PARTY CONTRIBUTIONS CAP', domain: 'seller_concession', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Interested-party contributions (brokers/realtors/sellers) limited to 3% of the total loan amount; any excess is deducted from the purchase price for structuring.',
    checks: [S('Interested-party contributions ≤ 3% of total loan amount', true), S('Excess above 3% deducted from purchase price', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 7 },
  { cond_no: 25, name: 'DELAYED-PURCHASE / CASH-OUT LIMITS', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.refinance,
    required_evidence: 'A refinance of a cash purchase within 180 days is a delayed purchase (purchase leverage; cash-out ≤ 85% of purchase price). A cash-out refinance (cash > lesser of $20,000 or 2% of loan) is allowed only where work is completed, capped at the lesser of the applicable Gold LTV or 100% of verified hard costs.',
    checks: [S('Delayed purchase = cash acquisition refinanced within 180 days', true), S('Delayed-purchase cash-out ≤ 85% of purchase price', true), S('Cash-out refi only where work completed; ≤ lesser of applicable LTV or 100% verified hard costs', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 8 },
  { cond_no: 26, name: 'INITIAL BASIS BY OWNERSHIP SEASONING', domain: 'valuation', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.refinance,
    required_evidence: 'Owned > 12 months → as-is value used in place of costs to date; owned 6–12 months with work completed → as-is value by discretionary exception.',
    checks: [S('Owned > 12 months → as-is value replaces cost basis', true), S('Owned 6–12 months with work done → as-is by exception', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 8 },
  { cond_no: 27, name: 'PROFITABLE BUSINESS PLAN (COSTS ≤ ARV)', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.has_rehab,
    required_evidence: 'For any loan with a renovation or construction component, total project costs must not exceed the ARV.',
    checks: [S('Total project costs must not exceed ARV', true)], clears_by: 'system', pilot_template_code: null, match_quality: 'new', source_page: 9 },

  // ---------------------------------------------------------------------------------
  // BORROWER — CREDIT / BACKGROUND / OFAC / IDENTITY
  // ---------------------------------------------------------------------------------
  { cond_no: 40, name: 'TRI-MERGE CREDIT REPORT', domain: 'credit', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Tri-merge credit report per guarantor, dated within 180 days of closing, with a minimum of 2 scores. FICO = the middle of 3, or the lower of 2.',
    checks: [S('Tri-merge report within 180 days of closing, min 2 scores'), S('FICO = middle of 3 (or lower of 2)')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_credit', match_quality: 'exact', source_page: 13 },
  { cond_no: 41, name: 'FICO FLOOR + TIER + DEROGATORY SEASONING', domain: 'credit', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Every guarantor ≥ 660 FICO (hard floor); 680+ needed for a standard tier; 660–679 only by approved exception. No foreclosure, bankruptcy, deed-in-lieu, or short sale within the past 48 months. Tier assignment (FICO × experience) is governed by the live Gold engine.',
    checks: [S('All guarantors ≥ 660 FICO (hard floor)', true), S('680+ required for a standard tier; 660–679 by exception (Gold-governed)', true), S('No FC / BK / DIL / short sale within 48 months', true), S('Eligibility + tiering use the highest mid-score across guarantors', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_credit', match_quality: 'partial', source_page: 14, meta: GOVERNED_BY_GOLD },
  { cond_no: 42, name: 'BACKGROUND REPORT + LIEN / JUDGMENT CLEARANCE', domain: 'background_ofac', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Background report per guarantor within 180 days of closing. Any tax lien, or any lien/judgment > $5,000, paid at closing or evidence of release. Litigation requires an LOE and purchaser approval.',
    checks: [S('Background report per guarantor within 180 days of closing'), S('Tax liens / any lien or judgment > $5,000 paid at closing or released', true), S('Ineligible: felony within 15 years, financial crimes, or liens/judgments that could supersede a mortgage', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_fraud', match_quality: 'partial', source_page: 14 },
  { cond_no: 43, name: 'OFAC — GUARANTORS, 25% MEMBERS, AND ENTITY', domain: 'background_ofac', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'OFAC search for each guarantor, each entity member with 25%+ ownership, AND the borrowing entity — all clear of the sanctioned-party list.',
    checks: [S('OFAC for each guarantor + each 25%+ member + the entity'), S('None on the sanctioned-party list')],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_fraud', match_quality: 'partial', source_page: 14 },
  { cond_no: 44, name: 'NON-ARM\'S-LENGTH TRANSACTION INELIGIBLE', domain: 'background_ofac', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.non_arms_length,
    disposition: 'concern', concern_field: 'non_arms_length_concern',
    required_evidence: 'Confirm buyer and seller have no pre-existing relationship (family, business partners, affiliated parties). Non-arm\'s-length transactions are ineligible.',
    checks: [S('No pre-existing buyer/seller relationship (non-arm\'s length is ineligible)', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_fraud', match_quality: 'partial', source_page: 8 },
  { cond_no: 45, name: 'FOREIGN-NATIONAL GUARANTOR INELIGIBLE', domain: 'identity', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.foreign_national,
    required_evidence: 'Evidence each guarantor is a U.S. permanent resident or citizen. Any non-permanent-resident guarantor makes the loan ineligible.',
    checks: [S('No non-permanent-resident (foreign national) guarantors', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_id', match_quality: 'partial', source_page: 17 },
  { cond_no: 46, name: 'GOVERNMENT ID — ALL GUARANTORS', domain: 'identity', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Government-issued ID for each guarantor / controlling party.',
    checks: [], clears_by: 'document_upload', pilot_template_code: 'rtl_p1_id', match_quality: 'exact', source_page: 27 },

  // ---------------------------------------------------------------------------------
  // EXPERIENCE / TRACK RECORD
  // ---------------------------------------------------------------------------------
  { cond_no: 60, name: 'SPONSOR EXPERIENCE + TIER', domain: 'track_record', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Track record showing a minimum of 2 completed transactions in the previous 36 months. Completed = sold OR stabilized as a rental (sale date within 36 months); active rentals held ≥ 36 months count with relevant rehab/construction experience. Tier (experience × FICO) is governed by the live Gold engine.',
    checks: [S('Minimum 2 completed transactions in the previous 36 months', true), S('Completed = sold or stabilized as a rental', true), S('Experience tier is Gold-governed', true), S('< 2 completed transactions is ineligible', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_reo', match_quality: 'partial', source_page: 13, meta: GOVERNED_BY_GOLD },
  { cond_no: 61, name: 'EXPERIENCE OWNERSHIP VERIFICATION', domain: 'track_record', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Public property records verifying the ownership entity for each project counted; guarantor held ≥ 20% equity or was a managing member; operating agreement for non-borrower entities.',
    checks: [S('Guarantor held ≥ 20% equity or was a managing member', true), S('Public property records verify ownership; non-borrower entities need the operating agreement', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_reo', match_quality: 'partial', source_page: 14 },
  { cond_no: 62, name: 'COMPARABLE-PROJECT EXPERIENCE (REHAB / CONSTRUCTION)', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.has_rehab,
    required_evidence: 'For any loan with a construction or rehabilitation budget, prior projects comparable in size and budget, within a reasonably proximate geographic area. A ground-up loan requires the minimum number of completed ground-up projects.',
    checks: [S('Prior projects comparable in size/budget and geographically proximate', true), S('Ground-up loan requires completed ground-up experience', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_reo', match_quality: 'new', source_page: 15 },

  // ---------------------------------------------------------------------------------
  // LIQUIDITY / ASSETS
  // ---------------------------------------------------------------------------------
  { cond_no: 80, name: 'SPONSOR LIQUIDITY MINIMUM', domain: 'assets_liquidity', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Liquidity ≥ cash to close + 5% of the total loan amount. If the seller sold multiple loans from the same sponsor, add 5% of the total loan amount sold in the past 12 months.',
    checks: [S('Minimum liquidity = cash to close + 5% of total loan amount', true), S('Same-sponsor aggregation: + 5% of total loan amount sold in the past 12 months', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_liq', match_quality: 'partial', source_page: 15 },
  { cond_no: 81, name: 'LIQUIDITY DOCUMENTATION + CREDITS', domain: 'assets_liquidity', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Complete account statements within 60 days of closing, for the borrowing entity, guarantor(s), or a guarantor-controlled entity. Credited: cash 100%, brokerage 80%, vested retirement 60%. Cash-out proceeds are NOT eligible liquidity.',
    checks: [S('Complete statements within 60 days of closing'), S('Credited: cash 100% / brokerage 80% / vested retirement 60%', true), S('Cash-out proceeds are not eligible liquidity', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p3_assets', match_quality: 'partial', source_page: 15 },

  // ---------------------------------------------------------------------------------
  // ENTITY / GUARANTY
  // ---------------------------------------------------------------------------------
  { cond_no: 100, name: 'ENTITY REVIEW — LLC DOCUMENTS', domain: 'entity_vesting', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.entity,
    required_evidence: 'Fully executed operating agreement (all amendments/exhibits) naming authorized signers; entity agreements for members ≥ 25%; certificate of good standing; articles/certificate of formation from the formation state (and the property state if different); any consents/resolutions; entity background + OFAC.',
    checks: [S('Executed operating agreement naming authorized signers'), S('Entity agreements for members ≥ 25% ownership', true), S('Good standing + articles of formation (formation state, and property state if different)'), S('Entity background check + OFAC')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_llc_opagmt', match_quality: 'partial', source_page: 15 },
  { cond_no: 101, name: 'ENTITY REVIEW — CORPORATION DOCUMENTS', domain: 'entity_vesting', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.entity,
    required_evidence: 'For an S/C corp: executed bylaws (amendments/exhibits) naming authorized signers; entity agreements for members ≥ 25%; good standing; most recent officer/director elections; minutes or stock certificates; articles of incorporation (formation state, and property state if different); consents/resolutions/minutes; entity background + OFAC.',
    checks: [S('Executed bylaws + officer/director elections + minutes/stock certificates', true), S('Entity agreements for members ≥ 25%', true), S('Good standing + articles of incorporation; entity background + OFAC')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_llc_formation', match_quality: 'partial', source_page: 16 },
  { cond_no: 102, name: 'GUARANTOR REQUIREMENT (25% / 51% RULE)', domain: 'entity_vesting', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.entity,
    required_evidence: 'Any member with 25%+ ownership must be a guarantor; if none, a combination of guarantors totaling 51%+ ownership. Only equity owners may guaranty. Any liquidity / track record / credit used for qualifying must be tied to a guarantor.',
    checks: [S('Any member ≥ 25% must be a guarantor', true), S('If no 25%+ member, guarantors totaling ≥ 51%', true), S('Only equity owners may guaranty; qualifying factors must tie to a guarantor', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_investorstruct', match_quality: 'new', source_page: 16 },
  { cond_no: 103, name: 'W9 / EIN — ENTITY', domain: 'entity_vesting', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.entity,
    required_evidence: 'Entity W9 / EIN letter.',
    checks: [], clears_by: 'document_upload', pilot_template_code: 'rtl_llc_ein', match_quality: 'exact', source_page: 27 },

  // ---------------------------------------------------------------------------------
  // PROPERTY ELIGIBILITY
  // ---------------------------------------------------------------------------------
  { cond_no: 120, name: 'ELIGIBLE PROPERTY TYPE', domain: 'property', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Appraisal confirms 4 units or fewer, non-owner-occupied, residential, and one of: SFR, 2–4 unit, warrantable condo, PUD, townhome.',
    checks: [S('4 units or fewer, non-owner-occupied, residential', true), S('Eligible: SFR / 2–4 unit / warrantable condo / PUD / townhome', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_appraisaldocs', match_quality: 'partial', source_page: 11 },
  { cond_no: 121, name: 'INELIGIBLE PROPERTY TYPES / USES', domain: 'property', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Confirm the property is not an ineligible type/use: 5+ units; owner-occupied; mobile/manufactured; agricultural/farm/industrial; co-ops; timeshares; vacant land (unless ground-up during term); log cabins; geodesic domes; condotels/resort; ground-lease; adverse environmental; earthen homes; in litigation; zoning violations; purchase-option; fractional ownership; unique/assisted-living/non-profit; native American land; condos over 6 stories; rural; short-term rentals; SRO; rehab/care facilities; hospitality.',
    checks: [S('Not an ineligible property type or use per the guideline list', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_appraisaldocs', match_quality: 'partial', source_page: 11 },
  { cond_no: 122, name: 'NON-OWNER-OCCUPIED (AFFIDAVIT)', domain: 'occupancy', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Occupancy affidavit confirming the property is and was non-owner-occupied by the borrower, equitable owners (direct and indirect), and their immediate families. A previously borrower-occupied property is ineligible.',
    checks: [S('Non-owner-occupied by borrower, equitable owners, and immediate families', true), S('Previously borrower-occupied is ineligible', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 11 },
  { cond_no: 123, name: 'RURAL PROPERTY INELIGIBLE', domain: 'property', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.rural,
    disposition: 'appraisal', concern_field: 'appraisal_rural',
    required_evidence: 'Appraisal review confirming the property is not rural. Rural = any of: rural designation on the appraisal; zoned agricultural; solely gravel/dirt road access; 2 of 3 comps > 5 miles away; subject/comps lot > 10 acres; outbuildings / large storage sheds.',
    checks: [S('Not rural per the guideline criteria', true)], clears_by: 'third_party_order', pilot_template_code: null, match_quality: 'new', source_page: 6 },
  { cond_no: 124, name: 'BRIDGE PROPERTY CONDITION C4 OR BETTER', domain: 'property', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.bridge,
    required_evidence: 'For a bridge loan with no construction financed, appraisal condition rating C4 or better.',
    checks: [S('Bridge (no construction) property condition ≥ C4', true)], clears_by: 'third_party_order', pilot_template_code: null, match_quality: 'new', source_page: 7 },
  { cond_no: 125, name: 'PROPERTY-USE CONVERSION RULES', domain: 'property', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.conversion,
    required_evidence: 'A change of use requires escalation AND appraiser confirmation it meets zoning. Condo conversions must be jurisdiction-approved prior to origination. Only residential-to-residential conversions are permitted; commercial conversions are ineligible.',
    checks: [S('Conversion escalated + appraiser zoning confirmation', true), S('Condo conversion jurisdiction-approved pre-origination', true), S('Residential-to-residential only; commercial conversions ineligible', true)],
    clears_by: 'third_party_order', pilot_template_code: null, match_quality: 'new', source_page: 10 },

  // ---------------------------------------------------------------------------------
  // TITLE / CLOSING PROTECTION
  // ---------------------------------------------------------------------------------
  { cond_no: 140, name: 'TITLE POLICY FORM + COVERAGE', domain: 'title', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'ALTA extended lender\'s policy with mechanic\'s-lien coverage; ISAOA/ATIMA (or equivalent) assignability; coverage amount equal to the maximum loan amount.',
    checks: [S('ALTA extended lender\'s policy with mechanic\'s-lien coverage', true), S('ISAOA/ATIMA (or equivalent) assignability', true), S('Coverage = maximum loan amount', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_page: 21 },
  { cond_no: 141, name: 'TITLE SCHEDULE A REQUIREMENTS', domain: 'title', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Schedule A shows the committed loan amount, loan number, property address, complete borrower vesting, complete lender vesting; effective date within 90 days of funding; purchase = current vested owner executes the contract/deed; refi = vested owner is the borrowing entity; legal description matches the loan docs.',
    checks: [S('Effective date within 90 days of funding', true), S('Vesting matches the transaction (purchase vs refi)', true), S('Legal description matches the loan docs')],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_page: 21 },
  { cond_no: 142, name: 'TITLE SCHEDULE B CLEARANCE', domain: 'title', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Schedule B-I: all non-standard requirements risking priority removed. Schedule B-II: free of liens/fees/fines and disputes (bankruptcy, foreclosure, probate, third-party); taxes due within 60 days paid at closing per HUD; only customary recordings (easements, CC&Rs, taxes not yet due) remain.',
    checks: [S('B-I: all priority-risk requirements removed', true), S('B-II: free of liens and disputes; near-term taxes paid at closing', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_page: 21 },
  { cond_no: 143, name: 'TITLE INDEMNITY ENDORSEMENT (PRE-CLOSING WORK)', domain: 'title', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.has_rehab,
    required_evidence: 'For any work performed prior to closing, an indemnity endorsement (varies by state; commonly endorsement 32 or ALTA 14) protecting lien priority.',
    checks: [S('Indemnity endorsement for pre-closing work (broken priority)', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_title', match_quality: 'new', source_page: 22 },
  { cond_no: 144, name: 'SINGLE PARCEL / NO CROSS-COLLATERAL', domain: 'title', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Secured by a single parcel; no cross-collateralization; no partial releases; a subdivision during the term must be repaid in full through a single payoff.',
    checks: [S('Single parcel; no cross-collateralization', true), S('No partial releases; subdivision → single full payoff', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_title', match_quality: 'partial', source_page: 13 },
  { cond_no: 145, name: 'CLOSING PROTECTION LETTER', domain: 'title', scope: 'note_buyer', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'A Closing Protection Letter in the closing set.',
    checks: [], clears_by: 'attorney_closing', pilot_template_code: 'rtl_cond_settlement', match_quality: 'partial', source_page: 28 },

  // ---------------------------------------------------------------------------------
  // APPRAISAL / VALUATION REPORT
  // ---------------------------------------------------------------------------------
  { cond_no: 160, name: 'VALUATION REPORT — TYPE, DATING, STANDARDS', domain: 'appraisal', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Approved-vendor valuation for every loan. Type by loan amount: ≤ $400,000 full or hybrid/DVI (full required if renovation/construction > 20% of the as-is purchase price); > $400,000 full appraisal. Dated within 90 days of closing (or 120 with recertification by the original appraiser); USPAP & FIRREA compliant; not transferred or assigned.',
    checks: [S('Correct report type by loan amount (≤ $400k full/hybrid, > $400k full)', true), S('Full appraisal if reno/construction > 20% of as-is purchase price (≤ $400k)', true), S('Dated within 90 days (or 120 with recert); USPAP & FIRREA; not transferred/assigned', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_appraisaldocs', match_quality: 'partial', source_page: 20 },
  { cond_no: 161, name: 'APPRAISAL COMP + ADJUSTMENT STANDARDS', domain: 'appraisal', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'As-is value with ≥ 3 sold comps and ARV (if applicable) with ≥ 3 sold comps; 2 of 3 within 5 miles; 3 primary comps sold within the previous 12 months; net/gross adjustments < 15%/25% for ≥ 2 of 3; a declining market needs ≥ 1 comp sold within 90 days.',
    checks: [S('As-is ≥ 3 sold comps; ARV ≥ 3 sold comps'), S('2 of 3 comps within 5 miles', true), S('3 primary comps sold within 12 months', true), S('Net/gross adjustments < 15%/25% for ≥ 2 of 3', true)],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_appraisaldocs', match_quality: 'partial', source_page: 20 },

  // ---------------------------------------------------------------------------------
  // INSURANCE
  // ---------------------------------------------------------------------------------
  { cond_no: 180, name: 'HAZARD INSURANCE', domain: 'insurance_hazard', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Hazard policy with dwelling coverage = appraiser replacement cost (or the hybrid/DVI formula: 80% of As-Is for bridge, 80% of ARV for renovation); mortgagee clause ISAOA/ATIMA; proof the premium is paid if not shown on the HUD.',
    checks: [S('Dwelling coverage = replacement cost (or 80% As-Is bridge / 80% ARV renovation)', true), S('Mortgagee clause ISAOA/ATIMA'), S('Proof of premium paid if not on the HUD')],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_insurance', match_quality: 'partial', source_page: 23 },
  { cond_no: 181, name: 'BUILDERS RISK + GENERAL LIABILITY (GROUND-UP / HEAVY REHAB)', domain: 'insurance_hazard', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.ground_up_or_heavy,
    required_evidence: 'For ground-up construction OR heavy rehab: Builders Risk = budgeted hard costs, and General Liability $1,000,000 per occurrence / $2,000,000 aggregate ($1,000,000 aggregate acceptable only if the agent cannot exceed it). If demolition, hazard is not required on the existing dwelling.',
    checks: [S('Builders Risk = budgeted hard costs', true), S('General Liability $1M per occurrence / $2M aggregate', true), S('$1M aggregate acceptable only if the agent cannot exceed it', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_cond_insurance', match_quality: 'new', source_page: 23 },
  { cond_no: 182, name: 'FLOOD DETERMINATION + FLOOD INSURANCE', domain: 'flood', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Flood-zone determination certificate matching the loan address; if in a special flood hazard area, flood insurance and the signed Notice of Special Flood Hazards.',
    checks: [S('Flood cert matches the loan address'), S('Flood insurance if in a special flood hazard area')],
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_flood', match_quality: 'exact', source_page: 27 },

  // ---------------------------------------------------------------------------------
  // CONSTRUCTION / FEASIBILITY (ground-up + heavy rehab per owner) + rehab budget
  // ---------------------------------------------------------------------------------
  { cond_no: 200, name: 'CONSTRUCTION FEASIBILITY REPORT (GROUND-UP / HEAVY REHAB)', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.ground_up_or_heavy,
    required_evidence: `A third-party feasibility report from an approved vendor (${FEASIBILITY_VENDORS.join(', ')}) with site inspection + photos and a budget assessment. Budget line items within a 10% variance to the report (if no variance is given, all line items are acceptable).`,
    checks: [S('Feasibility report from an approved vendor (ground-up or heavy rehab)', true), S('Site inspection with photos + budget assessment', true), S('Budget line items within 10% variance to the feasibility report', true)],
    // Dedicated feasibility-report condition (db/285) — NOT the SOW code, so the
    // overlay fires a FATAL coverage gap when a ground-up/heavy file has no
    // third-party feasibility-report condition (owner: "pop up something big").
    clears_by: 'third_party_order', pilot_template_code: 'rtl_cond_feasibility', match_quality: 'exact', source_page: 5 },
  { cond_no: 201, name: 'CONSTRUCTION BUDGET (EXCEL) + CONTINGENCY', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.has_rehab,
    required_evidence: 'A line-item budget in Excel with a narrative scope, hard/soft costs by line item, and a contingency: minimum 7% for ground-up / heavy rehab, minimum 5% for renovation. An ADU is broken out separately.',
    checks: [S('Line-item budget in Excel with narrative scope', true), S('Contingency ≥ 7% (ground-up / heavy rehab) or ≥ 5% (renovation)', true), S('ADU broken out separately', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_budget', match_quality: 'partial', source_page: 25 },
  { cond_no: 202, name: 'CONSTRUCTION TIMELINE / SCHEDULE', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.ground_up_or_heavy,
    required_evidence: 'A budget > $500,000 requires a milestone timeline (permits, demo, foundation, framing, mechanicals, drywall, Certificate of Occupancy); under $500,000 requires a completion date / project duration.',
    checks: [S('Budget > $500,000 → milestone timeline', true), S('Budget ≤ $500,000 → completion date / duration', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 25 },
  { cond_no: 203, name: 'PLANS & PERMITS (GROUND-UP)', domain: 'construction_feasibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.ground_up,
    required_evidence: 'Architectural/structural/MEP plans and permits if applicable. On a purchase, permits may be obtained after closing but NO construction draws are released until permits are received.',
    checks: [S('Plans (architectural/structural/MEP) + permits if applicable', true), S('No construction draws until permits received', true)],
    clears_by: 'document_upload', pilot_template_code: 'rtl_p1_plans', match_quality: 'partial', source_page: 25 },
  gold({ cond_no: 204, name: 'INTEREST RESERVE — CONSTRUCTION / REHAB', domain: 'construction_feasibility', trigger: T.has_rehab,
    required_evidence: 'Interest-reserve treatment is governed by the live Gold engine: ground-up requires a full-term reserve (Tier 1 may elect none under limits); renovation / heavy rehab reserves come out of initial proceeds and are NOT in the cost basis.',
    checks: [S('Interest reserve rules are Gold-governed (full-term ground-up; reno/heavy not in cost basis)', true)], source_page: 9 }),

  // ---------------------------------------------------------------------------------
  // ESCALATION / EXCEPTIONS / PROJECT AGGREGATION (advisory — routes to review, never a block)
  // ---------------------------------------------------------------------------------
  { cond_no: 220, name: 'ESCALATION TRIGGERS (CREDIT COMMITTEE)', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Identify whether the loan hits an escalation trigger; if so, escalated review + explicit purchaser approval before purchase. Triggers: loan > $1,500,000; renovation budget > AIV or > $250,000; construction budget > $1,000,000; adverse markets; cash-out proceeds > $250,000; change of density/use (conversion); property in NY/AK/HI; any exception.',
    checks: [S('Loan > $1,500,000', true), S('Renovation budget > AIV or > $250,000', true), S('Construction (ground-up) budget > $1,000,000', true), S('Cash-out proceeds > $250,000', true), S('NY / AK / HI, or a change of density/use', true)],
    clears_by: 'system', pilot_template_code: null, match_quality: 'new', source_page: 18 },
  { cond_no: 221, name: 'PROJECT AGGREGATION + 4-LOAN CAP', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Related loans (same guarantor(s) / ≥ 50% common control; contiguous/closely-situated lots; same approach and exit; closings within a 60-day period) are evaluated in aggregate. More than 1 loan in a project escalates; more than 4 loans is ineligible.',
    checks: [S('Project loans evaluated on aggregate exposure', true), S('More than 1 loan in a project escalates', true), S('More than 4 loans in a project is ineligible', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 6 },
  { cond_no: 222, name: 'MID-CONSTRUCTION / STAGNANT-REFI / DEFAULT-PAYOFF INELIGIBILITY', domain: 'program_eligibility', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'Confirm the loan is not: a mid-construction loan (borrower-owned with work in progress at origination, unless there is no current lender or it refinances a purchaser-owned loan); a stagnant internal refinance (no project progress, e.g. bridge-to-bridge or undrawn construction — land-for-ground-up refis are allowed); or a payoff showing default interest / legal fees / default indicators.',
    checks: [S('Not a mid-construction loan (borrower-owned, work in progress)', true), S('Not a stagnant no-progress balance-sheet refinance', true), S('Payoff demand shows no default interest / legal fees / default indicators', true)],
    clears_by: 'document_upload', pilot_template_code: null, match_quality: 'new', source_page: 10 },

  // ---------------------------------------------------------------------------------
  // CLOSING-SET DOCUMENTS (pre-close package items held for the closing/attorney stage)
  // ---------------------------------------------------------------------------------
  { cond_no: 240, name: 'PURCHASE CONTRACT + ASSIGNMENTS', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'active_now', trigger: T.always,
    required_evidence: 'All purchase contracts, addendums, and assignments provided (for a refinance, the original HUD / proof of prior purchase price and date).',
    checks: [], clears_by: 'document_upload', pilot_template_code: 'rtl_p1_contract', match_quality: 'partial', source_page: 8 },
  { cond_no: 241, name: 'BUSINESS-PURPOSE / NON-OWNER-OCCUPANCY CERTIFICATE', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'hold_attorney_closing', trigger: T.always,
    required_evidence: 'Borrower signs the business-purpose / non-owner-occupancy certificate at closing.',
    checks: [], clears_by: 'attorney_closing', pilot_template_code: 'rtl_cond_disclosures', match_quality: 'partial', source_page: 28 },

  // ---------------------------------------------------------------------------------
  // POST-CLOSE — set aside for the future post-closing build (kept, not evaluated now)
  // ---------------------------------------------------------------------------------
  { cond_no: 900, name: 'DISBURSEMENT / DATE-DOWN ENDORSEMENTS (DRAWS)', domain: 'title', scope: 'note_buyer', lifecycle: 'defer_post_closing', trigger: T.has_rehab,
    required_evidence: 'Disbursement / date-down title endorsements ordered over the life of the loan as draws are requested (ground-up & heavy rehab at 25/50/75/100% of the holdback; renovation at 50% and 100% or completion). Charged at closing.',
    checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_page: 22, meta: { phase: 'post_close' } },
  { cond_no: 901, name: 'FINAL CLOSING SET (POST-CLOSE)', domain: 'closing_docs', scope: 'note_buyer', lifecycle: 'defer_post_closing', trigger: T.always,
    required_evidence: 'Post-close: final HUD, note, mortgage/deed of trust, personal guaranty, loan agreement, environmental indemnity, title policy, business-purpose/non-owner-occupancy, ACH form.',
    checks: [], clears_by: 'attorney_closing', pilot_template_code: null, match_quality: 'new', source_page: 28, meta: { phase: 'post_close' } },
];

// -------------------------------------------------------------------------------------
// Pure applicability helpers (mirror corrfirst-fnf-spec so the seed + tests are uniform).
// -------------------------------------------------------------------------------------
function appliesToNoteBuyer(cond, noteBuyerKey) {
  if (!cond || typeof cond !== 'object') return false;
  if (cond.scope === 'all_note_buyers' || cond.scope === 'all_but_note_buyer_limits') return true;
  if (cond.scope === 'note_buyer') return String(noteBuyerKey || '').toLowerCase().replace(/[^a-z0-9]/g, '') === NOTE_BUYER;
  return false;
}
function limitsApplyToNoteBuyer(cond, noteBuyerKey) {
  if (!cond) return false;
  if (cond.scope === 'all_note_buyers') return true;
  return String(noteBuyerKey || '').toLowerCase().replace(/[^a-z0-9]/g, '') === NOTE_BUYER;
}
function activeConditions() { return CONDITIONS.filter((c) => c.lifecycle === 'active_now'); }
function applicableFor(noteBuyerKey, opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  return CONDITIONS.filter((c) => appliesToNoteBuyer(c, noteBuyerKey) && (o.includeDeferred || c.lifecycle === 'active_now'));
}
/** goldGoverned() → the conditions whose numbers defer to the live Gold engine (no forked value). */
function goldGoverned() { return CONDITIONS.filter((c) => c.meta && c.meta.governed_by === 'gold_program'); }

const SCOPES = Object.freeze(['all_note_buyers', 'note_buyer', 'all_but_note_buyer_limits']);
const LIFECYCLES = Object.freeze(['active_now', 'hold_attorney_closing', 'defer_post_closing', 'closing_phase']);
const CLEARS_BY = Object.freeze(['document_upload', 'internal_verification', 'third_party_order', 'attorney_closing', 'system']);

module.exports = {
  PRODUCT, NOTE_BUYER, NOTE_BUYER_NAME, SOURCE_VERSION, SOURCE_TITLE,
  CONDITIONS,
  ELIGIBLE_STATES, HIGH_VOLATILITY_MSAS, FEASIBILITY_VENDORS,
  appliesToNoteBuyer, limitsApplyToNoteBuyer, activeConditions, applicableFor, goldGoverned,
  SCOPES, LIFECYCLES, CLEARS_BY, TRIGGERS: T,
};
