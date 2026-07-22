-- R5.30 — Seed condition intents for more MATERIAL conditions.
--
-- db/233 seeded 10 intents (ID, LLC formation, EIN, good standing, assets,
-- credit, background/OFAC, title, insurance, flood). This adds four more
-- material conditions the cure engine can now actually evaluate — every
-- requirement below uses ONLY assertions that exist in cure.js ASSERTIONS
-- (equals_file / before_closing / present) and ONLY fact keys the twin's
-- EXTRACTED_FIELD_MAP actually records for the filed document type, so a filed
-- document produces a real satisfied / not_satisfied verdict (not a blanket
-- "unable to determine"). Non-autonomous: the proof informs a human.
--
-- Idempotent (ON CONFLICT (code) DO NOTHING) — never overwrites a hand-tuned
-- intent already present for these codes.

INSERT INTO condition_intents (code, primary_goal, risk_addressed, satisfaction_requirements, acceptable_evidence, unacceptable_evidence, expiration_policy, materiality)
VALUES
  -- Purchase contract: the governing purchase terms match the file (address,
  -- price, and the buyer is the borrowing entity). purchase_contract extracts
  -- propertyAddress→property.address, price→transaction.purchase_price,
  -- buyerName→entity.name, closingDate→transaction.closing_date.
  ('rtl_p1_contract',
   'Confirm the executed purchase contract matches the file — property, price, and that the buyer is the borrowing entity.',
   '["wrong_property","price_mismatch","buyer_not_vesting_entity","unexecuted_contract"]'::jsonb,
   $rq$[
     {"id":"property_address_matches","label":"Property address matches the file","fact_key":"property.address","assertion":"equals_file"},
     {"id":"purchase_price_matches","label":"Purchase price matches the file","fact_key":"transaction.purchase_price","assertion":"equals_file"},
     {"id":"buyer_matches_entity","label":"Buyer is the borrowing entity on the file","fact_key":"entity.name","assertion":"equals_file"}
   ]$rq$::jsonb,
   '["purchase_contract","contract_amendment"]'::jsonb,
   '[]'::jsonb,
   'must_remain_current_through_closing', 'ctc_blocking'),

  -- Operating agreement: the entity named on the agreement is the borrowing
  -- entity. operating_agreement extracts entityName→entity.name. (Signing
  -- authority has no deterministic assertion yet — it stays a human check.)
  ('rtl_llc_opagmt',
   'Confirm the operating agreement is for the borrowing entity on the file.',
   '["wrong_entity","entity_name_changed"]'::jsonb,
   $rq$[
     {"id":"entity_name_matches","label":"Entity name on the operating agreement matches the file","fact_key":"entity.name","assertion":"equals_file"}
   ]$rq$::jsonb,
   '["operating_agreement"]'::jsonb,
   '[]'::jsonb,
   'permanent', 'material'),

  -- Signed application: pulled on the borrower on the file, for the loan amount
  -- on the file. signed_application extracts borrowerName→borrower.name,
  -- loanAmount→loan.amount.
  ('rtl_cond_signed_app',
   'Confirm the signed application is for the borrower and loan amount on the file.',
   '["wrong_borrower","stale_loan_amount","unsigned_application"]'::jsonb,
   $rq$[
     {"id":"borrower_matches","label":"Application is for the borrower on the file","fact_key":"borrower.name","assertion":"equals_file"},
     {"id":"loan_amount_matches","label":"Application loan amount matches the file","fact_key":"loan.amount","assertion":"equals_file"}
   ]$rq$::jsonb,
   '["signed_application"]'::jsonb,
   '[]'::jsonb,
   'valid_for_90_days', 'material'),

  -- Signed term sheet: the loan amount on the executed term sheet matches the
  -- file. signed_term_sheet extracts loanAmount→loan.amount.
  ('rtl_cond_signedts',
   'Confirm the signed term sheet reflects the loan amount on the file.',
   '["stale_terms","unsigned_term_sheet"]'::jsonb,
   $rq$[
     {"id":"loan_amount_matches","label":"Term sheet loan amount matches the file","fact_key":"loan.amount","assertion":"equals_file"}
   ]$rq$::jsonb,
   '["signed_term_sheet"]'::jsonb,
   '[]'::jsonb,
   'valid_for_90_days', 'material')
ON CONFLICT (code) DO NOTHING;
