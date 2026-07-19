-- ============================================================================
-- 140 — Record the MISMO version each credit report used (2026-07-19)
--
-- The portal now speaks BOTH MISMO 2.3.1 and 3.4 (owner-directed: 3.4 is the
-- newest). Store which version produced each report so a report is always
-- interpretable and the version mix is auditable. Idempotent.
-- ============================================================================
ALTER TABLE credit_reports
  ADD COLUMN IF NOT EXISTS mismo_version text;
