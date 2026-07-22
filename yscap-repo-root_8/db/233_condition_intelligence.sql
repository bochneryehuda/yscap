-- 228 — Condition Intelligence + Cure Analysis (Sovereign 2/4).
--
-- Owner-directed 2026-07-21: a condition is no longer just "checklist row with
-- a label." Every condition now carries STRUCTURED INTENT — what it's really
-- asking for, what risk it addresses, which specific requirements must be
-- satisfied, and what evidence would (or would NOT) satisfy them. When a
-- document is attached to clear a condition, PILOT produces a CURE PROOF that
-- checks each requirement one-by-one and looks for NEW findings the cure
-- document itself surfaces (e.g. a bank statement that clears "prove source
-- of $175k" but reveals a previously-undisclosed loan).
--
-- Three new tables + one column. Idempotent (safe to re-run every boot).
--
-- Design ideas:
--   1. Intent lives at the CODE level (condition_intents, one row per
--      condition CODE) — reusable across every file that has that condition.
--      A per-file customization is a separate row on the item (rare).
--   2. Clearance proofs are APPEND-ONLY — every attempt is preserved so a
--      later dispute can re-read exactly why an earlier attempt failed.
--   3. A cure that raises a NEW FINDING creates a document_findings row via
--      the existing pipeline, linked to the clearance proof.

-- ---- INTENT LIBRARY --------------------------------------------------------
CREATE TABLE IF NOT EXISTS condition_intents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     text NOT NULL UNIQUE,   -- matches checklist_templates.code
  primary_goal             text NOT NULL,
  risk_addressed           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ['borrowed_funds','undisclosed_debt', …]
  satisfaction_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{ id:'verify_transfer_amount', label:'Amount matches', fact_key:'assets.large_deposit_amount', assertion:'equals_expected' }, ...]
  acceptable_evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ['bank_statement', 'gift_letter', ...]
  unacceptable_evidence    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ['unsupported_explanation_letter']
  expiration_policy        text,                    -- 'must_remain_current_through_closing' | 'valid_for_90_days' | 'permanent'
  materiality              text NOT NULL DEFAULT 'material'
                           CHECK (materiality IN ('informational','advisory','material','fatal','ctc_blocking')),
  version                  integer NOT NULL DEFAULT 1,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_condition_intents_code ON condition_intents(code);

