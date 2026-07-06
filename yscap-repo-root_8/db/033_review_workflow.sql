-- =====================================================================
-- 033_review_workflow.sql
-- Condition review roles: a loan officer can mark a condition REVIEWED;
-- only a processor (or admin) can COMPLETE / sign it off. Reviewed is a
-- lighter stamp that lives alongside the existing sign-off columns.
-- Idempotent: safe to re-run on every boot.
-- =====================================================================
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
