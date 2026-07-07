-- ============================================================================
-- 046_clickup_snapshot_audit.sql — preserve ALL task data + audit support
--
--  * clickup_task_index.snapshot: a masked snapshot of every task's mapped fields
--    (RTL and non-RTL/long-term alike) so no ClickUp data is lost even for file
--    types we don't materialize as loan files yet. SSN/card are masked, never
--    stored in cleartext here.
--  * snapshot_at: when the snapshot was last refreshed.
-- Additive + idempotent.
-- ============================================================================

ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS snapshot     jsonb;
ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS snapshot_at  timestamptz;
ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS task_name    text;   -- ClickUp task name (borrower · address)
ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS folder_id    text;   -- originating pipeline folder
ALTER TABLE clickup_task_index ADD COLUMN IF NOT EXISTS internal_status text; -- ClickUp status (for non-materialized tasks too)
