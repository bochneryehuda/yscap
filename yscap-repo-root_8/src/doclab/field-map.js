'use strict';
/**
 * PILOT → DOCLAB FIELD MAP — where every DocLab variable comes from.
 *
 * This is the mapping exercise DocLab's own integration plan calls the one activity
 * "expected to result in re-work if not done aptly". It is DATA, not code: one row
 * per DocLab variable, saying which PILOT value feeds it, how, and — where nothing
 * feeds it yet — exactly what is missing. `payload.js` walks this table; nothing
 * else may decide where a variable's value comes from.
 *
 * `status` is the whole point of the file:
 *   'mapped'       — a PILOT value feeds it today, and `source` names it.
 *   'derived'      — computed from PILOT values by a named rule in payload.js.
 *   'needs_source' — DocLab wants it, PILOT does not hold it yet. NEVER guessed.
 *   'needs_config' — a standing fact about YS Capital that belongs in settings.
 *   'needs_rule'   — PILOT holds the ingredients but the business rule is a legal
 *                    choice nobody has made yet. Also never guessed.
 *   'out_of_scope' — DSCR-only, so this build never sends it.
 *
 * A 'needs_*' row is not a TODO comment — it is the reason `payload.js` can report
 * an honest, itemised "here is what is still missing" instead of quietly submitting
 * a package with holes in it. Turning one into 'mapped' is the unit of progress on
 * this integration.
 *
 * ────────────────────────────────────────────────────────────────────────────────
 * THREE TRAPS THAT WOULD PUT THE WRONG THING ON A RECORDED DOCUMENT. Read these
 * before touching a row; every one of them is a word PILOT and DocLab both use for
 * different things.
 *
 * 1. "LENDER" IS THREE DIFFERENT THINGS HERE, AND ONE OF THEM IS SECRET.
 *      · `template.lender_name`  — the name our TEMPLATES are filed under at PLL.
 *        A routing key, not a party. Config, never a file value.
 *      · `variables.lender_name` — the legal entity that MAKES the loan and whose
 *        name is printed on the note and the mortgage. YS Capital. Config.
 *      · `applications.lender`   — PILOT's NOTE BUYER / capital partner (Fidelis,
 *        Blue Lake, EMCAP). This is NOT the lender on the documents, it is who buys
 *        the note afterwards, and this repo's standing rule is that its name never
 *        reaches a borrower-facing surface. A loan document IS a borrower-facing
 *        surface. **`applications.lender` MUST NEVER FEED ANY DocLab FIELD.**
 *        The test asserts it appears in no `source` in this file.
 *
 * 2. `underwriter` IS THE TITLE UNDERWRITER, NOT OUR UNDERWRITER. The per-template
 *    matrix spells it out: "The name of the title underwriter issuing the loan
 *    policy" — Fidelity National, First American, Old Republic. PILOT has a staff
 *    role literally called `underwriter`, and wiring that in would print the name
 *    of the person who approved the credit onto a title clause.
 *
 * 3. `state_abbrev` IS NOT THE STATE. The global data dictionary says "Two-letter
 *    abbreviation of the state (e.g. NY)" — and it is WRONG, or at least stale. The
 *    per-template matrix says "Abbreviation for the state department of
 *    environmental protection (e.g. CADEP, NYDEP, TXDEP)", and their own master
 *    payload sends `"FLDEP - Florida Department of Environmental Protection"` with
 *    the comment "Must be a value from provided list of environmental options". Two
 *    of their three sources agree it is an environmental-agency code, and one of
 *    those is a live example. Sending "NY" would merge the wrong text into an
 *    environmental-indemnity clause. We do not have the list, so this stays
 *    `needs_source` — the one place where the safest reading of the documentation
 *    is to send nothing and ask.
 * ────────────────────────────────────────────────────────────────────────────────
 */

const catalog = require('./catalog');

/**
 * `file` below refers to the shape `payload.js` is handed — the loaded view of a
 * loan file. It is deliberately the SAME shape `lib/closing-prep.js` already builds
 * (`getClosingPrepData`), because that module solves the identical problem for the
 * identical step: telling the closing attorney everything they need to draft. The
 * two must never disagree about what a file says.
 */
