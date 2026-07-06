-- =====================================================================
-- 030_application_pricing_fields.sql — the borrower's requested interest
-- reserve (months) chosen in the Term Sheet Studio step of the loan
-- application. `term` already exists on applications; this completes the
-- pricing scenario so server-side re-quotes match the registered studio
-- scenario exactly.
-- =====================================================================
ALTER TABLE applications ADD COLUMN IF NOT EXISTS requested_ir_months integer
  CHECK (requested_ir_months IS NULL OR (requested_ir_months BETWEEN 0 AND 24));
