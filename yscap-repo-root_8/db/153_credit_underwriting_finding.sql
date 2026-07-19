-- 153 - Underwriting FICO-match finding on a credit report (owner-directed 2026-07-19)
--
-- When an imported credit report's VERIFIED representative FICO lands in a
-- DIFFERENT standard bracket than the FICO the file was built/priced on, that is a
-- FATAL underwriting finding: the loan's economics were sized on a score the bureau
-- did not confirm. We store the structured finding on the report row so the staff
-- credit section can surface it and the credit condition can block sign-off until a
-- human reconciles (re-registers on the verified score). NULL = no mismatch.
--
-- Idempotent: safe to re-run on every boot.
ALTER TABLE credit_reports
  ADD COLUMN IF NOT EXISTS underwriting_finding jsonb;

COMMENT ON COLUMN credit_reports.underwriting_finding IS
  'FICO-match underwriting finding {type,severity,verified,claimed,verifiedBracket,claimedBracket,perBorrower[],message} or NULL when the verified FICO matches the file (same bracket).';
