-- ============================================================================
-- 162 — Store credit-score reason-code factors (owner-directed 2026-07-19)
--
-- Each CREDIT_SCORE carries ~4 bureau reason codes (the "factors that most
-- affected this score", MISMO CREDIT_SCORE/_FACTOR _Code/_Text). They are the
-- principal-reason source for a business-purpose adverse-action notice and a
-- clear "why" for staff + borrower, so persist them per score row. Idempotent.
-- ============================================================================
ALTER TABLE credit_scores
  ADD COLUMN IF NOT EXISTS factors jsonb NOT NULL DEFAULT '[]'::jsonb;
