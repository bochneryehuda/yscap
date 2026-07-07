-- 055_clickup_created_at.sql
-- The pipeline's "Newest / Oldest first" sort used applications.created_at, but
-- every ClickUp-imported file was inserted with created_at = import time, so the
-- entire back-book clustered at one timestamp and the sort looked broken. Capture
-- the REAL ClickUp task creation date so the sort reflects true file chronology.
-- Native portal files (no ClickUp date) keep falling back to created_at.

ALTER TABLE applications
  ADD COLUMN IF NOT EXISTS clickup_created_at timestamptz;
