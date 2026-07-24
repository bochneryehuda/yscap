# Blue Lake ISG analysis — shared reference for extraction agents

You are extracting **Blue Lake Capital** (note buyer, normalized key `bluelake`) RTL soft
guidelines into a machine-readable spec that plugs into the EXISTING PILOT investor-guideline
framework. Do NOT invent structure — match the shapes below exactly so the output compiles.

## Output target: one CONDITION object per guideline rule (shape from corrfirst-fnf-spec.js)

```
{ cond_no: <int, unique>, name: 'SHORT NAME', domain: '<domain>', scope: '<scope>',
  lifecycle: '<lifecycle>', trigger: <trigger obj>,
  required_evidence: 'exact plain-language: what document/proof clears this',
  checks: [ { text/detail, note_buyer_specific?:bool } ],   // the verifications (numbers cited)
  clears_by: 'document_upload'|'third_party_order'|'attorney_closing'|'system',
  pilot_template_code: '<existing template code or null>', match_quality: 'exact'|'partial'|'new',
  phase: 'pre_close'|'post_close',        // <-- ADD THIS. Focus pre_close.
  source_page: <pdf page number>, source_quote: 'verbatim guideline text' }
```

## Allowed enum values
- **domain**: credit, identity, assets_liquidity, title, flood, track_record, appraisal,
  background_ofac, closing_docs, entity_vesting, occupancy, insurance_hazard,
  construction_feasibility, seller_concession, valuation, property, program_eligibility,
  state_overlay, other  (add a new one ONLY if truly none fits — flag it)
- **scope**: `all_note_buyers` (applies to every buyer — a general RTL rule),
  `note_buyer` (Blue-Lake-specific value/limit), `all_but_note_buyer_limits`
- **lifecycle**: `active_now` (verify pre-close), `hold_attorney_closing`, `defer_post_closing`,
  `closing_phase`
- **clears_by**: document_upload, third_party_order, attorney_closing, system

## Loan-file field keys available for TRIGGERS (field-registry — use ONLY these)
acquisition_date arv as_is_value assignment_fee borrower_state citizenship fico has_co_borrower
has_llc in_flood_zone is_assignment liquidity_required llc_state llc_verified loan_amount
loan_purpose loan_to_arv loan_to_cost ltv note_buyer occupancy original_purchase_price
payoff_amount program_strategy property_city property_state property_type property_zip
purchase_price rate_pct registered_program rehab_budget rehab_type requested_exp_flips
requested_exp_ground requested_exp_holds requested_ir_amount requested_ir_months sqft_post
sqft_pre status tier underlying_contract_price units verified_flips verified_holds
verified_ground ys_loan_number

Trigger shape (conditions/rules dialect): `{combinator:'and', rules:[{field, operator, value}]}`
operators: eq, gt, lt, in, is_true, is_false. Empty `{}` = always applies.
If a rule keys off something NOT in the field list (e.g. rehab_type=heavy, property_type=condo),
still write the trigger with the closest field + note the gap in `trigger_note`.

## Existing PILOT RTL checklist template codes (map to these where the rule matches one)
rtl_cond_credit rtl_p1_id rtl_p3_assets rtl_cond_title rtl_cond_flood rtl_cond_signedts
rtl_p3_reo rtl_cond_appraisaldocs rtl_cond_fraud rtl_cond_insurance rtl_p3_sow1 rtl_p3_sow2
rtl_cond_disclosures rtl_cond_investorstruct rtl_cond_iska rtl_cond_settlement rtl_llc_ein
rtl_llc_formation rtl_llc_goodstanding rtl_llc_opagmt rtl_p1_budget rtl_p1_plans rtl_p1_contract
rtl_p3_liq rtl_p3_credit rtl_p3_titleord rtl_p3_insord  (null if no PILOT equivalent → match_quality:'new')

## Existing document-intelligence doc-type tokens (for the doc-list mapping agent)
application appraisal assignment background_report bank_statement construction contractor cpl
credit_report ein ein_letter experience flood formation good_standing government_id hazard
insurance lease llc_formation ofac operating_agreement purchase_agreement title track_record ...

## Numeric overlays to capture separately (Blue Lake's own numbers)
Any LTV / LTC / ARV cap, FICO minimum, min/max loan size, experience-tier requirement,
reserve/liquidity months, seller-concession cap, contingency cap, DSCR floor, rehab-budget
threshold, property-type eligibility. Capture as an `overlays` list: {metric, program/strategy,
value, source_page, source_quote}.

## HARD RULES
- Go PAGE BY PAGE. Do not skip pages or summarize away detail. Quote the source.
- Focus **pre-close**. Mark post-close items `phase:'post_close'` and keep them in a SEPARATE list.
- Read BOTH the extracted text file AND visually Read the actual PDF pages (tables/matrices/grids
  in the text extraction are flattened and easy to misread — confirm every number against the PDF image).
- You are READ-ONLY. Do NOT run any git command. Do NOT edit or create any file in the repo.
  Write your findings ONLY to your assigned output file under the scratchpad bluelake/ dir.
