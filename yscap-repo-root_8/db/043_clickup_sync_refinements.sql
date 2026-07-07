-- ============================================================================
-- 043_clickup_sync_refinements.sql — round-4 owner refinements
--
--   * applications.clickup_extra  — hidden backend capture of every ClickUp
--     field we don't explicitly map (never displayed until asked).
--   * applications.co_borrower_task_id — ClickUp SUBTASK id holding the
--     co-borrower's full profile (Part 7.7).
--   * borrowers.saved_card_*  — reusable appraisal card on the borrower profile
--     (encrypted; carried across files; CVV persisted, Part 7.9).
--
-- The ClickUp task id itself is already stored on applications.clickup_pipeline_task_id.
-- lender / channel / occupancy already have columns — they're backend-only by
-- UI policy (no schema change). Additive + idempotent.
-- ============================================================================

ALTER TABLE applications ADD COLUMN IF NOT EXISTS clickup_extra       jsonb;   -- unmapped CU fields, backend-only
ALTER TABLE applications ADD COLUMN IF NOT EXISTS co_borrower_task_id  text;   -- ClickUp subtask id (co-borrower profile)

-- Reusable appraisal card on the borrower profile (encrypted; never logged).
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS saved_card_number_encrypted bytea;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS saved_card_last4            char(4);
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS saved_card_exp             text;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS saved_card_cvv_encrypted   bytea;
ALTER TABLE borrowers ADD COLUMN IF NOT EXISTS save_card_for_reuse        boolean NOT NULL DEFAULT false;
