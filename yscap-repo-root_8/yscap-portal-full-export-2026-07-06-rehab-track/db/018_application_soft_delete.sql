-- 018_application_soft_delete.sql — admins can delete (and restore) a file.
-- Soft delete keeps the row + audit trail; the file simply disappears from every
-- borrower and staff surface. Idempotent.
ALTER TABLE applications ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_applications_deleted ON applications(deleted_at);