-- ---- CLEARANCE PROOFS ------------------------------------------------------
CREATE TABLE IF NOT EXISTS condition_clearance_proofs (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id           uuid NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  checklist_item_id        uuid NOT NULL REFERENCES checklist_items(id) ON DELETE CASCADE,
  intent_id                uuid REFERENCES condition_intents(id) ON DELETE SET NULL,
  document_id              uuid REFERENCES documents(id) ON DELETE SET NULL,
  extraction_id            uuid REFERENCES document_extractions(id) ON DELETE SET NULL,
  -- Outcome: what this cure attempt did to the condition.
  --   satisfied              — every required piece was met
  --   partially_satisfied    — some met, some not
  --   not_satisfied          — evidence didn't address the condition
  --   creates_new_finding    — cure addresses this condition BUT surfaces a
  --                            separate new issue (see linked_new_finding_id)
  --   unable_to_determine    — evidence couldn't be read / classified
  result                   text NOT NULL
                           CHECK (result IN ('satisfied','partially_satisfied',
                                             'not_satisfied','creates_new_finding',
                                             'unable_to_determine')),
  requirements_json        jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- [{ id, label, status:'satisfied'|'not_satisfied'|'unable_to_determine',
    --    evidence:{document_id, page, quote, fact_key}, reason }]
  recommended_action       text,          -- 'clear' | 'request_more' | 'post_condition' | 'grant_exception' | 'decline'
  reviewer_summary         text,          -- plain-language paragraph for the reviewer
  new_findings_json        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- capsule of new findings surfaced by the cure
  linked_finding_ids       uuid[] NOT NULL DEFAULT '{}'::uuid[],  -- FKs into document_findings for the new-finding rows
  analyzer_version         text,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ccp_item ON condition_clearance_proofs(checklist_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ccp_app  ON condition_clearance_proofs(application_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ccp_doc  ON condition_clearance_proofs(document_id) WHERE document_id IS NOT NULL;

-- ---- Per-file intent OVERRIDE (rare) — a specific file's condition may
-- carry a customized intent (e.g. an over-cap exception with extra
-- requirements). Falls back to the code-level intent when NULL.
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS intent_override jsonb;

-- ---- Seeds — the initial intent library for the most common conditions.
-- Idempotent (ON CONFLICT DO NOTHING) so existing intents aren't overwritten.
INSERT INTO condition_intents (code, primary_goal, risk_addressed, satisfaction_requirements, acceptable_evidence, unacceptable_evidence, expiration_policy, materiality)
VALUES
  ('rtl_p1_id',
   'Verify the borrower is who they say they are — name, DOB, address, photo.',
   '["identity_theft","synthetic_identity","expired_id"]'::jsonb,
   $rq$[
     {"id":"name_matches_file","label":"Name on ID matches the borrower on the file","fact_key":"borrower.name","assertion":"equals_file"},
     {"id":"dob_matches_file","label":"DOB on ID matches the borrower on the file","fact_key":"borrower.date_of_birth","assertion":"equals_file"},
     {"id":"id_not_expired","label":"ID is not expired at closing","fact_key":"borrower.id_expiration","assertion":"after_closing"},
     {"id":"photo_present","label":"ID carries a photograph","assertion":"present"}
   ]$rq$::jsonb,
   '["government_id"]'::jsonb,
   '["expired_id","photocopy_no_photo"]'::jsonb,
   'must_remain_current_through_closing', 'fatal'),
  ('rtl_llc_formation',
   'Prove the borrowing entity legally exists and is authorized to do business.',
   '["nonexistent_entity","wrong_state","dissolved_entity"]'::jsonb,
   $rq$[
     {"id":"entity_name_matches","label":"Entity name matches the vesting entity on the file","fact_key":"entity.name","assertion":"equals_file"},
     {"id":"formation_state","label":"Formation state recorded","fact_key":"entity.formation_state","assertion":"present"},
     {"id":"formation_date_present","label":"Formation date recorded","fact_key":"entity.formation_date","assertion":"present"}
   ]$rq$::jsonb,
   '["llc_formation"]'::jsonb,
   '[]'::jsonb,
   'permanent', 'fatal'),
  ('rtl_llc_ein',
   'Confirm the entity has a federal tax ID and the ID matches the entity name.',
   '["ein_mismatch","synthetic_entity"]'::jsonb,
   $rq$[
     {"id":"ein_present","label":"EIN present on the letter","fact_key":"entity.ein","assertion":"present"},
     {"id":"entity_name_matches","label":"Entity name on EIN letter matches the file","fact_key":"entity.name","assertion":"equals_file"}
   ]$rq$::jsonb,
   '["ein_letter"]'::jsonb,
   '[]'::jsonb,
   'permanent', 'fatal'),
  ('rtl_llc_goodstanding',
   'Confirm the entity is currently active and in good standing with its state — needed to close.',
   '["dissolved_entity","suspended_entity","not_authorized_to_do_business"]'::jsonb,
   $rq$[
     {"id":"good_standing_present","label":"Certificate says the entity is in good standing / active","fact_key":"entity.good_standing","assertion":"is_true"},
     {"id":"entity_name_matches","label":"Entity name matches the file","fact_key":"entity.name","assertion":"equals_file"},
     {"id":"recent_certificate","label":"Certificate is dated within the last 90 days","fact_key":"entity.good_standing_date","assertion":"within_days_90"}
   ]$rq$::jsonb,
   '["good_standing"]'::jsonb,
   '[]'::jsonb,
   'valid_for_90_days', 'fatal'),
  ('rtl_p3_assets',
   'Prove the borrower has the liquidity the program requires — cash to close + reserves.',
   '["insufficient_funds","borrowed_funds","undisclosed_debt","commingled_funds"]'::jsonb,
   $rq$[
     {"id":"account_owner_matches","label":"Account owner is the borrower or the borrowing entity","fact_key":"assets.bank_account_owner","assertion":"equals_file"},
     {"id":"ending_balance_present","label":"Ending balance is legible","fact_key":"assets.bank_ending_balance","assertion":"present"},
     {"id":"period_covers_required_months","label":"Statement period covers the program's required months","assertion":"statement_period_covers_months"},
     {"id":"no_undisclosed_large_deposits","label":"No large deposits without documented source","assertion":"no_undocumented_deposits"}
   ]$rq$::jsonb,
   '["bank_statement","gift_letter","sale_document","business_distribution_evidence"]'::jsonb,
   '["unsupported_explanation_letter","cropped_screenshot_without_ownership"]'::jsonb,
   'valid_for_90_days', 'material'),
  ('rtl_cond_credit',
   'Pull the borrower FICO + review derogatories, undisclosed liabilities, mortgage history.',
   '["insufficient_credit","undisclosed_liabilities","recent_derog"]'::jsonb,
   $rq$[
     {"id":"fico_meets_min","label":"FICO meets the program minimum","fact_key":"borrower.fico","assertion":"gte_program_min"},
     {"id":"borrower_matches","label":"Report pulled on the borrower on the file","fact_key":"borrower.name","assertion":"equals_file"},
     {"id":"no_open_bankruptcy","label":"No open / recent bankruptcy","assertion":"no_recent_bankruptcy"}
   ]$rq$::jsonb,
   '["credit_report"]'::jsonb,
   '[]'::jsonb,
   'valid_for_90_days', 'material'),
  ('rtl_cond_fraud',
   'Screen the borrower + borrowing entity against OFAC / sanctions / fraud alerts.',
   '["ofac_sanction","identity_theft","straw_borrower","pep"]'::jsonb,
   $rq$[
     {"id":"screened_borrower","label":"Screen was run on the borrower on the file","fact_key":"compliance.ofac_subject_name","assertion":"equals_file"},
     {"id":"screened_entity","label":"Borrowing entity was screened too","assertion":"entity_screened_when_present"},
     {"id":"ofac_clear","label":"No confirmed OFAC match","fact_key":"compliance.ofac_result","assertion":"is_clear"},
     {"id":"fraud_alerts_cleared","label":"Any high fraud alerts have been adjudicated and cleared","assertion":"fraud_alerts_cleared"}
   ]$rq$::jsonb,
   '["background_report"]'::jsonb,
   '[]'::jsonb,
   'valid_for_90_days', 'material'),
  ('rtl_cond_title',
   'Confirm ownership, unknown liens to clear, and that the vesting entity is correctly named.',
   '["wrong_owner","unknown_liens","incorrect_vesting","property_description_mismatch"]'::jsonb,
   $rq$[
     {"id":"property_address_matches","label":"Property address matches the file","fact_key":"property.address","assertion":"equals_file"},
     {"id":"vesting_matches","label":"Vesting entity matches the borrowing entity on the file","fact_key":"title.vesting","assertion":"equals_file"},
     {"id":"liens_disclosed","label":"All liens are disclosed and can be cleared at closing","assertion":"liens_clearable"}
   ]$rq$::jsonb,
   '["title"]'::jsonb,
   '[]'::jsonb,
   'must_remain_current_through_closing', 'ctc_blocking'),
  ('rtl_cond_insurance',
   'Confirm evidence of insurance and that the premium is paid so coverage is in force at funding.',
   '["uninsured_property","insufficient_coverage","insured_name_mismatch","policy_lapsed"]'::jsonb,
   $rq$[
     {"id":"insured_name_matches","label":"Insured name matches the vesting entity","fact_key":"insurance.insured_name","assertion":"equals_file"},
     {"id":"coverage_gte_loan","label":"Coverage amount at least the loan amount","fact_key":"insurance.coverage_amount","assertion":"gte_loan_amount"},
     {"id":"effective_covers_closing","label":"Effective date covers the closing date","fact_key":"insurance.effective_date","assertion":"before_closing"},
     {"id":"mortgagee_clause","label":"Lender is listed as mortgagee","assertion":"mortgagee_present"}
   ]$rq$::jsonb,
   '["insurance","insurance_invoice"]'::jsonb,
   '[]'::jsonb,
   'must_remain_current_through_closing', 'ctc_blocking'),
  ('rtl_cond_flood',
   'Confirm the flood determination and, if in a flood zone, that the property carries flood coverage.',
   '["property_in_flood_zone_uninsured"]'::jsonb,
   $rq$[
     {"id":"determination_present","label":"Flood determination is on file","fact_key":"property.flood_zone","assertion":"present"},
     {"id":"flood_policy_if_zone_a_or_v","label":"If in an A or V flood zone, a flood policy is on file","assertion":"flood_policy_when_in_zone"}
   ]$rq$::jsonb,
   '["flood"]'::jsonb,
   '[]'::jsonb,
   'must_remain_current_through_closing', 'ctc_blocking')
ON CONFLICT (code) DO NOTHING;