const FIELDS = Object.freeze([

  /* ───────────────────────── template selection (root) ───────────────────────── */
  { key: 'template.lender_name', status: 'needs_config', group: 'template',
    source: 'cfg.doclab.templateLenderName',
    note: 'The name OUR templates are filed under at PLL. A routing key. PLL tells us the exact string; it is not necessarily our legal name and it is not the note buyer.' },
  { key: 'template.loan_category', status: 'needs_rule', group: 'template',
    source: 'applications.program / loan_type / rehab_type + construction_holdback',
    note: 'PILOT knows bridge vs rehab vs ground-up and whether there is a holdback; the mapping onto DocLab\'s category names is a decision (docs/doclab/DOCLAB-INTEGRATION-BLUEPRINT.md). Never inferred silently.' },
  { key: 'template.state', status: 'mapped', group: 'template',
    source: 'applications.property_address.state',
    note: 'The SUBJECT PROPERTY state — it selects the security instrument (deed of trust vs mortgage vs deed to secure debt), so it is the property\'s state, never the borrower\'s or ours.' },

  /* ─────────────────────────────── other root fields ─────────────────────────── */
  { key: 'requestId', status: 'derived', group: 'root',
    source: 'doclab_requests.doclab_request_id',
    note: 'Absent creates a new request; present updates that one. Sending a stale one silently overwrites another loan.' },
  { key: 'auto_approve', status: 'needs_rule', group: 'root', source: 'cfg.doclab.autoApprove',
    note: 'true skips the separate approve call and goes straight to generating Word documents. Whether we want a human beat before that is an owner decision.' },
  { key: 'auto_approve_pdf', status: 'needs_rule', group: 'root', source: 'cfg.doclab.autoApprovePdf',
    note: 'true also generates the PDF in the same request. Their Create page: do NOT also call the PDF endpoint when this is set.' },
  { key: 'license_type', status: 'needs_rule', group: 'root',
    source: 'GET /getLenderCategory → state.licenseNeeded + our licence position',
    note: '10 = licensed, 20 = exception, null = not required. DocLab reports whether the STATE needs one; which of 10/20 we are is a fact about our licensing, per state.' },
  { key: 'prepayment_option_code', status: 'derived', group: 'root',
    source: 'scope.rtlPrepaymentCode() → "RTL-No"',
    note: 'Required by DocLab even when there is no penalty. RTL always asks for NO penalty, validated against the live per-state list.' },

  /* ──────────────────────────────── the borrower ──────────────────────────────── */
  { key: 'borrower_name', status: 'mapped', group: 'borrowers', array: 'borrowers',
    source: 'llcs.llc_name (vesting entity) — else borrowers.full_name on a personal-name purchase',
    note: 'The BORROWING ENTITY, not the human. `lib/vesting-label.isIndividual()` is the one place that decides which.' },
  { key: 'borrower_state', status: 'mapped', group: 'borrowers', array: 'borrowers',
    source: 'llcs.formation_state',
    note: 'Where the entity was FORMED — not where it operates and not where the property is.' },
  { key: 'borrower_address', status: 'mapped', group: 'borrowers', array: 'borrowers',
    source: 'borrowers.current_address (the entity\'s notice address)',
    note: 'PILOT holds no separate mailing address for the entity, so the borrower\'s own address is used. Worth confirming with counsel that this is what the notice clause should say.' },
  { key: 'borrower_title', status: 'needs_source', group: 'borrowers', array: 'borrowers',
    source: null,
    note: 'The borrower\'s role — "Managing Member", "President". PILOT records ownership percentage but never a title.' },
  { key: 'signatory_name', status: 'mapped', group: 'borrowers', array: 'borrowers.signatories',
    source: 'borrowers.full_name of every member on llc_borrowers',
    note: 'Who signs for the entity. On a personal-name purchase, the borrower themself.' },
  { key: 'signatory_title', status: 'needs_source', group: 'borrowers', array: 'borrowers.signatories',
    source: null,
    note: 'Same gap as borrower_title, and this one is printed on the signature block of every document.' },

  /* ─────────────────────────────── entity character ─────────────────────────────── */
  { key: 'type_of_organization', status: 'needs_source', group: 'entity',
    source: null,
    note: 'THE BIGGEST GAP. PILOT has no LLC-vs-Corporation-vs-Trust-vs-Partnership field — the table is literally named `llcs` and assumes one answer. Five DocLab variables hang off it.' },
  { key: 'acknowledgement_corporate_status', status: 'needs_source', group: 'entity',
    source: 'derived from type_of_organization',
    note: '"operating agreement and its members" for an LLC, "bylaws and its shareholders" for a corporation. Blocked on the gap above.' },
  { key: 'bylaws_operating_agreement', status: 'needs_source', group: 'entity',
    source: 'derived from type_of_organization',
    note: 'Must be exactly "bylaws" or "operating agreement". Blocked on the gap above.' },
  { key: 'operating_agreement_or_bylaws', status: 'needs_source', group: 'entity',
    source: 'derived from type_of_organization', note: 'Same value, second variable name. DocLab carries both.' },
  { key: 'membership_interest_percentage', status: 'mapped', group: 'entity',
    source: 'llc_borrowers.ownership_pct (per member)',
    note: 'Only meaningful for an LLC. A corporation wants number_of_shares instead.' },
  { key: 'number_of_shares', status: 'needs_source', group: 'entity', source: null,
    note: 'Corporations only. PILOT records percentages, never share counts.' },
  { key: 'certificate_number', status: 'needs_source', group: 'entity', source: null,
    note: 'The stock/membership certificate pledged. Comes off the certificate itself at closing.' },
  { key: 'written consent', status: 'needs_config', group: 'entity',
    source: 'a standing sentence of boilerplate',
    note: 'Their master payload sends a fixed resolution sentence. Note the SPACE in the key — it is not a typo on our side.' },

  /* ─────────────────────────── guarantors and pledgors ─────────────────────────── */
  { key: 'guarantor_name', status: 'mapped', group: 'guarantors', array: 'guarantors',
    source: 'borrowers.full_name for the borrower and co-borrower',
    note: 'The individuals behind the entity. Honour applications.co_borrower_pg_waived — an approved waiver means the co-borrower is a member but NOT a guarantor.' },
  { key: 'guarantor_address', status: 'mapped', group: 'guarantors', array: 'guarantors',
    source: 'borrowers.current_address',
    note: 'Their migration note flags this as newly required by some documents.' },
  { key: 'guarantor_title', status: 'needs_source', group: 'guarantors', array: 'guarantors', source: null,
    note: 'Optional; blank for an individual guarantor.' },
  { key: 'guarantor_or_collectively_the_guarantor', status: 'derived', group: 'guarantors',
    source: 'count of guarantors',
    note: 'Exactly "the Guarantor" for one, "collectively the Guarantor" for more.' },
  { key: 'individual_jointly_and_severally', status: 'derived', group: 'guarantors',
    source: 'count of guarantors',
    note: 'Exactly "individually" for one, "jointly and severally" for more.' },
  { key: 'pledgor', status: 'mapped', group: 'guarantors',
    source: 'the members of the borrowing entity (llc_borrowers → borrowers.full_name)',
    note: 'Whoever pledges their interest in the entity. The matrix says there should be one per member so the pledge is complete.' },
  { key: 'pledgor_address', status: 'mapped', group: 'guarantors', source: 'borrowers.current_address' },
  { key: 'pledgor_or_collectively_the_pledgor', status: 'derived', group: 'guarantors',
    source: 'count of pledgors', note: 'Exactly "the Pledgor" or "collectively the Pledgor".' },

  /* ──────────────────────────── the collateral property ──────────────────────────── */
  { key: 'collateral_property_address', status: 'mapped', group: 'property', array: 'collateral_properties',
    source: 'applications.property_address (USPS-verified form)',
    note: 'Use the USPS-imported address when the file has one — the same rule the closing-prep order already applies.' },
  { key: 'collateral_property_state', status: 'mapped', group: 'property', array: 'collateral_properties',
    source: 'applications.property_address.state' },
  { key: 'collateral_property_county', status: 'needs_source', group: 'property', array: 'collateral_properties',
    source: null,
    note: 'PILOT stores no county. It is on the title commitment and in the appraisal; it is also what the recording office is keyed on, so it cannot be skipped.' },
  { key: 'collateral_property_city', status: 'mapped', group: 'property', array: 'collateral_properties',
    source: 'applications.property_address.city' },
  { key: 'collateral_property_town', status: 'mapped', group: 'property', array: 'collateral_properties',
    source: 'applications.property_address.city',
    note: 'Their master payload sends town and city as separate keys with different values. We send the same city for both unless PLL tells us they differ.' },
  { key: 'collateral_property_name', status: 'out_of_scope', group: 'property', array: 'collateral_properties',
    source: null, note: 'DSCR-only per the matrix.' },
  { key: 'property_street_address', status: 'out_of_scope', group: 'property', source: null,
    note: 'DSCR-only per the matrix. RTL uses collateral_property_address.' },
  { key: 'property_town', status: 'mapped', group: 'property', source: 'applications.property_address.city' },
  { key: 'legal_description', status: 'needs_source', group: 'property', source: null,
    note: 'Metes and bounds, off the title commitment. PILOT holds the title document but has never parsed the legal description out of it.' },
  { key: 'legal_description_image', status: 'needs_source', group: 'property', source: null,
    note: 'Their migration note: the same value as legal_description, OR a URL to an external Word document. The URL route may be the practical answer for a long description.' },
  { key: 'section_number', status: 'needs_source', group: 'property', source: null,
    note: 'NY BUILDING LOAN AND CEMA ONLY. Off the tax map / title commitment.' },
  { key: 'block_number', status: 'needs_source', group: 'property', source: null, note: 'NY building loan and CEMA only.' },
  { key: 'lot_number', status: 'needs_source', group: 'property', source: null, note: 'NY building loan and CEMA only.' },
  { key: 'district_number', status: 'needs_source', group: 'property', source: null, note: 'NY building loan and CEMA only.' },

  /* ─────────────────────────────── the money ─────────────────────────────── */
  { key: 'loan_amount', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.sizing.totalLoan',
    note: 'The REGISTERED structure is the authority, never a re-derivation. Frozen-engine rule.' },
  { key: 'initial_advance', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.sizing.initialAdvance',
    note: 'The matrix describes it as the loan amount less the construction holdback, which is what the engine already sizes.' },
  { key: 'initial_advance_upon_closing', status: 'out_of_scope', group: 'money',
    source: null, note: 'Same figure under a second name; DSCR columns only per the matrix.' },
  { key: 'construction_holdback', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.sizing.rehabHoldback',
    note: 'Required by every holdback / building-loan template.' },
  { key: 'amount_at_closing', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.sizing (initial advance net of closing costs)',
    note: 'The matrix: "the net amount of funds available to Borrower after all fees and costs are netted, including the Construction Holdback (if any)". Compute from the frozen quote, never re-derive the sizing.' },
  { key: 'borrower_contribution', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.cashToClose',
    note: 'NY building loan and CEMA. What the borrower puts in from their own funds.' },
  { key: 'interest_rate', status: 'mapped', group: 'money', source: 'product_registrations.note_rate',
    note: 'Their master payload sends a bare number ("5.2"), no percent sign.' },
  { key: 'interest_reserve', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.sizing.financedReserve' },
  { key: 'monthly_payment', status: 'mapped', group: 'money',
    source: 'product_registrations.quote.sizing.monthlyPayment' },
  { key: 'loan_to_value_percent', status: 'needs_rule', group: 'money', source: null,
    note: 'NOT our computed LTV. The matrix calls it the MAXIMUM LTV permitted under the loan — a mark-to-market covenant the borrower must pay down to. That is a term of the deal, not a measurement of it.' },
  { key: 'default_rate_percent', status: 'needs_config', group: 'money', source: null,
    note: 'A standing programme term. Not on the file today.' },
  { key: 'maximum_default_rate_percentage', status: 'needs_config', group: 'money', source: null,
    note: 'The state usury ceiling the default rate is capped at. Per state.' },
  { key: 'short_term_interest_amount', status: 'derived', group: 'money',
    source: 'per-diem interest from funding to the end of the closing month',
    note: 'Computable from rate + loan amount + closing date once the funding date is fixed.' },
  { key: 'gap_loan_amount', status: 'needs_source', group: 'money', source: null,
    note: 'CEMA only — the new money above the assigned loan, which is the part NY mortgage recording tax is owed on.' },
  { key: 'purchase_refinance', status: 'mapped', group: 'money', source: 'applications.loan_type',
    note: 'Their master payload sends "New Purchase" or "Refinance" — note "New Purchase", not "Purchase".' },
  { key: 'purpose_of_loan', status: 'mapped', group: 'money', source: 'applications.loan_type / program' },

  /* ───────────────────────────────── the dates ───────────────────────────────── */
  { key: 'date_of_closing', status: 'mapped', group: 'dates',
    source: 'closing_workflow.est_closing_date → applications.expected_closing → est_closing_date',
    note: 'Long form ("October 31, 2025") in their payload, not ISO. PILOT holds calendar strings; the formatting happens at the edge.' },
  { key: 'month_of_closing', status: 'derived', group: 'dates', source: 'the closing date' },
  { key: 'year_for_notary_block', status: 'derived', group: 'dates', source: 'the closing date' },
  { key: 'last_day_of_the_month', status: 'derived', group: 'dates',
    source: 'the closing date',
    note: 'The matrix: the last day of the closing MONTH, used as the date per-diem interest accrues to. The global dictionary calls it a boolean, which contradicts both the matrix and their own example — the matrix wins.' },
  { key: 'first_payment_date', status: 'mapped', group: 'dates', source: 'applications.first_payment_date',
    note: 'Already derived by lib/term-options.keyDates() — 1st of the 2nd month after closing.' },
  { key: 'monthly_payment_date_begin', status: 'mapped', group: 'dates', source: 'applications.first_payment_date',
    note: 'Same date, second variable name.' },
  { key: 'first_day_of_month_plus_1_year', status: 'derived', group: 'dates', source: 'first payment date + 1 year' },
  { key: 'maturity_date', status: 'mapped', group: 'dates', source: 'applications.maturity_date' },
  { key: 'maturity_date_of_loan', status: 'mapped', group: 'dates', source: 'applications.maturity_date',
    note: 'Same date, second variable name. Both appear on RTL templates.' },
  { key: 'last_day_to_draw', status: 'needs_rule', group: 'dates', source: null,
    note: 'The matrix states the convention — "most commonly two months before the maturity date" — but a convention is not a rule. Somebody has to say whether that is ours.' },

  /* ─────────────────────────────── the fees ─────────────────────────────── */
  { key: 'origination_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.origination' },
  { key: 'counsel_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.extraFees (legal)',
    note: 'DocLab\'s "Legal Fee" dynamic fee.' },
  { key: 'legal_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.extraFees (legal)',
    note: 'Their master payload carries both counsel_fee and legal_fee.' },
  { key: 'processing_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.extraFees' },
  { key: 'underwriting_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.extraFees' },
  { key: 'funding_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.extraFees' },
  { key: 'other_fee', status: 'mapped', group: 'fees', source: 'quote.closingCosts.extraFees',
    note: 'Their example is a whole sentence ("A fee of $2,000 water risk assessment"), not an amount.' },
  { key: 'draw_fee_amount', status: 'mapped', group: 'fees', source: 'lib/term-options.drawFeeLines(program)',
    note: 'Gold $250 physical; Standard $299 hybrid / $499 physical. Already a printed term-sheet term.' },
  { key: 'exit_fee_percentage', status: 'mapped', group: 'fees', source: 'applications.deferred_orig_pct',
    note: 'PILOT\'s deferred origination is a percentage paid at exit — which is what DocLab calls the exit fee. Confirm the two mean the same thing before the first live package.' },
  { key: 'extension_fee', status: 'needs_config', group: 'fees', source: null, note: 'A standing programme term.' },
  { key: 'prepayment_penalty', status: 'out_of_scope', group: 'fees', source: null,
    note: 'RTL documents carry no prepayment penalty. Kept legacy-compatible by sending the RTL-No option code instead.' },

  /* ──────────────────────────────── the lender ──────────────────────────────── */
  { key: 'lender_name', status: 'needs_config', group: 'lender', source: 'cfg.doclab.lenderName',
    note: 'YS CAPITAL — the entity that makes the loan. NOT applications.lender (the note buyer) and not necessarily the same string as template.lender_name.' },
  { key: 'lender_name_all_caps', status: 'derived', group: 'lender', source: 'lender_name, uppercased',
    note: 'For recording. Uppercased at the edge, never stored twice.' },
  { key: 'lender_address', status: 'needs_config', group: 'lender', source: 'cfg.doclab.lenderAddress',
    note: 'The notice address printed on the note and the mortgage. A standing fact about us, set once in settings — never read off a file.' },
  { key: 'lender_state', status: 'needs_config', group: 'lender', source: 'cfg.doclab.lenderState',
    note: 'The state the lending entity is organised in. Not the property state.' },
  { key: 'lender_town_and_state', status: 'needs_config', group: 'lender', source: 'cfg.doclab.lenderTownAndState',
    note: 'Their own example is one combined string ("Loveland, Colorado"), so it is configured as written rather than assembled from the two fields above.' },
  { key: 'lender_type_of_organization', status: 'needs_config', group: 'lender', source: 'cfg.doclab.lenderOrgType',
    note: 'e.g. "limited liability company".' },
  { key: 'lender_city', status: 'needs_config', group: 'lender', source: 'cfg.doclab.lenderCity', note: 'Added at 3.1.4.' },
  { key: 'lender_name_abbreviated', status: 'needs_config', group: 'lender', source: null, note: 'Added at 3.1.4.' },
  { key: 'governing_law', status: 'needs_rule', group: 'lender', source: null,
    note: 'Which state\'s law governs. Often the lender\'s state rather than the property\'s, and it is a legal choice per state — never inferred.' },
  { key: 'governing_law_all_caps', status: 'derived', group: 'lender', source: 'governing_law, uppercased' },
  { key: 'loan_id', status: 'mapped', group: 'lender', source: 'applications.ys_loan_number',
    note: 'Our loan number, printed on the documents and the key we reconcile a DocLab request back to a file by.' },

  /* ───────────────────────────── the third parties ───────────────────────────── */
  { key: 'settlement_agent_name', status: 'mapped', group: 'third_parties',
    source: 'service_contacts where contact_type = settlement_agent' },
  { key: 'settlement_agent_name_and_address', status: 'mapped', group: 'third_parties',
    source: 'service_contacts (settlement_agent) name + address' },
  { key: 'title_agent', status: 'mapped', group: 'third_parties',
    source: 'service_contacts where contact_type = title_company' },
  { key: 'title_agent_name', status: 'mapped', group: 'third_parties', source: 'service_contacts (title_company)' },
  { key: 'title_agent_name_and_address', status: 'mapped', group: 'third_parties',
    source: 'service_contacts (title_company) name + address' },
  { key: 'underwriter', status: 'needs_source', group: 'third_parties', source: null,
    note: 'THE TITLE UNDERWRITER issuing the loan policy — Fidelity National, First American, Old Republic. It is on the title commitment. It is NOT our staff underwriter; see the trap note at the top of this file.' },
  { key: 'trustee', status: 'needs_rule', group: 'third_parties', source: null,
    note: 'Deed-of-trust states only. Usually the title company at closing, but some states require a named local trustee — a legal designation, so never auto-filled from the title contact.' },
  { key: 'servicer_name', status: 'needs_config', group: 'third_parties', source: 'cfg.doclab.servicerName',
    note: 'Who administers the loan and takes the payments. Standing configuration — and worth confirming it is the same servicer on every RTL programme before it is set once.' },
  { key: 'servicer_address', status: 'needs_config', group: 'third_parties', source: 'cfg.doclab.servicerAddress',
    note: 'Where the borrower sends payments. Printed on the note, so it has to be the address the servicer actually wants.' },

  /* ─────────────────────────────── formatting ─────────────────────────────── */
  { key: 'state_abbrev', status: 'needs_source', group: 'formatting', source: null,
    note: 'NOT the state code — the state environmental-protection agency (see the trap note at the top). We need PLL\'s list of environmental options before this can be sent at all.' },
  { key: 'state', status: 'derived', group: 'formatting', source: 'a single space',
    note: 'Required inside `variables` but their master payload sends " " with the comment "Required but can be empty space" — the real state lives in the template object.' },
  { key: 'loan_category', status: 'derived', group: 'formatting', source: 'a single space',
    note: 'Same as `state` above.' },

  /* ─────────────────── DSCR-only, recorded so nothing reaches for them ─────────────────── */
  { key: 'monthly_escrow_payments', status: 'out_of_scope', group: 'dscr', source: null },
  { key: 'monthly_payment_with_escrows', status: 'out_of_scope', group: 'dscr', source: null },
  { key: 'late_charge_percentage', status: 'out_of_scope', group: 'dscr', source: null,
    note: 'DSCR columns only in the matrix. If an RTL note turns out to carry a late charge, this becomes needs_config.' },
  { key: 'grace_period_days', status: 'out_of_scope', group: 'dscr', source: null, note: 'Same as above.' },
  { key: 'mers_number', status: 'out_of_scope', group: 'dscr', source: null,
    note: 'MERS registration is a rental-loan practice; no RTL column asks for it.' },
]);

/* ────────────────────────────────── helpers ────────────────────────────────── */

const BY_KEY = Object.freeze(FIELDS.reduce((m, f) => { m[f.key] = f; return m; }, {}));

/** Statuses that mean "PILOT can fill this today". */
const READY_STATUSES = Object.freeze(['mapped', 'derived']);
function isReady(f) { return !!f && READY_STATUSES.includes(f.status); }

/** Statuses that mean "somebody has to do something before this can ever be sent". */
const BLOCKED_STATUSES = Object.freeze(['needs_source', 'needs_config', 'needs_rule']);
function isBlocked(f) { return !!f && BLOCKED_STATUSES.includes(f.status); }

/**
 * What is still missing for one loan category — the honest answer to "can we draft
 * this file's documents yet?".
 *
 * Reads the category's own variable list out of the published matrix, so it asks
 * only about variables THIS template actually uses. A DSCR-only variable can never
 * appear, and neither can one belonging to a different RTL template.
 *
 * `matrixKnown: false` is the deliberate third answer, not a pass: for Ground Up
 * Construction the matrix carries no column at all, so we do not know what it needs
 * — and reporting "nothing missing" there would be the single most dangerous thing
 * this function could say.
 */
function gapsForCategory(loanCategory) {
  const known = catalog.matrixKnownFor(loanCategory);
  const wanted = catalog.variablesForCategory(loanCategory).filter((k) => !catalog.isPseudoKey(k));
  const rows = wanted.map((k) => BY_KEY[k]).filter(Boolean);
  const unmapped = wanted.filter((k) => !BY_KEY[k]);
  return {
    matrixKnown: known,
    total: wanted.length,
    ready: rows.filter(isReady).map((f) => f.key),
    blocked: rows.filter(isBlocked).map((f) => ({ key: f.key, status: f.status, note: f.note || null })),
    // A variable the matrix demands that this file has never heard of. Should be
    // empty; if it is not, the map is behind the dictionary and the test says so.
    unmapped,
  };
}

module.exports = {
  FIELDS, BY_KEY,
  READY_STATUSES, BLOCKED_STATUSES, isReady, isBlocked,
  gapsForCategory,
};
