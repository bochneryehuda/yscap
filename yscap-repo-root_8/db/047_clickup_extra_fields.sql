-- 047_clickup_extra_fields.sql
-- Round 3 of the ClickUp data-completeness work: promote 19 additional loan-file
-- fields the team keeps in ClickUp into first-class portal columns so staff can
-- SEE them on the file (rates, carrying costs, valuation, title/insurance, liens,
-- pipeline status). These are PULL-ONLY (ClickUp is the source of truth) — the
-- outbound push never writes them, so there is no echo/clobber risk. Idempotent.
ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS actual_rate                   text,
  ADD COLUMN IF NOT EXISTS desired_rate                  text,
  ADD COLUMN IF NOT EXISTS property_taxes                numeric(14,2),
  ADD COLUMN IF NOT EXISTS property_insurance            numeric(14,2),
  ADD COLUMN IF NOT EXISTS property_hoa                  numeric(14,2),
  ADD COLUMN IF NOT EXISTS rental_income                 numeric(14,2),
  ADD COLUMN IF NOT EXISTS prepayment_penalty            text,
  ADD COLUMN IF NOT EXISTS title_company                 text,
  ADD COLUMN IF NOT EXISTS title_company_contact         text,
  ADD COLUMN IF NOT EXISTS insurance_company             text,
  ADD COLUMN IF NOT EXISTS insurance_company_contact     text,
  ADD COLUMN IF NOT EXISTS first_lien                    numeric(14,2),
  ADD COLUMN IF NOT EXISTS second_lien                   numeric(14,2),
  ADD COLUMN IF NOT EXISTS appraised_rental_value        numeric(14,2),
  ADD COLUMN IF NOT EXISTS approx_appraised_rental_value numeric(14,2),
  ADD COLUMN IF NOT EXISTS cda_value                     numeric(14,2),
  ADD COLUMN IF NOT EXISTS appraiser_name                text,
  ADD COLUMN IF NOT EXISTS encompass_status              text,
  ADD COLUMN IF NOT EXISTS application_submitted         text;
